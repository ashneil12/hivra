# posthog-proxy-worker

Reverse-proxies PostHog through Cloudflare instead of through Vercel.

## Why

The dashboard proxies all PostHog traffic same-origin so ad-blockers can't drop
analytics (`api_host: '/p'` → Next.js rewrite → `us.i.posthog.com`). That rewrite
runs on **Vercel**, so every event (`/i/v0/e/`), every session-replay chunk
(`/s/`), every `/decide/` flag call, and every recorder bundle (`/static/*`) for
every visitor is a billable Vercel function hit + Fast Origin Transfer. Live logs
showed `/p/s` + `/p/i/v0/e` firing ~1–2×/sec all day — a top contributor to the
Fast Origin Transfer line on the bill.

Moving the proxy to a Cloudflare Worker keeps the first-party origin (ad-block
resistance intact) while taking the bytes off Vercel — Worker egress is the cheap
case. The dashboard flips to it via a single env var (`NEXT_PUBLIC_POSTHOG_API_HOST`),
so cutover and rollback are env-only, no code deploy.

This Worker is a dumb stateless reverse proxy — no secrets (the PostHog project
token is public/client-side), no auth, no wallet logic.

## Local verification

Use Node.js 22 or newer. From this directory in a full repository checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
WRANGLER_SEND_METRICS=false npm run build
npm test
```

`build` is a local Wrangler dry run; it does not upload or deploy. The tests run
the resulting bundle in workerd with dummy bindings and intercepted outbound
requests. They check routing, cookie stripping, response relay and edge caching.
No Cloudflare account or PostHog project is needed. Build before testing so the
bundle matches current source. The shared harness lives in `scripts/release/`.

The toolchain and transitive packages are locked. Miniflare is pinned to the
same version used by Wrangler, including its upstream prerelease suffix; it is
test tooling, not a deployed dependency. CI repeats these local-only checks.
Keep `.dev.vars*`, `.wrangler/`, `dist/` and credentials out of Git.

## Deploy

Needs a **Workers-scoped** Cloudflare API token (Account → Workers Scripts:Edit
+ Account Settings:Read). The DNS token used by `reconcile-cloudflare-dns` is NOT
sufficient (same gotcha as `venice-proxy-worker`).

```bash
cd services/posthog-proxy-worker
npm ci --ignore-scripts --no-audit --no-fund

export CLOUDFLARE_API_TOKEN=<workers-scoped-token>
npx wrangler deploy
# → prints https://posthog-proxy.<subdomain>.workers.dev
```

### Option A — instant (workers.dev)

Use the printed `*.workers.dev` URL directly. Fastest to validate. Slightly less
ad-block-resistant than a first-party subdomain (some lists block `workers.dev`),
but still off Vercel.

### Option B — first-party subdomain (recommended for prod)

Best ad-block resistance. Requires the `hivra.cloud` zone on this Cloudflare
account. Uncomment the `routes` block in `wrangler.toml`:

```toml
routes = [{ pattern = "ph.hivra.cloud/*", zone_name = "hivra.cloud" }]
```

Add a proxied (orange-cloud) DNS record for `ph` → the Worker (a placeholder
`AAAA ph 100::` proxied record is the usual trick to attach a Worker route), then
`npx wrangler deploy` again.

## Cut over the dashboard (env-only, reversible)

Set on the **prod** Vercel project (`hermesos`) and redeploy:

```
NEXT_PUBLIC_POSTHOG_API_HOST = https://posthog-proxy.<subdomain>.workers.dev
# or, with Option B:
NEXT_PUBLIC_POSTHOG_API_HOST = https://ph.hivra.cloud
```

`PostHogProvider.tsx` reads this and falls back to `/p` (the existing Vercel
rewrite) when unset, so:
- **before** you set it → no change, traffic still on Vercel;
- **after** you set it + redeploy → all PostHog traffic flows through CF;
- **rollback** → unset the env var + redeploy (or just remove the Worker route).

`next.config.ts` adds the host's origin to the (report-only) CSP `script-src` +
`connect-src` automatically when the env var is an absolute URL.

## Verify after cutover

1. Load `hivra.cloud` in a fresh tab, open DevTools → Network, filter by the
   Worker host. Confirm `/i/v0/e/` (events), `/static/*` (bundles), and — since
   replay stays on — `/s/` (session recording) all return `200` from the Worker.
2. In the PostHog UI, confirm live events + a new session recording arrive (so no
   analytics was silently dropped).
3. In Vercel runtime logs, confirm `/p/i/v0/e` and `/p/s` traffic has dropped to
   ~zero.

Leave the Vercel `/p/*` rewrites in `next.config.ts` in place as the rollback
fallback; remove them only once CF is proven over a few days.
