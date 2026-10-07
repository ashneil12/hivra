# Claude on a Hivra computer, used through a browser

**Status:** research and recommendation. It grants no deployment authority. The
build it describes is on Canary only; prod is unchanged until the owner promotes it.

## The requirement

The owner's own computer has nothing from Anthropic on it. Claude runs on the Hivra
computer and is used through Hivra in a browser. Two views of it: the Claude app on
its own, full screen and fast, and the regular desktop with the app visibly running.

## What was tried, and what happened

| Path | Result |
| --- | --- |
| **B. Anthropic's Linux desktop app on an Ubuntu Desktop computer, streamed by Hivra's existing desktop** | Runs. Measured on a throwaway Canary computer. The app starts, fills the stream full screen, and moves into a window on the desktop and back (the window changed by the next check, one second later). |
| **A. `claude remote-control` on a Claude Code box, viewed on claude.ai/code** | **Not tested signed in.** It needs the owner's Claude sign-in, which only they can give. Only the documented limits were re-checked (below). |
| **C. A rebuilt Claude UI inside HivraChat** | Not needed. Not built. |

### Path B, measured

- The package (`claude-desktop` 2.26454.0, 181 MB) comes from Anthropic's own apt
  repository. It unpacks without root inside the desktop container and runs with
  `--no-sandbox`. No missing libraries.
- The container has no `apt`: no-new-privileges blocks `sudo`. Unpacking the `.deb` as the
  desktop user is the only install route there.
- Idle and not signed in, the app adds about 0.5–0.6 GB to a 2 CPU / 4 GB computer whose
  desktop already uses about 0.8 GB.
- **The container's home is thrown away on every desktop restart** (`docker run --rm`,
  one mount). A plain install loses the app, its settings and its sign-in each time.
  Hivra keeps the app's profile in a root-only snapshot on the VM and restores it
  before the app starts. Verified by restarting the desktop service: the app
  came back full screen, with a marker file from the profile intact.
- **The first launch hits a KDE Wallet wizard** that blocks the app window. Its default
  option fails ("no keys suitable for encryption"). Starting the app with no D-Bus
  session and `--password-store=basic` avoids the wizard entirely.
- Opening a link from the app starts Google Chrome, which first asks to accept Google's
  terms. Firefox starts clean, so the helper makes it the default browser unless the
  owner has chosen one.

### Path A, from the documents only

Re-checked on 2026-10-07 against Anthropic's documents and the npm registry.

- There is no documented minimum CLI version for remote-control. The ">= 2.1.290" in the
  brief was not found. 2.1.292 is latest and 2.1.285 is `stable`.
- Only a full `claude auth login` works. `claude setup-token`, API keys and any
  non-Anthropic `ANTHROPIC_BASE_URL` block it.
- No headless flag exists. The workspace-trust prompt needs a terminal; no way to pre-answer
  the "Enable Remote Control?" prompt is documented. The server exits after about ten
  minutes offline and archives its live sessions.
- The browser gets chat, a diff pane and the session list. The documents list no
  terminal, file editor, preview pane or plugin browser there.

## Recommendation

1. **Default: the Claude app on an Ubuntu Desktop computer, full screen** (Path B),
   with the desktop one switch away. It is the real app, so Code tab, diff, worktrees,
   terminal, editor and preview are the real ones. Whether the Code tab works as
   a signed-in, local session on Linux is **not yet verified**.
2. **Opt-in, never automatic.** The owner adds the app, sees what it downloads and from
   whom, and signs in themselves.
3. **Path A stays the lighter alternative** for a Claude Code box, once someone with a
   Claude subscription has tested it end to end.

## What is missing compared with the real desktop app

- Computer use and dictation (Anthropic's Linux beta lacks both).
- Sound, the clipboard and file transfer: Hivra's stream disables all three.
- A keyring. The app's sign-in is stored without one. Whether it signs in and stays
  signed in this way is **unverified**.
- Cowork needs KVM inside the computer: not checked.
- Typing the sign-in inside the stream, because the clipboard is off.

## For the owner to decide with Anthropic before any marketing

Anthropic's legal page allows a user to sign in to the unmodified app on a platform that
hosts it, and bars a platform from collecting, storing or proxying that sign-in. This
build never touches the sign-in and does not modify the binary. The page also treats
"automated means" as off limits on consumer plans. Nothing here automates the sign-in or
drives the app, but the page does not name a hosted, streamed desktop app. Ask Anthropic
before describing this publicly.
