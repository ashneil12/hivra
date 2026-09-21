# Stickiness & Build-Gap Execution Plan

**Status:** Proposed, not started.
**Author:** Claude (2026-06-13)
**Executor:** Claude background workflows (this repo), supervised by Ash for money + flag-flip + prod steps.
**Goal:** Ship all 14 verified stickiness/build gaps from the 2026-06-13 audit — turning a platform whose retention/builder machinery is *built but unwired* into one that pulls users back, lets them build, and makes leaving costly — canary-first, prod trailing, each feature with its own PostHog events.

> Companion docs: `CONVERSION_PLAN.md` (demand-side funnel, 2026-06-10), the audit artifact (`project_stickiness_build_audit_2026_06_13` memory), and the grounding investigation (6 areas, captured inline below). This plan is the BUILD-side superset.

---

## Status table (READ THIS FIRST)

| Check / Phase | Status | Notes |
|---|---|---|
| V1 (worktree verify harness) | ✅ PASS | node_modules symlinked; tsc exit 0 via rtk proxy |
| V2 (lifecycle cron gate + ledger) | ✅ PASS | `lifecycle_email_sends` exists on canary AND prod; flag default-off |
| V3 (hivra_agents columns live) | ✅ PASS | goal/context/chat_url/api_token/type present, first_task absent (added in Phase 0); prod parity confirmed |
| V4 (box cron HTTP contract) | ⏳ DEFERRED | needs a live running box; run at Wave 2 start |
| V5 (credit ledger reason CHECK) | ✅ PASS | CHECK = the 8 values incl `bonus_credit`, NO marketplace/transfer; in-flight lock is per-`user_id` |
| V6 (skill write-path on box) | ✅ PASS | box has GET+DELETE /api/skills only; normalizeSavedName unimplemented; transport decision pending |
| V7 (llm_config drift uncommitted) | ✅ PASS | zero migration files referenced it; committed in Phase 0 |
| V8 (PostHog event existence audit) | ✅ PASS | only `paywall_dismissed` + `agent_initiated_message_sent` MISSING |
| Phase 0 (foundations) | ✅ MERGED | canary #231 (drift migration renamed →170000 via #236 to clear a collision); canary DB migrated; tsc✓ jest 89/89✓ |
| Wave 1 (pull loop) | ⚠️ RE-SCOPE | **1.5 channel-connect SHIPPED by parallel #228** (Telegram both lanes + channel_connected + insights tile). Re-verify 1.2/1.3/1.4 vs #220 before building. Email-default channel likely still a gap |
| Wave 2 (standing tasks) | ⚠️ RE-VERIFY | #220 changed first-session/`instances/[id]/route.ts`; run V4 + re-check overlap |
| Wave 3 (builder creation) | BLOCKED | BUILD. Needs install-transport decision (V6) |
| Wave 4 (value visibility + export) | NOT STARTED | STAY. Lowest parallel-overlap risk — good next candidate |
| Wave 5 (shared memory + templates) | NOT STARTED | BUILD network effect. Phase 0b (llm_config) landed |
| Wave 6 (builder economy — MONEY) | HELD | **SUPERVISED ONLY. No autonomous merge. Canary-only until Ash signs off** |

**Things needed from Ash to unblock execution:**
1. **Decisions (block specific waves):** skill-installer write transport (Wave 3); shared-memory scope — one account-wide store vs per-goal, contradicts current "isolated by default" copy (Wave 5); template-share privacy — strip free-text `context` on share? (Wave 5); referral economics — amounts + trigger event (Wave 6); marketplace settle — reserve-then-capture vs direct atomic debit (Wave 6); export — implement real 30-day post-cancel window vs amend the copy (Wave 4).
2. **Authority:** flip `LIFECYCLE_EMAILS_ENABLED=true` (Vercel env, canary then prod) — emails real dormant users (Wave 1.1); **sign-off before any Wave 6 PR merges anywhere** (money); go-ahead per prod PR (prod auto-merge is ON for green CI — see Release section).
3. **Access:** confirm the executor has Supabase MCP write to BOTH canary (`srrwbdvxlqvqjuexitaf`) and prod (`prvdajgvxnkunvpmitbt`) for `apply_migration`; if canary-only, prod migration application is an owner manual step.

---

## Why this plan exists

The audit's central finding: **the constraint is not building features — it's the last 10% of wiring on machinery that already exists.** The platform pulls only 7.3% of new visitors back on day 2 and day-1 retention collapses to 15% (`CONVERSION_PLAN.md`), yet a complete 6-cohort lifecycle-email system, a per-box scheduler, a finished task editor, a 42-entry skill catalog with a proven install endpoint, owner-agnostic wallet plumbing, and an idempotent credit ledger are all sitting dark, orphaned, or one route short. Past "add a retention feature" instincts would rebuild what's already there. This plan instead **finishes and wires** what exists, in dependency order, with pre-flight gates that STOP when reality contradicts an assumption — and fences the money paths behind supervised execution because Ash has had two customer-data/billing incidents (`feedback_destructive_billing_verify`, `project_billing_period_end_incident`).

---

## Root cause synthesis

| Symptom | Real cause (file:line) |
|---|---|
| "Product never pulls users back," 7.3% day-2 return | Only systematic re-engagement channel is gated dark: `envBool('LIFECYCLE_EMAILS_ENABLED', false)` set nowhere — `dashboard/src/app/api/cron/lifecycle-emails/route.ts:31-52` |
| Lifecycle emails would be generic even if on | Builders receive only `{firstName,agentName,instanceId}` — `dashboard/src/lib/email/lifecycle.ts:36-53`; sweep never selects goal/first_task and never touches `hivra_agents` — `dashboard/src/lib/lifecycle-email-sweep.ts:331-426` |
| Agent goes silent after deploy | No standing task auto-provisioned; deploy seeds identity only — `dashboard/src/lib/hivra/agent-bootstrap.ts:179-211`; cron is Pro-gated with no free exception — `dashboard/src/components/dashboard/OnboardingChecklist.tsx:264` |
| First session wastes the "earn a 2nd visit" moment | Agent ends first turn by inviting a menu, not doing the task; the non-interactive turn that *could* auto-execute already exists — `dashboard/src/lib/hivra/agent-welcome.ts:28-95` |
| `channel_connected` ≈ 0 (north-star) | Every channel path demands a BotFather token + numeric owner id; no zero-friction email default; Hermes lane has no channel surface — `dashboard/src/components/hivra/HivraTelegram.tsx`, `dashboard/src/lib/integrations/config.ts` |
| Recurring work is invisible/unmanageable | `TaskModal.tsx` built but only calls GET `/profiles`; no `/api/instances/[id]/cron` route exists; `scheduledTaskWrite` bucket defined+unused — `dashboard/src/components/scheduled-tasks/TaskModal.tsx`, `dashboard/src/lib/authenticated-rate-limit.ts:8` |
| Agent never gets more capable in-app | No skill installer; box has GET/DELETE `/api/skills` only; proven write is SSH at provision — `dashboard/src/lib/hivra/agent-api.ts:328-342`, `dashboard/src/lib/hivra/bankr-skills-seed.ts:129-151` |
| No reason to run a 2nd agent | Memory strictly per-box; no account-level store — grep over migrations returns none; "Hive Mind" is marketing only |
| No network effect / creator economy | No save/share/fork; user agents not persisted as templates; `agency-templates` is read-only static prompts — `dashboard/src/data/agency-templates.ts` |
| Wallets are a roach motel | Hivra lane deposit-only; no withdraw/set-destination route — `dashboard/src/app/api/hivra/agents/[id]/bankr-wallet/route.ts` (absence confirmed) |
| Token has no in-product utility | Ledger has dead `bonus_credit` reason, no marketplace/transfer reasons — `dashboard/supabase/migrations/20260425120000_credit_billing_foundation.sql:20-31` |
| Users can't see value / "data is yours" is a lie | Per-user usage data is admin-only (`instance_usage_snapshots` read only by crons); export promised in blog + features page but absent — `dashboard/src/lib/blog/articles/persistent-memory-explained.ts:68`, `dashboard/src/app/features/[slug]/page.tsx:115-116` |

---

## Goal & target architecture

Wire the existing machinery into three loops: a **pull loop** (agent re-contacts the user on a channel they live in), a **build loop** (install skills, compose standing tasks, save/share agents), and a **value loop** (see what you got, take it with you, transact on it). Each loop reuses primitives already in the repo; new code is glue + a handful of additive migrations.

```
PULL:   deploy ─→ capture goal/first_task (col) ─→ auto-execute first task (box turn)
                                              └─→ seed 1 free standing task ─→ box cron ─→ channel
        dormant ─→ lifecycle cron (flag ON) ─→ goal-personalized email + activity digest ─→ inbox

BUILD:  HivraSkills ─→ curated-skills picker ─→ install (transport TBD) ─→ box skills dir
        agent config ─→ "Save as template" ─→ agent_templates(row) ─→ slug ─→ launch path ─→ fork
        TaskModal ─→ /api/instances/[id]/cron (NEW proxy) ─→ box /api/cron/jobs

VALUE:  instance_usage_snapshots ─→ per-USER insights surface
        box /api/sessions + USER.md ─→ archive route ─→ one-click export (closes 30-day claim)
        USER.md ◀─▶ user_memory(account) ─→ every new box reads at bootstrap  (switching cost)

MONEY (supervised):  credit_ledger(+reasons, overdraft guard) ─→ marketplace buy/earn
        bankr wallet (owner-agnostic) ─→ Hivra withdraw + set-destination + history
        referrals(table) + ?ref= ─→ bonus_credit grant (idempotent)
```

**Key principle:** *Finish and wire what exists; do not rebuild it.* Every gap is glue + an additive migration, never new infrastructure. Reuse the proven path (the Bankr seed, the welcome turn, the terminal proxy, the crypto-topup grant) as the template for its sibling.

---

## Success criteria (definition of done)

1. A dormant free user receives a goal-personalized lifecycle email within their cohort window, exactly once (ledger-enforced), with `LIFECYCLE_EMAILS_ENABLED=true` on canary then prod.
2. A new deploy auto-executes the captured first task and returns a finished deliverable in the first session (not a menu), idempotently.
3. A new free deploy gets exactly ONE standing task delivered to a connected channel the next morning; the cap is enforced server-side.
4. A user can connect a channel via a guided in-flow step, including zero-friction **email** with no credential paste; `channel_connected` fires.
5. `TaskModal` creates/edits/pauses/deletes real box cron jobs through a new `/api/instances/[id]/cron` route, behind `isProTierUser()` + `scheduledTaskWrite` rate limit, surfaced as a "Tasks" tab with run history.
6. A user can browse `curated-skills` and one-click install onto their box; installed-vs-available state is correct (installedAs diff).
7. A user can "Save as template" a configured agent and re-launch/fork it from a slug; private→link→public visibility works; no encrypted key ever leaves the row.
8. Every one of a user's agents reads a shared per-account `user_memory` at bootstrap and writes deltas back; per-instance BYO providers untouched.
9. A user sees their own usage (sessions/messages/tokens/est. cost/top model) and can one-click export chat history + memory + workspace as a portable archive — satisfying or amending the 30-day/JSON marketing claims.
10. **(MONEY, supervised)** Hivra-lane wallets can withdraw + set destination with the per-user in-flight guard respected; a credit can move buyer→seller (distinct reference_ids, overdraft-guarded); a referral grants `bonus_credit` once per referee. No double-credit, no overdraw, no cross-lane wallet mixups — proven by tests against the real constraints.
11. Every feature ships its PostHog events in the same PR (server `capture+flush` with `$insert_id`; client via `captureClient`); `tsc --noEmit` + targeted jest green; migration hygiene + manifest regenerated.

---

## Execution model (workflow-driven)

This plan is executed by **Claude background workflows**, one per wave, each item a pipeline stage: `pre-flight gate → implement in this worktree → verify (tsc + targeted jest via rtk) → open a CANARY PR`. Rules:

- **Autonomous-safe waves (1 code-side, 2, 3, 4, 5):** workflows may implement and open **canary** (`origin=hermesdeploy-canary`) PRs without pausing. They must STOP on any pre-flight contradiction (see Handoff #5).
- **Supervised steps:** the lifecycle **flag flip** (1.1) and **all of Wave 6 (money)** — workflows may write code and open a **canary-only** PR marked `DRAFT / DO NOT MERGE`, then STOP and report. No prod PR, no merge, no env flip without Ash.
- **Prod PRs are never opened autonomously.** Prod (`upstream=hermesdeploy`) has auto-merge ON for green CI — a prod PR self-merges. Workflows open prod PRs only after canary soak **and** Ash go-ahead, per item.
- **Migrations** are applied via MCP `apply_migration` to BOTH DBs by NAME, ahead of deploy; the manifest is regenerated per target. Money migrations wait for Ash sign-off.
- **One worktree per concurrent code-writing wave** (`isolation: 'worktree'`) to avoid collisions; this worktree is canary-aligned (origin/main, 4 ahead/0 behind).

---

## Pre-flight verification (DO FIRST)

**STOP on any failure — report the contradiction, propose a plan revision. Do not improvise, do not patch silently, do not "try the next thing."**

### V1 — Worktree verify harness works
**Category:** live-state
**Why:** the worktree has NO node_modules; tsc/jest fail until symlinked, and RTK eats jest output.
**Steps:**
1. `test -e dashboard/node_modules && echo PRESENT || echo ABSENT`
2. if ABSENT: `ln -s /Users/example/Projects/Hermesdeploy/dashboard/node_modules /Users/example/Projects/Hermesdeploy/.claude/worktrees/unruffled-lovelace-afd9e1/dashboard/node_modules`
3. `cd dashboard && rtk proxy npx tsc --noEmit` (pretypecheck regenerates the manifest)
**Pass:** tsc exits 0 via `rtk proxy`.
**Fail handling:** if symlink invalid (different deps), STOP — the worktree branch diverged from main's lockfile; reconcile before any code.

### V2 — Lifecycle cron is inert when gated, ledger exists on both DBs
**Category:** live-state
**Why:** flipping the flag must not double-send or hit a missing ledger.
**Steps:**
1. `grep -n 'LIFECYCLE_EMAILS_ENABLED\|CRON_SECRET\|LIFECYCLE_EMAILS_BATCH_SIZE' dashboard/src/app/api/cron/lifecycle-emails/route.ts dashboard/src/lib/lifecycle-email-sweep.ts`
2. Supabase MCP on BOTH DBs: `select 1 from information_schema.tables where table_name='lifecycle_email_sends';`
3. (when a deploy URL exists) `curl -s -X POST "$DEPLOY_URL/api/cron/lifecycle-emails" -H "Authorization: Bearer $CRON_SECRET"`
**Pass:** gate names unchanged; ledger present both DBs; gated call returns `{ok:true, enabled:false, skipped:...}`.
**Fail handling:** if ledger missing on either DB, apply `20260610213000_lifecycle_email_sends.sql` there BEFORE any flip; if 401, wrong CRON_SECRET; if 500, CRON_SECRET unset.

### V3 — hivra_agents has goal/context, not first_task
**Category:** live-state
**Why:** personalization + auto-execute need a queryable first_task; goal/context already exist.
**Steps:** Supabase MCP (canary): `select column_name from information_schema.columns where table_name='hivra_agents' and column_name in ('goal','context','first_task','chat_url','api_token','type');`
**Pass:** returns goal, context, chat_url, api_token, type — NOT first_task.
**Fail handling:** if first_task present, skip its migration; if goal/context absent, the bootstrap migration hasn't landed — apply `20260606120000` first.

### V4 — Box cron HTTP contract, end-to-end, on a live running instance
**Category:** live-state + wire-contract capture
**Why:** Wave 2 proxies to the box scheduler; the contract must be captured from the live canary image, not the stale vanilla checkout.
**Steps:**
1. `grep -nE "@app\.(get|post|put|delete).*/api/cron/jobs" /Users/example/Projects/vanilla-hermes-agent-canary/hermes_cli/web_server.py` (expect ~6832-6999)
2. `grep -nE "_SESSION_TOKEN =|HERMES_DASHBOARD_SESSION_TOKEN" .../web_server.py` (expect line ~185, env-pinned)
3. pull a running instance `gateway_url` + decrypt `api_server_key_encrypted`, then `curl -sS -H "Authorization: Bearer $KEY" "$GATEWAY_URL/desktop/api/cron/jobs?profile=all"` — **capture the raw success payload as a test fixture**.
**Pass:** routes present; token env-pinned; curl returns 200 + JSON array (possibly `[]`); garbage token → 401.
**Fail handling:** if 401 with the real key → image doesn't honor the pinned token; use the `/desktop` Caddy route (Caddy authorizes) and confirm the fleet image is the canary build. If routes absent → gate the Tasks UI on image version ("redeploy to enable"), don't 502.

### V5 — Credit ledger reason CHECK + idempotency key (MONEY)
**Category:** live-state
**Why:** the single biggest double-credit risk; the real idempotency key is `unique(source, reference_id, reason)`, NOT what the code comments claim.
**Steps:**
1. Supabase MCP (canary): `select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.credit_ledger_entries'::regclass and contype='c' and conname like '%reason%';`
2. `select indexdef from pg_indexes where tablename='credit_ledger_entries';` and `... where tablename='bankr_withdrawals' and indexname='uq_bankr_withdrawals_one_in_flight_per_user';`
**Pass:** CHECK = exactly the 8 values incl `bonus_credit`, NOT marketplace/transfer; unique is `(source, reference_id, reason)`; bankr in-flight lock is per-`user_id`.
**Fail handling:** if a parallel agent already widened the CHECK, reconcile by name — do NOT blind-DROP. If the unique differs, re-derive every idempotency key in Wave 6 before writing.

### V6 — No box skills write endpoint; pick the install transport
**Category:** code-assumption
**Steps:** `grep -n "/api/skills" dashboard/src/lib/hivra/agent-api.ts`; check the provisioner box `server.js` for any POST `/api/skills`; `grep -rn "normalizeSavedName\|installedAs" dashboard/src | grep -v curated-skills.ts`
**Pass:** only GET + DELETE on the box; installedAs match logic unimplemented.
**Fail handling:** if a write helper exists, extend it. **DECISION (Ash):** transport = (a) add box POST `/api/skills` in provisioner (cross-repo + redeploy), (b) on-demand SSH write reusing `bankr-skills-seed.ts` (no box change, per-install SSH), or (c) `writeBoxFile` (likely blocked by edit-only guard). Default recommendation: (b).

### V7 — llm_config drift still uncommitted
**Category:** code-assumption
**Steps:** `grep -rl "llm_config" dashboard/supabase/migrations`
**Pass:** zero files (drift uncommitted — Phase 0b needed before any new hivra_agents migration sequences after it).
**Fail handling:** if a file exists, a parallel agent committed it; skip 0b.

### V8 — PostHog event existence audit
**Category:** code-assumption
**Steps:** `for e in paywall_viewed paywall_dismissed upgrade_clicked channel_connected agent_initiated_message_sent agent_first_message_sent; do printf '%s: ' "$e"; grep -rql "$e" dashboard/src --include='*.ts' --include='*.tsx' && echo EXISTS || echo MISSING; done`
**Pass:** only `paywall_dismissed` + `agent_initiated_message_sent` MISSING; rest EXIST.
**Fail handling:** implement only the MISSING ones; for EXISTING, add props to the call site — never a parallel event. (Note: the CONVERSION_PLAN claim that `activation_failed` lacks a reason is STALE — it has reason/stage.)

---

## Release, migration & blast radius

- **Deploy target:** Dashboard (Vercel) + dual Supabase. Wave 2/3/5 box interactions are runtime HTTP/SSH (no image rebuild) EXCEPT skill-install option (a), which needs a provisioner box change + `redeploy-webui-instances`.
- **Deploy trigger:** PR to `origin` (canary) and `upstream` (prod). Single required check **"Verify Dashboard"** (`dashboard-ci.yml`, ~3.5min): migration hygiene → hot-surface coverage → `npm ci` → smoke/hot-path → `npm run verify` (lint+typecheck+test:ci+build).
- **Migration behavior:** append-only, CI-enforced; new file `<YYYYMMDDHHMMSS>_<snake>.sql` dated `> 20260613120000`, idempotent (`add column if not exists` / DO-block CHECK swap), RLS service-role lockout. Apply to BOTH DBs by NAME via MCP `apply_migration` ahead of deploy; regenerate `src/lib/generated/migrations-manifest.ts` PER target (mains diverge).
- **Old-code-vs-new-migration safety:** all migrations are additive → old app runs safely against new schema. Apply migration BEFORE or WITH the deploy; never code-before-column for a NOT NULL (we add none).
- **Ordering:** `0b (commit llm_config drift) → any new hivra_agents migration`. `Wave 6 migration (6.1) → all Wave 6 code`.
- **Rollback:** Vercel revert (per PR) + `git revert`; migrations are additive so rollback = leave columns unused (no down-migration needed); box cron jobs deletable via the same route.
- **Blast radius:** Waves 1–5 bounded per surface; **Wave 1.1 flag flip fans out to the whole dormant fleet** (mitigated by the 21-day lookback floor + batch cap + canary-first). **Wave 6 touches real money** → supervised, canary-only until sign-off; prod auto-merge means a green prod PR self-merges, so money PRs stay canary-draft.

---

## Phased execution

### Phase 0 — Foundations & shared instrumentation (gates everything)

**Goal:** make the worktree verifiable, commit schema drift, add the queryable columns + missing events every wave reuses.

**Items:**
- **0a — Verify harness:** symlink node_modules; confirm `rtk proxy npx tsc/jest`. (V1)
- **0b — Commit llm_config drift:** new migration `alter table public.hivra_agents add column if not exists llm_config jsonb; add column if not exists llm_api_key_encrypted text;` (live on both DBs, no file). MUST precede any new hivra_agents migration. (V7)
- **0c — Missing PostHog events:** add `paywall_dismissed` + `agent_initiated_message_sent` (the latter fired by Wave 1.4). Server: `posthogClient.capture({distinctId,event,properties:{...,$insert_id}})` + `await flush()`; client: `captureClient(event, props)`. (V8)
- **0d — Queryable goal/first_task:** `hivra_agents.first_task text`; thread it through `WelcomeFlow.applyHivraWelcomePersonalization` + the onboarding action route (`dashboard/src/app/api/hivra/agents/[id]/action/route.ts:84-117`) so it's written, not just folded into `context`. Hermes lane: add `goal/first_task/context` to `hermes_instances` (today systemPrompt-only) — **scope decision below**.

**Verification gate:** tsc + jest green; both DBs show the new columns; gated lifecycle cron still returns `enabled:false`.
**Rollback:** additive columns + new events — revert files; columns sit unused.
**Risk:** Hermes-lane columns only matter if the pull loop targets Hermes (Decision #1).

### Wave 1 — The pull loop (STAY)

**Precondition:** Phase 0 (0c, 0d).

- **1.1 — Flip lifecycle emails ON (SUPERVISED).** Pre-flips: thread `goal/first_task` into the sweep's per-user query + widen `LifecycleEmailContentParams` (`dashboard/src/lib/email/lifecycle.ts:36-53`) + copy pass (ash-copywriting). Then Ash sets `LIFECYCLE_EMAILS_ENABLED=true` canary → soak → prod. **Workflow stops at the env flip.**
- **1.2 — Goal-personalize builders:** `buildDay1Idle`/`buildDay3Usecase` reference the user's stated goal. (Ships with 1.1.)
- **1.3 — Activity-digest-in-email:** call `buildInstanceActivityDigest` via `resolveWebUIInstanceClient` (cron-safe, no Clerk — `dashboard/src/lib/webui/instance.ts`) inside the lifecycle cron; new `email_key` (no DDL — `email_key` is free text, widen the `LifecycleEmailKey` TS union only).
- **1.4 — Auto-execute first task:** server-side reuse `requestAgentWelcomeMessage` (`dashboard/src/lib/hivra/agent-welcome.ts:28-95`) with the captured first_task as the message; fire `agent_initiated_message_sent`; **own at-most-once ledger key** (`auto_first_task`) — the client localStorage guard won't apply server-side. Budget for box `maxDuration`; consider continuing the welcome `session_id`.
- **1.5 — Channel connect:** guided in-flow step in `WelcomeFlow`; **zero-friction email-as-default** (no token paste) using `INTEGRATION_DEFINITIONS` + Resend rail; Hermes-lane parity (it has no channel surface today). Fire `channel_connected`.

**Verification gate:** dry-run sweep shows personalized copy + digest section; auto-execute returns a deliverable once (re-run is a no-op); a test user connects email with no credentials and `channel_connected` fires; canary PR green.
**Rollback:** flag back to false; revert per file; ledger keys are inert if unused.
**Risk:** activity digest is Hermes/WebUI-only — Hivra-lane boxes need the box `/api/sessions` path instead (Decision #1). Long task turns block the cron (synchronous NDJSON).

### Wave 2 — Standing tasks as owned artifacts (STAY + BUILD)

**Precondition:** V4 (box cron contract).

- **2.1 — New `/api/instances/[id]/cron` proxy route:** GET/POST/PUT/DELETE + pause/resume/trigger, mirroring the signed-header sidecar pattern in `dashboard/src/app/api/instances/[id]/terminal/interactive/route.ts`. Enforce `isProTierUser()` server-side **with a capped-free carve-out**; apply `scheduledTaskWrite` rate limit. Map TaskModal fields → box: `command→prompt`, send RAW cron in `schedule`, derive display from `schedule_display`, `enabled↔state`, drop/derive `errorCount` from `last_error`.
- **2.2 — Wire TaskModal + "Tasks" tab:** add the tab to `dashboard/src/app/dashboard/agent/[id]/page.tsx` and the console; list view with `next_run_at`/`last_run_at`/`last_status`/run-history.
- **2.3 — Day-1 auto-provisioned task (capped-free):** at the bootstrap hook (`dashboard/src/app/api/hivra/agents/[id]/route.ts`, after `bootstrapped_at`), POST ONE cron job to the running box (NOT a seeded file — the gateway clobbers files mid-tick, incident 2026-06-12), schedule `0 9 * * *`, `deliver` set to the connected channel (needs box `/api/cron/delivery-targets`); idempotency stamp (`day1_task_seeded_at`). Footer = upsell.

**Verification gate:** TaskModal CRUD round-trips against a live box; free user gets exactly one task, cap holds server-side; tab shows run history.
**Rollback:** delete the route + tab; delete seeded jobs via the route.
**Risk:** lane confusion — TaskModal/cron is the **Hermes** lane (`/api/instances`, official-dashboard:9119); `agent-bootstrap` is the **Hivra** lane. Don't cross them (Decision #1 decides which lane gets the day-1 task).

### Wave 3 — Builder creation (BUILD)

**Precondition:** V6 + install-transport decision.

- **3.1 — In-app skill installer:** "Add skills" in `HivraSkills.tsx` header → curated-skills picker (`dashboard/src/data/curated-skills.ts`, 40 entries, 38 inline SKILL.md) → install via chosen transport → reload via existing `load`. Implement the installed-vs-available diff (`normalize(boxSkill.name)` vs `normalize(entry.name|installedAs)`) since it's documented but unimplemented. Codex/claude-code only (`.agents/skills` / `.claude/skills`).
- **3.2 — Slash-command palette + "what this agent can do":** consume the orphaned GET `/api/instances/[id]/capabilities` (or client-side `slash-commands.ts` + `buildCommandRegistry`, which are pure + tested) in a chat `/` palette + a capability preview. Note: the capabilities route lacks a Hivra-box branch — add one or go client-side.
- **3.3 — (optional) Packs:** a new `packs.ts` grouping over curated-skill ids (no pack model exists). Defer unless Ash wants it for the marketplace.

**Verification gate:** install adds a skill that appears in box `/api/skills`; diff shows correct installed state; palette filters and inserts a command.
**Rollback:** remove the install button/route; palette is additive.
**Risk:** transport (a) is cross-repo + redeploy; (b) is an SSH round-trip per install. No DB needed unless persisting installed-packs.

### Wave 4 — Value visibility + portability (STAY + switching cost)

- **4.1 — Per-user usage surface:** scope `instance_usage_snapshots` (written by `harvest-agent-usage`) to the signed-in user; reuse `Sparkline.tsx`. Sessions/messages/tokens/est. cost/top model. (Pairs with 1.3's email digest.)
- **4.2 — One-click export:** add a streaming-archive approach (no archiver dep exists) + a new route bundling box `/api/sessions` + `/api/file` (USER.md/MEMORY.md/SOUL.md) + workspace. **Closes the live marketing claim** (`persistent-memory-explained.ts:68` 30-day window + JSON; `features/[slug]/page.tsx:115-116`) — Decision: implement the 30-day post-cancel window or amend the copy.

**Verification gate:** a user sees their own usage (not admin); export produces a valid archive with chat + memory + workspace; claim satisfied or amended.
**Rollback:** routes are read-only/additive; revert.
**Risk:** SFTP route only streams one file and only within `/root|/opt|/tmp` (wrong root for Hivra `/home/bux`); export must compose box reads, handle empty/unreachable boxes gracefully.

### Wave 5 — Compounding intelligence (BUILD network effect)

**Precondition:** Phase 0b.

- **5.1 — Shared per-user memory v0:** new `user_memory` table (one row/Clerk user, markdown text, version, updated_at). Read at the bootstrap hook → fold into `USER.md` via `buildUser()`; write back on delta (poll-diff with `memory_synced_at` OR box-push endpoint — Decision). Keep per-instance BYO providers (`instance-settings.ts`) untouched — orthogonal.
- **5.2 — Save/share/fork template:** new `agent_templates` table (owner, slug unique, type, goal/context/personality/emoji, `llm_config` key-free, `visibility` CHECK private|link|public, `share_token`, `forked_from`). Snapshot a `hivra_agents` identity; launch path resolves slug → fields (per `docs/hivra-marketplace-seams.md` rule 2). Capture skill ids from box `/api/skills` at save, re-seed on fork. NEVER carry `llm_api_key_encrypted`.

**Verification gate:** a 2nd agent reads the account memory at first boot; save→fork reproduces an agent; link/public visibility gates correctly; no key leaks (sanitize round-trip).
**Rollback:** tables additive; feature-flag the bootstrap read so memory fold can be disabled.
**Risk:** "isolated by default" copy contradicts one shared store (Decision); share-token may leak free-text `context` (Decision).

### Wave 6 — Builder economy (MONEY — SUPERVISED, canary-only until sign-off)

**Precondition:** V5; Ash sign-off per item; migration (6.1) before all 6.x code.

- **6.1 — Widen ledger reasons + overdraft guard:** DO-block migration adding `marketplace_purchase, marketplace_earn, transfer` to the `reason` CHECK (keep `bonus_credit`); add matching `CreditLedgerReason` union literals (`credits.ts:10-18`). Add a BEFORE-INSERT overdraft trigger on `credit_reservations` (generic reservations have none; mirror the venice guard `20260606140100`).
- **6.2 — Hivra-lane withdraw + set-destination:** owner-agnostic `withdrawForOwner` using `getBankrWalletForOwner({hivraAgentId})`; new routes under `dashboard/src/app/api/hivra/agents/[id]/bankr-wallet/` mirroring the instance withdraw route (zod, ownership, rate limit, in-flight claim). Destination: either widen `instance_bankr_wallet_recipients` (instance_id NOT NULL blocker → nullable + XOR owner) or store only on `instance_bankr_wallets.withdrawal_destination_evm` (simpler, Decision).
- **6.3 — Earnings/transaction history:** read `bankr_withdrawals` (RLS service-role; build a server endpoint). Per-agent scoping needs an owner column add (Decision: per-agent vs user-level v1).
- **6.4 — Credit earn/transfer sink:** buyer `marketplace_purchase` debit + seller `marketplace_earn` credit with **distinct reference_ids** (the `unique(source,reference_id,reason)` key means a shared id silently no-ops one leg). Reserve-then-capture vs direct debit (Decision). Mirror `settleCryptoTopUpIntent` (credit-first-then-mark).
- **6.5 — Referral give/get:** new `referrals` table (unique `referred_user_id`); `?ref=` capture in `PostHogProvider` (separate from signup_attribution); grant `bonus_credit` idempotently. Amounts + trigger (Decision).

**Verification gate (each item):** tests against the REAL constraints — double-fire is a no-op, overdraw blocked, cross-lane wallet not mixed, per-user in-flight 409 respected; `tsc` + the existing withdraw tests green; **Ash reviews the canary PR before any merge; no prod PR without go-ahead.**
**Rollback:** additive migrations; money routes behind a flag default-off until validated.
**Risk:** the audit's listed double-credit/double-spend/lane/FK gotchas — see "What NOT to do."

---

## What NOT to do (avoid relapses)

- ❌ **Do NOT rebuild what exists.** Lifecycle emails, the task editor, the skill catalog, the welcome turn, owner-agnostic wallet plumbing are all built — wire them.
- ❌ **(MONEY) Do NOT reuse one reference_id for both legs of a transfer/referral.** The DB key is `unique(source, reference_id, reason)` — a shared id silently no-ops the second leg. Use distinct ids/reasons per side.
- ❌ **(MONEY) Do NOT treat `appendCreditLedgerEntry` as balance-guarded.** It will insert a negative below zero. A buy must reserve with an overdraft guard (generic reservations have none today).
- ❌ **(MONEY) Do NOT reuse `bankr-instance-withdraw.ts` for Hivra.** It's hard-wired to `getBankrWalletForInstance` — it would drain the WRONG wallet. Add an owner-agnostic twin.
- ❌ **Do NOT cross the lanes.** Hivra (`hivra_agents`, `/home/bux`, `chat_url`+`api_token`, SSH-seeded USER.md) ≠ Hermes (`hermes_instances`, gateway+`api_server_key`, official-dashboard cron, BYO memory). TaskModal/cron = Hermes; bootstrap/skills/shared-memory = Hivra.
- ❌ **Do NOT seed a cron file on a running box.** The gateway clobbers `jobs.json` mid-tick (double-delivery incident 2026-06-12) — call POST `/api/cron/jobs` instead.
- ❌ **Do NOT mix the two PostHog signatures.** Server = object arg `{distinctId,event,properties}` + `await flush()` + `$insert_id`; client = positional `capture(event, props)` (use `captureClient` if it can fire pre-init).
- ❌ **Do NOT edit/rename/delete an existing migration.** Append-only, CI-enforced; new timestamp `> 20260613120000`; regenerate the manifest per target.
- ❌ **Do NOT open a prod PR autonomously, or any money PR.** Prod auto-merges on green CI.
- ❌ **Do NOT replace BYO memory providers** with shared memory — it's an orthogonal account store.
- ⚠️ A saved template must be sanitized (no `llm_api_key_encrypted`, no per-agent minted proxy keys) — re-mint on fork.

---

## Decision points (ask Ash before improvising)

1. **Pull-loop lane:** Hermes instances, Hivra boxes, or both? (Different fetch contracts + storage; decides Phase 0d Hermes columns, 1.3 digest path, 2.3 day-1 lane.)
2. **Skill-install transport:** (a) box POST endpoint, (b) on-demand SSH (recommended), (c) writeBoxFile. (Wave 3 shape.)
3. **Shared-memory scope:** one account-wide store (matches "shared per-user memory") vs per-goal — contradicts current "isolated by default" copy. (Wave 5.1.)
4. **Template-share privacy:** strip free-text `context` on public/link share? (Wave 5.2.)
5. **Export:** implement the real 30-day post-cancel window vs amend the blog/features copy. (Wave 4.2.)
6. **Marketplace settle:** reserve-then-capture (needs overdraft trigger) vs direct atomic debit; transfer user→user vs user→platform sink. (Wave 6.4.)
7. **Referral economics:** amounts (referrer/referee) + trigger (signup / first deploy / first paid). (Wave 6.5.)
8. **Earnings history granularity:** per-agent (needs `bankr_withdrawals` owner column) vs user-level v1. (Wave 6.3.)

---

## Open questions

1. Does `agent_first_message_sent` actually fire in prod since the `harvest-agent-usage` deploy? (Confirm in PostHog — the CONVERSION_PLAN "restore" task may be a no-op.)
2. Is shared-memory write-back poll-driven (`memory_synced_at` + content hash) or box-push (new authenticated box→dashboard route)?
3. Does the executor have MCP write to BOTH Supabase projects, or canary-only (prod migrations = owner step)?
4. Do conversion tables need a durable DB ledger per event for funnel SQL, or does PostHog suffice?

---

## Estimated effort

- Pre-flight (V1–V8): ~0.5 day
- Phase 0: ~1 day
- Wave 1 (pull loop): ~3–4 days (1.1 flip is minutes once 1.2 lands)
- Wave 2 (standing tasks): ~3 days
- Wave 3 (builder creation): ~3 days
- Wave 4 (value + export): ~3 days
- Wave 5 (memory + templates): ~4 days
- Wave 6 (money, supervised): ~5–6 days incl. review cycles
- **Total: ~3–4 weeks of focused agentic execution, money trailing.**

**Critical ordering:**
`Pre-flight → Phase 0 (0a, 0b, 0c, 0d) → (Wave 1 ‖ Wave 2 ‖ Wave 3 ‖ Wave 4 ‖ Wave 5) → Wave 6`
within Phase 0: `0b → any hivra_agents migration`. Within Wave 6: `6.1 → (6.2 ‖ 6.5) → 6.3 → 6.4`.

---

## Handoff notes for executor (workflow orchestrator)

1. **Read this whole doc before any code changes.**
2. **Run pre-flight V1–V8 in order. Report each.** Do not start Phase 0 until V1/V2/V7 pass and Ash has reviewed the Decision list.
3. **Each wave/item has a verification gate.** Do not open a PR until tsc + targeted jest are green via `rtk proxy`.
4. **Canary PRs only, autonomously.** Prod PRs and ALL money PRs require Ash go-ahead. Prod auto-merges green CI.
5. **If pre-flight fails, STOP, report the contradiction, propose a plan revision. Do not push through on assumptions.** This is the single most important rule in this doc.
6. **When in doubt:** the live canary image is the source of truth over the stale vanilla checkout; the real DB constraint is the source of truth over code comments.
7. **Money is supervised.** Wave 6 items are canary-draft + STOP. No exceptions.
8. **Mark user-only items clearly** (env flips, prod migrations, money sign-off, the 8 Decisions).

---

## Plan revision history (newest at top)

## v1 → v2 update — parallel agents are actively shipping overlapping waves on canary

Discovered during Phase 0 execution: canary `main` advanced ~18 commits mid-execution (another agent / aeon), shipping work that overlaps this plan, and colliding on a migration timestamp.

| Plan said | Reality found | Evidence |
|---|---|---|
| Wave 1.5 (channel-connect, both lanes) is a gap to build | **Already shipped** — Telegram connect on both lanes + `channel_connected` event + `channel_connections` table + insights tile | canary #228; migration `20260613140000_channel_connections.sql`; `lib/telegram-activation.ts`, `components/channels/TelegramConnect.tsx` |
| First-session deploy flow is the plan's to change (1.4 auto-execute, 2.3 day-1 task) | First-session reworked by a parallel PR ("kill deploy dead-end, honest boot") touching `instances/[id]/route.ts`, `DeployForm`, `DeployedCelebration` | canary #220 |
| Pick same-day migration timestamps freely | Timestamp **collision** — #220 and #231 both used `20260613130000` | fixed by renaming the drift migration →`170000` (#236) |

**Net effect on phases:**
- **Wave 1.5 → DONE** (drop from scope). Re-scope Wave 1 to the still-missing pieces: goal-personalized lifecycle copy (1.2), activity-digest-in-email (1.3), auto-execute-first-task (1.4, re-verify vs #220), zero-friction **email-as-default** channel (the part #228's Telegram-first work likely didn't cover).
- **Wave 2** must re-verify against #220's first-session changes before building.
- **Process change:** before each wave, `git fetch` + re-baseline the gap against current `main`, and claim a migration timestamp immediately before push. Do NOT merge a canary PR before its CI is green (canary merges without required checks — that's how the #231 collision reached main).

**New user-blocker:** coordination — is another agent / aeon actively owning this stickiness workstream? If so, decide who owns which waves. (See report.)

<!-- vN → vN+1 update sections accumulate here as the plan evolves. Do not delete older revisions. -->

## v1 → v2 update — ONBOARDING DIRECTION CHANGED: form removed, conversational ritual is canonical (2026-06-13)

**⛔ STAND DOWN on form-driven onboarding. Do NOT re-add the deploy-card personalization form or its goal/context/first_task capture.**

Ash changed the onboarding direction from form-driven to **conversational**. Shipped in canary PR #254 (MERGED, commit `512ccd3d3`):
- The deploy-card personalization form (goal/context/first-task in `DeployingState`) is **REMOVED**.
- Fresh agents are seeded with a BOOTSTRAP-style "who am I / who are you" ritual as their `SOUL.md` at provision (`dashboard/src/lib/onboarding-ritual.ts` + `webui-instance-builder.ts` docker-exec seed into the `webui-state` named volume, provision-only, `! -s` guarded). The agent runs identity + first-task onboarding conversationally on first contact, then rewrites its own SOUL.md (self-terminating).

| Plan said | New reality |
|---|---|
| Wave 0d/1.2: thread the form's goal/first_task to the agent | Form is GONE; nothing captured at deploy. The threading + `applyHermesWelcomePersonalization`/`applyHivraWelcomePersonalization` plumbing is now INERT (empty draft) — left in place to avoid churn, scheduled for cleanup. |
| Wave 1.4: auto-execute the captured first_task on first turn | No first_task captured → naturally a no-op. The ritual does the first task instead. Do NOT re-wire it to a form. |
| Wave 1.5: in-flow channel connect | **KEEP** — the ritual points the user to the Telegram connect surface. Complementary. |

**Net for the pipeline:** Wave 1.1/1.2/1.3 (lifecycle emails) and 1.5 (channel connect) stand; Wave 1.4 (form-driven auto-execute) and any deploy-form re-introduction are **SUPERSEDED**. Pending follow-ups (owned by the onboarding-revamp thread, see `docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md`): speak-first (agent `api_server` + image rebuild), managed-keyless default + onboarding credit, "agent online" email, full plumbing cleanup, Hivra `agent-bootstrap.ts` ritual parity.
