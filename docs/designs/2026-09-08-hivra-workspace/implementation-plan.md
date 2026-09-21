# Hivra workspace redesign: implementation proposal

**Status:** Design proposal for review, 2026-09-08. The adjacent prototype is a
standalone interaction study. This document does not replace approved product
direction, establish runtime support, or authorize deployment/public release.

## Outcome and governing sources

Make it easy to launch a resource, find it again, switch between agents and
computers, and work in its best supported interface. Retain Hivra's dark/Vellum
surfaces, etched borders, restrained red and distinctive typography. Put advanced
controls near the resource they affect, behind deliberate disclosure.

The governing order remains `VISION.md`, `docs/PRODUCT-ARCHITECTURE.md`,
`docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md`, then
`docs/superpowers/plans/2026-09-04-hivra-core-experience-reset.md` and `ROADMAP.md`.
The canonical design's sections “Experience Model,” “Access Surfaces,” and
“User experience verification” govern switching, native access and state truth.
The reset plan's “Core experience” governs launch, management and visual behavior.

## Proposed IA mapped to existing implementation

| Proposed responsibility | Existing route and implementation to evolve |
| --- | --- |
| Quiet shell, one resource switcher, one Launch entry | `dashboard/src/components/layout/DashboardSidebar.tsx`, `DashboardPageShell.tsx`; `dashboard/src/lib/dashboard-navigation.ts`; `dashboard/src/components/pwa/PwaBottomNavigation.tsx` |
| Resume work; first-run empty state | `/dashboard`; `dashboard/src/components/dashboard/home/HivraHome.tsx` |
| Agent inventory and selected-agent context | `/dashboard/agents`; `dashboard/src/components/agents/AgentsPage.tsx`; `dashboard/src/components/dashboard/command-center/HivraAgentsPanel.tsx` |
| Computer inventory and selected-computer context | `/dashboard/computers`; `dashboard/src/components/computers/ComputerCatalogPage.tsx` |
| One resumable Launch | `/dashboard/launch`; `dashboard/src/components/launch/LaunchJourney.tsx`; `dashboard/src/lib/launch/{contracts,draft-store,launch-adapter}.ts` |
| Work and contextual Manage | `/dashboard/agent/[id]`, `/dashboard/instances/[id]` and existing console/explorer/TUI routes; `dashboard/src/components/hivra/HivraManage.tsx` |
| Optional supported agent conversation pane | `/dashboard/workspace`; `dashboard/src/components/workspace/{UnifiedWorkspace,AgentRail,WorkspaceConversation}.tsx`, conversation/surface adapters; `dashboard/src/lib/workspace/` |
| Secondary activity, connections and settings | Existing `/dashboard/activity`, `/dashboard/infrastructure`, `/dashboard/settings`, billing/vault/tools routes; regroup entry points without deleting destinations |
| Shared clients and installation clarity | `dashboard/src/components/pwa/PwaInstallPrompt.tsx`; `apps/macos/HivraMac/Sources/HivraMac/{HivraRootView,HivraBrowserPane,HivraProfileStore}.swift`; `apps/macos/HivraMac/README.md` |

These are responsibility mappings, not a route-renaming instruction. Current
Computer inventory lists desktop-kind Hivra records; the compatibility agent
inventory spans separate source families. Showing every underlying computer
requires verified projections and identity deduplication, not relabelling agent
cards. Reuse `dashboard/src/lib/agent-computers/` contracts and existing source
adapters without changing their write authority as part of shell styling.

## Phase 1 — Existing shell, switching and inventory

1. Keep Home, agent/computer inventory and Launch immediately findable. Move
   low-frequency destinations into a labelled secondary area; preserve URLs,
   deep links, browser history and active navigation for every existing route.
2. Add a searchable resource switcher with separate Agent and Computer groups,
   a clear current selection and observed status. Open existing runtime routes.
   Switching must never provision, rebind an identity or start another resource.
3. Consolidate inventory hierarchy: name, kind/runtime or OS, real status,
   relevant placement, one Open action and contextual Manage. Move future OS and
   runtime previews into optional Explore/disclosures, preserving readiness links.
4. Keep first-run Home to two sibling launch choices. Returning Home shows
   Continue, actionable attention and recent resources; absent data is not zero.

**Acceptance:** keyboard and pointer switching select the same exact resource;
duplicate names remain distinguishable; stale/deleted selection has an explicit
recovery action; failed inventory loads do not become empty fleets; sidebar and
theme preferences survive refresh; mobile drawer state does not overwrite the
desktop preference. Back/Forward and pasted native-route links remain usable.
Record inventory identity/count parity before and after the implementation.

## Phase 2 — Launch and contextual Manage

1. Evolve `LaunchJourney` into resource type → runtime/OS → capacity → review →
   launch/open. Show one recommended allocation, a compact placement summary and
   one Advanced disclosure. Keep missing-capacity setup inline and resumable.
2. Preserve saved drafts, selected targets, back navigation and model/runtime
   authentication handoffs. Credentials remain at their current required boundary.
3. Keep cost, isolation, location and exact effects visible in review. Purchase,
   preparation and launch retain their distinct confirmation/operation contracts.
4. Open the existing best accepted surface after launch. Group lifecycle controls
   under Manage with capability-driven availability and existing confirmations.
5. Use in-flow layout for actions at small heights. Do not repeat the rejected
   sticky footer that obscured the name field in the 980×690 Mac app; see the
   reset plan's “2026-09-07 capacity-layout rejection.”

**Acceptance:** a draft survives Back, refresh and an interrupted connection step
without duplicate submission or changed target; keyboard focus moves to each
step heading but stays in edited fields; current action is reachable at 980×690
and 360px width without overlapping input. Expired plans, blocked capacity,
failed operations and resumed work expose observed state and the correct next
action. Existing launch/lifecycle APIs, spending boundaries and source authority
remain intact. Agent attachment remains gated by its separate implementation
and acceptance plan; a redesign cannot make it an enabled button by itself.

## Phase 3 — Optional supported agent conversations

1. Evaluate the existing `UnifiedWorkspace` as an optional entry from Agents.
   Reuse its adapters and persisted routing rather than building another chat
   store. No project or task is required for ordinary conversation.
2. Show selected agent, selected computer and native-interface entry clearly.
   Remember interface preference; collapse auxiliary Files/Git/Terminal/Browser
   controls without hiding the conversation or runtime-specific workflow.
3. Retain owner/source identity checks, request cancellation on switching,
   per-agent state and capability intersection. Never render a late response from
   agent A inside agent B's view or carry a composer draft to another recipient.
4. Do not present `UnifiedWorkspace` as supporting Desktop merely because a
   desktop surface exists in a type or resource capability list. Keep Desktop on
   its working resource route until an implemented adapter and live acceptance
   prove that exact selected-computer surface.

**Acceptance:** selection, conversation and supported surface survive refresh;
rapid A→B switching discards stale responses; unsent drafts retain their recipient;
unsupported surfaces stay unavailable with truthful recovery/native navigation.
Pass canonical `UX-CHAT-01`, `UX-RUN-REFRESH-01`, `UX-APPROVAL-01`,
`UX-INPUT-01`, `UX-BLOCKED-01`, `UX-NATIVE-01` and `UX-NETWORK-01` on the
supported path before considering a default-workspace change. A successful
fixture rendering is not proof of durable execution or a live surface grant.

## Phase 4 — Shared web/PWA/Mac and application clarity

1. Apply the accepted web shell to PWA and the Mac Alpha without copying launch,
   resource or credential logic into Swift. Keep native toolbar actions focused
   on connection, navigation, detach and supported native capabilities.
2. Preserve separate Local, Canary/hosted and Custom connection profiles and
   origin-isolated sessions. “No Hivra Cloud account required” must not imply no
   installation-local authentication.
3. Design one clear installation/access entry describing web access, PWA install
   and the Mac build's actual distribution status. No dedicated download route
   was established by this audit; select its location during phase review.
4. Label Mac Alpha, supported platforms and required setup accurately. Public
   download/signing/notarization/update claims require accepted artifacts and
   separate release authority; Windows client and Windows guest are distinct.

**Acceptance:** the same resource and draft open correctly in browser, PWA and
the actual Mac window; profile switching preserves origin boundaries; Back,
Forward, Detach, focus and reconnect work. Verify installation copy against the
actual artifact, then test the exact permitted install/update path. Do not infer
distribution readiness from a successful local build.

## Phase 5 — Durable multi-agent orchestration, later

Keep coordinated tasks, dispatcher controls and multi-agent execution out of
the initial redesign. Revisit after single-agent delivery/execution, authority,
recovery and bounded cancellation are proven. Use the approved reset plan's
“Multi-agent orchestration” and Slice 8: real tasks/runs, attention states,
artifacts, scoped computers/credentials/budgets and revocable delegation.
Conductor is research input; develop Hivra's own terminology and interaction
design. Acceptance must include refresh, disconnect, restart and partial failure
without fabricated queue, progress, agents or completion.

## Verification and implementation handoff

After design review, implement each phase on a branch in reviewable commits and
PRs. Keep earlier working routes accessible until parity and rollback are proven.
Read `dashboard/AGENTS.md` and the installed Next.js documentation before code
changes. The following commands are planned checks, **not executed evidence**.

From `dashboard/`, Phase 1 focused checks:

```sh
npm run verify:plan -- --risk normal
npm test -- --runInBand --runTestsByPath src/lib/__tests__/dashboard-navigation.test.ts src/components/layout/__tests__/DashboardSidebar.test.tsx src/components/dashboard/home/__tests__/HivraHome.test.tsx src/components/computers/__tests__/ComputerCatalogPage.test.tsx src/components/pwa/__tests__/PwaBottomNavigation.test.tsx
```

Phase 2 focused checks, expanding to affected hot paths when logic changes:

```sh
npm run verify:plan -- --risk high
npm test -- --runInBand --runTestsByPath src/app/dashboard/launch/__tests__/page.test.tsx src/lib/launch/__tests__/draft-store.test.ts src/components/hivra/__tests__/HivraManage.test.tsx
```

Phase 3 focused checks:

```sh
npm test -- --runInBand --runTestsByPath src/components/workspace/__tests__/UnifiedWorkspace.test.tsx src/components/workspace/__tests__/workspace-navigation.test.tsx src/components/workspace/__tests__/workspace-conversation-adapters.test.tsx src/components/workspace/__tests__/workspace-surface-adapters.test.tsx src/lib/workspace/__tests__/workspace-persistence.test.ts
```

Run `npm run typecheck`, lint touched files, and `npm run build` for integrated
UI changes; follow `verify:plan` for any broader required checks. For native code,
run `swift test` from `apps/macos/HivraMac`. Extend existing tests with behavioral
regressions above; avoid CSS-string assertions as proof of visual usability.

Use `.codex/skills/live-environment-verification/SKILL.md` for implemented UI
acceptance. After an authorized Canary deployment, record exact revision/target,
desktop and 360px mobile browser results, 980×690 Mac results where relevant,
keyboard/zoom/theme checks, resource preservation and session cleanup. Obtain
exact target authority before any deployment or live lifecycle action. Distinguish
prototype review, implementation checks, deployment and live acceptance.
