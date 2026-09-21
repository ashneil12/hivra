# Compact desktop fit — Canary acceptance

PASS for the compact KDE launcher, fit toggle, pointer/keyboard input and
full-screen round trip described below. Physical monitor unplugging/mixed-DPI
transitions and the wider computer-platform goal remain unaccepted.

## Cause and correction

The [preceding live check](2026-09-06-mac-refresh-fullscreen-acceptance.md)
found the KDE launcher clipped at the top of the compact Mac viewport even
after resizing settled. Fresh read-only guest checks on owned VM1120,
`hivra-cc-1120`, confirmed `hivra-selkies-desktop` at 1808×864 with Xft.dpi 192.
That leaves about 432 logical pixels of height, insufficient for the menu.

Source `f9f685c3d9562aeb608fdb0e1456fb3d7dc70f78` adds a stable viewport wrapper.
Fit desktop is on by default: each logical axis is at least 1024×640, uniformly
scaled and centered within the available area. Letterboxing preserves the
desktop's aspect ratio; there is no stretching. Users can turn Fit desktop off
for the former exact-window geometry and larger text. No guest preference,
credential, handoff, lease or input-isolation contract is changed. The existing
iframe/ref/src stays mounted across fit changes and resizing.

Independent review caught unbounded inverse-percentage dimensions in the first
implementation when the window was briefly very thin. The corrected canvas
bounds each axis independently instead. Thin-wide/tall regressions cover this;
the rejected implementation was not deployed.

## Verification and deployed identity

- Final component suites: 27 tests passed in 1.396 seconds, covering bounded
  geometry, zero-size handling, full-screen-size round trips, fit on/off,
  unchanged iframe/contentWindow and one session-issuance request.
- Independent corrected review: 27 tests passed in 1.148 seconds; no remaining
  actionable P1/P2. Pointer behavior was explicitly held for real-browser checks.
- Existing broker suite: 18 tests passed in 1.528 seconds, including strict
  viewport forwarding and session lifecycle. Focused ESLint, TypeScript and
  `git diff --check` passed. No new full-suite campaign was added for this slice.
- A clean Git export of the exact source commit was deployed only to project
  `hermesos-canary`, `prj_XEG52ZLtihRGP8Fg6pDZwQCATzVA`, root `dashboard`.
  Vercel compilation, TypeScript and static generation passed. Deployment:
  `dpl_n5XLDxTL3iPQUBgFrTZR8VXLPTeh`.
- Fresh CLI inspection confirmed Ready and the alias `canary.hermesos.cloud`
  pointing to `hermesos-canary-ejanw8z59-ashneil12s-projects.vercel.app`.
  The actual production project was not touched.

## Actual Mac user flow, September 6, 07:18–07:21 UTC

Used the existing authenticated Mac Alpha and existing computer
`CANARY_ALIGNED_UBUNTU_0905`, `00000000-0000-4000-8000-000000001025`.
Refreshed the inventory to the new deployment, then opened its normal desktop
card. KDE rendered with Fit desktop on; displayed secure setup was 11.8 seconds.

Clicked the visible launcher in the fitted compact desktop. The complete menu,
including its previously clipped top/search field, was visible. Typed
`calculator` and visually confirmed it in the guest search field, then cleared
the text. Turned fit off and back on, entered full-screen, opened the launcher
there with a pointer click, and returned to the compact window with the menu
still open. Its top and bottom remained visible after the resize settled.
The same session ID remained throughout:
`00000000-0000-4000-8000-000000001092`; SQL showed only that session issued to
this computer during the post-deploy check. No refresh/reconnect was used to
repair any fit/full-screen transition.

Read-only guest confirmation after returning to compact fit: 2048×1280,
Xft.dpi still 192 and Xcursor.size still 24. The logical desktop has more room
without changing its guest scaling preference. This supplements the visible
menu and input checks; it is not their substitute.

The performance panel reported two two-second input-measurement timeouts during
the interaction sequence. These observations are retained, not treated as a
latency PASS. No physical latency, audio, drag/pointer-lock, mixed-monitor,
suspend/wake or other browser-platform acceptance is claimed here.

## Cleanup, preservation and rollback

Closed the launcher and returned to Computers. SQL confirmed the acceptance
session revoked at 07:21:10.560753 UTC and input released at 07:21:11.848613 UTC.
The earlier diagnosis session `00000000-0000-4000-8000-000000001093` was revoked
at 07:08:51.155316 UTC and released at 07:08:52.048579 UTC. No test stream or
controller lease was left active. The existing computer/data were retained;
no file, power, resize-capacity, recovery or guest-update action was submitted.

The owned clean export `/tmp/hivra-desktop-fit-deploy.VHzzSN` was removed
after deployment completed; absence was verified. Its source remains in Git.
No paid fixture was created and no additional Hetzner spend was incurred;
the prior conservative reservation remains GBP 6.90/10. No network or native
app installation was changed. Rollback, if needed, is the prior Canary Ready
deployment `dpl_H85X5fu1ZBHhTdtRGGy9nVNso7DM` plus a PR source revert; rollback
was not exercised because the scoped acceptance passed.
