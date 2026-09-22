#!/usr/bin/env node
// Drive the server over real stdio like an MCP client would.
//   node scripts/try.mjs <tool> '<json args>'
// AGENTADMIT_TOKEN (optional) is injected as agentadmit_token so it never
// appears on a command line; ATTESTATION_ID likewise.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [tool, rawArgs = '{}'] = process.argv.slice(2);
if (!tool) { console.error('usage: try.mjs <tool> [json-args]'); process.exit(2); }
const args = JSON.parse(rawArgs);
if (process.env.AGENTADMIT_TOKEN) args.agentadmit_token = process.env.AGENTADMIT_TOKEN;
if (process.env.ATTESTATION_ID) args.action_attestation_id = process.env.ATTESTATION_ID;

const here = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: 'node', args: [join(here, '..', 'src', 'server.mjs')], env: { ...process.env, AGENTADMIT_TOKEN: '', ATTESTATION_ID: '' }, stderr: 'pipe' });
const client = new Client({ name: 'try', version: '0' });
await client.connect(transport);
const r = await client.callTool({ name: tool, arguments: args });
console.log(r.isError ? 'TOOL ERROR:' : 'OK:');
for (const c of r.content) console.log(c.text ?? JSON.stringify(c));
await client.close();
