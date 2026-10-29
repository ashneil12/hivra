/**
 * A same-application path that a sign-in may send the browser to afterwards.
 * The value arrives in a query string anyone can craft, and it is then
 * handed to Clerk (hosted) or to window.location.assign (self-host). Only a
 * single-slash path that resolves back to the same placeholder origin is
 * accepted, and the result is the canonical pathname, query and fragment.
 *
 * Rejected: absolute and protocol-relative URLs, backslashes, whitespace and
 * control characters (literal or percent-encoded), credentials, and anything
 * that does not parse as a path. The same check runs on the page and again in
 * the self-host sign-in shim, so neither copy is a bypass for the other.
 */

const INTERNAL_PATH_BASE = "https://internal-path.invalid";

/** Long enough for any app route plus its query. */
export const MAX_INTERNAL_PATH_LENGTH = 2048;

// Backslash (browsers read it as a slash), whitespace, and C0/C1 controls.
const FORBIDDEN_PATH_CHARACTERS = /[\\\s\u0000-\u001f\u007f-\u009f]/u;

function isSafePathText(text: string): boolean {
  return text.startsWith("/") && !text.startsWith("//") && !FORBIDDEN_PATH_CHARACTERS.test(text);
}

/** The canonical path, query and fragment, or null when `value` is not a safe internal path. */
export function safeInternalPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_INTERNAL_PATH_LENGTH) return null;
  if (!isSafePathText(value)) return null;
  // A percent-encoded form of a forbidden sequence is still a forbidden target.
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!isSafePathText(decoded)) return null;
  let url: URL;
  try {
    url = new URL(value, INTERNAL_PATH_BASE);
  } catch {
    return null;
  }
  if (url.origin !== INTERNAL_PATH_BASE || url.username || url.password) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
