# Pre-launch security review — handoff

Updated 2026-09-25. Companion to `docs/security/PRE-LAUNCH-REVIEW-2026-09.md`, whose
**Status** table is the source of truth for what is fixed.

## Where things stand

- **Every critical and high finding is fixed in code on canary** (#150–#174). Each fix was
  re-checked by an independent reviewer against `origin/canary`.
- Some fixes only take effect after owner steps: database migrations are applied by hand,
  and a leaked token must be rotated. Those are listed under **Before Promote**.
- Everything left in code is medium/low or behind a precondition, listed under **Next week**.

## Before Promote (owner — Ash)

Do these before promoting canary to hivra.cloud. None can be done from a Claude session.

1. **Apply the missing migrations to prod** (`prvdajgvxnkunvpmitbt`), reconciling by
   *name* first: several prod migrations were recorded under different version numbers,
   and prod has drift that isn't in the repo, so do not blind `db push`. Security-critical:
   - `20260923001301_revoke_api_execute_on_definer_functions.sql` — closes 5 functions anon
     can call on prod today (`record_cron_heartbeat` can fake cron health).
   - `20260922172439_enable_rls_remaining_public_tables.sql`
   - `20260925174500_hermes_instances_api_role_writes.sql` (#155) and
     `20260926090000_public_tables_api_role_writes.sql` (#174) — also apply #174 to **canary**
     (canary already has #155). Apply #174 as **one transaction** (SQL editor, or
     `psql -1 -v ON_ERROR_STOP=1`) so a failed assertion rolls back; it prints each dropped
     policy as a NOTICE — keep that output. A read-only preview on 2026-09-25 showed it drops
     10 policies on canary and 19 on prod (all tables owned by `postgres`); each dropped
     `FOR ALL` policy is re-created as a `FOR SELECT` policy, so own-row reads are unchanged.
2. **Supabase auth settings, both projects:** in the Supabase dashboard confirm GoTrue
   **signup is off**, **anonymous sign-ins are off**, and **no Clerk third-party auth / JWT
   template** is configured. This removes the precondition for the RLS findings outright.
   (Prod shows 15 GoTrue users with 0 sessions — worth a look.)
3. **Rotate `GHCR_TOKEN`** once canary's scrub (#152/#171) has rolled out and the images are
   confirmed pullable without it. Copies on existing boxes, in old Hetzner `user_data`, and in
   VM backups stay valid until it is revoked. Use `read:packages` scope, or make images public.
4. **Check legacy `managed_venice_token_quotes` rows with `sweep_status='failed'`** before
   Promote: rows from before #164 have no submit marker, so they stay auto-retryable and a
   transfer whose response was lost could be sent twice from a shared deposit wallet.
5. **Confirm the managed-Venice upstream keys are INFERENCE keys**, not ADMIN.
6. **Prod Vercel env** (the session's token could not list it): `CRON_SECRET` set and
   different from canary's; `APPLE_ACCEPT_SANDBOX_NOTIFICATIONS` unset; Workspace-Cloud price
   ids as intended.
7. **Decide on Hivra-provisioned agent-wallet keys** (79 in prod): they have no recipient
   allowlist and sit on the box, so an account takeover can drain them through the agent or
   terminal without the new step-up. Options: re-mint with an allowlist, or migrate holders
   to user-connected wallets.
8. **Enable GitHub secret scanning + push protection**, and rotate anything that ever sat in
   the retired private repos.

## Next week (code — can wait until after launch)

Ranked by risk. Each needs a regression test and a PR into canary.

1. **Unpinned guest SSH in three more lanes** (same class as #157, needs tenant root on a
   shared bridge + ARP spoof): `lib/hivra/agent-bootstrap.ts` (~:342, writes the LLM key incl.
   managed `hven_live_`), `lib/hivra/tool-mcp-seed.ts` (~:179, tool MCP credentials),
   `lib/services/workspace-cloud-provisioner.ts` (~:99/212/463/484, `API_SERVER_KEY` and
   provider keys). Reuse the VMID + ipconfig + QGA-attested host-key pin
   (`vmid-bound-guest-ssh.ts` / `proxmox/hermes-guest-ssh.ts`).
2. **Crypto top-up rate limit + one-open-session constraint:** `POST /api/billing/crypto/top-up`
   has no rate limit and the session check is check-then-insert (`crypto-payment-sessions.ts`),
   so a burst still delays everyone (bounded since #164). Add a per-user rate limit and a
   partial unique index on open sessions.
3. **Apple IAP revocation** (must land before the iOS app ships): reject `revocationDate` in
   `mobile/iap/attach` and the webhook service; confirm live status before activating.
4. **Managed-Venice overage and paid chat options:** finish #166/#170 (another session).
   Also: `video/retrieve`, `audio/retrieve` and `GET v1/videos/[id]` forward any queue id with
   no owner binding (cross-tenant read if an id leaks).
5. **`/api/reserve` ILIKE:** switch `.ilike("email", …)` to `.eq` in `reserve/route.ts` and
   `lib/reservations/promote-next.ts` (stored emails are all lower-case — checked on both DBs).
6. **Link-only template by slug:** in `lib/hivra/agent-templates.ts` `getTemplateForLaunch`,
   serve `link` templates to non-owners only through the share token.
7. **Canary `VERCEL_AUTOMATION_BYPASS_SECRET` on guests:** give the remote-desktop broker a
   per-computer token instead; then rotate the secret.
8. **WebUI handoff key in URL:** replace the `apiServerKey` in the login URL with a short-lived
   sidecar-checked token.
9. **CI secret scanning:** add a `gitleaks git` range scan on PRs, custom rules for `bk_`,
   `hven_live_`, `hvra_otlp_`, `sb_secret_`, and fail on stale `.gitleaksignore` entries
   (coordinate with any open PR touching `.gitleaksignore`).
10. **Disabling backups via PATCH leaves the Stripe add-on billing:** `PATCH backupsEnabled:false`
    turns Hetzner backups off but keeps `backups_enabled` and the Stripe line item (pre-existing;
    no UI sends it). Route disable through the add-on endpoint too.
11. Hardening ideas in the report (enforced nonce CSP, split `CRON_SECRET`, revoke single-use
    Bankr keys after use, `ssrfSafeFetch` manual redirects, `command-output-redaction` for
    `bk_` keys).

## Rules that still apply

- Canary changes only through a PR merged into `canary`; never `vercel deploy/promote/…`.
- No prod or customer DB writes, env changes, secret rotation, emails or spending from a
  session — list them for Ash.
- Before editing, check open PRs (`#166`, `#170`, `#139`, `#128`, `#118`, `#117`, `#54`, `#28`,
  `#14` at the time of writing) and avoid their files.

## ENCRYPTION_KEY rotation (when needed)

1. Set a dedicated `LAUNCH_FINGERPRINT_KEY` (and optionally `CHAT_ENCRYPTION_KEY`).
2. Drain in-flight `hivra_model_key_operations`, `hivra_launch_model_requests` and
   `infrastructure_first_boot_enrollments`.
3. Add and rewrap `hivra_buzz_agent_bindings.encrypted_*` (not covered by the rotation
   script today; retiring the old key without this bricks Buzz identities).
4. Set `ENCRYPTION_KEY=<new>` + `ENCRYPTION_KEY_LEGACY=<old>` everywhere that shares the DB.
5. `npm run rotate:encryption-keys -- --coverage-only`, `--dry-run`, then `--apply`; rerun
   until candidates, conflicts and failures are 0.
6. Keep the old key while backups under it exist, then remove `ENCRYPTION_KEY_LEGACY`.
