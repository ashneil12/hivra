// SCRIPTURE_ANCHOR: secret-watch | Proverbs 4:23 | Verse: Keep your heart with all diligence, for out of it is the wellspring of life.

const JSON_SECRET_PATTERN =
  /("?(?:access_token|accessToken|refresh_token|refreshToken|id_token|idToken|client_secret|clientSecret|api_key|apiKey|auth_key|authKey|session_token|sessionToken|authorization_code|authorizationCode|partner_key|partnerKey|x_partner_key|xPartnerKey|password|secret|token)"?\s*:\s*")([^"]+)(")/gi;
const JSON_SINGLE_QUOTE_SECRET_PATTERN =
  /("?(?:access_token|accessToken|refresh_token|refreshToken|id_token|idToken|client_secret|clientSecret|api_key|apiKey|auth_key|authKey|session_token|sessionToken|authorization_code|authorizationCode|partner_key|partnerKey|x_partner_key|xPartnerKey|password|secret|token)"?\s*:\s*')([^']+)(')/gi;
// Secret words that make a `NAME=value` assignment a secret. A name counts when
// it ENDS in one of them, so `OPENAI_API_KEY=`, `GITHUB_TOKEN=` and
// `BANKR_USER_KEY=` are caught as well as a bare `token=`. The old pattern began
// at a word boundary, and there is no boundary between an underscore and a
// letter, so it missed every environment-style name. `_key` is here for names
// such as API_SERVER_KEY that carry no other secret word; a name ending in
// `public_key` is skipped in the replacer below.
const ASSIGNMENT_SECRET_WORDS =
  "access_token|accessToken|refresh_token|refreshToken|id_token|idToken|client_secret|clientSecret|api_key|apiKey|auth_key|authKey|session_token|sessionToken|authorization_code|authorizationCode|partner_key|partnerKey|x_partner_key|xPartnerKey|password|secret|token|_key";
const ASSIGNMENT_SECRET_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_])([A-Za-z0-9_]*(?:${ASSIGNMENT_SECRET_WORDS}))=([^\\s"'\`]+)`,
  "gi",
);
const PUBLIC_KEY_NAME_PATTERN = /(?:^|_)public_?key$/i;
const QUERY_PARAM_SECRET_PATTERN =
  /([?&](?:key|api_key|access_token|refresh_token|client_secret|session_token|authorization_code|token)=)([^&#\s]+)/gi;
const BEARER_SECRET_PATTERN = /(\bBearer\s+)([A-Za-z0-9._-]+)/gi;
const TAILSCALE_AUTH_KEY_PATTERN = /\btskey-auth-[A-Za-z0-9_-]+\b/gi;
// Managed-Venice proxy keys (hven_live_* / hven_test_*) bill the user's wallet — redact
// the value wherever it appears, since they ride the provisioner env into command output.
const MANAGED_VENICE_KEY_PATTERN = /\bhven_(?:live|test)_[A-Za-z0-9_-]+\b/gi;
// Bankr keys (bk_usr_*, bk_ptr_*, bk_agent_*) move money for a user's wallet. The
// key is redacted on its own as well as inside an assignment, because it can
// appear in command output with no name in front of it.
const BANKR_KEY_PATTERN = /\bbk_[A-Za-z0-9][A-Za-z0-9_-]{9,}/g;
// Agent-run reporter credentials (hvra_otlp_v1.<claims>.<signature>) ride the
// launch/start handoff into Proxmox hosts and guests; never echo one.
const ACTIVITY_COLLECTOR_TOKEN_PATTERN = /hvra_otlp_v1\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/gi;
const GENERIC_SECRET_LIKE_PATTERN =
  /\b(sk-(?:live|test|proj)-[A-Za-z0-9_-]+|(?:[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-secret(?:-[A-Za-z0-9]+)*|secret(?:-[A-Za-z0-9]+)+))\b/gi;

export function redactSensitiveCommandOutput(raw: string, maxLength = 300): string {
  const redacted = raw
    .replace(JSON_SECRET_PATTERN, '$1[REDACTED]$3')
    .replace(JSON_SINGLE_QUOTE_SECRET_PATTERN, '$1[REDACTED]$3')
    .replace(ASSIGNMENT_SECRET_PATTERN, (match, name: string) =>
      PUBLIC_KEY_NAME_PATTERN.test(name) ? match : `${name}=[REDACTED]`,
    )
    .replace(QUERY_PARAM_SECRET_PATTERN, '$1[REDACTED]')
    .replace(BEARER_SECRET_PATTERN, '$1[REDACTED]')
    .replace(TAILSCALE_AUTH_KEY_PATTERN, '[REDACTED]')
    .replace(MANAGED_VENICE_KEY_PATTERN, '[REDACTED]')
    .replace(BANKR_KEY_PATTERN, '[REDACTED]')
    .replace(ACTIVITY_COLLECTOR_TOKEN_PATTERN, '[REDACTED]')
    .replace(GENERIC_SECRET_LIKE_PATTERN, '[REDACTED]');

  return redacted.length > maxLength ? redacted.slice(0, maxLength) : redacted;
}
