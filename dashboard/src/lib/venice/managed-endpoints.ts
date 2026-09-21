// Live dashboard apex. Must be the CURRENT brand domain (hivra.cloud), not the
// legacy hermesos.cloud — the apex 301-redirects to hivra, and the agent's
// OpenAI client won't follow a cross-origin POST redirect, so a stale default
// here silently kills all managed-Venice inference (see the Jun-2026 incident).
const DEFAULT_APP_URL = "https://hivra.cloud";

// Read NEXT_PUBLIC_APP_URL through a COMPUTED key, never `process.env.NEXT_PUBLIC_APP_URL`
// directly. Next inlines statically-accessed `process.env.NEXT_PUBLIC_*` at BUILD time, so
// a server-side caller would freeze to whatever value the build baked in. That is exactly
// how the hermesos→hivra cutover kept re-baking the dead legacy proxy URL into
// webui-backend boxes for days AFTER the env var was corrected: the runtime value was
// already hivra (dynamic reads got it right), but this build-inlined read stayed hermesos,
// so every webui (re)deploy stamped a 301-dead `hermesos.cloud/api/managed-venice` URL and
// the agent's OpenAI client wouldn't replay POST across the redirect. A computed-key read
// is not inlined — it resolves against the live runtime env on every call, so the proxy
// URL tracks the current apex even when the deployed build predates an env change.
// (Jun-2026 managed-Venice cliff; see also the DEFAULT_APP_URL note above.)
function runtimeAppUrl(): string | undefined {
  const key = "NEXT_PUBLIC_APP_URL";
  return process.env[key];
}

// Off-Vercel proxy override (cost reduction — docs/PRODUCT-ARCHITECTURE.md).
// When set, managed-Venice points at the Cloudflare Worker instead of the
// in-Vercel `/api/managed-venice/v1` route, off-loading the streaming byte-pump.
// The value is the worker's full base ending in `/v1` (e.g.
// `https://venice-proxy-canary.<sub>.workers.dev/v1`). Computed-key read so Next
// never build-inlines it (same reasoning as runtimeAppUrl above) — a redeploy
// or env flip must be able to flip the proxy target without rebaking the build.
function runtimeProxyWorkerUrl(): string | undefined {
  const key = "MANAGED_VENICE_PROXY_WORKER_URL";
  return process.env[key];
}

export function getManagedVeniceProxyBaseUrl(
  appUrl: string | undefined = runtimeAppUrl()
) {
  const workerUrl = runtimeProxyWorkerUrl()?.trim();
  if (workerUrl) return workerUrl.replace(/\/+$/, "");
  const base = (appUrl?.trim() || DEFAULT_APP_URL).replace(/\/+$/, "");
  return `${base}/api/managed-venice/v1`;
}

// Dashboard origin (no trailing slash) for USER-FACING managed-Venice links —
// e.g. the top-up URL embedded in 402 "insufficient balance" + spend-cap errors
// returned by the proxy. Computed-key runtime read (via runtimeAppUrl) for the
// SAME build-inline reason as getManagedVeniceProxyBaseUrl above: a 402 emitted
// by a build that predates an apex change must still link to the LIVE dashboard
// (hivra.cloud), not the legacy host (hermesos.cloud) frozen into the bundle at
// build time. The legacy apex only 301-redirects, so a stale link still
// resolves — but the canonical link must track the current origin.
export function getDashboardOrigin(
  appUrl: string | undefined = runtimeAppUrl()
): string {
  return (appUrl?.trim() || DEFAULT_APP_URL).replace(/\/+$/, "");
}
