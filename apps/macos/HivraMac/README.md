# Hivra for Mac

Hivra for Mac uses a SwiftUI workspace around the existing Hivra control plane.
Home, agent and computer inventories, resource search, retained work tabs,
connection management, appearance, and local runtime setup are native Mac views.
Agent interfaces, desktop access, launch, activity, infrastructure, and account
settings use the existing authenticated web surfaces inside focused work panes.

The main window uses one integrated header for resource tabs and workspace
controls. The sidebar reaches the window edge; AppKit retains the real close,
minimize, zoom and full-screen controls. Drag the header to move the window.
There is no additional dashboard title bar around the workspace.

The native workspace adapter is enabled only for a main-frame page on the
connection's exact trusted origin. Older control planes without the adapter
remain usable in the embedded pane. Native metadata contains resource names,
observed status and safe dashboard routes; it carries no guest tokens or keys.
The adapter does not add a lifecycle API or replace an existing runtime.

## Build and open

Requirements: macOS 14 or newer and Xcode with the Swift toolchain installed.

```bash
cd apps/macos/HivraMac
./scripts/build-app.sh
```

Open `dist/Hivra.app`. The build also creates `dist/Hivra-Mac-Alpha.zip`.
The alpha is ad-hoc signed for local use. Set `HIVRA_MAC_CODESIGN_IDENTITY` to a
stable Apple signing identity when testing Keychain persistence across rebuilds;
ad-hoc builds may require the local operator sign-in again after a binary change.
Public distribution still requires Developer ID signing and notarization.

## Workspaces and controls

Choose a connection at the top of the native sidebar. Each connection retains
its opened resource tabs while the app window remains open. Open an agent or
computer from Home, its inventory, the sidebar, or the resource switcher. Selecting
another tab or a native inventory keeps the opened WebKit session in memory.
Closing a tab releases that tab's session. Tabs are not restored across app exits.
Account changes clear the previous account's native inventory and work tabs.

Within a resource, the native surface selector exposes the surfaces advertised
by that resource. Existing connection guards and desktop authorization still
apply. Use the **Open in Separate Window** button beside the surface selector, press
Option Command O, or right-click a resource tab or sidebar resource. The window
opens the same agent/computer and selected surface; it does not launch another
runtime. Each window can be moved to another display or made full-screen with
the standard Mac green window control. Its title identifies the resource and
connection. Repeating the action for an already detached resource focuses its existing window.

Resource pop-outs move the existing WebKit view into the separate window. Drafts,
page history and the selected surface stay with that view. The original tab shows
**Show Window** and **Return to Hivra** rather than running a duplicate view.
Use **Return to Hivra** in either window, or close the separate window, to bring
that same session back. Repeating pop-out for a resource focuses its existing
window. Different resources have independent windows.

Closing the resource tab releases its view and closes its separate window;
it does not stop the remote agent or computer. Clearing the account or removing
a connection also closes its owned windows. Closing the parent workspace closes
its resource views. Tabs and pop-outs are not restored across app exits.
Non-resource web pop-ups still use independent URL-based windows. Terminal
connections and desktop controllers keep their existing session/lease rules.
Focus mode hides the sidebar and resource tab strip.

| Shortcut | Action |
| --- | --- |
| Option Command O | Open selected resource in a separate window |
| Shift Command N | New workspace window |
| Command K | Find and switch resource |
| Command 1 / 2 / 3 | Home / Agents / Computers |
| Command N | Launch |
| Shift Command W | Close the selected resource tab |
| Shift Command F | Toggle focus mode |
| Option Command S | Show / hide sidebar |
| Command R | Refresh the visible workspace |
| Command [ / ] | Back / Forward within a web pane |
| Command , | App settings |

App settings contains Appearance, Connections, and Local Hivra. System, Dark,
and Light control the native shell's appearance. Embedded runtime interfaces
retain their own theme controls.

## Connections

- **Local Hivra** opens `http://127.0.0.1:3000/dashboard`. Local runtime controls
  expose checkout selection, setup, start, stop, and the actual launcher output.
  Setup credentials are passed to the self-host launcher through its environment,
  not command-line arguments. Successful setup stores the installation-only
  sign-in in macOS Keychain and exchanges it for the normal local session. A
  Hivra Cloud account is not required.
- **Hivra Canary** uses the hosted Canary control plane and its normal sign-in.
- **Custom** accepts another HTTP or HTTPS Hivra control-plane address.

Profiles persist on the Mac. Local and hosted origins keep their own web cookies.
The native workspace never starts a local runtime or creates capacity merely
because its connection is selected.

## Desktop access and acceptance boundaries

The origin-bound native desktop bridge remains separate from the workspace
metadata bridge. The existing Moonlight identity, pairing, launch, stop and
lease controls retain their own authorization and readiness checks. Installing
this shell does not admit an operating system or provider that lacks accepted
runtime evidence. Browser desktop controls, native Moonlight and guest runtime
UIs are different access surfaces; the app shell does not make a browser stream
a native video transport.

Public release and additional provider/device acceptance remain separate gates.

## Local runtime prerequisites

The native controls call `dashboard/scripts/hivra-self-host.mjs`. The selected
checkout needs Node.js 22.22 or newer, Docker Desktop, OrbStack or another
Docker-compatible engine, and the Supabase CLI and dashboard dependencies used
by that launcher. State lives under `~/.config/hivra`.

The app never installs system software silently. Prerequisite failures and
launcher output remain visible in native setup so the operator can correct the
host configuration.
