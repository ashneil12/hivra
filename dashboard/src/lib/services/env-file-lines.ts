/**
 * Canonical serializer for `KEY=value` lines in the env files this dashboard
 * generates for customer boxes.
 *
 * Why this exists: the same `.env` file is consumed by readers with very
 * different expansion semantics —
 *
 *   1. bash, via `set -a; . .env; set +a` in the profile-gateway launch script
 *      and the gateway supervisor (every restart). An UNQUOTED value is shell
 *      input: `$(...)`, backticks and `${VAR}` are evaluated when the file is
 *      sourced. That is a remote-command-execution sink for any byte a user
 *      can land in stored config (a custom LLM base URL, an API key, a bot
 *      name) — and the sourcing scripts run as root.
 *   2. python-dotenv, which the in-container agent uses to load the same file.
 *   3. Docker Compose `env_file:` parsing.
 *   4. line-oriented copy/merge machinery (awk/sed) that treats lines opaquely.
 *
 * The only quoting form all three parsers agree on is single quotes: fully
 * literal in bash, stripped (never interpolated) by python-dotenv, stripped by
 * compose-go. So values that fit a conservative safe charset are emitted
 * unquoted — byte-identical to historical output for every platform-generated
 * token, hex key, URL and model name — and everything else is single-quoted.
 *
 * Two shapes cannot round-trip through single quotes:
 *
 *   - Apostrophes. bash needs the `'it'\''s'` concatenation idiom, which
 *     python-dotenv cannot parse at all. A value whose ONLY exotic character
 *     is the apostrophe (typical for a user-supplied display name) is emitted
 *     double-quoted instead — safe in bash only because such a value carries
 *     none of `"`/`$`/backtick/backslash, the characters bash still expands
 *     inside double quotes.
 *   - Values ending in a backslash. python-dotenv mis-parses a trailing
 *     backslash inside single quotes badly enough to swallow the REST OF THE
 *     FILE (verified behavior: subsequent keys vanish), and unquoted a
 *     trailing backslash is a line continuation in bash. There is no faithful
 *     cross-reader encoding, so these are refused.
 *
 * Values that fit neither form are refused (throw). That is a deliberate
 * fail-closed choice: the shapes in question (an apostrophe combined with
 * `$`/backtick/quote/backslash, or a trailing backslash) are already corrupt
 * or hazardous under the historical unquoted format, so no legitimate
 * deployment depends on them, and silently mangling a credential would be
 * worse than a loud provisioning error.
 *
 * Line-break and NUL bytes are stripped before quoting (the SEC-04 contract):
 * they can never be represented in this format at all, and letting one
 * through would split the line into a second, attacker-controlled assignment.
 */

// Characters that are literal in an unquoted bash assignment AND carry no
// special meaning in any dotenv reader. Deliberately conservative: `?`/`*`/`[`
// (glob), `#` (dotenv inline comment), `~` (bash tilde expansion), whitespace,
// quotes and shell metacharacters all force quoting even though a few of them
// are technically survivable in one reader or another. Quoting is always
// correct, so the conservative set costs nothing.
const SAFE_UNQUOTED_VALUE = /^[A-Za-z0-9_@%+=:,./-]*$/;

// Characters bash still expands inside double quotes. A value carrying none of
// them is fully literal in a double-quoted bash string — and with no backslash
// present there is nothing for python-dotenv's double-quote escape processing
// to rewrite either.
const DOUBLE_QUOTE_FORBIDDEN = /["$`\\]/;

const ENV_KEY_LINE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function stripLineBreaks(value: string): string {
  return String(value).replace(/[\r\n\0]/g, "");
}

/**
 * Serialize one env VALUE for a file that may be bash-sourced.
 * Returns the value exactly as it should appear after `KEY=` — including any
 * quoting. Throws when no faithful cross-reader encoding exists.
 */
export function serializeEnvValue(rawValue: string, keyForError?: string): string {
  const value = stripLineBreaks(rawValue);
  const key = keyForError ?? "env value";

  if (SAFE_UNQUOTED_VALUE.test(value)) {
    return value;
  }

  if (!value.includes("'") && !value.endsWith("\\")) {
    // Fully literal in bash; python-dotenv and compose strip the quotes.
    return `'${value}'`;
  }

  if (!DOUBLE_QUOTE_FORBIDDEN.test(value)) {
    // Only reachable when the value contains an apostrophe (otherwise the
    // single-quote branch above already won, except for trailing backslashes —
    // and those contain a backslash, so they can never reach this branch).
    // With none of `"`/`$`/backtick/backslash present, a double-quoted string
    // is fully literal in bash and carries no escapable bytes for the dotenv
    // readers.
    return `"${value}"`;
  }

  throw new Error(
    `Refusing to write ${key}: no shell-safe dotenv encoding exists for a value ` +
      `combining an apostrophe with double quotes, '$', backticks or backslashes ` +
      `(or ending in a backslash). Remove those characters.`
  );
}

/**
 * Re-serialize one assembled `KEY=value` line so the value part is safe for
 * bash-sourced env files. Lines that are not KEY=value assignments (comments,
 * blanks) pass through verbatim. Line breaks/NULs are stripped from the whole
 * line first, preserving the SEC-04 single-line invariant.
 */
export function serializeEnvAssignmentLine(line: string): string {
  const clean = stripLineBreaks(line);
  if (!ENV_KEY_LINE.test(clean)) {
    return clean;
  }
  const separatorIndex = clean.indexOf("=");
  const key = clean.slice(0, separatorIndex);
  const value = clean.slice(separatorIndex + 1);
  return `${key}=${serializeEnvValue(value, key)}`;
}
