#!/usr/bin/env node
/**
 * Demo Database MCP — a database MCP server protected by AgentAdmit.
 *
 * What the user gets that a raw MCP server cannot give them:
 *   - the grant starts with the human: no token, no calls; the server hands
 *     the human a hosted consent link (passkey required) where THEY pick the
 *     scopes and the duration
 *   - every tool call is verified against the hosted service (revocation
 *     bites on the next call, per-agent attribution on every row)
 *   - db:delete is confirm-each-time: drop_table / delete_rows stop until the
 *     human confirms exactly that call with a passkey, or declines it
 *
 * Transport: stdio. The agent passes `agentadmit_token` as a tool argument
 * (MCP Operator Guide, STDIO pattern) and `action_attestation_id` on a retry
 * after the human confirmed.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDb, seed, listTables, runQuery, insertRow, deleteRows, dropTable, countWhere } from './db.mjs';
import { init, mintConsentLink, verifyToolCall, ConfirmationRequiredError, VerifyRefusedError } from './agentadmit.mjs';
import { TOOL_SCOPE, ALL_SCOPES, RECOMMENDED_SCOPES } from './scopes.mjs';

const credentialArgs = {
  agentadmit_token: z.string().optional().describe('AgentAdmit access token (ag_at_…) for the connection the user granted this agent. Omit it to receive an authorization link for the user.'),
  action_attestation_id: z.string().optional().describe('On a retry after the user confirmed a destructive action on the hosted page: the action_session_id from the confirmation_required error.'),
};

function text(s) { return { content: [{ type: 'text', text: s }] }; }
function fail(s) { return { isError: true, content: [{ type: 'text', text: s }] }; }

export function buildServer({ db, userId = process.env.DEMO_USER_ID || `user_${randomBytes(6).toString('hex')}` } = {}) {
  const server = new McpServer({ name: 'demo-database-mcp', version: '0.1.0' });

  /** The gate every tool goes through. Returns the agent context or a tool
   * error the agent can act on (a link for the human, or a final refusal). */
  async function gate(tool, args, summary) {
    const scope = TOOL_SCOPE[tool];
    if (!args.agentadmit_token) {
      const link = await mintConsentLink({ userId, scopes: ALL_SCOPES, recommended: RECOMMENDED_SCOPES, purpose: 'Let this agent work with the demo database on my behalf' });
      return { error: fail(
        `This server requires the user's authorization before any tool runs.\n` +
        `Ask your human to open ${link.url} (valid until ${link.expires_at}), choose which permissions this agent gets and for how long, confirm with their passkey, and paste the generated token back to you.\n` +
        `Then call the tool again with agentadmit_token. You cannot complete that page yourself.`) };
    }
    try {
      const ctx = await verifyToolCall({ token: args.agentadmit_token, tool, scope, args, summary, attestationId: args.action_attestation_id });
      return { ctx };
    } catch (err) {
      if (err instanceof ConfirmationRequiredError) {
        const c = err.confirmation;
        return { error: fail(
          `confirmation_required: "${summary}" needs the user's fresh confirmation before it runs${err.attestationStatus ? ` (previous attestation: ${err.attestationStatus})` : ''}.\n` +
          `Give the user this link: ${c.action_session_url} (expires ${c.expires_at}). They confirm exactly this action with their passkey, or decline it.\n` +
          `After they confirm, call ${tool} again with the same arguments plus action_attestation_id="${c.action_session_id}". Nothing has run.`) };
      }
      if (err instanceof VerifyRefusedError) {
        switch (err.code) {
          case 'confirmation_declined':
            return { error: fail(`confirmation_declined: the user declined "${summary}" on the hosted confirmation page. Nothing ran. Do not retry this action unless the user asks you to.`) };
          case 'insufficient_scope':
            return { error: fail(`insufficient_scope: ${tool} needs the "${scope}" permission and the user did not grant it to this agent. Ask the user; only they can widen the grant (a new authorization link).`) };
          case 'bound_exceeded':
            return { error: fail(`bound_exceeded: the user's call ceiling for this connection has been reached. Only a new user-authorized grant lifts it.`) };
          default:
            return { error: fail(`${err.code}: the authorization service refused this call.`) };
        }
      }
      return { error: fail(`not_authorized: ${err.message}. If the connection was revoked or expired, ask the user for a new authorization link (call the tool without agentadmit_token).`) };
    }
  }

  server.registerTool('list_tables', {
    description: 'List tables in the demo database with row counts. Scope: db:read.',
    inputSchema: { ...credentialArgs },
  }, async (args) => {
    const g = await gate('list_tables', args, 'List tables');
    if (g.error) return g.error;
    return text(JSON.stringify(listTables(db), null, 2));
  });

  server.registerTool('run_query', {
    description: 'Run a single read-only SELECT query. Scope: db:read.',
    inputSchema: { sql: z.string().min(1).max(2000), ...credentialArgs },
  }, async (args) => {
    const g = await gate('run_query', args, `Run query: ${args.sql.slice(0, 120)}`);
    if (g.error) return g.error;
    try { return text(JSON.stringify(runQuery(db, args.sql), null, 2)); } catch (e) { return fail(e.message); }
  });

  server.registerTool('insert_row', {
    description: 'Insert one row into a table. Scope: db:write.',
    inputSchema: { table: z.string(), data: z.record(z.string(), z.union([z.string(), z.number(), z.null()])), ...credentialArgs },
  }, async (args) => {
    const g = await gate('insert_row', args, `Insert a row into ${args.table}`);
    if (g.error) return g.error;
    try { return text(JSON.stringify(insertRow(db, args.table, args.data))); } catch (e) { return fail(e.message); }
  });

  server.registerTool('delete_rows', {
    description: 'Delete rows matching a WHERE predicate. Scope: db:delete (confirm each time: the user must confirm this exact call with a passkey).',
    inputSchema: { table: z.string(), where: z.string().min(1).max(500), ...credentialArgs },
  }, async (args) => {
    let n = null;
    try { n = countWhere(db, args.table, args.where); } catch (e) { return fail(e.message); }
    const g = await gate('delete_rows', args, `Delete ${n} row${n === 1 ? '' : 's'} from ${args.table} where ${args.where}`);
    if (g.error) return g.error;
    try { return text(JSON.stringify({ ...deleteRows(db, args.table, args.where), confirmed_by: g.ctx.user_id })); } catch (e) { return fail(e.message); }
  });

  server.registerTool('drop_table', {
    description: 'Drop a whole table. Irreversible. Scope: db:delete (confirm each time: the user must confirm this exact call with a passkey).',
    inputSchema: { table: z.string(), ...credentialArgs },
  }, async (args) => {
    let rows = null;
    try { rows = countWhere(db, args.table, '1=1'); } catch (e) { return fail(e.message); }
    const g = await gate('drop_table', args, `Drop table ${args.table} (${rows} row${rows === 1 ? '' : 's'}, irreversible)`);
    if (g.error) return g.error;
    try { return text(JSON.stringify({ ...dropTable(db, args.table), confirmed_by: g.ctx.user_id })); } catch (e) { return fail(e.message); }
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  init();
  const db = openDb(process.env.DEMO_DB_PATH || 'demo.db');
  seed(db);
  const server = buildServer({ db });
  await server.connect(new StdioServerTransport());
}
