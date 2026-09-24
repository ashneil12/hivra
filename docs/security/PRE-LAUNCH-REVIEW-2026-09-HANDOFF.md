# Pre-launch security review — handoff to continue locally

This is the continuation note for **TASK S1** (pre-launch security review, `ashneil12/hivra`,
`canary`). The cloud session that ran the review was stopped early to save credits; this file
records exactly what was done, what remains, and how to pick up on a local machine.

## State at handoff

- **Branch:** `claude/security-review-launch`, cut from `origin/canary` at `08d2ff1`. The only
  commit on it adds `docs/security/PRE-LAUNCH-REVIEW-2026-09.md` and this file. **No code fixes
  were made.**
- **Findings report:** `docs/security/PRE-LAUNCH-REVIEW-2026-09.md` — merged into canary as
  acceptance boundary (a).
- **Acceptance boundary (b) — fixes for confirmed critical/high, with regression tests, served on
  canary — is NOT done.** All findings are OPEN.
- **Acceptance boundary (c) — Needs Ash — is in the report's "Needs Ash" section.**
- **Reviewer proofs / raw notes** were under the cloud container's scratchpad
  (`/tmp/claude-.../scratchpad/`): `money/`, `money-a/`, `money-d/`, `cron/`, `reports/`,
  `supabase/` (incl. `missing_on_prod.txt`), `web/`, `wallet-keys/`, `authz/`. **These do not
  survive the container** — re-derive the two PoCs you want to keep (WC cross-lane invoice; Venice
  stream-cancel refund) locally from the file:line refs in the report.

## Verification status of findings

Each area reviewer self-refuted its findings and, where possible, proved them with a scratch Jest
test. The lead independently re-checked only the `restore_backup` finding (confirmed code, then
downgraded to low after DB counts showed 0 live Hetzner-lane instances) and spot-checked the Venice
critical (mint + verify-only gating confirmed). **The remaining findings are single-reviewer +
self-refutation, not yet independently re-verified.** Before writing each fix, re-confirm the
finding on current `origin/canary` — that is the `hivra-code-loop` "fresh reviewer" step the task
asks for.

## Recommended fix order (one PR each, cut fresh from updated origin/canary)

Ship money/credit-theft first, then tenant isolation, then web, then hygiene. For each: reproduce
→ minimal fix → regression test → `verify:plan` at the right risk → PR → `gh pr update-branch` →
wait for **Current tree safety** → merge → confirm the served SHA on canary.

1. **Venice media/passthrough spend gate (CRITICAL).** Add a balance reservation before forwarding
   on every `v1/*` media route and the `[...path]` catch-all; allowlist passthrough paths (reject
   `api_keys*`/`billing*`); refuse mint/use for unfunded accounts. Files: `managed-venice/v1/**`,
   `lib/venice/proxy-keys.ts`, `proxy-settlement.ts`.
2. **Venice chat stream-cancel refund (HIGH).** Mirror `v1/responses/route.ts`: keep the hold on
   cancel, non-sweepable reconciliation item, never release after upstream 200.
3. **Token-tier permanence (HIGH).** `bankr-deposit-wallets.ts:471` default `makePrimary:false`
   and pass it explicitly in the 4 callers; make the holdings cron breach "eligible rows but no
   eligible verification wallet"; paginate the 100-wallet cron.
4. **Stripe WC cross-lane invoice (HIGH).** `webhooks/stripe/route.ts` + `stripe-webhook-service.ts`:
   skip WC subs in `handleInvoicePaid`/`handlePaymentFailed`; only update `hermes_subscriptions`
   where `stripe_subscription_id` matches.
5. **GHCR_TOKEN in tenant VMs (HIGH).** Make images public or pull host-side; else `read:packages`
   token + `docker logout` + remove `~/.docker/config.json`; never in `user_data`.
6. **Hermes-lane unpinned SSH (HIGH).** Reuse the Hivra-lane VMID-tag + ipconfig + QGA host-key pin
   (`vmid-bound-guest-ssh.ts`) before any secret-carrying SSH in `instance-orchestrator.ts` /
   `hetzner/ssh.ts`.
7. **`hermes_instances` RLS `ALL` policy (HIGH, gated).** Drop the unused `authenticated`/`anon`/
   `public` write policies + revoke default writes (migration); make `purge-expired` refuse rows
   whose `user_id` is not a known Clerk user. **Coordinate with Needs Ash #2** — the DB migration is
   a canary DB change, so land the code guard via PR and hand the migration to Ash for both DBs.
8. **`/clerk-assets` XSS (HIGH).** Narrow the rewrite to `@clerk/...` + add a sandbox CSP on that
   path (or self-host); move the document CSP to enforced nonce.
9. **Mediums** in the report order (overage reservation, token-lot debit CAS, top-up starvation
   index, price-gate young-pool minimum, mv-token-sweep claim, ops/events clamp+rate-limit,
   /health cache, `getIP` header trust, apple revocation [before iOS], withdraw step-up, canary
   CSRF, terminal Content-Type pin).
10. **Lows** (reserve ILIKE, update-report revive, template slug, restore_backup removal, backups
    PATCH gate, canary bypass secret, handoff URL token, gitleaks history scan + custom rules).

## Constraints carried over (still apply)

- Develop only in this worktree/branch; canary changes ONLY via a PR merged into `canary`.
- Never: prod Promote; any `vercel deploy/--prod/--force/redeploy/promote/rollback/alias set/link`
  on `hermesos`/`hermesos-canary`; Vercel env changes or secret rotation (list for Ash); prod or
  customer DB writes; attacking anything but your own disposable canary fixtures / local instances;
  VM/fleet changes beyond your own fixture; emails; spending; repo-settings changes.
- Fixtures must be disposable, owned, ledgered, and cleaned up before reporting.
- Before editing a file, `gh pr list -R ashneil12/hivra --state open` and avoid files with open PRs
  (at handoff: #111, #109, #54, #28, #14).

## Prod migration gap (for Needs Ash #1)

Prod `prvdajgvxnkunvpmitbt` is missing ~162–173 repo migrations **by name**; several already on
prod are recorded under different version numbers, and prod has drift not in the repo — so
**reconcile by name before applying**, do not blind `db push`. Security-relevant ones to prioritise:
`20260923001301_revoke_api_execute_on_definer_functions.sql`,
`20260922172439_enable_rls_remaining_public_tables.sql`,
`20260829211000_self_host_service_role_baseline.sql`, and the definer/RLS-bearing migrations
`20260923120000 / 150000 / 190000 / 203000`, `20260924090000 / 101500 / 171100 / 190000 / 210000`.
Re-run the missing-migration diff locally against both projects (SELECT `version` from
`supabase_migrations.schema_migrations`) to regenerate the exact list.

## ENCRYPTION_KEY rotation steps (Needs Ash #7 detail)

1. Set a dedicated `LAUNCH_FINGERPRINT_KEY` (and optionally `CHAT_ENCRYPTION_KEY`) first.
2. Drain/cancel in-flight `hivra_model_key_operations`, `hivra_launch_model_requests` (incl.
   terminal v1 fingerprint rows), and `infrastructure_first_boot_enrollments` until the four
   coverage-gate counts are 0.
3. **Add and rewrap the uncovered `hivra_buzz_agent_bindings.encrypted_*` columns** (currently
   neither rewrapped nor in the coverage gate — retiring the legacy key without this bricks Buzz).
4. Set `ENCRYPTION_KEY=<new>` + `ENCRYPTION_KEY_LEGACY=<old>` on every deployment sharing the DB
   (canary via PR merge, prod via owner Promote).
5. `npm run rotate:encryption-keys -- --coverage-only`, then `--dry-run`, then `--apply`; rerun
   until legacy/plaintext candidates, conflicts and failures are all 0.
6. Keep the old key while backups encrypted under it exist; then remove `ENCRYPTION_KEY_LEGACY`.
7. If compromise is suspected, also rotate the Bankr keys at Bankr.

## What still needs doing to satisfy the task

- Independently re-verify each remaining finding, then land fix PRs (order above) — boundary (b).
- After each merge, confirm canary serves the merge SHA (Vercel Git deployment for the `canary`
  branch; the container here can't reach the domain, so use the Vercel API or a machine that can).
- Update the report's per-finding status from OPEN to fixed/PR as they land.
- Send the final report to the session **"Hivra white paper review"** (SendMessage) — not yet sent.
