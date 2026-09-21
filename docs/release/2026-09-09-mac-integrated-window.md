# Integrated Mac window acceptance — 2026-09-09

The screenshot-backed followup removes the separate system toolbar around the
workspace. Resource tabs and actions now share one 44-point header with the real
Mac window controls. The sidebar reaches the window edge, and surface controls use
quieter selection styling. The duplicate resource title and profile pill are gone.

`NavigationSplitView` plus the unified toolbar produced the inset sidebar and
second header on macOS 26. The replacement uses a titled, resizable AppKit window
with a hidden title bar, a native split view, and a header-only drag region. Both
split panes extend behind the title-bar safe area so no empty band remains.
Settings and detached windows retain their existing chrome. Window-menu and
accessibility titles still identify the selected resource and connection.

| Artifact | Verified value |
| --- | --- |
| Native source | `090c8c7bc8c30995ff007d40acbb126f47ccb7d4` |
| Installed app | `/Users/example/Applications/Hivra.app` |
| Version / build | `0.2.1` / `3` |
| Executable SHA-256 | `609b1e24ebda5136a1faa3555beb22cfcc4f397af9bdddb96d514526b3ee8376` |
| Mac used for UI checks | macOS 26.6.2, Xcode 26.6 |
| Observed Canary deployment | `dpl_ADNV4qny3kCY9EMfvd4Wb5RTGLS1` |
| Observed Canary source | `371cca5487a5c9132cc9608556436b2f0f28dec1` |

The combined revision passed **57 Swift tests in 10 suites**, including a new
AppKit regression that removes an existing toolbar while preserving standard
window buttons, title metadata, resizing and content-input boundaries. Release
build and `codesign --verify --deep --strict` passed. Logs are
`/tmp/hivra-integrated-chrome-combined-tests.log` and
`/tmp/hivra-integrated-chrome-combined-release.log` on the verification Mac.

Rendered checks used an isolated loopback fixture and then the installed app:

- The header and traffic lights share one row; there is no inset sidebar frame.
- Command-K search opened resources. A fixture note and page-instance identifier
  survived switching tabs and focus mode. Home preserved both open tabs.
- The native green button entered full screen; Escape returned. Header double-click
  zoomed the window. Sidebar dragging changed its width. The minimum-width window
  stacked the Home panels while keeping tabs, search, focus and creation reachable.
- The final installed app loaded all **3 agents and 4 computers** from Canary.
  The user's Omarchy and stopped Ubuntu tabs were reopened, and the exact two-tab
  layout from the reported screenshot was checked without the duplicate framing.

An intermediate build omitted a newer desktop compatibility change installed by
the parallel desktop task. Canary's `open=native|fast` resource routes therefore
failed the old native allowlist and left the inventory loading. The existing
desktop fix `f6c9f4f7c13ed05deecda3f4390351f33c4e83d2` was merged intact before the
final rebuild. No duplicate routing fix or Canary deployment was made here.

The pre-update Moonlight process ended before the app was restarted. Reopening
the existing Omarchy tab used its accepted automatic native-open path and started
Moonlight through the updated app; that restored session was left available.
Other original Hivra processes were preserved. No guest was started, stopped,
recreated or modified, and no agent message was sent. Transport performance and
lease-renewal acceptance remain in the desktop workstream.

The fixture app was quit and moved to Trash; its loopback server was stopped and
its listener verified absent. A temporary failed browser diagnostic tab was
closed. A copy of the previous installed app remains at
`/tmp/Hivra-before-integrated-window.app` for rollback. This is still an
ad-hoc signed local alpha, with public distribution and PR merge separate.
