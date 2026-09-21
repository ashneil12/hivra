# Stream resolution and cursor repair — 21 September 2026

Status: Omarchy browser resolution and cursor fixes accepted live on Canary at `2d315af81e6dbc2d517e17b5ee817c584be74942` in Chrome.

## Diagnosis

The modern Selkies client installed on the retained Omarchy computer exposes
`webrtcInput`, `selkiesTransport`, and same-origin `settings` and
`setManualResolution` messages. Its installed JavaScript does not expose the
legacy `app.videoBitRate`/`app.videoFramerate` interface used by the broker.
Writing quality to that missing object silently did nothing. The outer viewport
alone also cannot override a retained manual resolution in the streaming client.

The Omarchy broker separately forced every cursor update back to `default` with
a MutationObserver. This suppressed guest hand, text, resize, and hidden cursors.
Live Chrome testing after removing that override still received only a fixed arrow sprite. The external Hyprland capture path does not provide changing cursor metadata. Omarchy therefore needs the compositor cursor captured in video and both local renderers hidden. This adds stream latency to pointer motion but preserves the real guest shapes without a duplicate pointer.

## Change

- Send bitrate/framerate and explicit, even-pixel resolution through the modern
  client message API. Preserve the selected preset's pixel budget at the viewport
  aspect, bounded to the guest's 4080-pixel axes. Skip hidden geometry, duplicate
  settings, closed sessions, and messages from an untrusted parent.
- Retain the legacy quality setter for the older client. Preserve the guest's
  local CSS cursor shapes for ordinary clients. Omarchy opts into a captured
  cursor: its paired installer always enables compositor capture, and its broker
  enables capture explicitly for each connected session before hiding the CSS
  cursor, while browser mode disables the separate Selkies canvas. Failure to send
  that command ends the stream instead of leaving an invisible active pointer.
- Update exact source integrity pins. Keep the previous Ubuntu bundle admitted
  for secure sessions during an explicit runtime update.

## Verification

- Broker suite: 38 tests passed. Omarchy layout policy: 9 passed. Installer: 4 passed, 1 systemd-only check skipped on macOS.
- Capability inspection and session broker: 112 tests passed on the final code.
  Remote desktop UI and viewport: 55 tests passed before the cursor-only follow-up;
  those UI files are unchanged.
- The three cursor/modern-client regression cases fail against the original
  broker at base `1b871926f`, then pass with this change.
- TypeScript, lint of touched TypeScript files, JavaScript syntax, and diff checks
  passed. Full Vercel application builds passed, including the final accepted revision. Full application test suite was not run;
  checks targeted the changed transport and its identity/session boundaries.

## Live observation and remaining acceptance

Authorized Canary release (deployment identity retained in private engineering history) serves code
`6c9d7b3a5ee7f8a2ed811dd3c3d4a673d3705291`. Canary returned HTTP 200,
`X-Robots-Tag: noindex,nofollow`, and robots Disallow `/`. Public production was
not changed. GitHub Actions could not start because of the account's Actions
budget; local checks and Vercel build ran successfully.

Chrome opened the retained test computer through the normal
authenticated dashboard. Supported preparation installed the exact source broker
hash. In one session, actual Hyprland dimensions changed at scale 1 / 60 Hz:

| Preset | Actual guest dimensions |
| --- | --- |
| Performance | 1304 x 704 |
| HQ | 1958 x 1058 |
| QHD | 2610 x 1410 |
| 4K | 3916 x 2116 |

These preserve the viewport aspect at each preset's pixel budget. Fullscreen HQ
adapted to 1850 x 1120. Opening guest Chromium and visiting Example Domain proved
input and frames still worked. Its link context menu confirmed the test pointer
was on a guest link, but the CSS cursor sprite remained the arrow. Cursor live
acceptance consequently failed for that revision and motivated the additional
captured-cursor correction above.

The first captured-cursor trial at `c700861a4` installed the matching runtime,
but capture logs still reported `cursor=consumer`: Selkies defaults capture off
for every session independently of its metadata setting. The follow-up sends
`SET_NATIVE_CURSOR_RENDERING,1` once the session is connected. Regression tests
assert this command precedes hiding the CSS pointer and a send failure ends the
stream.

## Final live acceptance

Final deployment: (deployment identity retained in private engineering history), code
`2d315af81e6dbc2d517e17b5ee817c584be74942`. The Canary alias resolved READY to
that exact commit, returned HTTP 200, and retained `X-Robots-Tag: noindex, nofollow`.
Public production was not changed.

Used the normal **Update desktop** action for the retained Omarchy computer.
Read-only guest inspection matched installed files to the final source:

- `broker.cjs`: `7f71dbd64f725cf0fc688337f62bba919f8b8d0b83152f69d5f8b95fd478419f`
- `install-omarchy-web.py`: `ff899b97ad3f02b5af9cfc7f3e9429acf894a2d087738d33f5c5fe03b346c3a0`
- `omarchy-web-server.cjs`: `c91a4a189eaf56cf5734735b4a11f5d6563d837b1bb96c09996d6488bf4df89e`

Capture logs recorded `Received SET_NATIVE_CURSOR_RENDERING: True` followed by
an ext capture session at 1958x1058 with `cursor=painted`. In the verified Chrome session, guest Chromium's Example Domain page showed
an I-beam over paragraph text and a hand over its link. The local overlay had
`cursor: none !important` and the separate cursor canvas was hidden. Screenshots
in the task show the actual guest cursors; the browser automation marker was
moved outside the guest area to avoid obscuring them.

Switched the final runtime to 4K and confirmed actual guest 3916x2116 / scale 1 /
60 Hz, then restored HQ. Reloaded Chrome to create a fresh session: it connected without another update, preserved
the open guest browser, retained the hidden local cursor, and again displayed
the captured text cursor. Final monitor: 1958x1058 / scale 1 / 60 Hz.

Closed only the guest Chromium window opened for testing (Example Domain and its
IANA background tab), restored the normal windowed HQ view, and left the desktop
open in Chrome. CPU, memory, boot media, display adapter, and original 40 GiB disk
identity matched the pre-change VM configuration. No VM replacement, disk
replacement, reboot, user-file cleanup, or capacity purchase was performed.

Limits: no live Ubuntu, Windows RDP, native Moonlight, mobile/touch, or separate
resize-cursor acceptance. The Omarchy cursor intentionally follows stream latency.
GitHub Actions remain blocked by account budget; local verification and the full
Vercel build passed. The full repository test suite was not run.
