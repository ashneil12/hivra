# Promote packet: hivra.cloud, first cutover to the public repository

Prepared 2026-10-08 against the Canary tip. **Status: PREPARED ONLY. NOTHING HAS BEEN EXECUTED.**

> **PROD HOLD is in force.** The owner has frozen every production action (no Promote,
> no merge into `main`, no release PR merge, no production database write, no fleet
> rollout) until he lifts it in plain words. This packet is preparation. It does not
> authorise anything. The only production contact made while writing it was read-only
> (`read_only` Management API queries, a read-only alias lookup).

This packet is the dated worked recompute of [PROD-CUTOVER-PACKET.md](PROD-CUTOVER-PACKET.md)
(the procedure). Numbers here go stale the moment `canary` or either database moves.
Recompute before Promote. Deployment ids, project references and the pre-image of
production objects are in the owner's private notes, not here.

## 0. What the owner has to do, in order

Nothing below happens until the hold is lifted.

1. **Legal review gate (blocks Promote).** Section 6 lists every token, custody and
   geo-gate surface that ships at Promote. None has had legal review. Either get the
   review, or hold those surfaces back on Canary first (a PR into `canary`), then
   re-pin. Do not Promote with them as they are.
2. **Decide the open calls in section 9** (geo-gate wording, activity retention flag,
   dunning sweep, SEO jobs, the early security migrations). Each has a recommended answer.
3. **Rehearse the database chain** (section 4.5). Needs a temporary database login to
   dump the production schema, so it is an owner action. Fix anything it finds by a PR
   into `canary` first.
4. **Set production environment** (section 7). Names only are listed here. Values are the
   owner's. `NEXT_PUBLIC_*` names are baked in at build, so set them **before** the
   release PR is merged.
5. **Refresh the release PR**: a new `release/canary-<sha7>` pinned to the exact Canary
   SHA that was served and accepted. Close any older release PR as superseded.
6. **Merge the release PR into `main`.** This only stages a candidate. Check it is READY,
   `source: git`, no domain alias, tree identical to the pinned Canary SHA.
7. **Apply the database chain** in the window just before Promote (section 4). Owner only.
8. **Promote** the staged candidate in the Vercel dashboard (project `hermesos`).
9. **Post-Promote acceptance** (PROD-CUTOVER-PACKET.md section 9, plus section 8 below).
10. **If it goes wrong**: section 10. Rolling code back does not undo SQL.

## 1. Pin

| Item | Value (2026-10-08) |
|---|---|
| Canary serves | `f5db90ee` ("Merge pull request #256"), `source: git`, `ashneil12/hivra`, ref `canary`, READY. Verified by alias lookup. |
| hivra.cloud serves | A CLI deployment of the retired private repository (`source: cli`). This is the rollback target. Id is in the private notes. |
| `main` | Last release merge 2026-09-23. No commits on `main` that are not on `canary`. |
| Canary ahead of `main` | 1174 commits, 186 merged PRs, 2116 files (+236,607 / -46,331). |
| Real delta | Everything. The live build is the retired repository, so `main..canary` understates the cutover. Sections 3 to 5 measure it directly. |

Canary keeps moving. Anything merged after `f5db90ee` is not in these numbers.

## 2. Commits and PRs not on production

Production runs the retired private build, so there is no shared history to diff. Listed
here is what `canary` carries beyond `main` (the staged candidates so far); the full
public tree is the real delta (section 3).

- Token, wallet and money (legal review flag where marked): 46 PRs (#52, #53, #55, #56, #57, #58, #63, #66, #67, #68, #72, #75, #77, #78, #79, #80, #82, #85, #88, #93, #108, #109, #110, #111, #150, #152, #153, #158, #160, #161, #164, #165, #167, #168, #169, #193, #194, #205, #206, #223, #225, #226, #228, #230, #246, #256)
- Hermes release registry and fleet: 13 PRs (#157, #171, #229, #234, #235, #236, #239, #243, #244, #247, #249, #250, #253)
- SEO and site copy: 56 PRs (#51, #65, #69, #89, #103, #106, #114, #125, #138, #176, #177, #178, #179, #180, #181, #182, #183, #184, #185, #186, #187, #188, #190, #191, #192, #195, #196, #197, #198, #199, #200, #201, #202, #203, #207, #208, #209, #210, #211, #212, #213, #215, #216, #217, #218, #219, #220, #221, #222, #224, #231, #232, #233, #240, #242, #248)
- Security and database hardening: 16 PRs (#112, #119, #141, #145, #147, #154, #155, #156, #159, #162, #163, #173, #174, #175, #204, #254)
- Computers, desktops, launch, attach and agents: 48 PRs (#62, #64, #73, #81, #86, #87, #94, #95, #96, #97, #98, #99, #100, #101, #102, #104, #105, #107, #113, #115, #116, #120, #121, #122, #123, #124, #126, #127, #129, #130, #131, #133, #134, #135, #136, #137, #140, #143, #144, #146, #148, #149, #151, #172, #227, #237, #238, #241)
- Other: 7 PRs (#61, #83, #84, #132, #142, #245, #255)

Full list: `git log --merges --first-parent origin/main..origin/canary`.

New routes in the candidate that the live build does not have (23): `/about`, `/security`,
`/status`, `/download`, `/ecosystem`, `/offline`, `/tokenomics`, `/why-hivra/evolution`,
`/dashboard/{activity,agents,buzz,collaboration,computers,computers/recovery,convert,infrastructure,ops/releases,runtimes/deepseek-harness,settings/applications,settings/help,settings/referral,tools,workspace}`.
One route disappears (`/roofing`).

## 3. Production database: schema catch-up

Read-only object diff of schema `public`, canary against production (taken 2026-10-08):

| Category | Canary | Production | Only canary | Only production | Differ |
|---|---:|---:|---:|---:|---:|
| tables | 172 | 112 | **96** | 36 | 0 |
| columns | 2314 | 1420 | 93 (+1191 on new tables) | 47 (+343 on prod-only tables) | 9 |
| functions | 468 | 39 | 433 | 4 | 9 |
| triggers | 154 | 52 | 38 | 3 | 0 |
| constraints | 1251 | 475 | 43 | 6 | 11 |
| indexes | 540 | 370 | 36 | 9 | 2 |
| policies | 89 | 175 | 10 | 28 | 0 |

The earlier "68 tables" figure is stale. Canary now has **96** tables production lacks.
Row counts of populated production tables the chain touches: `hivra_agents` about 108,
`managed_venice_token_quotes` about 179, `yearly_token_subscriptions` about 1,
`hermes_instances` about 1,950. Nothing here is a destructive rewrite of a large table;
the heavy tables (`instance_metering_events` about 2.6M rows) are not altered by the chain.

**Production-only objects** (36 tables, 4 functions, 3 extensions `pg_cron`, `pg_net`,
`pgmq`, 3 storage buckets). Checked against code: the candidate reads none of the
36 tables except `operator_usage_*`, which exist on production. The five `seo_*` tables the
live build uses are read by nothing in the candidate (section 6.6). Their rows stay.
**Do not drop any of these.** No migration in the chain references the three extensions
(searched for `pg_cron`, `pg_net`, `pgmq`, `cron.schedule`, `net.http`).

**Differing shared objects.** Nine columns (`profiles` NOT NULL drift, `user_api_keys`,
`hermes_instances.product_surface`), 9 functions, 11 constraints (mostly the `hermesos`
only wallet-type and status CHECKs that the dual-token migration widens, plus
`token_entitlement_configs_pkey` going from `(tier_key)` to `(tier_key, token_key)`),
2 indexes, 64 table-grant differences. The pre-image of every one is saved privately
(function bodies, constraint definitions, index definitions) for rollback.

### 3.1 Security exposure that exists on production today

Structural findings from the object diff. **Not tested through the API and not exploited.**

- Two SECURITY DEFINER functions are executable by `anon` and `authenticated`:
  `record_cron_heartbeat` and `refresh_credit_account_cached_balance`. Fix:
  `20260923001301_revoke_api_execute_on_definer_functions` (production has 2 of its 15 checks).
- `authenticated` holds INSERT/UPDATE/DELETE grants on about 62 tables (billing, wallet,
  credit and Venice tables included). RLS is on for every table and the billing and wallet
  tables have **no** write policy for `authenticated`, so those writes are denied today. The
  live write paths are about a dozen tenant-scoped FOR ALL or write policies keyed on the JWT subject
  (`hermes_hosts`, `hermes_instances`, `hermes_conversations`, `hermes_messages`,
  `user_api_keys`, `profiles`, `instances` and a few more). A user holding a valid JWT can
  write its own rows directly, including fields the lifecycle crons act on. `hermes_hosts` is
  the sharpest, per the fix migration's own analysis: a host delete removes the server named in the row. The wallet credentials
  table is not exposed (policy limited to the service role; anon and authenticated have no
  privilege on it). Fixes: `20260925174500_hermes_instances_api_role_writes`,
  `20260926090000_public_tables_api_role_writes`, `20260930140000_lock_down_api_role_grants`,
  plus `20260922172439_enable_rls_remaining_public_tables`.
- Static check that the live build does not depend on those privileges: at the live commit,
  the browser Supabase client (anon key) is exported but nothing imports it, and the
  Clerk-JWT hook is defined but unused. So these five are **backward compatible with the live build on paper**.
  Unverified at runtime.

These are the best candidates to apply before the whole chain, once the hold lifts (section 9).

## 4. Migration chain

The ledger is not evidence. Production's migration ledger has 221 rows and its newest is
`20260922180543`; **196** files in the candidate have no ledger row. Each was checked by
objects (tables, columns, indexes, constraints, triggers, policies, grants, exact function
bodies), one small read-only slice at a time. Canary was checked first as a control: 169 of its 191 checked files are fully present; the other 22 show only later redefinitions (expected, a later file replaced the body) and were not each re-examined.

### 4.1 Buckets

| Production state | Count | Meaning |
|---|---:|---|
| ABSENT | 161 | none of its objects exist. Apply. |
| PARTIAL | 10 | some objects exist (usually an older same-named constraint). Decide per object. |
| PRESENT+M | 1 | objects exist, but a redefined constraint or dynamic SQL needs a manual check. |
| PRESENT | 1 | all objects and exact function bodies match. Ledger row only. |
| UNCHECKABLE | 23 | data statements or dynamic SQL, no static objects. Apply, then fingerprint. |

Static risk verdicts (heuristic, from `scripts/release/prod-migration-risk.mjs`):
ADDITIVE 119, REVIEW 58, NOT-AS-IS 19.

Record only (one file): 20260922234806 (`reconcile_rpc_yearly_tier_rank`). Its
function body was applied on production out of band after 2026-09-23; this was found by the
body check. Re-check immediately before recording.

By topic (all 196): desktop and provisioner 100, agents, hosts, launch, other 67, token engine 20, security hardening 5, activity retention 3, release registry 1.

### 4.2 The 19 NOT-AS-IS files (read before anything else)

Sixteen add a validated constraint, a NOT NULL or a guard trigger to `hivra_agents`
(about 108 rows). Three touch token tables (`crypto_deposit_receipts`; `yearly_token_quotes`
and `yearly_token_subscriptions`; `managed_venice_token_quotes`). The failure mode is
one of: a constraint rejects an existing row and the file fails (atomic, nothing recorded),
or a guard trigger makes the **live build's** writes to `hivra_agents` fail until Promote.
That second one is why the window must be short. Rehearse against production-shaped rows.

- 20260826130000_hivra_agent_authority_operations
- 20260828010000_provider_computer_ownership
- 20260828020000_provider_installer_operation_fence
- 20260831235500_provider_native_access_binding
- 20260831235900_provider_native_gateway_credentials
- 20260905140000_managed_provisioner_channels
- 20260905150000_hivra_desktop_prepare_lifecycle
- 20260905220000_provider_desktop_lifecycle
- 20260906190000_hivra_attachment_lease
- 20260915143000_windows_iso_source
- 20260915150000_hivra_resource_envelopes
- 20260915153000_hivra_private_access
- 20260915170000_hivra_gvisor_computers
- 20260922185029_credit_deposit_sweep_state
- 20260922222737_yearly_token_payment_attribution
- 20260923120000_digitalocean_managed_agent_sessions
- 20260924101500_digitalocean_token_expiry_and_forget
- 20260925100200_hivra_agent_attachment_lifecycle
- 20260925193100_managed_venice_token_sweep_claim

### 4.3 Dependencies that make order mandatory

- The desktop and provider release admission files (`*_release*`, 23 uncheckable) rewrite
  existing functions by anchor text. Each raises "anchor mismatch" if the previous
  admission is missing. They must run in filename order and only after the files that
  create `admit_prepared_provider_computer` and the identity functions.
- Many ADDITIVE files depend on tables created by earlier REVIEW files. Do not split the
  chain by class unless the rehearsal proves the prefix is self-contained.
- 154 of the 196 files sort **before** the newest ledger version. Apply by filename order,
  not by "newer than the ledger".

### 4.4 How to apply (owner)

Strict filename order. One file per atomic transaction that also writes its ledger row. Stop
at the first failure and re-check that file's objects before anything else. The maintainer
tooling for this is the `hivra-supabase-ops` skill scripts (`apply-sequence.sh`, plan mode
by default); `--apply` needs the owner's write token for production. Never `supabase db push`.

Proposed shape, after rehearsal:

1. **Early, once the hold lifts and rehearsal passes**: the five security hardening files
   (section 3.1). Independent value, cheap to verify, backward compatible on paper.
2. **Window, immediately before Promote**: all remaining files in strict order, then the
   one record-only row.
3. **Never in this release**: `dashboard/supabase/_pending_destructive_migrations/`.

### 4.5 Rehearsal (harness built, real run not done)

A repeatable harness now exists: [PROD-CHAIN-REHEARSAL.md](PROD-CHAIN-REHEARSAL.md). It has been
run only on a SYNTHETIC schema, which does not satisfy this step.

No one has run the full chain against a copy of production's schema. Cheapest honest path:
schema-only dump of production into a local Postgres (docker is installed), plus the rows
of `hivra_agents`, `crypto_deposit_receipts`, `yearly_token_quotes`,
`yearly_token_subscriptions`, `managed_venice_token_quotes`; stub the Supabase roles; run the
wrappers in order. **Unverified end to end.** Canary only proves the files apply on a schema
that evolved differently from production's.

### 4.6 After the chain

Required: every candidate file has a ledger row; production has zero SECURITY DEFINER
functions executable by `anon` or `authenticated` (today: 2); no table in `public` has RLS
off (today: 0); re-run the object diff and the migration-drift cron reports nothing missing.
After Promote, any name without a ledger row becomes a fatal ops event on the 10 minute
drift cron, so record the proven ones in the same window.

## 5. Crons

Compared the live build's `vercel.json` with the candidate's (61 cron paths on the live
side). Differences:

| Cron | Live | Candidate | First-run effect on production |
|---|---|---|---|
| `dunning-sweep` | daily | **removed** | The past-due email sweep stops. 7 subscriptions are past due today. The webhook lane and grace enforcement stay. Decide (section 9). |
| `trial-expiry` | hourly | **removed** | No trials exist in the candidate. |
| `reservation-claim-expiry` | every 2h | **removed** | Waitlist retired. |
| `seo/gsc-pull`, `seo/index-coverage`, `seo/inventory-check` | daily/weekly | **removed** | The SEO engine stops writing. Data stays. |
| `managed-venice-hold-sweep` | none | hourly | New. Settles stale managed-Venice wallet holds (capture or release); it used to run inside the daily reconcile. Production has 24 active holds, the oldest from mid-May, so the first run moves user balances. Read the counts in the logs. |
| `prune-hivra-activity` | none | daily | Dry run unless `ACTIVITY_RETENTION_ENABLED=true` (section 6.2). |
| `progress-agent-attachments` | none | every minute | New. |
| `recover-stuck-hivra-agents` | every 5 min | every 2 min | Faster. |
| `daily-instance-backups` | 4 times a day | once a day | **Fewer backups.** Confirm intended. |
| `seed-daily-brief`, `sweep-server-enrollments`, `sync-connectors` | none | new | New. |

Database-side cron (`cron.job`) needs a privileged role; the read-only role sees none.
**Not checked.**

## 6. Topic sections

### 6.1 LEGAL REVIEW FLAG: token engine, custody, geo-gate

**Every item in this subsection ships to production at Promote and none has had legal
review. Do not Promote until the owner clears it or it is held back.** The UK financial
promotion route and legal-entity naming are not covered here (de-scoped by the owner).

Public surfaces with token content that go live: `/token` (exists on the live build, copy
changes), `/tokenomics` (new), `/why-hivra/evolution` (new), `/dashboard/convert` (new),
the litepaper (`/docs/litepaper`, new on production), and `LITEPAPER.md`, `WHITEPAPER.md`,
`TOKENOMICS.md` as served files. App surfaces: wallet verification, yearly token
subscriptions, managed-Venice token top-ups, tier holding refresh, $HermesOS to $HIVRA
conversion. PRs touching them (23): #52, #53, #55, #56, #57, #58, #63, #67, #68, #72, #78, #79, #80, #88, #93, #110, #152, #158, #168, #193, #194, #205, #206.

**Token engine (dual-token).** `$HIVRA` is dormant: `HIVRA_TOKEN_LAUNCH.contractAddress` is
empty, so the platform behaves as $HermesOS only. Activation is one reviewed PR that pastes
the address (docs/token/HIVRA-ACTIVATION.md). The migration
`20260923150000_dual_platform_token_foundation` adds a `token_key` dimension to seven token
tables with defaults (existing rows stay $HermesOS), widens CHECKs to accept `hivra`, and
changes `token_entitlement_configs` primary key. Production has 13 of its 74 checks (old
same-named constraints). Risk: medium, schema only; existing $HermesOS users and discounts
carry over by the column default. **Not tested**: a fresh $HIVRA activation on a production
copy. Rollback: the old constraints and primary key are saved in the private pre-image;
re-adding the single-column primary key fails once any `hivra` row exists.

**Custody.** `docs/security/KEY-CUSTODY-INVENTORY.md` (written for counsel) and whitepaper
section 8.6, which states the custody facts and carries its own review flag. Agent wallets
now connect the user's own Bankr account. Customer-asset keys held by Hivra: see the
inventory; this packet does not restate them. Legal review needed before the whitepaper and
the wallet connect flow are public.

**Geo-gate.** Task instruction: do not enable. **The code as merged already blocks `GB`.**
`dashboard/src/lib/compliance/token-geo-list.ts` ships `BLOCKED_COUNTRIES = ["GB"]` (set on
2026-09-30 per the runbook, PR #205 made it fail closed across documents and surfaces). So a
Promote **turns the UK block on in production** as a side effect, with no separate switch.
The runbook says it needs a UK crypto lawyer's review and lists uncovered surfaces (emails,
social posts, the public GitHub copies, no card-country check). The owner said not to act on
the UK geo-gate. **Decision needed (section 9):** accept GB blocked at Promote, or empty the
list on Canary first so it ships dormant. I did not change it.

### 6.2 Activity retention

Migration `20260923190000_hivra_activity_retention`: an index on `hivra_agent_events`, a
`prune_hivra_activity` function, and a trigger that deletes a computer's activity rows and
collector row when its status becomes `deleted`. Additive. Existing leftovers are removed
only by the cron job, which is a dry run unless `ACTIVITY_RETENTION_ENABLED=true` is set in
the production environment. Production has 526 event rows, **418 older than 90 days**. If the
flag is set, the first run deletes those 418. Recommendation: leave the flag unset at
Promote, read the dry-run count in the logs, then set it deliberately. Rollback: the deleted
rows are not recoverable; there is no archive. Risk: low while the flag is off.

### 6.3 Release registry (Hermes agent images)

Migration `20261007120000_hermes_releases` adds the registry tables and nullable columns on
`hermes_instances`. Service role only. A repository with no registered release is **not
governed**: its boxes keep following `:stable`, so an empty registry changes nothing. The
first registered release switches that repository to digest pinning. Needed before the fleet
update (the 0.21.0 to 0.21.5 roll) can be staged. Registering a release on production is a
registry change under the hold. Risk: low. Rollback: leave in place; halt a release in the
ops console.

### 6.4 Desktop and provider migrations

100 files. Most are `*_release*` admission files that patch
function bodies by anchor to admit each reviewed provisioner bundle (latest `2026.10.07.1`,
the optional Claude app on Ubuntu Desktop). They create the schema for remote desktop
sessions, desktop prepare, native hosts and lifecycle, attachments and resource envelopes.
Production has none of it. Risks: anchor mismatch if order is wrong; the `hivra_agents`
validated constraints (section 4.2). A Promote changes **no installed box**: provisioner or
sealed-runtime changes need their own immutable provisioner release and a VM rollout
(`dashboard/provisioner/VERSION` is `2026.10.07.1`), which is under the hold.

### 6.5 Metering CPU (PR #129)

Code only, no migration. Reads Hermes VM CPU from the `kvm` process on the newer Proxmox
hosts so the sampler stops reporting wrong CPU. Touches the metering sampler cron and the
resource watchdog, with a captured-output fixture test. Risk: low, but the watchdog acts on
what it reads, so check the first sampler runs for sane CPU values on both host generations.
Rollback: Vercel rollback of the code.

### 6.6 SEO (PR #114 and the later SEO series)

PR #114 (111 files) is cutover parity: the Hermes OS title, GA4 sign-up tracking behind
cookie consent, canonical and sitemap host handling in `seo-host.ts` and `seo-urls.ts`,
the agent SEO catalog, tool catalog and new blog articles. Around 55 other PRs are SEO
and site copy. What changes on production:

- The live SEO engine (`gsc-pull`, `index-coverage`, `inventory-check` crons and the
  `seo_*` tables) has no counterpart in the candidate. Rows stay, jobs stop. Search Console
  data for the cutover would have to be read in Search Console itself.
- GA4 sign-up tracking is consent-gated, so no new tracking without consent.
- Canary is noindex; production is not. Check `robots` and canonical on the real hostname
  after Promote (`/robots.txt`, `/sitemap.xml`, one blog page, one tool page).

Risk: low for the app, medium for search visibility if canonical or host rules are wrong.
Rollback: code only.

## 7. Environment

Names only. Values are sensitive and are never read. I did **not** list Vercel environment
variables (that is an environment verb the maintainer rules forbid), so the comparison of
what production has set is **not done**. From code alone:

- The candidate reads these names the live build does not (excluding test and fixture
  names): Apple in-app purchase (`APPLE_*`), `BUZZ_UPSTREAM_*`, `HOST_RELAY_*`,
  `LAUNCH_FINGERPRINT_KEY` and `_LEGACY`, `ACTIVITY_COLLECTOR_SIGNING_SECRET`,
  `EXPO_PUSH_ACCESS_TOKEN`, `HERMES_RELEASE_CI_TOKEN`, `HERMES_COLD_STORAGE_HOST` and `_USER`,
  `HERMES_BASE_RPC_URL`, `HIVRA_MANAGED_PROVISIONER_CHANNEL`, `HIVRA_TRUSTED_CLIENT_ADDRESS_HEADER`,
  `MANAGED_VENICE_SPEND_CAPS_ENABLED`, `MANAGED_VENICE_MONTHLY_SPEND_CAP_USD`,
  `MANAGED_VENICE_MULTIMODAL_MARKUP`, `PROXMOX_SSH_HOST_FINGERPRINT`, `PROXMOX_VM_DISK_GB`,
  `NEXT_PUBLIC_HIVRA_REFERRAL_ENABLED`, `NEXT_PUBLIC_COMPOSIO_CONNECT_ENABLED`,
  `NEXT_PUBLIC_WORKFLOWS_RUN_ENABLED`, `NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED`.
  Each missing one either disables a feature or fails closed. Owner confirms per name.
- The live build reads these the candidate does not, so that behaviour ends at Promote:
  the card trial flags (`HERMES_CARD_*`), `HERMES_DUNNING_SWEEP_*`, `HERMES_TRIAL_*`,
  `HERMES_MANAGED_VENICE_STARTER_CREDIT_*`, `MAX_FREE_INSTANCES`,
  `STRIPE_TRIAL_OFFER_COUPON_ID`, `RESERVATION_AUTO_INVITE_ENABLED`, `GSC_SA_KEY`,
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. Matches the removal of trials and starter credit.
- `NEXT_PUBLIC_HIVRA_AGENTS` must be `1` on production or every launch except Hermes fails
  (PROD-CUTOVER-PACKET.md section 4). Value needs the owner's confirmation.
- `ACTIVITY_RETENTION_ENABLED`: leave unset (section 6.2).
- `HIVRA_NEW_TOKEN_SURFACES`: leave UNSET on production. Unset holds back the new token pages, the litepaper and the UK list
  while every $HermesOS feature keeps working (docs/token/NEW-TOKEN-SURFACES-SWITCH.md). It needs no value and no NEXT_PUBLIC twin.
- Compare the production environment name list against this by hand in the Vercel
  dashboard before merging the release PR.

## 8. Post-Promote acceptance (additions to PROD-CUTOVER-PACKET.md section 9)

- Token pages: `/token`, `/tokenomics`, `/why-hivra/evolution`, `/docs/litepaper` return
  what the legal review cleared, and a UK request (or a test request carrying the edge country header set to GB) gets
  the block the owner chose.
- `/dashboard/ops/releases` loads for the ops admin; an empty registry is expected.
- First `refresh-token-tiers` and `managed-venice-hold-sweep` runs: no 500 in the runtime logs.
- Billing: a paid and a free test account see the right plan; a test checkout is
  **not** run without the owner's OK (live Stripe).
- Search: `/robots.txt`, `/sitemap.xml`, a blog page canonical on the production host.
- Count of past-due subscriptions unchanged by the removal of the dunning sweep.

## 9. Open calls for the owner (recommended answer first)

1. Geo-gate: Promote with `GB` blocked as merged, or ship it dormant? Recommend: decide with
   counsel; default to leaving the code as is and not Promoting before the review.
2. Early security migrations (section 3.1): apply the five before the full chain once the
   hold lifts? Recommend yes, after a rehearsal.
3. `ACTIVITY_RETENTION_ENABLED`: leave unset at Promote. Recommend yes.
4. Dunning sweep email lane removed with the trial code: confirm intended, or restore a
   past-due lane before Promote (7 past-due subscriptions today).
5. SEO jobs removed: confirm Search Console is read in the console, not by the app.
6. Daily instance backups drop from 4 to 1 a day: confirm intended.
7. Run the rehearsal (needs a temporary production login for a schema dump).

## 10. Rollback and risk register

Rolling the code back (Promote the recorded rollback target) restores the old build only.

| Item | Risk | Rollback |
|---|---|---|
| Additive tables, columns, functions, indexes (about 120 files) | Low | Leave in place. The old build ignores them. |
| `hivra_agents` validated constraints and guard triggers (16 files) | **High** | The old build may fail writes while they exist. A down plan and a re-arm script are prepared ([HIVRA-AGENTS-GUARDS-DOWN-PLAN.sql](HIVRA-AGENTS-GUARDS-DOWN-PLAN.sql), [HIVRA-AGENTS-GUARDS-REARM.sql](HIVRA-AGENTS-GUARDS-REARM.sql)) and rehearsed on a synthetic schema only; owner-run, never automatic. |
| Token CHECK widening, `token_entitlement_configs` primary key | Medium | Old definitions saved in the private pre-image. Reverting the primary key fails once a `hivra` row exists. |
| Function replacements (9 differing functions) | Medium | Old bodies saved in the private pre-image. |
| API role revokes (section 3.1) | Medium | Re-grant from the pre-image if a live read path was missed. |
| Cron first runs (hold sweep, attachments, recovery) | Medium | Not undone by a code rollback. Read counts first. |
| Removed jobs (dunning, SEO, trial) | Low | Code rollback restores them. |
| GB geo-block, token pages | Legal | Section 6.1. |

## 11. Not verified

- Full chain rehearsal (4.5). Whole-chain apply order on production-shaped data.
- Production `cron.job` contents; the Vercel environment name comparison.
- That the five security migrations do not break any live read path (static check only).
- That `PARTIAL` and manual files apply cleanly over the older private variants.
- Anything about customer-visible behaviour after cutover: Canary is the only revision exercised.
- Whether anything outside the migration files (a production-only function or cron) uses
  `pg_cron`, `pg_net` or `pgmq`.

## Appendix A: ordered migration list (196 files)

Action key: APPLY, RECORD ONLY (ledger row only), APPLY DECIDE PER OBJECT (partial or manual
redefinition), APPLY FINGERPRINT AFTER (no static objects; check function bodies or row
effects by hand).

| # | Version | Name | Prod state | Verdict | Flags | Topic | Action |
|---:|---|---|---|---|---|---|---|
| 1 | 20260705120000 | daily_brief_seeded_at | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 2 | 20260716120000 | apple_iap_lane | ABSENT | REVIEW | DROP | token engine | APPLY |
| 3 | 20260716120100 | credit_ledger_source_apple | PRESENT+M | REVIEW | DO,DYN | token engine | APPLY, DECIDE PER OBJECT |
| 4 | 20260716140000 | mobile_device_tokens | ABSENT | ADDITIVE | - | token engine | APPLY |
| 5 | 20260825170000 | infrastructure_connections | ABSENT | REVIEW | DROP | agents, hosts, launch, other | APPLY |
| 6 | 20260826120000 | portable_hivra_target_bindings | PARTIAL | REVIEW | DATA,DO,DROP | agents, hosts, launch, other | APPLY, DECIDE PER OBJECT |
| 7 | 20260826130000 | hivra_agent_authority_operations | PARTIAL | NOT-AS-IS | DATA,DROP,NOTNULL,RLS | agents, hosts, launch, other | APPLY, DECIDE PER OBJECT |
| 8 | 20260826140000 | host_connections_v2 | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 9 | 20260826150000 | host_discovery_snapshots | ABSENT | REVIEW | DROP | agents, hosts, launch, other | APPLY |
| 10 | 20260826160000 | hetzner_cloud_connections | ABSENT | REVIEW | DO,DROP | agents, hosts, launch, other | APPLY |
| 11 | 20260826170000 | hetzner_cloud_capacity_orders | ABSENT | REVIEW | DROP | agents, hosts, launch, other | APPLY |
| 12 | 20260827090000 | hivra_delete_credential_guard | ABSENT | REVIEW | DROP | agents, hosts, launch, other | APPLY |
| 13 | 20260827150000 | hetzner_creation_resource_receipts | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 14 | 20260827160000 | hetzner_scoped_cleanup | ABSENT | REVIEW | DROP | agents, hosts, launch, other | APPLY |
| 15 | 20260827190000 | hetzner_first_boot_enrollment | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 16 | 20260827200000 | hetzner_first_boot_operations | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 17 | 20260827210000 | hetzner_first_boot_cleanup | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 18 | 20260827220000 | hetzner_first_boot_recipe_admission | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 19 | 20260827230000 | hetzner_enrolled_guest_lease | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 20 | 20260828010000 | provider_computer_ownership | ABSENT | NOT-AS-IS | CONSTRAINT,DROP | desktop and provisioner | APPLY |
| 21 | 20260828020000 | provider_installer_operation_fence | ABSENT | NOT-AS-IS | CONSTRAINT | desktop and provisioner | APPLY |
| 22 | 20260828030000 | provider_computer_preparation | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 23 | 20260828040000 | provider_power_operation_fence | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 24 | 20260828050000 | provider_power_journal_privileges | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 25 | 20260828060000 | provider_computer_launch_admission | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 26 | 20260828070000 | provider_provisioner_versions | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 27 | 20260828080000 | hivra_model_key_operations | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 28 | 20260828090000 | hivra_launch_model_custody | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 29 | 20260828100000 | hetzner_external_cleanup_resolution | ABSENT | REVIEW | DROP | agents, hosts, launch, other | APPLY |
| 30 | 20260828110000 | provider_public_bootstrap_version | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 31 | 20260828120000 | provider_responses_bundle_version | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 32 | 20260829010000 | legacy_encryption_rewrap_cas | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 33 | 20260829020000 | provider_runtime_update_bundle_version | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 34 | 20260829040000 | runtime_receipt_bundle_version | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 35 | 20260829050000 | runtime_receipt_os_identity | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 36 | 20260829060000 | runtime_evidence_bundle_version | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 37 | 20260829210000 | self_host_operator_settings | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 38 | 20260829211000 | self_host_service_role_baseline | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 39 | 20260829212000 | provider_runtime_receipt_inventory_fix | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 40 | 20260830132000 | launch_fingerprint_key_separation | ABSENT | REVIEW | SECDEF_NO_REVOKE | agents, hosts, launch, other | APPLY |
| 41 | 20260830150000 | complete_encryption_rotation_cas | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 42 | 20260830170000 | recursive_runtime_inventory | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 43 | 20260830180000 | hivra_agent_restore_points | ABSENT | REVIEW | DROP | agents, hosts, launch, other | APPLY |
| 44 | 20260830181000 | hivra_agent_restore_points_rls_portability | ABSENT | REVIEW | DROP | agents, hosts, launch, other | APPLY |
| 45 | 20260830182000 | hivra_agent_restore_point_resources | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 46 | 20260830190000 | standalone_provider_direct_access | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 47 | 20260831220000 | provider_guest_gateway_revision | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 48 | 20260831230000 | provider_guest_native_composition | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 49 | 20260831233000 | provider_native_cleanup_worker | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 50 | 20260831234500 | provider_native_cleanup_fence | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 51 | 20260831235500 | provider_native_access_binding | ABSENT | NOT-AS-IS | CONSTRAINT | desktop and provisioner | APPLY |
| 52 | 20260831235900 | provider_native_gateway_credentials | ABSENT | NOT-AS-IS | CONSTRAINT,DATA | desktop and provisioner | APPLY |
| 53 | 20260901000000 | hivra_buzz_connections | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 54 | 20260901010000 | hivra_buzz_runtime | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 55 | 20260901020000 | hivra_remote_desktop_sessions | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 56 | 20260901030000 | hivra_remote_desktop_guest_receipts | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 57 | 20260901031000 | provider_native_remote_desktop_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 58 | 20260901032000 | provider_bounded_remote_desktop_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 59 | 20260901033000 | provider_immutable_remote_desktop_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 60 | 20260901034000 | provider_remote_desktop_readiness_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 61 | 20260901035000 | provider_remote_desktop_auth_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 62 | 20260901036000 | provider_remote_desktop_container_readiness_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 63 | 20260901037000 | provider_deepseek_proxmox_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 64 | 20260901210000 | hivra_remote_desktop_session_renewal | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 65 | 20260901211000 | provider_desktop_renewal_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 66 | 20260901235500 | provider_desktop_timing_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 67 | 20260902010000 | hivra_buzz_venice_runtime | ABSENT | ADDITIVE | - | token engine | APPLY |
| 68 | 20260902020000 | hivra_buzz_sprig_pin | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 69 | 20260902030000 | provider_native_proxmox_handoff_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 70 | 20260902060000 | provider_native_vmid_ssh_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 71 | 20260902070000 | provider_native_lifecycle_ssh_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 72 | 20260902080000 | provider_native_qga_bootstrap_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 73 | 20260902120000 | provider_public_source_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 74 | 20260902170000 | provider_public_source_hygiene_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 75 | 20260902180000 | provider_public_export_review_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 76 | 20260902190000 | provider_linux_desktop_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 77 | 20260903010000 | hivra_computer_profiles | ABSENT | REVIEW | DATA,DO | agents, hosts, launch, other | APPLY |
| 78 | 20260904100000 | hivra_canonical_resource_shadow | ABSENT | REVIEW | DATA | agents, hosts, launch, other | APPLY |
| 79 | 20260904110000 | hivra_launch_operations | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 80 | 20260904130000 | hivra_provider_resize_operations | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 81 | 20260904140000 | provider_current_bundle_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 82 | 20260905070000 | hivra_provider_resize_action_command | ABSENT | REVIEW | DO | desktop and provisioner | APPLY |
| 83 | 20260905071000 | hivra_provider_resize_shutdown | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 84 | 20260905072000 | hivra_provider_resize_absence | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 85 | 20260905073000 | hivra_provider_resize_dispatch_version | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 86 | 20260905090000 | hivra_provider_resize_readiness | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 87 | 20260905091000 | hivra_provider_resize_readiness_dispatch | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 88 | 20260905100000 | hivra_folder_recovery | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 89 | 20260905110000 | provider_desktop_workspace_identity_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 90 | 20260905130000 | provider_desktop_special_modes_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 91 | 20260905140000 | managed_provisioner_channels | ABSENT | NOT-AS-IS | CONSTRAINT,DROP | agents, hosts, launch, other | APPLY |
| 92 | 20260905150000 | hivra_desktop_prepare_lifecycle | ABSENT | NOT-AS-IS | CONSTRAINT | desktop and provisioner | APPLY |
| 93 | 20260905160000 | provider_desktop_symlink_identity_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 94 | 20260905170000 | provider_desktop_session_binding_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 95 | 20260905180000 | provider_desktop_alignment_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 96 | 20260905190000 | provider_resize_setup_handoff | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 97 | 20260905200000 | provider_desktop_worker_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 98 | 20260905210000 | provider_desktop_cleanup_contract | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 99 | 20260905220000 | provider_desktop_lifecycle | ABSENT | NOT-AS-IS | CONSTRAINT | desktop and provisioner | APPLY |
| 100 | 20260905230000 | provider_desktop_framing_release | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 101 | 20260906000000 | provider_desktop_capability_refresh | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 102 | 20260906010000 | provider_desktop_power_completion | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 103 | 20260906020000 | provider_desktop_resize_floor | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 104 | 20260906030000 | provider_usd_capacity_ceiling | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 105 | 20260906040000 | provider_desktop_absent_handoff | ABSENT | REVIEW | DO | desktop and provisioner | APPLY |
| 106 | 20260906050000 | provider_desktop_teardown_authority | ABSENT | REVIEW | DO | desktop and provisioner | APPLY |
| 107 | 20260906060000 | provider_desktop_cold_start_release | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 108 | 20260906070000 | provider_workspace_sessions | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 109 | 20260906080000 | provider_workspace_release | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 110 | 20260906090000 | provider_node_ownership_release | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 111 | 20260906110000 | agent_zero_editor_release | UNCHECKABLE | REVIEW | DO | agents, hosts, launch, other | APPLY, FINGERPRINT AFTER |
| 112 | 20260906120000 | desktop_prepared_image_release | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 113 | 20260906130000 | desktop_image_transfer_release | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 114 | 20260906140000 | desktop_image_inventory_release | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 115 | 20260906150000 | hivra_canonical_binding_provenance | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 116 | 20260906160000 | hivra_canonical_parity_coverage | ABSENT | REVIEW | SECDEF_NO_REVOKE | agents, hosts, launch, other | APPLY |
| 117 | 20260906170000 | hivra_canonical_relationship_authority | PARTIAL | REVIEW | DATA,DO,DYN | agents, hosts, launch, other | APPLY, DECIDE PER OBJECT |
| 118 | 20260906180000 | hivra_canonical_relationship_reader | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 119 | 20260906190000 | hivra_attachment_lease | ABSENT | NOT-AS-IS | CONSTRAINT | agents, hosts, launch, other | APPLY |
| 120 | 20260906200000 | hivra_attachment_dispatch | ABSENT | REVIEW | DROP | agents, hosts, launch, other | APPLY |
| 121 | 20260906210000 | hivra_attachment_installation_reservation | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 122 | 20260906220000 | hivra_attachment_guest_observation | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 123 | 20260906230000 | hivra_attachment_staging_result | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 124 | 20260906233000 | hivra_attachment_execution_snapshot | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 125 | 20260906234000 | hivra_attachment_activation_dispatch | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 126 | 20260906235000 | hivra_attachment_activation_observations | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 127 | 20260907010000 | hivra_attachment_native_observations | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 128 | 20260907153000 | desktop_96_dpi_release | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 129 | 20260908023000 | hq_streaming_profiles_release | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 130 | 20260908050000 | remote_desktop_streaming_mode | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 131 | 20260908063000 | native_desktop_client_identity | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 132 | 20260908070000 | omarchy_native_activation_claim | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 133 | 20260908073000 | omarchy_native_activation_grant | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 134 | 20260908074000 | omarchy_native_activation_grant_reader | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 135 | 20260908075000 | omarchy_native_rolling_renewal | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 136 | 20260908080000 | first_frame_streaming_profile_release | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 137 | 20260908090000 | desktop_handoff_latency_release | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 138 | 20260908100000 | windows_desktop_prepare_receipt | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 139 | 20260908110000 | desktop_prepare_profiles | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 140 | 20260909160000 | desktop_resolution_profiles | ABSENT | REVIEW | DO | desktop and provisioner | APPLY |
| 141 | 20260909163000 | omarchy_wayland_web_transport | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 142 | 20260910120000 | omarchy_wayland_web_admission_consistency | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 143 | 20260915120000 | remote_desktop_boot_identity_fence | ABSENT | REVIEW | DROP | desktop and provisioner | APPLY |
| 144 | 20260915130000 | windows_byo_iso_launch | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 145 | 20260915143000 | windows_iso_source | ABSENT | NOT-AS-IS | CONSTRAINT | desktop and provisioner | APPLY |
| 146 | 20260915150000 | hivra_resource_envelopes | ABSENT | NOT-AS-IS | CONSTRAINT,DATA | agents, hosts, launch, other | APPLY |
| 147 | 20260915153000 | hivra_private_access | ABSENT | NOT-AS-IS | CONSTRAINT | agents, hosts, launch, other | APPLY |
| 148 | 20260915170000 | hivra_gvisor_computers | ABSENT | NOT-AS-IS | CONSTRAINT | desktop and provisioner | APPLY |
| 149 | 20260915183000 | host_discovery_inspection_time | ABSENT | REVIEW | DROP | agents, hosts, launch, other | APPLY |
| 150 | 20260915184000 | infrastructure_capacity_policy_rebind | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 151 | 20260915190000 | gvisor_preflight_external_id_text | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 152 | 20260915190100 | gvisor_preflight_connection_columns | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 153 | 20260918120000 | hivra_activity_read_path_indexes | ABSENT | ADDITIVE | - | activity retention | APPLY |
| 154 | 20260922172439 | enable_rls_remaining_public_tables | UNCHECKABLE | REVIEW | DO,DYN | security hardening | APPLY, FINGERPRINT AFTER |
| 155 | 20260922185029 | credit_deposit_sweep_state | ABSENT | NOT-AS-IS | CONSTRAINT,DATA,DROP | token engine | APPLY |
| 156 | 20260922190915 | hivra_activity_collectors | ABSENT | ADDITIVE | - | activity retention | APPLY |
| 157 | 20260922201510 | provider_release_admission_2026_09_22 | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 158 | 20260922222737 | yearly_token_payment_attribution | PARTIAL | NOT-AS-IS | CONSTRAINT,DATA,DROP | token engine | APPLY, DECIDE PER OBJECT |
| 159 | 20260922224500 | managed_venice_token_transfer_dedupe | ABSENT | ADDITIVE | - | token engine | APPLY |
| 160 | 20260922234806 | reconcile_rpc_yearly_tier_rank | PRESENT | REVIEW | REPLACES_PROD_FUNCTION | token engine | RECORD ONLY |
| 161 | 20260923001301 | revoke_api_execute_on_definer_functions | PARTIAL | ADDITIVE | - | security hardening | APPLY, DECIDE PER OBJECT |
| 162 | 20260923120000 | digitalocean_managed_agent_sessions | ABSENT | NOT-AS-IS | CONSTRAINT | agents, hosts, launch, other | APPLY |
| 163 | 20260923150000 | dual_platform_token_foundation | PARTIAL | REVIEW | DO,DROP,DYN,REPLACES_PROD_FUNCTION | token engine | APPLY, DECIDE PER OBJECT |
| 164 | 20260923190000 | hivra_activity_retention | ABSENT | REVIEW | DROP | activity retention | APPLY |
| 165 | 20260923203000 | reconcile_token_base_any_allowed_token | PARTIAL | REVIEW | REPLACES_PROD_FUNCTION | token engine | APPLY, DECIDE PER OBJECT |
| 166 | 20260923204000 | managed_venice_token_lots_unique_quote_any_token | ABSENT | ADDITIVE | - | token engine | APPLY |
| 167 | 20260924090000 | drop_user_bankr_key_on_agent_delete | ABSENT | REVIEW | DROP | token engine | APPLY |
| 168 | 20260924101500 | digitalocean_token_expiry_and_forget | ABSENT | NOT-AS-IS | CONSTRAINT | token engine | APPLY |
| 169 | 20260924171100 | hetzner_same_project_token_replacement | ABSENT | ADDITIVE | - | token engine | APPLY |
| 170 | 20260924180000 | provider_release_admission_2026_09_24 | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 171 | 20260924190000 | hetzner_first_boot_arm_at_start | ABSENT | REVIEW | DO,DROP | agents, hosts, launch, other | APPLY |
| 172 | 20260924210000 | hivra_computer_contracts | ABSENT | REVIEW | DO | agents, hosts, launch, other | APPLY |
| 173 | 20260924210100 | hivra_agent_provider_seed_attempts | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 174 | 20260924213000 | server_enrollment_command | ABSENT | REVIEW | DO,DROP,DYN | agents, hosts, launch, other | APPLY |
| 175 | 20260924220000 | provider_release_admission_2026_09_24_2 | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 176 | 20260924231500 | hivra_desktop_prepare_abandon | ABSENT | ADDITIVE | - | desktop and provisioner | APPLY |
| 177 | 20260925100000 | hivra_agent_slot_limit | ABSENT | REVIEW | DYN | agents, hosts, launch, other | APPLY |
| 178 | 20260925100100 | provider_release_admission_2026_09_24_3 | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 179 | 20260925100200 | hivra_agent_attachment_lifecycle | PARTIAL | NOT-AS-IS | CONSTRAINT,DROP | agents, hosts, launch, other | APPLY, DECIDE PER OBJECT |
| 180 | 20260925100300 | hivra_agent_attachment_grants | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 181 | 20260925100400 | hivra_agent_attach_readiness | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 182 | 20260925100500 | hivra_agent_attach_interrupt | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 183 | 20260925100600 | hivra_agent_attach_refusals | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 184 | 20260925110000 | provider_release_admission_2026_09_24_4 | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
| 185 | 20260925160000 | hivra_attached_agent_program_remove_fix | ABSENT | ADDITIVE | - | agents, hosts, launch, other | APPLY |
| 186 | 20260925174500 | hermes_instances_api_role_writes | PARTIAL | REVIEW | DO,DROP,DYN,RLS | security hardening | APPLY, DECIDE PER OBJECT |
| 187 | 20260925181500 | token_holding_refresh_cursor | ABSENT | ADDITIVE | - | token engine | APPLY |
| 188 | 20260925181600 | bankr_deposit_wallet_primary_repair | UNCHECKABLE | REVIEW | DO | token engine | APPLY, FINGERPRINT AFTER |
| 189 | 20260925193000 | crypto_topup_reconcile_queue | ABSENT | ADDITIVE | - | token engine | APPLY |
| 190 | 20260925193100 | managed_venice_token_sweep_claim | PARTIAL | NOT-AS-IS | CONSTRAINT | token engine | APPLY, DECIDE PER OBJECT |
| 191 | 20260925194500 | token_holding_refresh_standing_first | ABSENT | ADDITIVE | - | token engine | APPLY |
| 192 | 20260925201500 | managed_venice_atomic_wallet_debits | ABSENT | ADDITIVE | - | token engine | APPLY |
| 193 | 20260926090000 | public_tables_api_role_writes | UNCHECKABLE | REVIEW | DO,DYN | security hardening | APPLY, FINGERPRINT AFTER |
| 194 | 20260930140000 | lock_down_api_role_grants | UNCHECKABLE | REVIEW | DO,DYN | security hardening | APPLY, FINGERPRINT AFTER |
| 195 | 20261007120000 | hermes_releases | ABSENT | REVIEW | DO | release registry | APPLY |
| 196 | 20261007130000 | provider_release_admission_2026_10_07_1 | UNCHECKABLE | REVIEW | DO | desktop and provisioner | APPLY, FINGERPRINT AFTER |
