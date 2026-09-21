# HermesOS staging and preview QA runbook

<!-- SCRIPTURE_ANCHOR: qa-prove | 1 Thessalonians 5:21 | Verse: Test all things, and hold firmly that which is good. -->

HermesOS has three test targets. Use the least risky target that can answer the question.

## Environment ladder

1. **Local dev** — fastest feedback; safe for unit/integration checks and mocked flows.
2. **PR preview deployments** — default target for feature QA. Vex should test the latest Vercel preview URL for the PR branch before merge.
3. **Stable staging** — `https://staging.hermesos.cloud`, backed by the long-lived Git branch `staging` and Vercel Preview environment variables.
4. **Production** — `https://hermesos.cloud`; final smoke checks only.

## Staging access

`staging.hermesos.cloud` is protected by Vercel Deployment Protection. Browser automation must set the Vercel bypass cookie before loading the app.

Use the vault variable `VERCEL_AUTOMATION_BYPASS_SECRET`; never paste or print the secret value.

Bypass-cookie flow:

```text
https://staging.hermesos.cloud/?x-vercel-set-bypass-cookie=true&x-vercel-protection-bypass=$VERCEL_AUTOMATION_BYPASS_SECRET
```

After that request, continue testing `https://staging.hermesos.cloud/` with the same browser context/cookie jar.

## What is safe to test immediately

Until backend isolation is fully proven, staging/preview QA may test:

- Vercel protection bypass and page load
- Clerk/auth reachability
- dashboard navigation
- landing/dashboard rendering
- non-destructive chat UI behavior
- read-only console/browser/TUI reachability
- regression screenshots and network error collection

## Do **not** run these on staging yet without explicit approval

These flows can create external side effects or touch money/infra. Keep them disabled, mocked, or manually approved until the linked backend resources are proven non-production:

- real billing checkout, card setup, Stripe webhook replay, or subscription mutation
- Bankr/onchain/token flows with real assets
- instance provisioning, deletion, resize, suspend, or host mutation
- Cloudflare DNS mutation
- mass email / Resend broadcast
- cron endpoints that mutate billing, deposits, health probes, or lifecycle state
- anything that could email real users or alter a production customer record

## Current audit status

Confirmed:

- `staging` Git branch exists and deploys as Vercel Preview.
- `staging.hermesos.cloud` is mapped to the `staging` branch.
- Cloudflare DNS is `staging -> cname.vercel-dns.com`, proxied off.
- Vercel deployment protection is enabled; the automation bypass cookie works.
- Branch-scoped public envs exist for staging:
  - `NEXT_PUBLIC_HERMES_DEPLOY_ENV=staging`
  - `NEXT_PUBLIC_APP_URL=https://staging.hermesos.cloud`
- Direct infra credentials visible through pulled Preview env are absent, while production has Proxmox/Hermes infra settings.

Needs provider-level confirmation:

- Whether Vercel sensitive Preview values for Supabase and Clerk point to non-prod projects/instances.
- Whether Preview Stripe secret/price IDs are test-mode and isolated from production.
- Whether Resend preview credentials are restricted to test recipients.
- Whether shared `CRON_SECRET` is acceptable given Vercel cron scheduling behavior.

## Vex default protocol

1. Ask Circuit/Atlas for the exact target URL.
2. Prefer PR preview URL for branch-specific work.
3. Use `staging.hermesos.cloud` for post-merge, non-prod regression checks.
4. Set the Vercel bypass cookie in the browser context.
5. Log in with the designated staging/test account only.
6. Capture screenshots plus route/network failures.
7. Stop before destructive/billing/onchain/provisioning flows unless Circuit explicitly marks the scenario as approved.
