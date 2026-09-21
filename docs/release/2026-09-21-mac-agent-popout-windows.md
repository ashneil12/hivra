# Mac agent pop-out windows — 2026-09-21

## Scope

Native Mac changes based on Canary repository main `1b871926f`. Separate windows
already existed behind the work-pane options menu. This change adds a visible
button, Option Command O, and tab/sidebar context menus, and gives detached
windows resource/connection titles. An inactive tab uses its own browser URL and
name. The URL preserves the selected surface and existing resource identity.
There are no provisioning, billing, agent-stop, or remote lifecycle changes.

## Verification

- Swift debug build and release app packaging passed.
- 19 focused Swift tests passed: separate-window identity/restoration,
  workspace routing/selection/lifecycle policy, shared sign-in storage, and
  element full-screen configuration.
- Full Swift suite before the additional configuration test: 58/59 passed.
  `nativeDesktopRequestContract` fails at `HivraBrowserConfigurationTests.swift`
  on the rejected handoff-value expectation. The same test failed in an
  unmodified archive of base `1b871926f`; it is not introduced here.
- Actual Mac UI exercised in an isolated app with bundle identifier
  `cloud.hivra.mac.popout-qa-20260921` and the existing loopback fixture on port
  43187. Visible pop-out opened Hermes Files at the same resource URL with
  `tab=files`; Option Command O opened Code Chat independently. Right-clicking
  an inactive Hermes tab opened Hermes, not the selected Code agent.
- Detached Code entered full-screen and was visually inspected. Closing it
  retained the main workspace. Closing the main workspace retained detached
  Hermes with its same fixture page-instance identifier.
- The fixture and QA app were stopped; port 43187 and the QA process were absent.
  The temporary QA app/preferences contain only synthetic data. Installed Hivra
  preferences, connections, remote agents, credentials and data were not changed.

## Acceptance limits

This proves native window behavior with a local simulated resource, not remote
agent execution. No Canary deployment, installed-app replacement, production
release, or public distribution occurred. Actual remote agent work continuing
across window closure, simultaneous full-screen use on separate displays, and
unsent-input retention were not verified in this campaign. Session/controller
limits for terminal and remote desktop still apply; opening a second view is not
permission for a second controller. The packaged app is ad-hoc signed for local
use; Developer ID signing and notarization remain separate release work.
