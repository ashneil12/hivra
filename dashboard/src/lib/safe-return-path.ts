/**
 * Where a detour (Stripe checkout, plan activation) may send the owner back
 * to afterwards. The value crosses a trust boundary twice: it arrives in a
 * query string anyone can craft, and it is echoed through Stripe's success
 * URL. Only a same-origin, relative dashboard path is ever accepted.
 *
 * Rejected: absolute and protocol-relative URLs, backslashes, whitespace and
 * control characters, fragments, credentials, encoded separators or dots in
 * the path, dot segments, and anything outside /dashboard.
 */

const RETURN_PATH_BASE = "https://return-path.invalid";

/** Long enough for any dashboard route plus a launch draft id. */
export const MAX_RETURN_PATH_LENGTH = 256;

/** The canonical path and query, or null when `value` is not a safe return path. */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RETURN_PATH_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (/[\\\s#]/u.test(value)) return null;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return null;
  }
  const rawPath = value.split("?", 1)[0];
  // Encoded separators and dots decode differently across routers and servers.
  if (/%(?:2e|2f|5c)/i.test(rawPath)) return null;
  if (rawPath.split("/").slice(1).some(part => part === "." || part === "..")) return null;
  let url: URL;
  try {
    url = new URL(value, RETURN_PATH_BASE);
  } catch {
    return null;
  }
  if (url.origin !== RETURN_PATH_BASE || url.username || url.password || url.hash) return null;
  if (url.pathname !== "/dashboard" && !url.pathname.startsWith("/dashboard/")) return null;
  return `${url.pathname}${url.search}`;
}

/** A safe return path with `params` set in its query. */
export function withReturnParams(path: string, params: Record<string, string>): string {
  const url = new URL(path, RETURN_PATH_BASE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

/** The query a plan change adds to the path it returns to: the plan it moved
 * to, so that page can tell whether the new plan shows yet, or "1" when the
 * plan isn't known. */
export function planReturnParams(planKey: string | null): Record<string, string> {
  return { upgraded: planKey && /^[a-z]{1,32}$/.test(planKey) ? planKey : "1" };
}
