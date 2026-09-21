# Hivra for Mac native workspace acceptance — 2026-09-09

## Implemented and installed

The Mac app now uses SwiftUI for Home, the agent/computer sidebar and inventories,
resource search, retained work tabs, focus mode, connection management, appearance,
and local runtime settings. It keeps Hivra's serif wordmark, crimson accents,
graphite/cream palette and existing icon. The workspace adapts from two resource
columns to one in a smaller window, with independently scrolling navigation.

Agent interfaces, desktop access, launch, activity, infrastructure and account
settings remain existing authenticated web surfaces inside focused work panes.
The capability-gated dashboard adapter removes duplicate web navigation only in
the native app. It advertises existing surfaces and exchanges allowlisted resource
metadata, not credentials. The native bridge checks the main frame, exact origin,
resource identity, owner and safe relative routes. This change does not add a
runtime, provisioning API, native video transport or cross-agent chat service.

| Item | Accepted artifact |
| --- | --- |
| Native source revision | `c10e9dfed10bf019e22313c0a672d02ee8bfc565` |
| Installed app | `/Users/example/Applications/Hivra.app` |
| Version / build | `0.2.0` / `2` |
| Bundle identifier | `cloud.hivra.mac.alpha` |
| Executable SHA-256 | `3364ea4d9c7c000fccf22f6c86a91bbea2bf34e35d95b4107895c58bc8ca6f2c` |
| Local archive | `apps/macos/HivraMac/dist/Hivra-Mac-Alpha.zip` in the native workspace worktree |
| Dashboard target | `https://canary.hermesos.cloud` |
| Combined Canary source | `4318de06c41465d234726195e1256af3af404e60` |
| Canary deployment | `dpl_Ax66s6fdraNrrSE4PHTgi6EfxVTn` |

The bundle contains its source revision and passed `codesign --verify --deep
--strict`. This is an ad-hoc signed local alpha. Developer ID signing,
notarization and a public Mac distribution remain separate release gates.
The documentation commit following the accepted source does not alter the binary.

## Verification

- The combined native revision passed **56 Swift tests in 9 suites**, including
  strict bridge decoding, route/origin policy, account clearing, delayed resource
  adoption, tab selection and existing desktop/local-runtime contracts. The release
  build completed successfully. Logs: `/tmp/hivra-native-workspace-combined-tests.log`
  and `/tmp/hivra-native-workspace-combined-release.log` on the verification Mac.
- The dashboard adapter passed **168 tests in 9 focused suites**. Its account
  followup passed **42 tests in 4 suites**. These runs overlap and are not an
  additive test count. Dashboard typecheck and touched-file lint passed. Logs:
  `/tmp/hivra-native-web-tests.log`, `/tmp/hivra-native-account-tests.log`,
  `/tmp/hivra-native-web-typecheck.log` and `/tmp/hivra-native-followup-typecheck.log`.
- The coordinating desktop task reported **170 tests in 6 suites** for the combined
  Canary source, including the workspace adapter and desktop changes. The native
  task then verified the exact frozen alias and installed app against it.
- Independent final source review found no blocking regression in retained tabs,
  owner clearing, native Settings or surface dispatch. Its README label/link
  findings are corrected in this record's documentation commit.

### Installed app against real Canary

Normal sign-in succeeded. Native Home showed **3 agents and 3 computers**, with
five running and one stopped at observation time. Its accessibility tree contained
native resource controls and no embedded HTML Home. The duplicate web sidebar and
resource navigation were absent from the focused resource pane.

The following actions were performed in `/Users/example/Applications/Hivra.app`:

1. Command-2 opened the native agent inventory. Filtering to Stopped returned only
   `CODEX_E2E_DELIVERY`; opening it displayed the existing Not ready guard without
   starting it.
2. Command-K opened the native switcher with six real results. Typing `OMARCHY`
   produced one result; Return opened `MY_OMARCHY_DESKTOP` in a second native tab.
3. The Omarchy pane exposed native Desktop, Box Terminal, Files and Manage controls.
   Its existing recovery console reached Connected, and Open native Omarchy desktop
   remained available. No native launch, reconnect, guest input or lease creation
   was requested during this inspection.
4. Returning Home preserved both opened work tabs and showed them under Open in
   this window. Closing the two inspection tabs returned to Home and released the
   inspection-only work panes.
5. The native window was resized from its wide layout to its minimum width
   (900 pixels in the captured window). Home stacked its resource panels; scrolling
   reached all computers, and the fixed account/settings controls remained usable.
   The window was then restored to a wider layout.
6. Native App settings showed System/Dark/Light appearance controls and an accessible
   Connections list with the active Canary address. System appearance and both
   original saved connections were preserved.
7. Account opened the existing hosted settings surface with its compact account
   header. Open user menu exposed Manage account and Sign out. No account change
   or hosted sign-out was performed. The app was left on native Home.

### Isolated fixture checks

Retention and sign-out cases used the committed
`apps/macos/HivraMac/scripts/workspace-ui-fixture.mjs` on `127.0.0.1:43187`, with
four clearly labelled QA resources and no external API/network calls. A separate
`cloud.hivra.mac.ui-checks` bundle isolated its preferences and cookies. These checks
used the preceding `5e87f0ffd` build; the final installed revision additionally
received the real Canary, sizing, singular-result and connection-label checks above.

- Command-K search and Return opened a resource; an unsent test note was entered
  into a fixture textarea that has no send action.
- Switching to a computer, reloading that computer, returning Home and reopening
  the agent preserved the agent's page-instance identifier and unsent note.
- Native Files/Chat selection and focus mode preserved the same note.
- Fixture sign-out cleared all owned native resource metadata and work tabs.
  Signing back into the fixture restored the native inventory.
- Native Appearance, Connections and Local Hivra settings rendered correctly;
  Light appearance was checked only in the isolated QA app. No local runtime was
  set up, started or stopped.

The fixture server was stopped and its listener verified absent. The temporary QA
app was quit and moved to Trash. The fixture's isolated preferences contain only
test data; no fixture connection was added to the installed Hivra app.

## Preservation and remaining gates

The original Hivra app processes, their bundles, saved connections and live desktop
sessions were preserved. The task did not send an agent message, create capacity,
restart a guest, acquire a competing native Omarchy lease or change production.
No native stream performance, lease-renewal or public-transport acceptance is
claimed by this workspace record; those remain in the desktop workstream.

Canary briefly served an older adapter because concurrent tasks replaced the
alias. The desktop and workspace changes were combined at `4318de06c`, the alias
was frozen, and authenticated native acceptance used that combined version.
The native branch includes the coordinating desktop branch rather than reverting
its Moonlight/lease fixes. Pull requests remain unmerged.

Tabs retain their WebKit sessions while the app window remains open; they are not
restored across app exits. Embedded guest interfaces retain their own themes and
keyboard-capture behavior. Actual guest mutations, fresh provisioning and local
runtime installation were intentionally outside this UI acceptance pass.
