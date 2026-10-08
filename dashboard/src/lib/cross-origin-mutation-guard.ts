import { isSameOriginRequest } from "@/lib/self-host/request-origin";

/**
 * Refuses state-changing API requests that a browser sent from another origin.
 *
 * The Clerk session cookie is SameSite=Lax. Lax only stops CROSS-SITE requests;
 * it does nothing for another origin on the same registrable domain. Canary
 * (canary.hermesos.cloud) shares hermesos.cloud with the agent boxes
 * (box-*.hermesos.cloud), which run user- and model-controlled content. A page
 * there can POST to the dashboard with the victim's session cookie, and most
 * route handlers parse `request.json()` whatever the Content-Type, so a
 * `text/plain` "simple" request needs no CORS preflight.
 *
 * The browser tells us where a request came from:
 *   - `Sec-Fetch-Site` (Chrome 76+, Firefox 90+, Safari 16.4+) cannot be set by
 *     page script. Only `same-origin` and `none` (the user acting directly in
 *     the browser, never a page) are accepted.
 *   - Older browsers send only `Origin` on a non-GET request; it must be this
 *     dashboard's origin. An opaque `null` Origin is refused.
 *   - A request with neither header did not come from a web page (cron,
 *     provider webhooks, box scripts, the native apps' URLSession calls), so
 *     there is no ambient browser cookie to abuse and it is left to the route's
 *     own authentication.
 *
 * Reads (GET/HEAD) and CORS preflights (OPTIONS) are not state-changing and are
 * not gated here.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

/**
 * API paths that legitimately receive state-changing requests from other
 * origins. Each one authenticates without the session cookie, so a
 * cross-origin request there cannot ride a user's session.
 */
// Provider webhooks (Stripe, Clerk, Apple) are verified by their signatures.
const EXEMPT_PREFIXES = ["/api/webhooks/"];
// The CSP report sink is public and cookie-less by design; browsers post
// violation reports to it on the document's behalf.
const EXEMPT_PATHS = new Set(["/api/csp/report"]);

export type CrossOriginMutationRefusal = {
  reason: "fetch_site" | "origin";
  secFetchSite: string | null;
  origin: string | null;
};

function isGuardedApiPath(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  if (EXEMPT_PATHS.has(pathname)) return false;
  return !EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Returns why the request must be refused, or null when it may proceed.
 * `pathname` is the request's decoded pathname (request.nextUrl.pathname).
 */
export function crossOriginMutationRefusal(
  request: Request,
  pathname: string,
): CrossOriginMutationRefusal | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  if (!isGuardedApiPath(pathname)) return null;

  const secFetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase() || null;
  const origin = request.headers.get("origin");

  if (secFetchSite) {
    return ALLOWED_FETCH_SITES.has(secFetchSite)
      ? null
      : { reason: "fetch_site", secFetchSite, origin };
  }
  if (origin === null) return null;
  return isSameOriginRequest(request) ? null : { reason: "origin", secFetchSite, origin };
}
