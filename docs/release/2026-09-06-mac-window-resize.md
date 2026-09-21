# Mac Alpha real-window resize check

Status: PASS for ordinary native window enlargement/restoration. Physical
monitor unplug/replug and mixed-DPI monitor transitions remain unverified.

## Exact target

- Canary web source `180f66cc7164b0e4916af4a9568788dafa135d99`, deployment
  `dpl_5B6Mp9xMfwRUm4JnhybmSnyRNTyW`. Vercel CLI rechecked the Canary alias
  against this Ready deployment after the test.
- Workspace Mac Alpha from `3f30a43c7`; exact app path and binary digest are
  recorded in the [native navigation receipt](2026-09-06-mac-history-navigation.md).
- Existing CANARY_ALIGNED_UBUNTU_0905, VM 1120,
  `00000000-0000-4000-8000-000000001025`.
- One desktop session: `00000000-0000-4000-8000-000000001127`.

## Actual interaction, 2026-09-06 00:34–00:37 UTC

Opened the existing Ubuntu desktop through the normal Mac inventory. Read its
screen controls: HiDPI was enabled, UI scaling showed 200%, manual resolution
fields were unset, and local scaling was on. No setting was changed. Expanded
inspection sections were collapsed again.

Used the native window's exposed Zoom action to enlarge the actual WKWebView;
no browser viewport/DPR emulation was involved. The initial transition briefly
showed the old smaller image with black space. A subsequent settled screenshot
showed the desktop filling the enlarged region, including its complete bottom
panel. The same session URL and connected state remained present. Clicking the
remote application launcher at its new position opened the correct KDE menu.

Closed the menu with Escape and toggled native Zoom again to restore the
original window size. An initial locally scaled frame settled into the normal
smaller desktop layout. The bottom panel remained reachable, and clicking the
launcher opened the menu at the restored coordinates. No refresh, reconnect,
manual resolution change, server update, terminal or file creation was needed.

This is visual and input acceptance, not an exact resize-duration measurement.
The existing browser telemetry reported timeout samples despite the working
interaction; this check does not reinterpret them as measured latency or fix
that separate telemetry issue.

## Cleanup and limits

Closed the menu and returned the main window to Computers. The window size was
restored; display/stream settings were preserved. Read-only Canary database
observation confirmed the exact session was revoked at 00:36:51.209616 UTC and
`input_state=released` at 00:36:51.962960 UTC.

A narrowly filtered `system_profiler SPDisplaysDataType -json` inventory found
only the built-in Color LCD online, reported as 1512 × 982 at 120 Hz. No external
display was available for a genuine display migration or disconnect test. Do
not substitute this ordinary window check for mixed-DPI or physical unplug
acceptance. No monitor, network, hardware or OS display setting was changed.

No source/runtime repair was needed for the exercised resize path. No machine
was created, restarted or deleted; no extra Hetzner spend occurred. Full core,
Omarchy/Windows and all-agent acceptance remain open.
