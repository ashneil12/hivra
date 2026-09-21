/**
 * PostHog analytics proxy — Cloudflare Worker.
 *
 * Off-loads the PostHog reverse-proxy (events `/i/v0/e/`, session replay `/s/`,
 * feature flags `/decide/`, and the recorder/array JS bundles `/static/*`) from
 * Vercel onto Cloudflare. Previously the dashboard proxied all PostHog traffic
 * through a Next.js rewrite (`/p/*` -> us.i.posthog.com), so every event and
 * every session-replay chunk for every visitor ran a billable Vercel function
 * and counted toward Fast Origin Transfer. Routing it through this Worker keeps
 * the same first-party origin (so ad-blockers can't trivially drop analytics)
 * while removing that traffic from the Vercel bill entirely — CF egress is the
 * cheap case. See docs/PRODUCT-ARCHITECTURE.md.
 *
 * This is a dumb, stateless reverse proxy: no secrets, no auth, no wallet logic.
 * The PostHog project token is public (client-side), so there is nothing
 * sensitive to hold. The client points `api_host` at this Worker's hostname;
 * the Worker forwards `/static/*` to the asset host and everything else to the
 * ingestion host, preserving method, body, query string, and headers.
 */

export interface Env {
  /** PostHog ingestion host (no scheme). US cloud default. */
  POSTHOG_API_HOST: string;
  /** PostHog static-asset host (no scheme). US cloud default. */
  POSTHOG_ASSET_HOST: string;
}

const DEFAULT_API_HOST = "us.i.posthog.com";
const DEFAULT_ASSET_HOST = "us-assets.i.posthog.com";

/**
 * Forward a request to `host`, preserving method/body/query and rewriting the
 * Host header so PostHog routes it correctly. The inbound `cookie` header is
 * stripped — PostHog identifies via the request body/query, never our
 * first-party cookies, and forwarding them would needlessly leak session
 * cookies to a third party (and defeat any edge caching).
 */
async function forward(request: Request, host: string, pathWithSearch: string): Promise<Response> {
  const upstream = new Request(`https://${host}${pathWithSearch}`, request);
  upstream.headers.set("host", host);
  upstream.headers.delete("cookie");
  return fetch(upstream);
}

/**
 * Static assets (`/static/array.js`, the session-recorder bundle, etc.) are
 * immutable per build hash, so cache them at the CF edge: the recorder bundle
 * is ~100 KB and would otherwise be re-fetched from PostHog for every new
 * visitor.
 */
async function retrieveStatic(
  request: Request,
  assetHost: string,
  pathWithSearch: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const cache = caches.default;
  let response = await cache.match(request);
  if (!response) {
    response = await forward(request, assetHost, pathWithSearch);
    if (response.ok) {
      ctx.waitUntil(cache.put(request, response.clone()));
    }
  }
  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const apiHost = env.POSTHOG_API_HOST || DEFAULT_API_HOST;
    const assetHost = env.POSTHOG_ASSET_HOST || DEFAULT_ASSET_HOST;

    const url = new URL(request.url);
    const pathWithSearch = url.pathname + url.search;

    if (url.pathname.startsWith("/static/")) {
      return retrieveStatic(request, assetHost, pathWithSearch, ctx);
    }
    return forward(request, apiHost, pathWithSearch);
  },
};
