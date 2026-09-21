# Mac Alpha history navigation and managed Ubuntu check

Status: PASS for the bounded native navigation repair and managed Ubuntu
interaction below. This is not full core, multi-OS or public-release acceptance.

## Target and change

- Source: `3f30a43c7`, branch `codex/hivra-core-experience-plan`, PR 600.
- Local app: `apps/macos/HivraMac/dist/Hivra.app`, arm64, version 0.1.0/1,
  ad-hoc signed. Executable SHA-256:
  `289f38960bb057346fd7fcaee59d6ade7b42d53938398b55bfaf012b6dda364e`.
- Local archive SHA-256:
  `d450c09b082a184c45dc38db7823fffd99e10e159184df26213242d063cff608`.
- Existing Canary web deployment rechecked with Vercel CLI:
  `dpl_68M8jUgJCX68wz6DDFH4th6XXVg6`, Ready. No new web deployment.
- Existing test computer: CANARY_ALIGNED_UBUNTU_0905, VM 1120,
  `00000000-0000-4000-8000-000000001025`. No launch, restart, resize or update.

Before the repair, Home → computer navigation left native Back disabled.
Detach opened Home although the original WebView showed the computer. The
browser model only refreshed native state in document-navigation callbacks;
History API changes did not produce those callbacks. The model now observes
WebKit's URL, Back/Forward and loading properties, with main-actor delivery and
weak ownership. No injected web script, authentication or permission change.

## Verification

- `swift test --package-path apps/macos/HivraMac --scratch-path
  /tmp/hivra-mac-history-tests`: 17 tests passed, including real WebKit
  pushState, replaceState, Back and Forward. The fixture uses a temporary local
  document and a nonpersistent data store; its directory is removed afterward.
  Earlier synthetic loadHTMLString fixtures failed because they lacked the
  initial normal back/forward entry. Those failures were not counted as passes.
- `apps/macos/HivraMac/scripts/build-app.sh`: release build and local archive
  completed. `codesign --verify --deep --strict` passed; this is ad-hoc, not
  Developer ID signing or notarization.
- Reopened the exact rebuilt app path. Existing Canary sign-in remained usable;
  no password, cookie or credential was copied or entered.
- Opened the existing Ubuntu computer through Home. The native WebView rendered
  the actual KDE desktop; menu input opened Konsole and keyboard input produced
  `HIVRA_MAC_INPUT_OK` from a harmless echo command.
- One native Refresh reconnected and retained that terminal/output. No second
  refresh was needed. The displayed 6.4-second setup time is browser telemetry,
  not a physical latency measurement.
- Native Back became enabled after the in-page computer route change. Then
  navigated Home → Computers without a document refresh, used native Back to
  return Home and Forward to restore Computers. Detach opened Computers in a
  separate Hivra Surface window, not the previously loaded computer URL.

## Preservation and cleanup

Two installed Hivra builds were running. Initial read-only/desktop checks used
the older worktree build; the acceptance above was repeated against the exact
workspace app path. The older build was not replaced or quit. Both test-created
Konsole windows were exited normally; no test file, model prompt or cloud
capacity was created. The two test-created detached windows were closed.
The rebuilt main window remains on Computers. Nonessential cookies were
rejected in the initial test window.

Read-only Canary database checks confirmed every desktop session opened in this
campaign had `input_state=released`, `revoked_at` and `control_released_at`:

| Session | Control released, UTC |
| --- | --- |
| `00000000-0000-4000-8000-000000001121` | 2026-09-06 00:11:32 |
| `00000000-0000-4000-8000-000000001122` | 2026-09-06 00:19:17 |
| `00000000-0000-4000-8000-000000001123` | 2026-09-06 00:20:48 |
| `00000000-0000-4000-8000-000000001124` | 2026-09-06 00:21:16 |

The previous local app bundle was retained at
`/tmp/hivra-mac-history-rollback.Pft8gP/Hivra.app` for rollback; restore
only after quitting the workspace build. Rollback was not exercised. No live
machine or stored user file was removed. No additional Hetzner spend occurred.

## Remaining limits and next action

The dashboard detail page still keeps tab selection in local state: selecting
Manage left the URL's `tab=desktop` unchanged. This native fix preserves the
current URL, not an unrepresented selected tab. Next inspect `selectTab` and
its routing contract before changing dashboard behavior. Detach still opens a
second window; it does not transfer an active controller lease.

The selected-tab URL gap was subsequently repaired and verified on Canary in
the [computer tab-state acceptance](2026-09-06-computer-tab-state.md).

The Mac check used managed Ubuntu, not a fresh provider computer. Audio,
monitor unplug/replug, multi-monitor DPI, Windows, Omarchy native pairing and
input revocation, native agent inference, public signing/notarization and full
core completion remain unproven. Input telemetry showed timeout samples even
while visible interaction worked; no latency claim or telemetry repair is made.

Ordinary real-window enlargement/restoration was subsequently verified in the
[Mac resize check](2026-09-06-mac-window-resize.md), without proving physical
monitor changes or mixed-DPI transitions.
