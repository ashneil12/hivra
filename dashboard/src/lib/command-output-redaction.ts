// SCRIPTURE_ANCHOR: secret-watch | Proverbs 4:23 | Verse: Keep your heart with all diligence, for out of it is the wellspring of life.

const JSON_SECRET_PATTERN =
  /("?(?:access_token|accessToken|refresh_token|refreshToken|id_token|idToken|client_secret|clientSecret|api_key|api-key|apiKey|auth_key|authKey|session_token|sessionToken|authorization_code|authorizationCode|partner_key|partnerKey|x_partner_key|xPartnerKey|password|secret|token)"?\s*:\s*")([^"]+)(")/gi;
const JSON_SINGLE_QUOTE_SECRET_PATTERN =
  /("?(?:access_token|accessToken|refresh_token|refreshToken|id_token|idToken|client_secret|clientSecret|api_key|api-key|apiKey|auth_key|authKey|session_token|sessionToken|authorization_code|authorizationCode|partner_key|partnerKey|x_partner_key|xPartnerKey|password|secret|token)"?\s*:\s*')([^']+)(')/gi;
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
// Unquoted `name: value` lines, the form agent CLI configs are written in. Only a key
// that starts its own line counts (after indentation or a list dash), so prose such as
// "Auth token: missing" is left alone. Quoted values are covered by the JSON patterns
// above, and a value that is already [REDACTED] is skipped. `_key` is not a YAML
// secret word here: sort_key and primary_key are ordinary schema names.
const YAML_SECRET_WORDS =
  "access_token|accessToken|refresh_token|refreshToken|id_token|idToken|client_secret|clientSecret|api_key|api-key|apiKey|auth_key|authKey|session_token|sessionToken|authorization_code|authorizationCode|partner_key|partnerKey|x_partner_key|xPartnerKey|password|secret|token";
const YAML_SECRET_PATTERN = new RegExp(
  `^([ \\t]*(?:-[ \\t]+)?)([A-Za-z0-9_-]*(?:${YAML_SECRET_WORDS}))([ \\t]*:[ \\t]*)(?!["'\\[{|>])[^\\s"'\`,}\\]]+`,
  "gim",
);
const PUBLIC_KEY_NAME_PATTERN = /(?:^|_)public_?key$/i;
const QUERY_PARAM_SECRET_PATTERN =
  /([?&](?:key|api_key|access_token|refresh_token|client_secret|session_token|authorization_code|token)=)([^&#\s]+)/gi;
const BEARER_SECRET_PATTERN = /(\bBearer\s+)([A-Za-z0-9._-]+)/gi;
// A hex value of 64 or more characters straight after a token-like word (`token: <hex>`,
// `agent key <hex>`). A bare hex digest is not matched: sha256 digests are ordinary output
// and ops fingerprints are hex. The separator is one alternation, not two optional runs, so
// a long whitespace run after a token word is scanned once (linear, not quadratic).
const HEX_AFTER_SECRET_WORD_PATTERN = /((?:token|secret|password|key)(?:[ \t]*[:=][ \t]*|[ \t]+)?["']?)[0-9a-f]{64,}/gi;
// Bare token shapes: a provider, bot, cloud or infrastructure credential that
// appears with no name in front of it (for example an error body that echoes the
// key). The redactor masks every match, and the config snapshot scanner
// (services/config-snapshot.ts) tests the same list, so the two sinks cannot drift.
// The patterns carry no `g` flag: callers that replace build a global copy, and
// callers that only test use the pattern as it is.
//
// Most shapes start at a token boundary, so `task-` and `risk-` do not match `sk-`, and
// `%20` counts as a boundary, so a key inside a URL query is still found. The legacy
// shapes (sk-, gh*_, AKIA) are written as plain patterns with no leading boundary, as the
// snapshot scanner always matched them: a key glued onto a word (`notes keysk-ant-...`)
// is still masked and still blocks a push. Over-matching in the redactor is fail-closed.
// `blocksPush: false` keeps a shape out of the snapshot push gate (it still redacts): a
// JWT is how documentation shows a sample token, and a skill that quotes one must not stop
// every snapshot that carries it.
// Managed-Venice keys (hven_live_* / hven_test_*) bill a user's wallet; Bankr keys
// (bk_usr_*, bk_ptr_*, bk_agent_*, bk_scoped_*) move money; reporter credentials
// (hvra_otlp_v1.<claims>.<signature>) ride the launch handoff into hosts and guests.
export interface SecretTokenShape {
  kind: string;
  pattern: RegExp;
  blocksPush?: false;
}

const TOKEN_START = "(?:(?<![A-Za-z0-9])|(?<=%[0-9A-Fa-f]{2}))";
// A JWT starts only where no token character precedes it, dash and underscore included. With
// TOKEN_START a `-` counted as a boundary, so every `eyJ` in a dash-joined run started a match
// that scanned to the end of the run before failing on the missing `.eyJ`: quadratic on
// `eyJ-eyJ-...`. A JWT glued directly after `-` or `_` is then not matched (redaction only).
const JWT_START = "(?:(?<![A-Za-z0-9_-])|(?<=%[0-9A-Fa-f]{2}))";
export const SECRET_TOKEN_SHAPES: ReadonlyArray<SecretTokenShape> = [
  { kind: "private_key_block", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/ },
  { kind: "openai_key", pattern: /sk-[A-Za-z0-9_-]{32,}/ },
  { kind: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]{32,}/ },
  { kind: "github_pat", pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { kind: "github_pat", pattern: new RegExp(`${TOKEN_START}github_pat_[A-Za-z0-9_]{22,}`) },
  { kind: "gitlab_pat", pattern: new RegExp(`${TOKEN_START}glpat-[A-Za-z0-9_-]{20,}`) },
  // xAI keys are `xai-` plus alphanumerics. Hyphens are left out so prose such as
  // `xai-grok-helper-for-everything` is not a key.
  { kind: "xai_key", pattern: new RegExp(`${TOKEN_START}xai-[A-Za-z0-9]{40,}`) },
  { kind: "groq_key", pattern: new RegExp(`${TOKEN_START}gsk_[A-Za-z0-9]{20,}`) },
  { kind: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/ },
  // Temporary (session) AWS key IDs. looksSecret in the OTLP normaliser already treats ASIA as secret.
  { kind: "aws_session_key", pattern: /ASIA[0-9A-Z]{16}/ },
  { kind: "google_api_key", pattern: new RegExp(`${TOKEN_START}AIza[0-9A-Za-z_-]{35}`) },
  // Telegram bot token: `<bot id>:<35-char secret>`. Also matches inside a bot API URL.
  { kind: "telegram_bot_token", pattern: /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/ },
  { kind: "slack_token", pattern: new RegExp(`${TOKEN_START}xox[abposr]-[A-Za-z0-9-]{10,}`) },
  { kind: "stripe_key", pattern: new RegExp(`${TOKEN_START}[rs]k_(?:live|test)_[A-Za-z0-9]{10,}`) },
  { kind: "jwt", pattern: new RegExp(`${JWT_START}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]*`), blocksPush: false },
  { kind: "managed_venice_key", pattern: new RegExp(`${TOKEN_START}hven_(?:live|test)_[A-Za-z0-9_-]+`, "i") },
  // Bankr keys carry one of the issued prefixes. The push gate blocks on those only: a bare
  // `bk_` shape would stop every config snapshot that installs a documentation placeholder
  // such as `bk_YOUR_API_KEY` from the shipped skill catalogue. The redactor also masks any
  // other `bk_` token, as it always has.
  { kind: "bankr_key", pattern: new RegExp(`${TOKEN_START}bk_(?:usr|ptr|agent|scoped)_[A-Za-z0-9_-]{8,}`) },
  { kind: "bankr_key_any", pattern: new RegExp(`${TOKEN_START}bk_[A-Za-z0-9][A-Za-z0-9_-]{9,}`), blocksPush: false },
  { kind: "activity_collector_token", pattern: /hvra_otlp_v1\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/i },
  { kind: "agent_link_key", pattern: new RegExp(`${TOKEN_START}hvl_[0-9a-f]{64}(?![0-9a-f])`) },
  { kind: "tailscale_key", pattern: new RegExp(`${TOKEN_START}tskey-(?:auth|api|client)-[A-Za-z0-9_-]+`, "i") },
];
const SECRET_TOKEN_SHAPE_GLOBAL_PATTERNS = SECRET_TOKEN_SHAPES.map(
  ({ pattern }) => new RegExp(pattern.source, `${pattern.flags}g`),
);

const GENERIC_SECRET_LIKE_PATTERN =
  /\b(sk-(?:live|test|proj)-[A-Za-z0-9_-]+|(?:[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-secret(?:-[A-Za-z0-9]+)*|secret(?:-[A-Za-z0-9]+)+))\b/gi;

export function redactSensitiveCommandOutput(raw: string, maxLength = 300): string {
  const redacted = raw
    .replace(JSON_SECRET_PATTERN, '$1[REDACTED]$3')
    .replace(JSON_SINGLE_QUOTE_SECRET_PATTERN, '$1[REDACTED]$3')
    .replace(ASSIGNMENT_SECRET_PATTERN, (match, name: string) =>
      PUBLIC_KEY_NAME_PATTERN.test(name) ? match : `${name}=[REDACTED]`,
    )
    .replace(YAML_SECRET_PATTERN, (match, lead: string, name: string, sep: string) =>
      PUBLIC_KEY_NAME_PATTERN.test(name) ? match : `${lead}${name}${sep}[REDACTED]`,
    )
    .replace(HEX_AFTER_SECRET_WORD_PATTERN, '$1[REDACTED]')
    .replace(QUERY_PARAM_SECRET_PATTERN, '$1[REDACTED]')
    .replace(BEARER_SECRET_PATTERN, '$1[REDACTED]');

  const shaped = SECRET_TOKEN_SHAPE_GLOBAL_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, '[REDACTED]'),
    redacted,
  );
  const generic = shaped.replace(GENERIC_SECRET_LIKE_PATTERN, '[REDACTED]');

  return generic.length > maxLength ? generic.slice(0, maxLength) : generic;
}
