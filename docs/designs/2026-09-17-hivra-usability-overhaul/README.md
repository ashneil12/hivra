# Hivra dashboard usability and visual overhaul

**Status:** Scoping proposal for owner review, 2026-09-17. Not approved. This
document does not supersede `VISION.md`, `docs/PRODUCT-ARCHITECTURE.md`, the
canonical agent-computers design, or the reset plan. Current behavior and target
behavior are kept visibly distinct throughout.

## Open the click-through prototype

From the repository root:

```sh
node docs/designs/2026-09-17-hivra-usability-overhaul/serve.cjs
```

Open **http://127.0.0.1:4197** in a browser. The prototype is standalone: local
assets only, no CDN, no account, no dashboard backend. Stop the server with
Ctrl+C. Any static file server works; this script exists because the machine's
`python3` is currently blocked by an unaccepted Xcode license.

Interaction checks (after the dashboard's development dependencies are
installed):

```sh
node --test docs/designs/2026-09-17-hivra-usability-overhaul/prototype.test.cjs
```

It uses fictional example data and local interactions only. It cannot launch a
VM, message an agent, operate a computer or change any real resource. Assets
(fonts, icon set, particle canvas) are reused from
`docs/designs/2026-09-08-hivra-workspace/` with their OFL license texts.

### What to try

1. **Home (returning)** — compact greeting, Continue cards, one attention item,
   and a calm recent list. Nothing below the fold; no fleet analytics theatre.
2. **First-run state** (link in the top strip) — only two sibling actions:
   Launch an agent / Launch a computer.
3. **Workspace** (open Patch from Home or Agents) — rail on the left switches
   agents and computers, with collapsible groups and counts; the context bar
   carries the session switch and Manage; the center keeps the selected work
   surface.
4. **Chat** — the primary surface, built to be used often: streaming replies,
   tool cards that expand to their real output, an approval card you approve or
   deny in place, copy actions, attachments, and suggestion chips in a fresh
   chat. The session switcher starts a new chat or restores a previous one.
5. **Manage** — the control room per resource. Computers: power with live
   status transitions (Restart shows Starting, then recovers), a real resize
   flow (steppers, presets, pending banner surfacing in the context bar and
   rail, cancel), disk usage, snapshots, recovery, rename that updates
   everywhere, and Destroy gated behind typing the exact resource name. Agents:
   runtime restart, model, computer, access and removal.
6. **Terminal** — press Detach: the session keeps running and reattaches with
   scrollback intact. This is the Herdr-style embed, native to the pane.
7. **Launch** — Choose → Configure → Review in one screen each; the ready panel
   hands straight into the workspace. Preparation steps are simulated and
   labelled as such.
8. **Command palette** — ⌘K / Ctrl+K or the search row; filters agents and
   computers and jumps into the workspace.
9. **Theme + mobile** — toggle light/dark in the top strip; narrow the window to
   see the bottom nav and the rail collapsing to a Fleet sheet.

## Why this exists

The owner paused the Atlas-as-default-workspace direction on 2026-09-17 (PR #620
closed unmerged; work preserved on its branch and local park branches). The
direction is now: keep the current Hivra dashboard, and make it genuinely usable
through a visual and interaction overhaul, using Atlas, Conductor and Herdr as
**interaction references only**. The desired end state has two anchors:

1. One clear, calm place to manage agents and computers (simpler than Atlas and
   Conductor, not a clone of either).
2. Herdr-style terminal sessions embedded inside the current UI as native panes
   (like an iframe, but not an iframe), not as links to another product.

This scoping pass audits the current surfaces, defines the overhaul scope and
phases with acceptance criteria, and lists the decisions still needed from the
owner before implementation starts.

## Relationship to existing documents

- Builds on `docs/designs/2026-09-08-hivra-workspace/` — its live-screen audit
  remains the fullest usability evidence; its implementation proposal is now
  partially superseded (no Atlas migration, no shared workspace pane promotion
  in the first phases).
- Implements, for these surfaces, the approved reset plan sections "Core
  experience" and "Visual and interaction rules"
  (`docs/superpowers/plans/2026-09-04-hivra-core-experience-reset.md`).
- Reference inputs only:
  - **Atlas** (upstream pin recorded under `upstream/ports/atlas` on its branch):
    dense control-panel grouping, collapsible sections, compact status.
  - **Herdr** (upstream pin under `upstream/ports/herdr` on its branch):
    terminal-first working view, one session per pane, detach without stop.
  - **Conductor** (public docs only): parallel-agent overview patterns.
- Reset plan constraint applies unchanged: do not copy Conductor code, assets,
  prose, exact layouts, shortcuts, or trade dress. Any Atlas/Herdr source reuse
  must go through the existing `upstream/ports` provenance process; this plan
  borrows interaction patterns, not source.

## Verified current state (2026-09-17)

Checked on branch `codex/agent-terminal-files-leftovers-20260916`. Evidence is
from the working tree; live-canary rendering was not audited in this pass.

### Shell and navigation

- `dashboard/src/lib/dashboard-navigation.ts`: primary (Home, Computers, Agents,
  Activity), secondary (Infrastructure, Settings), standalone Launch, utility
  (Applications, Help).
- `dashboard/src/components/layout/ClientLayoutWrapper.tsx`: sidebar + mobile
  header + `PwaBottomNavigation` can render together on non-exempt routes.
- `DashboardSidebar.module.css`: 10px group headings, 11px notices, 12px footer
  nav; 36px rows at fine pointers.
- `DashboardSidebar.tsx` L30/L120: `showOpsLink` is passed but never used —
  the Ops destination is unreachable from the sidebar (verified dead prop).
- Sidebar labels localize only six ids; Activity/Applications/Help/resource
  headings and the mobile bottom nav stay English.

### Home

- `dashboard/src/app/dashboard/page.tsx` (2,473 lines) renders one of three
  surfaces: `HivraHome`, inline Command Center V2, or legacy V1.
- Headings clamp up to 4.4rem/3.5rem; the primary task can sit below the fold.
- `dashboard/src/components/dashboard/home/HivraHome.tsx` L50 declares
  `onLaunch` but never calls it; `page.tsx` L2200 passes it. Empty-state copy
  says "Choose Launch to launch your first agent/computer" (L602/L639) with no
  button — a dead end (verified).
- Home and Agents both render agent inventory; status casing differs between
  surfaces (`{computer.status}` shown raw vs `sentenceCase` on Home).

### Agents and Computers

- `components/agents/AgentsPage.tsx` (153 lines): header CTA → `HivraAgentsPanel`
  (search/filters/refresh) → collapsed "Browse agent runtimes" `<details>`.
- `components/computers/ComputerCatalogPage.tsx` (371 lines): header CTA →
  "Your computers" list → collapsed OS catalogue.
- `Launch Windows` in the OS catalogue is enabled even where card copy says
  capacity must be connected first (code-visible; behavior unverified live).

### Launch

- `components/launch/LaunchJourney.tsx` (998 lines): Choose → Configure →
  Review with resumable draft, uncertain/failed outcome states.
- Large headings and review rows can push the primary action below the initial
  viewport; the 2026-09-07 rejected sticky footer must not return
  (reset plan "capacity-layout rejection").

### Agent workspace

- `app/dashboard/agent/[id]/page.tsx`: 12 tabs — Chat, Dashboard (aeon),
  Desktop, "Claude Code Terminal", Browser, Box Terminal, Files, Git, Skills,
  Telegram, Tasks, Manage (verified list, L64–76).
- Three terminal UI technologies coexist: native xterm
  (`components/TerminalPanel.tsx`, `ShellTerminalWorkspace.tsx`, Hermes),
  ttyd iframes (Hivra terminal/box), and guided dead-ends for Windows/
  disconnected computers that push users to Desktop.
- Once opened, terminal, box and desktop iframes stay mounted simultaneously
  (retained sessions); heavy sessions accumulate.
- `?tab=` is validated against the full tab list, not the per-agent filtered
  list; an unreachable value silently falls back while the URL keeps it.
- Browser surface is explicitly read-only.

### Gated workspace route

- `app/dashboard/workspace/page.tsx`: gated by `HIVRA_WORKSPACE_SHELL_ENABLED`
  (default off; nav flag separate). `UnifiedWorkspace` provides a rail,
  conversation pane and surface adapters with persisted selection.
- Its Hivra terminal/browser surfaces are placeholder frames whose only action
  is "Open in new tab" — dead ends inside the workspace (verified in
  `workspace-surface-adapters.tsx`).

### Visual system

- Tailwind v4 + CSS modules + many inline styles; tokens in `globals.css`
  (`--vellum-bg #fdfcf9`, `--ink-black #1a1a1a`, dark `#0d0d0d`, `#ff3a3b`).
- Fonts: Outfit body, Space Mono metadata, Space Grotesk display (`.serif`);
  interactive particle canvas plus vellum texture overlay.
- Identity to preserve: near-black/paper/crimson, etched borders, white primary
  buttons, grain, red particle connections, editorial/technical type contrast.

## Scope

**In scope (Canary web + PWA surfaces):**

1. Shell, navigation, and typography legibility.
2. One Home with an honest empty state and no dead ends.
3. Agents and Computers inventory clarity.
4. Launch presentation pass (no contract or API changes).
5. Agent workspace consolidation, including a native terminal path.
6. Visual system consolidation and an accessibility/mobile sweep.

**Out of scope:**

- Atlas/Herdr forks, ports, or migration (parked 2026-09-17; separate decision
  if ever revisited).
- Backend, auth, billing, provisioning, database, or lifecycle contract changes.
- The Mac app, public website, and token/litepaper surfaces.
- New orchestration features (multi-agent dispatch, tasks, queues).
- Promoting the gated workspace route to any default before phase 5 acceptance
  and a separate owner decision (see Open questions).

## Guiding rules (from the approved reset plan, applied here)

- One primary action per state; remove repeated Launch/Manage/Continue controls
  with the same destination.
- Hierarchy comes from spacing, type and disclosure before another card, tag, or
  divider.
- Status color only for observed state; red must not make idle look failed.
- Empty, loading, blocked, failed, expired and resumed states are designed with
  the same care as success.
- The current decision, its explanation and its action fit the initial desktop
  viewport; 360px mobile, keyboard order, focus, zoom and reduced motion are part
  of acceptance — not a later polish pass.
- No fabricated progress; counts and states come from the existing APIs.

## Phases, deliverables and acceptance

Each phase lands as its own reviewable PR on a branch, keeps existing URLs and
flags working, and adds behavioral regression tests.

### Phase 1 — Legible shell and navigation

Deliverables: consistent type scale for shell text (no 10px operational text);
one mobile navigation layer at a time; completed sidebar localization; fix or
remove the dead `showOpsLink`; active-state correctness for `/dashboard/agent/*`
already resolved by resource kind (keep).

Acceptance: sidebar/mobile checks pass; keyboard focus order intact; no layout
regression at 360px/768px/1024px; existing navigation tests extended, not
replaced.

Focused checks: `dashboard-navigation.test.ts`, `DashboardSidebar.test.tsx`,
`ClientLayoutWrapper.test.tsx`, `PwaBottomNavigation.test.tsx`.

### Phase 2 — One Home

Deliverables: retire the three-way Home split on Canary (Command Center V2 and
legacy V1 behind an admin-only flag or removed from the Canary path); the empty
state shows the two approved actions (Launch an agent / Launch a computer) wired
to real navigation; remove the dead `onLaunch`; returning Home shows Continue,
attention, recent resources; de-duplicate inventory that belongs to Agents and
Computers pages.

Acceptance: empty/returning/partial states render correctly with real data and
without data; no dead-end copy remains; Home and Agents agree on status wording.

Focused checks: `app/dashboard/__tests__/page.test.tsx`,
`HivraHome.test.tsx`.

### Phase 3 — Agents and Computers inventory clarity

Deliverables: row hierarchy (name, kind/runtime or OS, observed status, one
Open, contextual Manage); consistent status vocabulary sourced from one helper;
catalogues stay collapsible; `Launch Windows` disabled state honest when capacity
is missing (or clearly routed with truthful copy).

Acceptance: keyboard and pointer reach the same actions; duplicate names remain
distinguishable; failed inventory loads do not render as empty fleets; status
wording matches Home.

Focused checks: `AgentsPage.test.tsx`, `ComputerCatalogPage.test.tsx`,
`HivraAgentsPanel.test.tsx`.

### Phase 4 — Launch presentation pass

Deliverables: heading scale and spacing so the current step and primary action
fit the initial viewport at 980×690 and 360px; in-flow actions only (no sticky
footer); compact review rows; keep draft persistence, contracts, and outcome
states unchanged.

Acceptance: draft survives Back/refresh/interruption; focus moves to step
headings but stays in edited fields; expired/blocked/failed/resumed states show
observed state and the correct next action.

Focused checks: `launch/__tests__/page.test.tsx`, `lib/launch/__tests__/
draft-store.test.ts`, `lib/launch/__tests__/launch-adapter.test.ts`.

### Phase 5 — Agent workspace consolidation and native terminal

Deliverables, in order:

1. Primary work area first: Chat (or the computer's working surface) opens as
   the default and keeps the most vertical space; tools group under Computer
   (Desktop, Terminal, Files, Git, Browser, Box) and configuration under Manage.
2. One terminal story: prefer the existing native xterm path
   (`TerminalPanel`/`ShellTerminalWorkspace`) for runtimes where the gateway
   WebSocket contract is proven; ttyd iframes remain only where no native path
   is accepted yet, and Windows/disconnected cases keep truthful guidance.
3. Retained-session discipline: do not keep terminal, box and desktop sessions
   mounted simultaneously beyond what the user opened and still needs; closing a
   pane must not stop a run (align with Herdr's detach-without-stop behavior).
4. Fix `?tab=` fallback so the URL, the visible tab and the per-agent tab list
   always agree.
5. Reuse `UnifiedWorkspace` building blocks (rail, persisted selection, adapters)
   only where they already pass their own acceptance; do not promote the gated
   route to any default in this phase.

Acceptance: on a supported runtime, a user opens Chat, runs one command in the
embedded terminal, closes the pane without stopping the run, and reopens it with
history intact; rapid agent switching discards stale responses; unsupported
surfaces show recovery actions, not dead ends. Hot-path checks pass before any
default-surface change (reset plan UX checks `UX-CHAT-01`, `UX-RUN-REFRESH-01`,
`UX-INPUT-01`, `UX-BLOCKED-01`, `UX-NATIVE-01`, `UX-NETWORK-01`).

Focused checks: `agent/[id]/__tests__/page.test.tsx`,
`TerminalPanel.test.tsx`, `ShellTerminalWorkspace.test.tsx`,
`workspace-surface-adapters.test.tsx`, `workspace-persistence.test.ts`.

### Phase 6 — Visual system and mobile sweep

Deliverables: shared type/spacing scale applied across Home, inventories, Launch
and agent pages; consolidate token drift where inline styles disagree with
`globals.css`; dark and light parity; reduced-motion path verified for the
particle background; 360px and phone-width pass across all touched surfaces.

Acceptance: no text below 12px for operational content; contrast and focus
visible in both themes; no document overflow at 360px; motion respects
`prefers-reduced-motion`.

## Verification and delivery

- Risk-based checks per `dashboard/AGENTS.md` and repo AGENTS.md:
  `npm run verify:plan -- --risk <tiny|normal|high>`; focused Jest suites per
  phase; `npm run typecheck`; lint on touched files; production build for
  integrated UI changes.
- Live acceptance for user-facing phases follows
  `.codex/skills/live-environment-verification/SKILL.md` after an authorized
  Canary deployment, recording revision, browser results (desktop, 360px,
  980×690 where relevant), and cleanup.
- No phase may claim success from fixture rendering alone.

## Risks and unknowns

- Native terminal coverage per runtime is unproven; the ttyd path may be the
  only accepted transport for some Hivra agents for now. Phase 5 acceptance is
  written to allow partial capability with honest UI.
- The retained-session change touches behavior users may rely on; it needs care
  and tests before landing.
- Retiring Home variants could remove an admin path; confirm the flag decision
  below before Phase 2.

## Direction update — 2026-09-17: a top-level Chat entry

Owner review of the prototype added one hard requirement: a **Chat** destination
in the primary navigation that lists every agent and switches the conversation
in place, so talking to another agent never requires `Agents → open → find chat`.

**Shipped in this slice (branch `codex/hivra-chat-entry-20260917`):**

- `Chat` primary destination → `/dashboard/workspace` (the existing gated
  workspace: agent rail, conversation, surfaces).
- The entry renders only when the workspace shell rollout is enabled for the
  environment (`NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED`, client-visible
  decision), matching the server gate on the route itself, so no environment
  gets a dead link. Canary enables both variables; production stays off until
  the owner says otherwise.
- `/dashboard/workspace` no longer maps to the Agents item; legacy
  `/dashboard/chat` stays under Agents until the workspace shell replaces it.
- Mobile rail becomes Home, Chat, Launch (centre), Agents, Computers; Activity
  stays desktop-first.

**Known gaps carried into later slices (not yet implemented):** first-use
landing still shows the agent picker rather than auto-opening the last
conversation; the Chat surface keeps its current presentation (tool cards,
approvals and session handling land in slice 5); Agent-name search and recent
conversations are not in the rail yet.

**Deploy receipt (2026-09-17):** `dpl_6ujYZjW8EkibBwPWbuxqWXKKfoTn`, production
target of the `hermesos-canary` project, aliased to
https://canary.hermesos.cloud. The rollout flags
(`HIVRA_WORKSPACE_SHELL_ENABLED`, `NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED`)
were already `"1"` in that project's production environment. The build is the
committed tree at `codex/hivra-chat-entry-20260917`; authenticated Chat-entry
verification is the owner's next step.

**First polish pass (owner review of the live surface):** the live rail showed
internal strings ("Source: … · Observed: …"), computers mixed into the agent
list, and QA chrome in the header. Fixed: rows read "Runtime · Status",
Agents and Computers are separate groups, the rail is titled "Your fleet",
duplicate names carry a short `#id`, the header drops "Canary preview" and
reduces the Test guide trigger to a quiet icon, and the legacy-session notice is
a muted info row. Deployed in `dpl_2nAnnK5faATuuKwZkDpgF5qgDCEA`; the deeper
chat presentation (messages, composer, sessions) remains slice 5.

**Second polish pass (same day):** `HivraChat` chrome restyled to the mock
language — quiet sessions rail, boxed composer with inline controls, dot
streaming state, rounded avatars and user bubbles, rounded starter/retry/
attachment chips. Deployed in `dpl_AR9LpQdy9x5CqqfvaUvsgcHTErHG`. Live
rendering of this pane still needs an account that owns Hivra agents; the QA
harness account has none.

**Third pass — reachability (owner report: "there's no chat area, no chat
button").** Verified against the live surface with an authenticated browser
session on the owner's own account, which owns seven real resources. Two
reachability defects, neither visible from the QA account:

1. Opening Chat with nothing selected rendered the agent picker and a blank
   pane. The nav destination looked broken next to the Agents page it is meant
   to replace. Chat now opens the first running agent, falling back to the
   first listed, and persists that choice. A saved selection that no longer
   resolves still shows the recovery notice without activating a different
   agent — that contract is unchanged and still covered by its tests.
2. Agents whose catalog surface is `dashboard` (Agent Zero, Aeon, OpenClaw)
   have no chat-CLI endpoint, so the conversation adapter returned null and the
   pane showed a state table reading "no canonical run acknowledgement" with no
   route to the running runtime. Those agents now embed their own web UI in the
   pane via a shared `RuntimeSurfaceFrame`; the per-agent page uses the same
   component. The bootstrap token still travels only in a hidden POST form
   targeted at the frame and never reaches a URL.

Also fixed while in the file: `HivraChat`'s inline-code background was a
light-on-dark literal that rendered near-invisible in light mode.

Deployed in `dpl_DHXQvYTb7CZbK8dzJ2EnEojYU18e`. Verified live on the owner's
account in both themes: Chat auto-opens a real conversation, and selecting
Agent Zero loads its actual runtime ("Hello! I'm Agent Zero", Quick Actions,
Chats) inside the pane.

**Fourth pass — the cascade bug (owner report: "the sidebar looks bad, and the
top area too, no spacing, the theme is off").**

The spacing complaint had a single root cause, and it was not styling taste.
`globals.css` declared `* { margin: 0; padding: 0 }` and `button { border: none }`
at the top level, with no `@layer`. Unlayered rules outrank every layered rule in
the CSS cascade, and Tailwind v4 emits all its utilities inside `@layer
utilities`. So those two lines silently defeated every Tailwind spacing and
border utility in the entire app. Measured on the live tab strip: the element
carried `px-3.5` and computed `padding: 0px`; the selected tab carried
`border-b-2` and computed `border-bottom-width: 0px` — which is why the mockup's
red active-tab underline had never rendered.

Both resets now live in `@layer base`, where Tailwind's own preflight already
zeroes the same properties. Utilities win again, and the cascade reads the way
every component in this repo was written assuming it did. **This touches every
route, not just the workspace.**

With utilities live, the shell was aligned to the prototype's measured metrics:

| | Prototype | Before | Now |
| --- | --- | --- | --- |
| Sidebar width | 248px | 256px | 248px |
| Nav row height / radius | 38px / 5px | 36px / 0px | 38px / 5px |
| Nav label | 13.5px | 13px | 13.5px |
| Active nav tint | red-soft .16 | .08 | .16 |
| Workspace header | 59px, 14px 20px | 56px, no padding | 59px, 14px 20px |
| Tab strip height | 44px | 52px | 44px |
| Tab label | 13px | 12px | 13px |
| Active tab underline | 2px red | 0px (invisible) | 2px red |

Deployed in `dpl_F3KWL9a2T6H1a7y7QJ8sG7RMaGzH`. Verified live in both themes:
the active tab now renders a 2px `rgb(255,58,59)` underline, nav rows are 38px
with 5px radii and real spacing, and the header measures 59px with padding.
1371 tests pass across `src/components` and `src/app/dashboard`.

**Remaining, still open:** the chat presentation list below (slice 5) is
unchanged by this pass; the "Legacy session" info row is honest but visually
heavy at 37px on every conversation; and the prototype's status chips plus
New/Manage are still missing from the context bar.

## More ideas (queued, not yet implemented)

- **Auto-open last conversation** on Chat, with a truthful empty state when
  nothing has been talked to yet.
- **Recent conversations** group at the top of the rail; switching sessions per
  agent without leaving Chat.
- **"Working now" strip** on Home: one row per active run with elapsed time from
  real events, linking straight into the conversation.
- **Command palette upgrade** (⌘K): type `chat <agent>` to jump straight into a
  conversation; needs permissions to stay honest.
- **Inline capability chips** in the composer (model, runtime, computer) that
  deep-link to the exact Manage section instead of a generic drawer.
- **Resize preview**: show the new hourly estimate next to the pending banner
  and allow scheduling at the next restart from the rail row menu.
- **Snapshot naming** and "restore as a copy" to make recovery safe for humans.
- **Attention digest**: one actionable sentence per interrupted agent with a
  single primary action, reusing the same vocabulary as Home.
- **Chat-first mobile**: composer stays visible above the keyboard; the rail
  becomes a swipeable sheet.

## Implementation slices

1. **Chat entry** — shipped (navigation, mobile rail, flag gating, tests).
2. **Home truth pass** — wire the dead first-run Launch actions, retire the
   legacy Home variants on Canary, dedupe Home vs Agents inventory.
3. **Launch presentation** — heading scale, in-flow actions, review above the
   fold at 980×690; no contract changes.
4. **Agents and Computers inventory** — one status vocabulary, row hierarchy,
   honest disabled states for catalogue items missing capacity.
5. **Chat surface parity** — tool cards, approval cards, session switcher,
   streaming states matching the prototype; per-agent drafts preserved.
6. **Manage depth** — resize flow with pending state, snapshots, rename,
   destroy confirmation, capability-gated actions only.
7. **Visual system + accessibility sweep** — type scale, tokens, dark/light,
   reduced motion, 360px and keyboard passes.

## Open questions for the owner

1. Home variants: remove Command Center V2 and legacy V1 from the Canary path
   entirely, or keep them behind an admin-only flag?
2. Phase 2 empty-state actions: "Launch an agent" and "Launch a computer" as the
   only two first-run actions are the approved reset behavior — confirm nothing
   else (demo, tour, docs) belongs there.
3. Phase 5 terminal priority order: which runtime first for the native terminal
   path — the Codex/Claude Code agents, or Hermes-managed agents?
4. Central work surface: decided — the workspace becomes the Chat destination
   (slice 1 shipped). The per-agent page stays the deep-work route; revisit
   consolidation after slices 2–6 pass.
5. Visual references: any specific Atlas or Herdr screens to match most closely
   for density and terminal presentation?
