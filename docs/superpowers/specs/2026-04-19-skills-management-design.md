# Skills Management Design

**Date:** 2026-04-19

**Status:** Proposed

**Scope:** Dashboard phase 1 only. No runtime refactor in this pass.

## Summary

The current dashboard skills page is a browser, not a manager. It lists installed skills from the upstream Hermes web dashboard API and supports search, category filtering, and a detail modal, but it does not let users install, import, remove, or curate skills from the dashboard.

This design adds a real skills-management surface to the dashboard without introducing a broad marketplace or a brittle dashboard-side execution layer. The phase-1 approach is intentionally narrow:

- Keep the installed-skills browser.
- Add a curated catalog of trusted skills.
- Add custom import entry points.
- Route install and import actions through the existing agent chat experience.
- Defer native dashboard enable/disable and uninstall controls until the upstream mutation contract is verified cleanly.

## Verified Facts

### Confirmed in this repo

- The current skills page is read-only and fetches skills through `GET /api/instances/[id]/skills`.
- The dashboard skills API route is `GET`-only and proxies the upstream `/api/skills` endpoint.
- The dashboard already has a reusable authenticated upstream web API client with `get`, `post`, `put`, and `del`.
- The dashboard already has a safe pattern for routing UX actions into chat using URL parameters and in-chat prompt injection.
- The roadmap copy already promises skill management as a platform feature.

### Confirmed in upstream Hermes docs

- Hermes stores skills in `~/.hermes/skills/`.
- Hermes supports skill installation and discovery from official, GitHub, well-known, and hub-like sources.
- Hermes supports agent-managed skill creation and editing through the `skill_manage` tool.
- Hermes supports per-platform enable and disable in its CLI/TUI experience.

### Not yet confirmed

- A stable upstream HTTP mutation contract for install, uninstall, or enable/disable that this dashboard can safely call directly.

Because that contract is not yet verified, phase 1 avoids direct dashboard-side mutations for those actions.

## Problem

Users can currently see what skills are installed, but they cannot manage that surface in a practical way from the dashboard.

The current experience has four product gaps:

1. It does not help users discover the small set of skills that are actually useful.
2. It does not let users add skills from a trusted curated list.
3. It does not provide a dashboard flow for custom import.
4. It does not distinguish between browsing installed skills and taking action on them.

The user goal for this pass is not a full public marketplace. The goal is a curated, opinionated management experience that feels safe and fast.

## Goals

- Turn the dashboard skills area into a management surface rather than a read-only list.
- Preserve the existing installed-skills browser and detail modal.
- Introduce a curated skills catalog maintained in this repo.
- Let a user install a curated skill with one click from the dashboard.
- Let a user import a custom skill by providing a source the agent can understand.
- Reuse existing dashboard chat and instance plumbing instead of inventing a new execution path.
- Keep the change surface small and regression-resistant.

## Non-Goals

- No open marketplace or broad “skills hub” browser in phase 1.
- No arbitrary remote code install pipeline owned by the dashboard.
- No attempt to rebuild every upstream CLI/TUI skill-management feature in one pass.
- No native enable/disable toggles in phase 1 unless the upstream HTTP contract is verified first.
- No hidden auto-installs with no visible user intent.

## Design Principles

### 1. Curated over open-ended

The dashboard should present a small, trusted set of recommended skills, not a giant searchable marketplace. This matches the product direction and materially reduces security and quality risk.

### 2. The dashboard chooses, the agent executes

The dashboard should be the control surface. The agent runtime should perform the install or import work. This avoids duplicating runtime logic in the dashboard and aligns with how Hermes already understands skill sources.

### 3. Reuse existing paths

This repo already has:

- an authenticated upstream web API proxy
- instance-aware chat routing
- URL-driven chat actions
- programmatic prompt injection into the composer

Phase 1 should reuse those patterns instead of creating a parallel execution subsystem.

### 4. Scope visible actions tightly

Every install flow should make the target instance and requested action explicit. The system should avoid ambiguous background behavior.

## Proposed UX

The skills page becomes a three-surface experience:

### Installed

Purpose: show what is already available on the target agent.

Behavior:

- Keep the current list, search, category filter, and detail modal.
- Add clearer grouping and labeling so the list is easier to scan.
- Preserve the enabled-state indicator if supplied by the upstream payload.
- Add lightweight metadata badges where available, such as source or trust state, if later payload enrichment makes that possible.

Phase-1 actions from Installed:

- `View`
- `Refresh`
- optional `Open advanced management` link to the official dashboard for users who want upstream-native tooling

Phase-1 does not include:

- native uninstall
- native enable/disable

### Curated

Purpose: let users discover and install trusted skills quickly.

Behavior:

- Show a curated set of skill cards managed in-repo.
- Each card should contain:
  - display name
  - short description
  - source label
  - tags
  - rationale or “why this is included”
  - install CTA
- Cards should be intentionally editorial, not exhaustive.

Install CTA behavior:

- Default phase-1 action opens or routes into the active instance chat with a structured install request.
- The user should land in the right instance context with the action ready to send.
- The flow may be either:
  - prefilled composer text with explicit send
  - or automatic dispatch into a fresh conversation if we decide that is safe and understandable

Recommended default:

- Prefill the action into the composer and require the user to send it.

Reason:

- It keeps the action explicit.
- It makes target and wording visible.
- It avoids surprise agent behavior.

### Import

Purpose: let users bring in custom skills without browsing a public marketplace.

Phase-1 import inputs:

- GitHub repo/path
- well-known skill URL or source URL

Phase-1 import behavior:

- Validate the input shape locally.
- Route into the active instance chat with a structured import request.
- Show simple guidance about acceptable source formats.

Potential phase-2 import additions:

- Paste raw `SKILL.md`
- Upload a skill archive

## Chat-Driven Action Model

Phase 1 uses the existing chat surface as the execution plane for installs and imports.

### Why this is the recommended path

- Upstream Hermes already knows how to work with skills.
- This repo already has a pattern for URL-param-driven chat actions.
- The dashboard can remain a thin orchestration layer.
- We avoid inventing and maintaining a new remote mutation API prematurely.

### Proposed action flow

1. User clicks `Install` on a curated skill or submits a custom import source.
2. Dashboard routes the user to the correct instance chat, preserving profile selection when relevant.
3. Chat receives a prefilled structured request describing:
   - the requested action
   - the skill source
   - the expected target behavior
4. User sends the action.
5. Agent performs the install or import using its existing runtime capabilities.
6. User returns to the Skills page or the Skills page refreshes after the action completes.

### Structured prompt shape

The message should be concise and deterministic enough that the agent acts predictably.

Examples:

```text
Install the curated skill from source `openai/skills/k8s` on this Hermes instance. Confirm success and tell me the installed skill name exactly as it appears in the skills list.
```

```text
Import a skill from this source on this Hermes instance: `https://example.com/.well-known/skills/index.json`. If multiple installable skills exist, tell me which ones you found before proceeding.
```

The dashboard should generate these messages from structured metadata rather than hard-coded ad hoc strings scattered through components.

## Data Model

Add a curated skills registry in the dashboard codebase.

Recommended file shape:

- `dashboard/src/data/curated-skills.ts`

Recommended fields per entry:

- `id`
- `name`
- `shortDescription`
- `sourceType`
- `sourceRef`
- `sourceUrl`
- `tags`
- `category`
- `trustNote`
- `installPromptTemplate`
- `featured`

This file should be editorial data, not a remote feed in phase 1.

## Routing Strategy

The dashboard already forwards selected URL params into the active instance route.

Phase 1 should extend that existing pattern instead of inventing a new cross-page state mechanism.

Recommended new params:

- `skillAction`
- `skillId`
- `skillSource`
- `skillSourceType`

These params should be consumed once, then removed from the URL after the chat handoff is prepared. That matches the existing pattern used elsewhere in chat-related flows.

## API Strategy

### Reuse now

- Keep `GET /api/instances/[id]/skills` for installed-skills browsing.
- Keep the upstream web dashboard API as the source for installed skill data.

### Do not add yet

- Do not add direct install, uninstall, or enable/disable APIs until the upstream contract is verified.

### Optional future API

If a clean upstream mutation contract is confirmed later, add narrow dashboard routes such as:

- `POST /api/instances/[id]/skills/install`
- `POST /api/instances/[id]/skills/import`
- `POST /api/instances/[id]/skills/toggle`
- `DELETE /api/instances/[id]/skills/:name`

That is explicitly out of scope for this phase-1 design.

## Enable / Disable Decision

Phase-1 recommendation: exclude native enable/disable from this implementation.

Reason:

- The runtime capability exists.
- The dashboard mutation contract is not yet verified.
- Shipping a partial or guessed toggle path would create more risk than value.

Interim UX:

- Show the enabled state if it is present in `/api/skills`.
- If users need advanced management now, offer an “Open official dashboard” path from the Installed surface or skill detail view.

## Information Architecture

Recommended page structure:

1. Header
2. Instance selector or connected-instance state
3. Top-level mode switch
   - Installed
   - Curated
   - Import
4. Context panel or notice
   - active instance
   - active profile if relevant
   - install behavior note: “Dashboard prepares the action, agent performs the install”

## Implementation Outline

### Dashboard files likely affected

- `dashboard/src/app/dashboard/skills/page.tsx`
- `dashboard/src/app/dashboard/chat/page.tsx`
- `dashboard/src/components/chat/HermesChat.tsx`
- `dashboard/src/components/chat/ChatInput.tsx` or a small helper near it
- `dashboard/src/data/curated-skills.ts` (new)
- `dashboard/src/lib/skills-actions.ts` (new helper for structured handoff)

### Possible optional additions

- a small reusable card component for curated skills
- a small import form component

## Risks

### 1. Source ambiguity

The installed-skills payload may not expose enough metadata to distinguish bundled, agent-created, or imported skills. The installed view should not depend on that metadata existing in phase 1.

### 2. Action visibility

Auto-sending install messages would be faster, but it is less explicit and more surprising. Prefill-first is safer.

### 3. Multi-instance confusion

If the user has multiple instances or profiles, the target of the install action must remain obvious at all times.

### 4. Catalog staleness

A curated registry is only useful if it stays current. The list should start small.

## Open Questions

These do not block the phase-1 design, but they affect implementation detail:

1. Should curated installs prefill the composer or auto-send into a new conversation?
2. Should the curated registry support both skill identifiers and raw GitHub paths from day one?
3. Should the Installed tab show the official-dashboard link at page level, row level, or both?
4. Should custom import support pasted raw `SKILL.md` in phase 1 or wait for phase 2?

## Recommendation

Build phase 1 as:

- Installed browser
- Curated catalog
- Custom import
- Chat-driven action handoff

Do not build:

- native enable/disable
- native uninstall
- open marketplace discovery

This gives the dashboard a real skill-management story quickly, stays aligned with the user’s product direction, and keeps the implementation on the smallest safe path.
