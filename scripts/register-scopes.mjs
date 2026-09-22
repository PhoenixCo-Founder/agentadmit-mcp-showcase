#!/usr/bin/env node
// Registers the server's scope catalog with AgentAdmit (idempotent upsert).
// db:delete is confirm-each-time: every call needs a fresh human passkey
// confirmation of the exact action, even inside a valid grant.
import { init } from '../src/agentadmit.mjs';
import { SCOPES } from '../src/scopes.mjs';

const cfg = init();
const base = (cfg.agentadmit_api_url || 'https://api.agentadmit.com').replace(/\/$/, '');
const res = await fetch(`${base}/api/v1/apps/${cfg.app_id}/scopes`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${cfg.api_key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ scopes: SCOPES }),
});
const data = await res.json().catch(() => ({}));
if (!res.ok) { console.error('scope registration failed', res.status, data); process.exit(1); }
const rows = Array.isArray(data.scopes) ? data.scopes : Array.isArray(data) ? data : [];
console.log('registered scopes:', rows.map((s) => `${s.name}${s.confirm_each_time ? ' (confirm each time)' : ''}`).join(', ') || JSON.stringify(data));
