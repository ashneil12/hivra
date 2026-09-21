# Ubuntu desktop: current open, reconnect and session release

PASS for this bounded live opening/reconnection check. It does not close the
full core, attachment, fresh-launch or OS-specific acceptance gates.

## Exact target

- Retained computer CANARY_ALIGNED_UBUNTU_0905:
  `00000000-0000-4000-8000-000000001025`.
- Signed-in normal Hivra Mac app, 980×690, expanded sidebar, dark theme.
- Local binary `apps/macos/HivraMac/dist/Hivra.app/Contents/MacOS/HivraMac`,
  SHA256 `289f38960bb057346fd7fcaee59d6ade7b42d53938398b55bfaf012b6dda364e`.
- Fresh Vercel inspection confirmed `https://canary.hermesos.cloud` resolves to
  `dpl_DP9fmpYx879wtrRyYEHf79APFSgo`, Ready, source
  `ddf11e93b1cbb9ffec32d3bf25d198df4d5e2677`.
- Normal public desktop path:
  `https://agents-canary-box-redacted.hermesos.cloud/desktop/handoff`.
- Cleanup read used linked Canary database `srrwbdvxlqvqjuexitaf`, selecting only
  the two observed session IDs and their non-secret release state.

## Actual actions and results, 2026-09-07 06:25–06:29 UTC

Opened the computer from Computers. Its installed runtime was rechecked and the
actual desktop rendered over WebSocket + WebCodecs, not just a healthy endpoint
or inventory status. UI secure-setup telemetry reported 12.7 seconds. No guest
input was sent; telemetry remained n=0. No takeover conflict was presented.

Returned through the Computers control. Session
`00000000-0000-4000-8000-000000001148` was revoked at
06:26:54.899226 UTC and its controller input released at 06:26:55.690906 UTC.
These are the server's recorded release results, not inferred from navigation.

Reopened the same computer through the normal inventory link. The desktop
rendered again; secure setup reported 4.8 seconds. This is a new session after
release, not a VM restart. Returned to Computers without guest input. Session
`00000000-0000-4000-8000-000000001149` was revoked at
06:28:10.619632 UTC and controller input released at 06:28:11.514930 UTC.
A final exact-ID query showed both input states released with non-null revocation
and control-release timestamps.

The final inventory displayed the same four retained computers Running at
2 CPU / 4 GB. App remains on Computers with expanded sidebar and dark theme.
Only the normal ephemeral viewing sessions were created and then released.
No guest command, file edit, resize, restart, delete, purchase, new VM, new native
binary, code deployment or migration occurred. No other session was terminated.
No added spend; conservative cumulative Hetzner reservation remains GBP 6.90/10.

## Limits

No guest input, model work, terminal command, file-byte comparison, reboot,
full-process restart, physical input-to-photon latency, multi-tenant concurrency
or fresh provisioning was tested in this slice. Existing desktop/user processes
were intentionally not stopped. The setup times are individual UI telemetry
observations, not performance percentiles or a platform SLA. Windows/Omarchy and
the unfinished attachment backend are not covered. This was verification of the
accepted release, not a new implementation milestone.
