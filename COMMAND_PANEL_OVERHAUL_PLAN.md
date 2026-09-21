# Command Panel Overhaul Plan

> Goal: make the Command Panel the **onboarding spine** of Hivra + Hermes — guided setup that retires itself, a real app picker over Composio's full catalog, an agent-generated daily brief, and working workflows. Grounded in 4 research passes (2026-07-05); every claim below has file:line evidence in the research transcript.

---

## Phase 0 — Quick fixes (small PRs, ship first, ~half day)

### 0.1 PANEL button overlap (bug)
- Today: collapsed-state reopen button floats `absolute top:12 right:12 z-47` over the webchat iframe's own top-right controls ([id]/page.tsx:1440–1467).
- Fix: **slim vertical edge tab** at mid-right (`right:0; top:50%; translateY(-50%)`) — the iframe's mid-right edge has no controls (its top-right and bottom-right do). Same pattern the AgentSwitcher already uses to avoid this exact problem.
- Also fix the ≤1100px trap: the media query hides the open dock but NOT the reopen button → tapping it opens an invisible panel. Hide the tab there too (or make the dock overlay on narrow screens).

### 0.2 Workflows section "empty" (not a migration regression)
- Root cause: `WorkflowsOfTheWeekShelf` permanently self-dismisses to localStorage (`hivra_workflows_of_the_week_dismissed`) — including **after running one workflow** — while CommandPanel still renders the "WORKFLOWS" header → empty section. Composio PRs #448–#460 are byte-identical on this code.
- Fixes:
  a) Include shelf dismissal in `workflowsVisible` so a dismissed shelf hides the whole section (helper `readWorkflowsShelfDismissed()` already exported).
  b) Don't persist-dismiss when a workflow is RUN from the panel (running ≠ "never show again").
  c) Scope the dismissal key by ISO week / card-set version so "of the week" actually rotates back.
  d) Add `NEXT_PUBLIC_WORKFLOWS_RUN_ENABLED=true` to local .env for dev parity.

### 0.3 Dead "Send your first task" checklist item
- Today: literally no onClick (AgentActivityDigest.tsx:36) — renders as an inert div.
- Fix: click → focus the webchat composer via the existing starter-sender/iframe bridge (`runWorkflowPrompt` path) and/or inject a starter prompt. When workflows exist, relabel to **"Run your first workflow"** and scroll to the shelf.

### 0.4 Checklist lifecycle
- Today: never disappears — permanently struck-through once complete.
- Fix: all-done → collapse to one-line "✓ You're set up" for one render-session, then gone (persist `hivra_onboarding_done:<instanceId>`).

### 0.5 Consistency nits
- Unify "connected channel" semantics: header count uses only the 4 quick-connect IDs while the checklist counts ANY configured integration. Pick one (any-integration).
- QuickConnectRow click should deep-link to that channel's setup in the modal, not the generic modal top.

---

## Phase 1 — The App Picker (the big one, ~1–2 days)

### Data layer (all verified live)
| Source | What | Auth |
|---|---|---|
| `docs.composio.dev/data/toolkits-list.json` | **All 1,403 toolkits**: slug, name, logo URL, category (78 categories), toolCount | none |
| `docs.composio.dev/data/toolkits.json` (18.7 MB, server-side only) | adds description + `composioManagedAuthSchemes` (the 35 true one-click-OAuth apps) | none |
| `logos.composio.dev/api/<slug>` | SVG logo per app | none |
| composio.dev/toolkits RSC payload | top-120 popularity `rank` → default sort seed | none |
| Tool Router `COMPOSIO_MANAGE_CONNECTIONS action:list` | per-user connected state, batch ~20–50 slugs/call | user's ck_ key |

- **New apps discover themselves**: our server refreshes the catalog with a daily conditional GET (ETag) — when Composio regenerates the file (they did 2 days ago), we pick it up automatically.
- Gotcha baked into design: `MANAGE_CONNECTIONS list` does NOT validate slugs (fake slug → looks "initiated") — only ever query slugs from the catalog; never use it to probe membership.

### Build
1. **`GET /api/account/composio/catalog`** — server route; caches the 270 KB list (KV/memory + ETag revalidate daily); enriches once from the big file (description + `oauth: true` badge); returns `{apps: [{slug,name,logo,category,toolCount,oauth,rank?}], categories: [...]}`.
2. **`<ComposioAppPicker>` modal** — full-screen-ish, opened from ONE button. UX:
   - Search box (client-side filter over all 1,403 — instant).
   - Category rail/pills (78 categories, count badges).
   - Default sort: popularity rank → OAuth-managed first → alphabetical.
   - Tile: logo + name + category + toolCount; **Connected** badge (green) from a batched MANAGE_CONNECTIONS list of the visible page; connected apps float to a "Connected" group at top.
   - Click → existing hosted-OAuth popup (`launch(slug)`) → `COMPOSIO_WAIT_FOR_CONNECTIONS`-style refresh on focus → badge flips live.
   - Footer link: "Manage everything on dashboard.composio.dev ↗" (the backup you wanted).
3. **Sidebar simplification** — Apps section becomes:
   - key panel (unchanged) →
   - compact **"Connected apps"** row of logos (live state) →
   - one **"＋ Connect apps"** button → opens the picker.
   - DELETE: hero tiles grid, 22-chip strip, and the type-in ConnectAnyApp (subsumed by picker search).

---

## Phase 2 — Panel restructure for onboarding (~1 day)

New section order (top → bottom):
1. **Getting started** (own section at TOP, not buried in Activity; disappears forever when done — see 0.4). Items:
   1. ✓ Your agent is awake
   2. Connect a chat channel *(deep-links)*
   3. Connect your first app *(NEW — opens the app picker)*
   4. Run your first task *(focuses composer / starter prompt)*
2. **Today's brief** (agent-generated — Phase 3)
3. **Chat channels** — **moved ABOVE apps** per your call; **expanded by default until ≥1 channel connected**, then auto-collapses to the "N connected" row.
4. **Apps** (key panel → connected row → Connect apps button)
5. **Workflows** (fixed per 0.2 — cards visible again)
6. **Activity** (live work + sessions; checklist removed from here)

Rationale: the order now mirrors the actual onboarding journey (talk to it → give it tools → give it jobs → watch it work), and every completed step visually retires.

---

## Phase 3 — Real "Today's brief" (agent-generated, ~1–2 days)

**Architecture: box-side cron, seeded fleet-wide, read back over the existing signed API.** (The agent fork literally ships a `morning-brief` cron blueprint already — this is a first-class upstream concept.)

1. **Seed**: clone the existing, battle-tested `seed-standing-tasks` sweep (Vercel cron → signed box API) to create one "Daily brief" job per box (`~0 8 * * *`, deliver:`local`) — prefer instantiating the box's own `morning-brief` blueprint (`POST /_sidecar/api/cron/blueprints/instantiate`). Idempotency via a `daily_brief_job_id` column, default-off env flag, PostHog telemetry — all mirroring the existing sweep.
2. **Read back**: extend the dashboard cron proxy to `GET jobs/{id}/runs?limit=1` → fetch that run-session's final message via `agentWebApi` → that text IS the brief (VoiceBrief reads it aloud unchanged). Current heuristic stays as the fallback for boxes with no run yet.
3. **Decision needed (Ash)**: Free tier has `FREE_STANDING_TASK_LIMIT = 1` — the auto-seeded brief would eat a Free user's only standing-task slot. Options: exempt the platform-seeded job from the count (recommended) or raise the limit.
4. **v2 (defer)**: bundle a `daily-brief` SKILL.md in the vanilla-hermes-agent fork (auto-seeded to every box by skills_sync, enabled-by-default) so brief instructions version centrally; set `skills:["daily-brief"]` on the job.
5. Explicitly NOT doing: Vercel-cron→run-API→Supabase generation (centralizes agent runs into Vercel function time — collides with the Vercel cost-reduction project — and the brief stops being "your agent wrote this").

---

## Sequencing & risk
- **PR order**: 0.1+0.5 (tiny) → 0.2+0.3+0.4 (checklist/workflows) → 1 (picker: catalog route, then modal, then sidebar swap) → 2 (reorder) → 3 (brief: seed sweep behind flag, then read-path, then flip flag).
- Each phase ships independently; nothing blocks on the next.
- Risks: catalog JSON is Composio's docs artifact (unofficial API) → we cache server-side + degrade to the bundled snapshot if it ever 404s; brief seeding touches the fleet → default-off flag + canary-first, same as every sweep.

## Open decisions for Ash
1. Free-tier: exempt the daily-brief job from the standing-task limit? (recommended: yes)
2. Brief delivery: `local` only, or also Telegram when connected?
3. Picker default sort: popularity vs category-grouped?
4. Getting-started completion: hide forever vs keep a tiny "setup ✓" affordance to reopen?
