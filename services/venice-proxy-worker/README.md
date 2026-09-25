# venice-proxy-worker (CANARY)

Off-loads the managed-Venice **chat streaming** byte-pump from Vercel Fluid
functions onto Cloudflare Workers. All wallet/billing logic stays on Vercel via
two short calls (`/api/managed-venice/internal/authorize` + `/settle`). Only
`POST /v1/chat/completions` is intercepted; every other `/v1/*` path is
transparently reverse-proxied back to Vercel.

See `../../docs/PRODUCT-ARCHITECTURE.md` for the why and the full design.

## Architecture

```
box → Worker /v1/chat/completions
        1. POST {VERCEL_BASE_URL}/api/managed-venice/internal/authorize
             {plaintextKey, body, acceptsBodyPatch: true}
               →  {referenceId, upstreamKey, upstreamUrl, walletType, userId, proxyKeyId, model, bodyPatch}
        2. fetch(api.venice.ai, Bearer upstreamKey) with {...body, ...bodyPatch}   ← Worker holds this stream
        3. tee → client gets tokens; sniff branch extracts usage
        4. POST {VERCEL_BASE_URL}/api/managed-venice/internal/settle
             {outcome:"settle", referenceId, usage, ...}   (or {outcome:"release"} on upstream failure)

box → Worker /v1/embeddings (and all other /v1/*)  →  reverse-proxied to Vercel verbatim
```

Output cap (`bodyPatch`): the wallet hold covers the request only as patched.
When a wallet cannot cover the model's maximum output, authorize lowers
`max_completion_tokens` / `max_tokens` to what it can cover, and the Worker must
forward that. While Vercel prices from the static catalog (the live Venice
pricing refresh is down), the model maximum is not confirmed by Venice, so the
held cap is written even when the wallet covers it. A Worker that does not send
`acceptsBodyPatch: true` (an older deploy) is never given a patch: its requests
hold the full worst case (the model's context window when the maximum is the
catalog's) or get a 402.

Auth/error relay rules:
- authorize `403` → Worker misconfig (wrong shared secret) → Worker returns `502` (does NOT blame the box's key).
- authorize `401/402/400/503` → relayed to the box verbatim (bad key / no balance / bad model / not configured).
- Worker never holds Venice keys at rest — `authorize` returns the pool-selected key per request.

## Local verification

Use Node.js 22 or newer. From this directory in a full repository checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
WRANGLER_SEND_METRICS=false npm run build
npm test
```

`build` is a local Wrangler dry run; it does not upload or deploy. Tests execute
the built bundle in workerd with dummy keys and intercepted outbound requests.
They cover configuration failure, authorization errors, reverse-proxy redirects,
JSON/SSE responses and the exact settle/release request identity. They do not
contact Venice, spend credits, change real reservations or prove live billing
reconciliation. Build before testing so the bundle matches current source. The
shared harness lives in `scripts/release/` in the repository root.

The toolchain and transitive packages are locked. Miniflare is pinned to the
same version used by Wrangler, including its upstream prerelease suffix; it is
test tooling, not a deployed dependency. CI requires no Cloudflare credentials
and never runs a remote deploy. Keep `.dev.vars*` and generated artifacts private.

## Deploy

Requires a **Workers-scoped** Cloudflare API token (Account → Workers Scripts:Edit,
+ Account Settings:Read). The DNS/zone token used by `reconcile-cloudflare-dns`
is NOT sufficient.

```bash
cd services/venice-proxy-worker
npm ci --ignore-scripts --no-audit --no-fund

# 1. Set the canary control-plane origin (no trailing slash) in wrangler.toml:
#    VERCEL_BASE_URL = "https://<canary-control-plane-origin>"

# 2. Deploy
export CLOUDFLARE_API_TOKEN=<workers-scoped-token>
npx wrangler deploy

# 3. Set the shared secret (must equal Vercel canary env MANAGED_VENICE_INTERNAL_SECRET)
npx wrangler secret put MANAGED_VENICE_INTERNAL_SECRET
```

Deploy prints the worker URL, e.g. `https://venice-proxy-canary.<subdomain>.workers.dev`.

## Vercel side (canary project)

Set one env var on the canary Vercel project (and redeploy):

```
MANAGED_VENICE_INTERNAL_SECRET = <same value as the worker secret>
```

## Cut over a single disposable canary box

Point the box's managed-Venice base URL at the worker `/v1` and restart the agent:

```
# in the box's /opt/data/.env (or wherever the managed-Venice base is set)
HERMES_...VENICE_BASE_URL = https://venice-proxy-canary.<subdomain>.workers.dev/v1
```

Validate a real chat:
- tokens stream back through the worker,
- `llm_usage_events` gains exactly one row for the request,
- the reservation settles (no orphaned hold),
- forcing a Venice error releases the reservation and relays the error (key stays live).

Roll back instantly by restoring the base URL to
`https://<canary-control-plane-origin>/api/managed-venice/v1`.
