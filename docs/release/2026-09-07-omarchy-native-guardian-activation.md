# Omarchy native guardian activation source evidence — 2026-09-07

## Result

PASS for the bounded guardian and native-client foundation. The v3 Omarchy
guardian started a hash-bound, deadline-bounded Sunshine systemd service on the
canary Omarchy VM. An isolated Moonlight v6.1.0 profile on macOS connected to it,
started the `Desktop` application, and initialized Apple VideoToolbox hardware
decoding. The exact stopped invocation then released its controller claim through
the new atomic release path.

The Omarchy native selector remains disabled. The canary provider firewall
dropped the Sunshine UDP ports before packets reached the Proxmox host, so the
end-to-end stream used a temporary TCP-encapsulated validation relay. That relay
and its nftables rules were removed after the test. A production authenticated
443 relay and server-to-guest activation dispatch are still required before the
app can perform the whole session automatically.

## Changed behavior

- The grant includes the exact systemd runtime maximum in microseconds.
- Activation validates the guest boot deadline and pinned preparation, Sunshine,
  guardian, ownership helper, and unit identities before writing authority.
- The root-owned one-use grant is persisted before the unit is installed or
  started. Start failure remains a hold and a retry cannot create another unit.
- The unit runs the root guardian with `Restart=no`, `KillMode=control-group`,
  `KillSignal=SIGKILL` and `RuntimeMaxSec`. `NoNewPrivileges=no` is explicit because the pinned
  Omarchy Sunshine binary needs its packaged file capabilities for capture and input.
- Native issue, exchange, authorization, and renewal use a revision containing
  the inspector, guardian, and ownership source hashes.
- Sunshine receives the exact Hyprland session environment and a valid
  `apps.json` containing both `apps` and `env`; the missing `env` member caused
  the pinned Sunshine build to abort during the first canary activation.
- Stop observation accepts a cleared systemd invocation only when one exact,
  retained terminal journal record matches the consumed grant. Release writes
  its authorization, atomically moves the active claim into the lease audit
  directory, and records the completed release.
- The macOS client can create an isolated per-session Moonlight identity and
  preload the exact Sunshine UUID and pinned certificate, removing Moonlight's
  interactive pairing screen without putting private key material in a URL or
  process arguments.

## Verification

- `python3 dashboard/runtime-adapters/omarchy-native/guardian-unit.test.py` — 4 passed.
- `python3 dashboard/runtime-adapters/omarchy-native/supervisor.test.py` — 13 passed, 7 platform/runtime checks skipped on macOS.
- `python3 dashboard/runtime-adapters/omarchy-native/guardian-stop.test.py` — 2 passed, 10 Linux-root checks skipped on macOS.
- `python3 dashboard/runtime-adapters/omarchy-native/ownership.test.py` — 33 passed, 4 platform/runtime checks skipped on macOS.
- `swift test` in `apps/macos/HivraMac` — 25 passed, including pinned-host profile preparation.
- Focused Jest capability, session-broker, transport, and profile suites — 75 passed.
- Dashboard TypeScript typecheck — passed.
- Direct ESLint on the four touched TypeScript files — passed.
- Python bytecode compilation for the guardian and new unit test — passed.

## Live acceptance

- Target: canary VM 2099, computer `00000000-0000-4000-8000-000000001145`.
- Moonlight connected through its loopback endpoint at 12 Mbps and 60 FPS,
  launched `Desktop`, selected the Apple M5 Pro Metal device, and initialized
  VideoToolbox H.264 decoding at 1280x720.
- Sunshine ran inside the expected one-shot systemd cgroup and stopped at its
  runtime deadline. Session `00000000-0000-4000-8000-000000001146`, lease
  `00000000-0000-4000-8000-000000001147`, produced an exact release record with
  `ownedProcessBoundaryStopped:true`, `controllerReleased:true`, and
  `releasePending:false`.
- Direct public UDP was not proven. Host nftables counters remained zero while
  external probes ran, locating the drop before the host. Browser access remains
  on its existing supported transport while the native 443 relay is unfinished.
