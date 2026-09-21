# Hivra Dashboard

Next.js control plane for the current Hivra platform. It provisions and operates Hermes instances and the newer Hivra agent-box lane while the repository migrates toward the canonical agent-computer architecture.

Target behavior and current behavior are intentionally distinguished. Start with:

- [`../VISION.md`](../VISION.md)
- [`../docs/PRODUCT-ARCHITECTURE.md`](../docs/PRODUCT-ARCHITECTURE.md)
- [`../docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md`](../docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md)
- [`../ROADMAP.md`](../ROADMAP.md)

## What It Includes

- Clerk-authenticated dashboard UI for provisioning and instance or agent management
- Supabase-backed persistence for instances, profiles, vault keys, and analytics
- Stripe billing flows for plan checkout and usage-aware limits
- Hetzner and Proxmox provisioning and host orchestration for managed agent instances
- Chat/profile tooling for provider selection, model routing, and runtime settings

## Local Development

Use Node.js 22.22 or newer in the Node 22 LTS line (the locked dependency tree
requires at least 22.22), with npm 10 or newer. CI uses Node 22; the security
update was verified locally on Node 22.23.1. Install the committed dependency
versions and start the app:

```bash
npm ci
npm run dev
```

For a new independent installation, see
[`Operator-owned encryption keys`](../docs/self-host/OPERATOR-KEYS.md) for the
safe key-generation step. It does not replace the remaining authentication,
database, and operator-service setup. Existing installations must retain their
original encryption keys; this command is not a rotation or recovery shortcut.

## Local Auth Notes

Clerk live keys (`pk_live_` / `sk_live_`) will not work on `http://localhost:3000`. Clerk blocks that origin by design.

Use one of these two paths:

- Normal local development: keep Clerk development keys in `.env.local` (`pk_test_...` / `sk_test_...`).
- Live-key debugging only: add `127.0.0.1 local.hermesos.cloud` to `/etc/hosts`, then run `sudo npm run dev:live-auth` and open `https://local.hermesos.cloud`.

The dashboard now detects the invalid live-key-on-localhost setup and shows this guidance instead of leaving the Clerk widget stuck half-loaded.

Useful checks:

```bash
npm test -- --runInBand
npm run lint
npm run build
```

The typecheck command gives the installed TypeScript compiler an explicit 4 GiB
old-space budget. Clean checks of the full source/test tree exceeded the Linux
CI runtime's automatic 2 GiB limit; this keeps the same no-emit checks enabled.
Total process memory can be higher. Run control-plane builds with sufficient available memory; this
build-time budget is separate from an individual deployed agent's allocation.

## Verified Environment Variables

These are read directly in the current codebase:

- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Stripe: `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- Credit top-ups: production card credit purchases require both `CREDIT_TOPUPS_ENABLED=true` and `NEXT_PUBLIC_CREDIT_TOPUPS_ENABLED=true`.
- Free-tier abuse checks: `FINGERPRINT_SECRET_KEY`, `NEXT_PUBLIC_FINGERPRINT_PUBLIC_KEY`
- Hetzner API: `HETZNER_API_TOKEN`, `HETZNER_SSH_KEY_ID`
- Hetzner SSH auth: `HETZNER_SSH_PRIVATE_KEY_B64` or `HETZNER_SSH_KEY_PATH`
- Proxmox rollout:
  - `HERMES_INFRA_PROVIDER=proxmox` makes the Proxmox backend available.
  - `HERMES_PROXMOX_ENABLED_USER_IDS` is a comma- or space-separated allowlist of Clerk user IDs that should use Proxmox.
  - Users not listed in `HERMES_PROXMOX_ENABLED_USER_IDS` keep using the regular Hetzner path.
  - Proxmox host settings: `PROXMOX_PUBLIC_IP`, `PROXMOX_SSH_HOST`, `PROXMOX_SSH_KEY_PATH` or `PROXMOX_SSH_PRIVATE_KEY_B64`, `PROXMOX_TEMPLATE_ID`, `PROXMOX_PRIVATE_SUBNET_PREFIX`, `PROXMOX_PRIVATE_GATEWAY`, `PROXMOX_VM_SSH_KEY_PATH`, `PROXMOX_CADDY_SITES_DIR`
  - Proxmox pilot sizing: `PROXMOX_VM_CORES=1`, `PROXMOX_VM_MEMORY_MB=2048`
- Voice transcription fallback: `VOICE_TRANSCRIPTION_OPENAI_API_KEY`
- Bankr partner API:
  - `BANKR_PARTNER_KEY=...`
  - `BANKR_API_BASE_URL=https://api.bankr.bot` (optional)
- Managed Venice inference:
  - `VENICE_API_KEY` is required for server-side proxy calls to Venice. It must stay server-only.
  - `MANAGED_VENICE_SETTLEMENT_SECRET` protects the server-side token quote settlement route. If omitted, settlement falls back to `BILLING_SETTLEMENT_SECRET` or `CRON_SECRET`.
  - `MANAGED_VENICE_PROXY_KEY_PEPPER` is required server-side to hash managed Venice proxy keys before storage.
  - `CRON_SECRET` protects the subsidy observability endpoint at `/api/ops/managed-venice/subsidy`.
  - `$HERMESOS` deposit quotes fail closed unless the DEXScreener price has a fresh independent cross-check before launch.
- SSH host verification:
  - Per host: `HETZNER_SSH_HOST_FINGERPRINT_<IP_WITH_UNDERSCORES>`
  - Bulk map: `HETZNER_SSH_HOST_FINGERPRINTS` with entries like `203.0.113.10=SHA256:...`
  - Temporary escape hatch only: `ALLOW_INSECURE_HETZNER_SSH=true`
- Legacy gateway TLS escape hatch only: `ALLOW_INSECURE_GATEWAY_TLS=true`

Other features also rely on provider- and platform-specific env vars, but the list above is the core set I verified directly from the active dashboard code.

`VOICE_TRANSCRIPTION_OPENAI_API_KEY` is optional and server-only. When set in Vercel, `/api/openai/transcriptions` can use it as a backend fallback for authenticated voice requests, including chats that use a non-OpenAI model provider, so the secret stays on the server and is never exposed to the browser.

## Current Architecture Notes

- App routes and API handlers live under [`src/app`](src/app).
- Shared client/server utilities live under [`src/lib`](src/lib).
- Hetzner provisioning and deploy-time config generation live in:
  - [`src/lib/hetzner`](src/lib/hetzner)
  - [`src/lib/services/hetzner-instance-service.ts`](src/lib/services/hetzner-instance-service.ts)
- Proxmox orchestration lives under [`src/lib/services/proxmox-instance-service.ts`](src/lib/services/proxmox-instance-service.ts).
- Current Hivra agent definitions and compatibility views live under [`src/lib/hivra`](src/lib/hivra).
- Current agent interaction UI lives primarily under [`src/components/hivra`](src/components/hivra), [`src/components/instances`](src/components/instances), [`src/components/webui`](src/components/webui), and [`src/components/profile`](src/components/profile).

The current Hermes and Hivra-agent paths do not yet share one canonical lifecycle, execution, or access contract. `src/lib/hivra/unified-agent.ts` is a presentation normalization layer, not backend unification. The host-side Hivra provisioner is now versioned in [`provisioner/`](provisioner/); its presence alone does not establish a complete independent-operator installation. See the current roadmap for the separately recorded provider, runtime, and self-host acceptance gates.

## Security Notes

- SSH connections now expect a pinned host fingerprint unless `ALLOW_INSECURE_HETZNER_SSH=true` is explicitly set.
- The gateway TLS break-glass path is request-scoped now; it no longer flips global Node TLS verification state for the whole process.
- Billing IP extraction is centralized so rate limiting and checkout metadata use the same client-IP rules.

## Current Maintenance Focus

- Keep provider/model catalogs current for APIs that change frequently.
- Prefer request-scoped network overrides over global process mutations.
- Add tests before changing provisioning, billing, or profile normalization behavior.
