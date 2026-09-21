# Omarchy guardian process-stop observation

Status: PASS for the internal process-stop observer: focused checks, lifecycle
regression and independent review passed. This is source/component evidence,
not native desktop acceptance.

## Scope and implementation

The internal `observe_lease_stop()` in `omarchy-native-supervisor.py` implements
the process-teardown observation required by the existing native-session plan.
It is read-only and separate from the guardian's own finally block. It takes the
exact consumed grant, holds the original preparation operation lock, checks the
retained active claim, guest boot, unit bytes and original systemd invocation,
then requires a stopped service, empty recursive cgroup and closed stream/admin
sockets. It rechecks original evidence after external observation. Missing,
collected, restarted, rebooted or changed evidence is a hold, not absence.

No CLI command, installer, broker route or public capability was added. No claim
is removed. The result remains `releasePending: true` and `desktopReady: false`:
stopped Sunshine processes do not by themselves prove Hyprland agent-input
suspension or authorize controller release. Native dispatch/release integration
must preserve that distinction.

The socket check uses the guest network namespace's TCP/UDP tables for both IP
families, not a successful or failed localhost connection. It rejects live stream
and administrator port users; TCP TIME_WAIT alone is not a live socket owner.
Shared mDNS port 5353 is not treated as exclusively Sunshine-owned; all processes
in the owned cgroup must still be gone, including any owned discovery process.

## Evidence

- Isolated Linux: 10 stop-observer tests passed in 9.948 seconds. Actual IPv4 and
  IPv6 TCP and UDP sockets were opened, prevented a stopped result, then closed;
  the next observation passed. The unit/cgroup boundary is explicitly substituted.
- Contracts cover changed/collected/running units, unknown invocation, restart
  policy, pending reload/drop-ins, reboot, changed grant/claim, changes during
  observation, recursive cgroup population and missing observation files.
- macOS: two cgroup contract tests passed; eight Linux-only checks skipped.
- The existing 14-test actual Sunshine lifecycle suite passed in 37.203 seconds
  after adding the observer. Its systemd context remains explicitly substituted.
- `git diff --check` passed. Final Docker inventory contained no owned guardian
  test containers; unrelated local services were preserved.
- Independent reviewer `core_gap_map` reran all 10 stop checks in the pinned
  isolated container and found no actionable P1/P2. Its container was removed;
  no source or live resources were edited during review.
- Read-only node-b `systemctl show apt-daily.service` observed loaded/inactive/dead,
  MainPID 0, a retained 32-hex InvocationID and empty ControlGroup. This confirms
  stopped-property serialization only. No unit was installed/reloaded/started.
- Recursive population semantics follow the
  [Linux cgroup v2 documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#un-populated-notification):
  `cgroup.events` covers descendants; an empty top-level PID file is insufficient.

Repeatable focused check:

```sh
docker run --rm --name hivra-guardian-stop-check \
  --platform linux/amd64 --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev -e PYTHONDONTWRITEBYTECODE=1 \
  --mount type=bind,source=/Users/example/Projects/Hermesdeploy-canary,target=/work,readonly \
  sha256:5478d6a069d57a5b96cfd74e18476ffe16fe5c53dad22dab674467c1de472763 \
  /work/dashboard/runtime-adapters/omarchy-native/guardian-stop.test.py
```

## Limits and next integration

Actual systemd ownership/termination, guardian hang/death, VM suspend/reboot,
controller release and native media/input/audio remain unverified. This helper
does not resolve the missing private Mac-to-guest path. The next implementation
must wire the exact unit recipe, native admission/dispatch and separate input
release proof rather than treating this snapshot as complete launch support.

No provider/guest/customer state, route, firewall or Canary deployment changed.
No additional Hetzner spend; the conservative cumulative reservation remains
GBP 6.90 of GBP 10. Test-owned temporary state was cleaned by the test harness;
main and independent test containers were removed. Source rollback
is a branch/PR revert; no live rollback is required.
