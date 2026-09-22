// SCRIPTURE_ANCHOR: secret-watch | Proverbs 4:23 | Verse: Keep your heart with all diligence, for out of it is the wellspring of life.

const JSON_SECRET_PATTERN =
  /("?(?:access_token|accessToken|refresh_token|refreshToken|id_token|idToken|client_secret|clientSecret|api_key|apiKey|auth_key|authKey|session_token|sessionToken|authorization_code|authorizationCode|partner_key|partnerKey|x_partner_key|xPartnerKey|password|secret|token)"?\s*:\s*")([^"]+)(")/gi;
const JSON_SINGLE_QUOTE_SECRET_PATTERN =
  /("?(?:access_token|accessToken|refresh_token|refreshToken|id_token|idToken|client_secret|clientSecret|api_key|apiKey|auth_key|authKey|session_token|sessionToken|authorization_code|authorizationCode|partner_key|partnerKey|x_partner_key|xPartnerKey|password|secret|token)"?\s*:\s*')([^']+)(')/gi;
const ASSIGNMENT_SECRET_PATTERN =
  /\b((?:access_token|accessToken|refresh_token|refreshToken|id_token|idToken|client_secret|clientSecret|api_key|apiKey|auth_key|authKey|session_token|sessionToken|authorization_code|authorizationCode|partner_key|partnerKey|x_partner_key|xPartnerKey|password|secret|token))=([^\s"'`]+)/gi;
const QUERY_PARAM_SECRET_PATTERN =
  /([?&](?:key|api_key|access_token|refresh_token|client_secret|session_token|authorization_code|token)=)([^&#\s]+)/gi;
const BEARER_SECRET_PATTERN = /(\bBearer\s+)([A-Za-z0-9._-]+)/gi;
const TAILSCALE_AUTH_KEY_PATTERN = /\btskey-auth-[A-Za-z0-9_-]+\b/gi;
// Managed-Venice proxy keys (hven_live_* / hven_test_*) bill the user's wallet — redact
// the value wherever it appears, since they ride the provisioner env into command output.
const MANAGED_VENICE_KEY_PATTERN = /\bhven_(?:live|test)_[A-Za-z0-9_-]+\b/gi;
// Agent-run reporter credentials (hvra_otlp_v1.<claims>.<signature>) ride the
// launch/start handoff into Proxmox hosts and guests; never echo one.
const ACTIVITY_COLLECTOR_TOKEN_PATTERN = /hvra_otlp_v1\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/gi;
const GENERIC_SECRET_LIKE_PATTERN =
  /\b(sk-(?:live|test|proj)-[A-Za-z0-9_-]+|(?:[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-secret(?:-[A-Za-z0-9]+)*|secret(?:-[A-Za-z0-9]+)+))\b/gi;

export function redactSensitiveCommandOutput(raw: string, maxLength = 300): string {
  const redacted = raw
    .replace(JSON_SECRET_PATTERN, '$1[REDACTED]$3')
    .replace(JSON_SINGLE_QUOTE_SECRET_PATTERN, '$1[REDACTED]$3')
    .replace(ASSIGNMENT_SECRET_PATTERN, '$1=[REDACTED]')
    .replace(QUERY_PARAM_SECRET_PATTERN, '$1[REDACTED]')
    .replace(BEARER_SECRET_PATTERN, '$1[REDACTED]')
    .replace(TAILSCALE_AUTH_KEY_PATTERN, '[REDACTED]')
    .replace(MANAGED_VENICE_KEY_PATTERN, '[REDACTED]')
    .replace(ACTIVITY_COLLECTOR_TOKEN_PATTERN, '[REDACTED]')
    .replace(GENERIC_SECRET_LIKE_PATTERN, '[REDACTED]');

  return redacted.length > maxLength ? redacted.slice(0, maxLength) : redacted;
}
