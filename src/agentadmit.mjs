// Everything that talks to AgentAdmit lives here so the tool handlers stay
// about the database. Verification goes through the official Node SDK
// (mandatory introspection: no local decode). Consent links are minted with
// one API call, exactly as the MCP Operator Guide describes.
import { createHash } from 'node:crypto';
import { loadConfig, getConfig, validateAgentToken, ConfirmationRequiredError, VerifyRefusedError } from '@agentadmit/sdk';

let loaded = false;
export function init(configPath = process.env.AGENTADMIT_CONFIG || 'agentadmit.yaml') {
  if (!loaded) { loadConfig(configPath); loaded = true; }
  return getConfig();
}

function apiBase() {
  return (getConfig().agentadmit_api_url || 'https://api.agentadmit.com').replace(/\/$/, '');
}

/** sha256:<hex> over the exact tool arguments (minus the credential fields),
 * so a confirmation covers this payload, not just the tool name. */
export function argsDigest(args) {
  const { agentadmit_token: _t, action_attestation_id: _a, ...rest } = args;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Mint a hosted consent link for a user who has no token yet. The link is
 * the credential: hand it to the human, never to the agent alone. Presence
 * is required so a browser-driving agent cannot complete it.
 */
export async function mintConsentLink({ userId, scopes, recommended, purpose }) {
  const cfg = getConfig();
  const res = await fetch(`${apiBase()}/api/v1/apps/${cfg.app_id}/consent-sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: userId,
      allowed_scopes: scopes,
      recommended_scopes: recommended,
      duration_options: ['1h', '24h', '7d'],
      purpose,
      presence: 'required',
      expires_in: 900,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`AgentAdmit consent-session mint failed: ${res.status} ${data.error || ''}`.trim());
  return { url: data.session_url, expires_at: data.expires_at, presence_mode: data.presence_mode };
}

/**
 * Verify one tool call against the hosted service. Returns the agent context
 * on success. Throws typed outcomes the server turns into tool errors:
 *   ConfirmationRequiredError  → hand the human the confirmation link
 *   VerifyRefusedError         → insufficient_scope / bound_exceeded /
 *                                confirmation_declined / …
 *   Error('Token is not active: …') → revoked / expired / unknown token
 */
export async function verifyToolCall({ token, tool, scope, args, summary, attestationId }) {
  return validateAgentToken(token, {
    scope_used: scope,
    method: 'TOOL',
    endpoint: `/tools/${tool}`,
    request_digest: argsDigest(args),
    action_summary: summary,
    ...(attestationId ? { action_attestation_id: attestationId } : {}),
  });
}

/**
 * The hosted consent page hands the human a ONE-TIME connection token
 * (ag_ct_…). Exchanging it for the access token (ag_at_…) is the server's
 * job, not the human's: POST /api/v1/exchange with no API key (the
 * connection token is the credential). Single use — the access token that
 * comes back is what the agent presents from then on.
 */
export async function exchangeConnectionToken(connectionToken, { agentLabel = 'Coding agent (demo)' } = {}) {
  const res = await fetch(`${apiBase()}/api/v1/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: connectionToken, agent_label: agentLabel }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`exchange_failed: ${data.error || res.status}`);
  return { accessToken: data.access_token, connectionId: data.connection_id, scopes: data.scopes, expiresAt: data.expires_at };
}

export { ConfirmationRequiredError, VerifyRefusedError };
