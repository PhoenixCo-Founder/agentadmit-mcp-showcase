import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb, seed } from '../src/db.mjs';
import { init } from '../src/agentadmit.mjs';
import { buildServer } from '../src/server.mjs';

// The SDK reads its config from a yaml file; give it a throwaway one.
const dir = mkdtempSync(join(tmpdir(), 'aa-showcase-'));
const cfgPath = join(dir, 'agentadmit.yaml');
writeFileSync(cfgPath, 'app_id: "app_test"\napi_key: "aa_test_fixture"\napi_base_url: "https://example.com"\nscopes: []\n');
init(cfgPath);

const calls = [];
let verifyResponses = [];
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/consent-sessions')) {
      return new Response(JSON.stringify({ session_id: 'csess_x', session_url: 'https://agentadmit.com/connect/csess_x', expires_at: '2026-09-22T23:00:00.000Z', presence_mode: 'required' }), { status: 201 });
    }
    if (String(url).endsWith('/api/v1/verify')) {
      const next = verifyResponses.shift() ?? { active: false, error: 'invalid_token' };
      return new Response(JSON.stringify(next), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});
after(() => { globalThis.fetch = realFetch; });

async function client() {
  const db = openDb(':memory:'); seed(db);
  const server = buildServer({ db, userId: 'user_fixture' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(ct);
  return c;
}
const textOf = (r) => r.content.map((x) => x.text).join('\n');

test('no token → the human gets a presence-required consent link, nothing runs', async () => {
  const c = await client();
  const r = await c.callTool({ name: 'list_tables', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /https:\/\/agentadmit\.com\/connect\/csess_x/);
  const mint = calls.find((x) => x.url.endsWith('/consent-sessions'));
  assert.equal(mint.body.presence, 'required');
  assert.deepEqual(mint.body.recommended_scopes, ['db:read']);
  assert.equal(mint.body.user_id, 'user_fixture');
});

test('granted db:read → list_tables runs and verify carried the exact call', async () => {
  const c = await client();
  verifyResponses = [{ active: true, scopes: ['db:read'], user_id: 'user_fixture', connection_id: 'conn_1', agent_label: 'Test agent' }];
  const r = await c.callTool({ name: 'list_tables', arguments: { agentadmit_token: 'ag_at_fixture' } });
  assert.equal(r.isError, undefined);
  assert.match(textOf(r), /"name": "customers"/);
  const v = calls.filter((x) => x.url.endsWith('/api/v1/verify')).pop().body;
  assert.equal(v.scope_used, 'db:read');
  assert.equal(v.endpoint, '/tools/list_tables');
  assert.equal(v.method, 'TOOL');
  assert.match(v.request_digest, /^sha256:[0-9a-f]{64}$/);
});

test('hosted refusal insufficient_scope → tool error names the missing scope, nothing runs', async () => {
  const c = await client();
  verifyResponses = [{ active: true, error: 'insufficient_scope', granted_scopes: ['db:read'] }];
  const r = await c.callTool({ name: 'insert_row', arguments: { agentadmit_token: 'ag_at_fixture', table: 'customers', data: { name: 'X', email: 'x@example.com', plan: 'pro' } } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /insufficient_scope: insert_row needs the "db:write" permission/);
});

test('confirm-each-time: drop_table stops with the confirmation link and the exact summary', async () => {
  const c = await client();
  verifyResponses = [{ active: true, error: 'confirmation_required', confirmation: { action_session_id: 'asess_1', action_session_url: 'https://agentadmit.com/confirm/action/asess_1', expires_at: '2026-09-22T23:15:00.000Z', scope: 'db:delete', method: 'TOOL', endpoint: '/tools/drop_table', request_digest: 'sha256:abc', summary: 'Drop table customers (6 rows, irreversible)' } }];
  const r = await c.callTool({ name: 'drop_table', arguments: { agentadmit_token: 'ag_at_fixture', table: 'customers' } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /confirmation_required: "Drop table customers \(6 rows, irreversible\)"/);
  assert.match(textOf(r), /https:\/\/agentadmit\.com\/confirm\/action\/asess_1/);
  assert.match(textOf(r), /action_attestation_id="asess_1"/);
  const v = calls.filter((x) => x.url.endsWith('/api/v1/verify')).pop().body;
  assert.equal(v.action_summary, 'Drop table customers (6 rows, irreversible)');
  // the table is still there
  verifyResponses = [{ active: true, scopes: ['db:read'], user_id: 'user_fixture', connection_id: 'conn_1' }];
  const l = await c.callTool({ name: 'list_tables', arguments: { agentadmit_token: 'ag_at_fixture' } });
  assert.match(textOf(l), /"customers"/);
});

test('the user declined → final answer, no link, nothing runs', async () => {
  const c = await client();
  verifyResponses = [{ active: true, error: 'confirmation_declined', declined: { action_session_id: 'asess_1', hold_until: '2026-09-22T23:15:00.000Z' } }];
  const r = await c.callTool({ name: 'drop_table', arguments: { agentadmit_token: 'ag_at_fixture', table: 'customers', action_attestation_id: 'asess_1' } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /confirmation_declined: the user declined "Drop table customers \(6 rows, irreversible\)"/);
  assert.doesNotMatch(textOf(r), /confirm\/action/);
});

test('confirmed retry → the attestation rides the verify call and the drop runs', async () => {
  const c = await client();
  verifyResponses = [{ active: true, scopes: ['db:read', 'db:delete'], user_id: 'user_fixture', connection_id: 'conn_1', action_confirmation: { action_session_id: 'asess_1', consumed: true } }];
  const r = await c.callTool({ name: 'drop_table', arguments: { agentadmit_token: 'ag_at_fixture', table: 'orders', action_attestation_id: 'asess_1' } });
  assert.equal(r.isError, undefined);
  assert.match(textOf(r), /"dropped":"orders"/);
  const v = calls.filter((x) => x.url.endsWith('/api/v1/verify')).pop().body;
  assert.equal(v.action_attestation_id, 'asess_1');
});

test('revoked/expired token → asks for a fresh authorization link', async () => {
  const c = await client();
  verifyResponses = [{ active: false, error: 'revoked' }];
  const r = await c.callTool({ name: 'list_tables', arguments: { agentadmit_token: 'ag_at_fixture' } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /not_authorized: Token is not active: revoked/);
});

test('run_query refuses anything that is not a read', async () => {
  const c = await client();
  verifyResponses = [{ active: true, scopes: ['db:read'], user_id: 'user_fixture', connection_id: 'conn_1' }];
  const r = await c.callTool({ name: 'run_query', arguments: { agentadmit_token: 'ag_at_fixture', sql: 'DELETE FROM customers' } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /read-only/);
});
