// Scheme safety for URLs that come back from a server (or any other
// untrusted source) before the browser navigates to or embeds them:
// window.location assignments, <a href> targets, <iframe> sources. Without
// this check a javascript:/data:/vbscript: payload would run attacker script
// in the dashboard origin, and file:/relative strings are never valid
// targets here either.
//
// Deliberately separate from checkOutboundUrlSafety (src/lib/url-safety.ts):
// that helper guards the dashboard's own SERVER-side fetches against SSRF,
// so it refuses loopback/private/reserved hosts. A navigation target is
// resolved by the user's own browser, where localhost/LAN/self-hosted box
// addresses are legitimate — the only requirement here is a parseable
// absolute http(s) URL with a real host.

/**
 * True when `url` is a string the browser may safely navigate to or embed:
 * an absolute http(s) URL with a non-empty host. Query strings and fragments
 * are fine (handoff URLs carry signed params); schemes that execute script
 * or reference local resources are not.
 */
export function isSafeHttpNavigationUrl(url: unknown): url is string {
  if (typeof url !== "string" || !url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Stricter check for a stored "connection address" — the bare box root we
 * show users, link to, and derive API endpoints from. On top of the
 * navigation rules it refuses surrounding whitespace, embedded credentials,
 * query and fragment, none of which belong on a root address.
 */
export function hasSafeHttpAccessUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

/**
 * An authorization or sign-in address a box or the agent runtime returned.
 * The owner opens it in a new tab or follows a link to it, so only an https
 * address is usable. Anything else (javascript:, data:, plain http, text that
 * is not a URL) reads as no address and returns "".
 */
export function readHttpsAuthorizationUrl(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  try {
    return new URL(value).protocol === "https:" ? value : "";
  } catch {
    return "";
  }
}
