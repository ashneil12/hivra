# Hermesdeploy Developer Mode and TUI Design

**Date:** 2026-04-21  
**Status:** Proposed  
**Scope:** Welcome deploy presets, instance runtime modes, terminal surfaces, and developer recovery flows

---

## Goal

Add a developer-friendly operating mode to Hermesdeploy without turning the whole product into a terminal-first application.

The intended result is:

1. standard users keep the current polished dashboard/chat experience
2. developers get persistence and deeper runtime control when they ask for it
3. the existing dedicated TUI remains available as its own surface, rather than being hidden behind Developer Mode
4. risky privilege changes stay explicit, reversible, and redeploy-gated

---

## Current State

### Welcome deploy is managed-first

Welcome deploy currently hardcodes a managed posture:

- `enableRootAccess: false`
- `mountPersistentSource: false`

Relevant file:

- `dashboard/src/lib/welcome-deploy.ts`

### Runtime root access already exists

Instance/profile runtime settings already expose root access controls and warning copy.

Relevant file:

- `dashboard/src/components/chat/profile-settings/AgentProfileRuntimeSection.tsx`

### The current modal terminal is not the native TUI

The quick terminal experience is a custom xterm-based shell with Hermes-branded presentation.

Relevant file:

- `dashboard/src/components/TerminalPanel.tsx`

### A dedicated TUI surface already exists

Hermesdeploy already has a dedicated full-page TUI route:

- `dashboard/src/app/dashboard/instances/[id]/tui/page.tsx`

This is important for the design: Developer Mode should not be the feature flag that creates TUI access. The TUI already exists as its own front door.

### Backend deploy primitives already support deeper runtime control

The deployment builders already support:

- persistent source mounts
- root/privileged deployment mode
- root-home based runtime wiring

Relevant file:

- `dashboard/src/lib/services/hetzner-instance-builders.ts`

---

## Product Decision

Hermesdeploy should treat these as separate but related concerns:

### 1. Surface choice

Users can work through different front doors:

- standard dashboard chat
- advanced console
- dedicated TUI page

These are surfaces, not privilege levels.

### 2. Runtime mode

Instances can run in:

- `managed`
- `developer`

This controls persistence and hackability, not whether the TUI route exists.

### 3. Privilege level

Privilege stays a separate escalation:

- root access remains off by default
- root access requires strong confirmation
- root access requires restart/redeploy

This separation avoids one overloaded switch trying to mean "more terminal", "more persistence", "more root", and "more developer."

---

## Target Model

### Runtime modes

Introduce a user-facing runtime model with two main states:

- `Managed`
- `Developer`

Recommended backend mapping:

- `Managed`
  - `runtimeMode = managed`
  - `mountPersistentSource = false`
  - `enableRootAccess = false`
- `Developer`
  - `runtimeMode = developer`
  - `mountPersistentSource = true`
  - `enableRootAccess = false`

`Root` is not a separate top-level runtime mode. It is an additional explicit toggle layered on top of `Developer`.

### Root escalation

When root is enabled:

- `runtimeMode = developer`
- `mountPersistentSource = true`
- `enableRootAccess = true`

This creates a clean ladder:

- `Managed -> Developer -> Developer + Root`

---

## UX Model

### Welcome deploy

Welcome deploy should remain simple by default.

Recommended shape:

- keep the current clean deploy flow for normal users
- add a `Developer Mode` expandable preset block
- default state: off
- when enabled, show:
  - what Developer Mode changes
  - that root access is still separate
  - that settings can be refined later in Advanced Console / runtime settings

Default bundle when `Developer Mode` is enabled during deploy:

- developer runtime mode on
- persistent developer workspace on
- root access off

The dedicated TUI should be described as an available workspace/surface, but not as something unlocked by Developer Mode.

### Instance-level settings

After deploy, the instance should expose the same model in runtime settings:

- `Runtime Mode`
  - `Managed`
  - `Developer`
- `Root Access`
  - available only when `Developer` is active
  - clearly marked as redeploy/restart required

### Surface entry points

Keep surface choices explicit:

- standard chat remains the default primary experience
- the current xterm modal becomes clearly framed as `Advanced Console`
- the dedicated TUI page remains a separate page for people who prefer Hermes' terminal-dominant workflow

The product should not imply that switching runtime mode changes the entire visual shell of the instance.

---

## TUI Positioning

### Dedicated TUI is independent

The dedicated TUI route should remain independently accessible.

It should not be gated behind Developer Mode because:

1. it already exists
2. surface preference and runtime privilege are separate concerns
3. some users may prefer the TUI interface without wanting persistent source mounts or root behavior

### Relationship to chat

The dashboard chat and the dedicated TUI should:

- point at the same deployed instance
- use the same environment and instance-level configuration
- remain separate active surfaces

Plain English:

- same agent environment
- different front doors
- no need to replace the main dashboard with the TUI

### Relationship to Advanced Console

The current modal terminal should still exist, but as a quick utility shell rather than a substitute for the native TUI.

Recommended product language:

- `Advanced Console` for quick shell work
- `Dedicated TUI` for longer Hermes-native sessions

---

## Recommended Developer Defaults

Because the product goal is "more support for developers" without normalizing dangerous behavior, the recommended defaults are:

### Managed

For standard users:

- no persistent source mount
- no root access
- standard chat default

### Developer

For people who want to tinker:

- persistent config/profile behavior
- persistent source/workspace mount
- standard chat still available
- dedicated TUI still available
- Advanced Console available
- no root access by default

### Developer + Root

For people who truly need deep control:

- all developer-mode persistence
- root/privileged runtime enabled
- strong warning and confirmation
- redeploy/restart required

This is the safest path that still gives meaningful developer value on day one.

---

## Recovery Model

Developer-facing features should be reversible by design.

Two explicit recovery actions should always be available when Developer Mode is active:

### Reset Developer Changes

Purpose:

- clear persistent developer drift
- keep the instance itself
- return the developer workspace/config to a clean baseline

This is the "start fresh but remain in developer mode" action.

### Return to Managed Mode

Purpose:

- disable developer runtime mode
- remove persistent developer mounts/behavior
- return the instance to standard managed posture

This should require redeploy/restart and make clear that developer persistence may be removed.

These actions are critical to making the feature approachable rather than scary.

---

## Safety Boundaries

### Root must remain explicitly scary

Root access copy should stay practical and direct:

- full system-level changes
- can break managed behavior
- requires redeploy/restart
- use only when truly needed

### Developer Mode should feel powerful, not reckless

Developer Mode should be framed as:

- persistent workspace
- editable instance behavior
- better support for config and code tinkering

It should not promise unrestricted host-level control unless root is explicitly enabled.

### Surface access and runtime access should not be conflated

TUI access should not automatically imply:

- root access
- privileged mode
- destructive persistence changes

This separation keeps the mental model sane for users.

---

## Implementation Direction

### Config layer

Add a stored/runtime concept such as:

- `runtimeMode?: "managed" | "developer"`

Then derive existing backend flags from it where appropriate:

- `mountPersistentSource`
- `enableRootAccess`

This keeps the product language simple while preserving compatibility with the existing deployment builders.

### Welcome deploy wiring

Update the welcome deploy builder so it no longer always assumes managed mode.

Specifically:

- `Developer Mode` can set developer defaults at first deploy
- root remains separate and off by default
- welcome deploy should not present the TUI as newly unlocked by this toggle

### Runtime settings wiring

Expose instance-level `Runtime Mode` selection and root escalation in the runtime settings area, using the same redeploy/restart semantics already used for other runtime-impacting changes.

### Terminal surface cleanup

Update the current quick terminal naming and presentation so it is clearly a utility console, not the canonical Hermes TUI.

### Dedicated TUI refinement

Keep the existing dedicated TUI page as the terminal-dominant workspace and refine its positioning, entry points, and messaging as needed.

---

## Rollout Plan

### Slice 1: Runtime mode model

- add `runtimeMode`
- wire managed vs developer defaults in config helpers
- preserve existing root toggle behavior

### Slice 2: Welcome deploy preset

- add Developer Mode preset to welcome deploy
- map it to developer runtime defaults
- keep root as a separate opt-in

### Slice 3: Instance settings controls

- expose runtime mode switching
- keep root behind strong confirmation
- ensure redeploy/restart messaging is explicit

### Slice 4: Terminal surface polish

- rename/reposition current modal terminal as Advanced Console
- remove any confusion between modal terminal and dedicated TUI

### Slice 5: Recovery actions

- implement Reset Developer Changes
- implement Return to Managed Mode

### Slice 6: Dedicated TUI integration polish

- improve entry points to existing TUI route
- ensure copy and navigation make the surface model obvious

---

## Success Criteria

This design is successful when:

- standard users still get the same polished dashboard-first experience
- developers can enable a persistent, hackable runtime without immediately enabling root
- the dedicated TUI remains accessible as its own surface rather than being tied to Developer Mode
- root changes always require explicit confirmation and redeploy/restart
- users can safely recover through reset and return-to-managed flows
- the quick terminal and dedicated TUI have clearly different roles

---

## Open Questions Carried Forward

These should be answered during implementation planning, not left vague in execution:

- how exactly `Reset Developer Changes` defines the reset boundary for config vs source vs generated files
- whether `runtimeMode` should be fully first-class in storage or derived from existing flags during migration
- which settings screen should own the runtime-mode controls if profile-level and instance-level settings overlap
- whether the dedicated TUI should receive additional affordances once runtime mode is `developer`
