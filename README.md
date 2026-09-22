# Demo Database MCP — an MCP server protected by AgentAdmit

A small database MCP server (stdio) that shows what user-mediated authorization looks like in practice. It is the "Database Query MCP Server" example from the [AgentAdmit MCP Operator Guide](https://agentadmit.com/docs/mcp-guide), running for real against the hosted service on a test key.

What the user gets that a raw MCP server cannot give them:

- **The grant starts with the human.** With no token, every tool answers with a hosted authorization link. The user opens it, picks which permissions this agent gets (`db:read`, `db:write`, `db:delete`) and for how long, and confirms with a passkey. The agent cannot complete that page itself.
- **Every call is verified.** Each tool call is checked against the hosted service with the exact tool, arguments digest, and a plain-language summary. Revoke the connection and the next call is refused. Every call is attributed to the agent that made it.
- **Destructive tools confirm each time.** `drop_table` and `delete_rows` stop until the user confirms exactly that call with a passkey on a hosted page, or declines it. A decline is a final answer: the agent is told, no new link is minted, and the same action stays refused until the request window ends.

## Run it

```bash
npm install --ignore-scripts
cp agentadmit.example.yaml agentadmit.yaml   # paste your app's aa_test_ key from the AgentAdmit dashboard
npm run register-scopes                       # registers db:read / db:write / db:delete (confirm each time)
npm run seed                                  # creates demo.db with a few customers and orders
```

Add it to your MCP client (Claude Code shown):

```bash
claude mcp add demo-database-mcp -- node /path/to/agentadmit-mcp-showcase/src/server.mjs
```

Then ask the agent to list the tables. It will hand you a link. The rest is the demo.

## Tools

| Tool | Scope | Human gate |
|---|---|---|
| `list_tables` | `db:read` | grant |
| `run_query` (read-only SQL) | `db:read` | grant |
| `insert_row` | `db:write` | grant |
| `delete_rows` | `db:delete` | grant + confirm each call |
| `drop_table` | `db:delete` | grant + confirm each call |

Every tool accepts `agentadmit_token` (the STDIO pattern from the guide) and, on a retry after a confirmation, `action_attestation_id`.

## What this does not claim

The gate is at the MCP layer: consent, scopes, per-call confirmation, decline, revocation, attribution. The database itself still trusts the server process; that is true of every MCP server. Evidence is tamper-evident, never tamper-proof.

## Tests

```bash
npm test
```

The tests run the server in-process with an in-memory MCP client and a mocked hosted service, covering: no token → link; granted read → runs; missing scope → refused; confirm-each-time → link with the exact summary; declined → final answer; confirmed retry → runs; revoked → re-authorize; read-only SQL guard.

MIT.
