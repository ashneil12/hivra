# Mac Alpha refresh and full-screen acceptance

Status: PASS for the bounded single-refresh and full-screen round trip below;
not physical monitor-change acceptance or full computer-platform completion.

## Exact target

Observed September 6, 2026, approximately 07:00–07:03 UTC, through the already
authenticated Hivra Mac Alpha at `canary.hermesos.cloud`.

- Computer: `CANARY_ALIGNED_UBUNTU_0905`,
  `00000000-0000-4000-8000-000000001025` (existing owned acceptance computer).
- Vercel CLI freshly confirmed Ready deployment
  `dpl_H85X5fu1ZBHhTdtRGGy9nVNso7DM`, project `hermesos-canary`, alias target
  `hermesos-canary-mw4ceuu2f-ashneil12s-projects.vercel.app`.
- The [deployment receipt](2026-09-06-provider-resize-installation-feedback.md)
  binds that deployment to source `dc03efa3dc214207d6e67f2a5d07f20ee77d6dbb`.
  Current CLI inspection did not supply a Git SHA; this source mapping comes
  from the recorded deployment, not an invented current metadata field.
- App: `apps/macos/HivraMac/dist/Hivra.app`, version 0.1.0, build 1.
  Its `Contents/MacOS/HivraMac` SHA256 was
  `289f38960bb057346fd7fcaee59d6ade7b42d53938398b55bfaf012b6dda364e`.
  This is an installed local Alpha artifact, not a claim that current branch
  HEAD was rebuilt or that the client is publicly released.

## Actual UI actions and results

1. Opened Computers, then the named Ubuntu computer through its normal card.
   The opening state changed to a rendered KDE desktop, wallpaper and taskbar;
   the page reported secure setup 11.4 seconds. Session:
   `00000000-0000-4000-8000-000000001125`.
2. Pressed the Hivra desktop Full Screen button. During the transition, the
   old-sized frame briefly occupied part of the enlarged viewport. The settled
   stream then filled it without a page refresh. Clicking the visible KDE
   launcher opened the menu at the expected pointer location. Dismissed it and
   returned to the compact window.
3. Pressed the native app Refresh button exactly once. A fresh desktop session
   connected automatically and rendered KDE; secure setup was 6.5 seconds.
   No second refresh or manual Reconnect was used. New session:
   `00000000-0000-4000-8000-000000001126`.
4. On that refreshed session, performed a full-screen-to-compact round trip
   without refreshing. Inspected the settled screen in both states. The full
   taskbar returned to the compact viewport, with the same session ID. Clicking
   its launcher still opened the menu at the expected pointer location.
5. Dismissed the launcher and returned to Computers, ending the test session.

The UI and screenshots, not just the connection label, showed the desktop and
the launcher responding. Setup figures are displayed setup measurements, not
physical input latency. The first session also displayed one two-second input
measurement timeout during this interaction sequence; it is not discarded or
used as a successful latency benchmark. No audio, clipboard, file mutation or
guest restart was tested in this check.

## Remaining display issue

The KDE launcher fits in full-screen but its top is clipped in the short
embedded viewport of the minimum-size Mac window. Pointer alignment and the
resize round trip worked; that does not make the constrained-height desktop
fully comfortable to use. This is a concrete remaining compact-layout/guest
scaling issue, not evidence that another page refresh is necessary. Investigate
usable guest geometry and dashboard chrome before choosing a fix; do not hide
it by calling the full display experience accepted.

Physical monitor unplugging, crossing mixed-DPI monitors and suspend/wake were
not exercised. No claim about those transitions follows from Full Screen.

## Preservation and cleanup

Read-only SQL after leaving the desktop confirmed both owned sessions revoked
with `input_state = released`:

- `00000000-0000-4000-8000-000000001125`: revoked 07:01:29.738349 UTC;
  control released 07:01:30.283762 UTC.
- `00000000-0000-4000-8000-000000001126`: revoked 07:03:08.771117 UTC;
  control released 07:03:09.346973 UTC.

Both reported `user_revoked`. The existing computer and its data were retained.
No provider purchase, VM creation, guest update, network configuration, app
installation or Canary deployment was performed. No additional Hetzner spend;
the prior conservative reservation remains GBP 6.90 of GBP 10. No product code
changed, so no new unit-test suite or runtime rollback was needed. The receipt
itself is checked with `git diff --check` and committed on the existing PR branch.
