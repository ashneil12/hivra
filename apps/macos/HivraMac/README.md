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
**Open in Separate Window** on a page that is not a resource (Launch, Activity,
Account) opens an ordinary web window for that address: it has no native
workspace metadata or desktop hand-off, and only HTTP(S) addresses are restored.
Terminal connections and desktop controllers keep their existing session/lease
rules. Focus mode hides the sidebar and resource tab strip.

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

## Web pages, popups, links and downloads

Embedded pages follow browser rules for windows, links, downloads and dialogs:

- **Popups.** A page that opens a window with a user gesture (an OAuth sign-in,
  a connector authorization, a blank window the page fills in later) gets a
  real popup window. The page keeps its handle, so `window.opener`,
  `postMessage` and `window.close()` work. The popup is sized from the page's
  request within the screen, opens over the window that asked for it, and is
  never restored at launch. Popups have no address bar, so the title starts with
  the page's origin. A popup closes when the page closes it, when you close it,
  or when the tab, window or account that opened it goes away. Popups are
  ordinary web content: they never receive the workspace or desktop hand-off
  bridges. Windows opened without a user gesture are blocked, as in a browser.
- **Links.** A link you click that opens another site in a new window (for
  example a link in agent chat) opens in your default browser; links that stay
  in the pane load there as before. A new window onto the connection's origin, or
  onto the origin of the page that opened it (such as a file link in an agent's
  web UI), stays in the app, where that page's session is. Sign-in providers stay
  in the app so they can return to the page that asked. A dashboard route opened
  in a new window opens its resource tab or destination in the workspace
  instead. Other schemes (and `about:`, `blob:`, `data:` and `javascript:`
  addresses, which WebKit handles itself) are never handed to macOS.
- **Your presses.** WebKit reports a script's `click()` as a link click, so the
  app counts your own mouse and key presses in a page instead. Each press can be
  used by one download or one hand-off to another app, and presses from before
  the page loaded do not count. The app cannot tell which frame you pressed in,
  so a press anywhere in the page counts.
- **Mail and phone links.** `mailto:` and `tel:` links in the page itself (not
  in a frame inside it) can open the Mac app registered for them (Mail,
  FaceTime). The connection's own page opens the app straight away when it has
  an unused press. Any other site, and any request without one (a page clicking
  its own link, or assistive technology activating it), first shows a sheet
  naming the site and the app. Only one such sheet is shown at a time, and it
  can stop the page from asking again until it navigates.
- **Downloads.** Attachments, `download` links and files WebKit cannot show are
  saved to Downloads. As in a browser, a page may save one file after it loads
  and one for each unused press. Beyond that, a sheet asks whether the page may
  download multiple files; the answer lasts until the page navigates. A frame
  from another origin than the connection (an embed inside the page) needs an
  unused press to save a file; without one, its download is refused without
  asking. An existing file is never replaced: a second `report.pdf` becomes
  `report (1).pdf`. A notice with **Show in Finder** appears briefly at the
  bottom of the page that started the download. Downloaded files keep macOS
  quarantine.
- **Dialogs and files.** JavaScript alerts, confirmations and prompts appear as
  sheets on the page's window and name the site asking. After the first dialog,
  you can stop a page from showing more until it navigates. File inputs open the
  Mac file picker, honouring multiple selection and folder selection.
- **Recovery.** If a page's web content process stops, the pane shows a recovery
  card with **Reload** instead of going blank. **Try again** after a failed first
  load retries the address that failed.

Pages identify the app with the user-agent token `HivraMac/<version>`, taken
from the bundle's `CFBundleShortVersionString`; unbundled development builds
report `HivraMac/0.0.0-dev`. Debug builds allow Safari's Web Inspector on every
web view; release builds do not.

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
metadata bridge. Only views that belong to a connection carry either bridge:
the connection page, its resource tabs and their pop-out windows, trusting that
connection's exact origin from the main frame. Popups and ordinary web windows
never carry them. The existing Moonlight identity, pairing, launch, stop and
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
