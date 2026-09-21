# Apple IAP backend (iOS lane, Phase 1)

The parallel App Store money lane: an Apple subscription is a first-class
entitlement source with its own tables, webhook, reconciler and lifecycle —
it never touches the Stripe machinery. Blueprint: the `workspace_cloud` lane.

## Components

| Piece | Path |
|---|---|
| Migrations (tables + credit source) | `supabase/migrations/20260716120000_apple_iap_lane.sql`, `20260716120100_credit_ledger_source_apple.sql` |
| Product-id → plan config | `src/lib/billing/apple-products.ts` |
| Apple root certificate acquisition | Downloaded from pinned Apple URLs at build time; certificate bytes are not stored in this source tree |
| Verifier / API-client construction | `src/lib/billing/apple-verifier.ts` |
| Webhook idempotency ledger | `src/lib/apple-webhook-events.ts` |
| Notification state machine | `src/lib/services/apple-webhook-service.ts` |
| Webhook endpoint (ASSN v2) | `src/app/api/webhooks/apple/route.ts` |
| Reconciler | `src/lib/billing/apple-subscription-reconciler.ts` |
| Reconciler cron | `src/app/api/cron/reconcile-apple-subscriptions/route.ts` |
| Client attach fallback | `src/app/api/mobile/iap/attach/route.ts` |
| Entitlement resolver branch | `src/lib/billing/instance-entitlement.ts` (`source: "apple_iap"`) |
| Billing-page management routing | `src/lib/billing/subscription-management-copy.ts` |

Entitlement precedence: **paid Stripe → apple_iap → token_yearly →
token_holding → free**. Apple statuses that grant access: `active`,
`trialing`, `grace_period` (Billing Grace Period). `past_due` (billing retry
without grace), `expired`, `revoked` do not.

## Environment variables (deploy time)

| Var | Required | Purpose |
|---|---|---|
| `APPLE_BUNDLE_ID` | recommended (defaults to `cloud.hivra.app`) | Bundle id every JWS verification is pinned to. |
| `APPLE_ENVIRONMENT` | yes | `Production` or `Sandbox` — primary verifier + App Store Server API host selection. |
| `APPLE_APP_APPLE_ID` | yes in Production | Numeric App Store app id; the verifier requires it for Production payloads. |
| `APPLE_ISSUER_ID` | yes (reconciler) | App Store Connect API key issuer id (Users and Access → Integrations). |
| `APPLE_KEY_ID` | yes (reconciler) | App Store Connect API key id. |
| `APPLE_PRIVATE_KEY` | yes (reconciler) | The `.p8` private key PEM. Literal `\n` sequences are accepted (Vercel env convention). Pass inline on redeploys — `vercel env pull` masks sensitive values. |
| `APPLE_ACCEPT_SANDBOX_NOTIFICATIONS` | optional | `true` lets a Production deploy verify sandbox-signed payloads (TestFlight / App Review purchases). Defaults: on outside production `NODE_ENV`, off in production. |
| `APPLE_PRODUCT_ID_PRO_MONTHLY` | optional | Override, default `cloud.hivra.pro.monthly` → `operator` plan. |
| `APPLE_PRODUCT_ID_PRO_YEARLY` | optional | Override, default `cloud.hivra.pro.yearly` → `operator`. |
| `APPLE_PRODUCT_ID_POWER_MONTHLY` | optional | Override, default `cloud.hivra.power.monthly` → `fleet`. |
| `APPLE_PRODUCT_ID_POWER_YEARLY` | optional | Override, default `cloud.hivra.power.yearly` → `fleet`. |
| `CRON_SECRET` | already configured | Bearer for `/api/cron/reconcile-apple-subscriptions` (same as sibling crons). |

## App Store Connect setup (Phase 0/V4, manual)

1. Create the subscription group + the four products above; add the 7-day
   intro offer; **enable Billing Grace Period (16 days)**.
2. Set the Server Notification URL (V2) — sandbox first — to
   `https://<host>/api/webhooks/apple`.
3. Request a Test Notification and confirm a verified `TEST` round-trip
   (the endpoint logs `action: "test_acknowledged"`).

## Deploy notes

- Migrations are **written, not applied**. Apply to BOTH DBs and stamp
  `schema_migrations` identically (standing drift rule) before enabling the
  webhook.
- Add `/api/cron/reconcile-apple-subscriptions` to the cron schedule
  (15-minute cadence, same as `reconcile-subscription-grace`).
- The lane is dormant until the iOS app ships: rollback = stop pointing the
  ASC notification URL at the route. No web-user impact.
- Never route Apple subscribers to Stripe surfaces: the billing page shows
  "Manage in the App Store" (`https://apps.apple.com/account/subscriptions`)
  and hides the Stripe portal/cancel controls for `source === "apple_iap"`.

## Double-subscription posture

Not auto-resolved (per plan §Phase 1 risk note): a user with both a live
Stripe sub and an Apple sub resolves to Stripe (precedence) and keeps both
until support intervenes. Apple-lapse suspension cross-checks the resolver
first and never suspends instances while another paid entitlement remains.
