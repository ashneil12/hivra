# Omarchy native guardian dispatch foundation — 2026-09-08

## Result

PASS for the source-only VM-bound lifecycle dispatch foundation. The server can
now build and execute exact `activate`, `observe-ready`, `revoke`, `observe-stop`, and
`release-stop` guardian transitions over the existing Proxmox QEMU Guest Agent
authority. The guest guardian now accepts an idempotent revocation request for
one exact consumed lease and retains controller release as a separate,
proof-bound transition.

This checkpoint does **not** enable the Omarchy selector or claim one-click
native desktop support. No API route calls the dispatcher yet, the native
capability inspector still describes the older standard Sunshine service, and
the retained Canary Omarchy VM does not currently expose QEMU Guest Agent.
Direct UDP reachability remains tomorrow's separate network gate.

## Boundaries

- Dispatch selects the exact VMID through QEMU Guest Agent after checking the
  Hivra infrastructure-binding tag and configured private IP on the Proxmox VM.
- SSH and guest IP are not used as guest identity.
- The fixed guest guardian and ownership-helper paths are SHA-256 checked before
  every transition; the guardian rechecks the full consumed grant and runtime
  identities at its own lifecycle boundary.
- Revocation creates or re-observes only the exact immutable marker for the
  active lease. A changed grant, claim, guest boot, or marker is a hold.
- An uncertain host response is not retried by the dispatcher. Revocation is
  explicitly idempotent if a caller later re-observes the same exact request.
- Revocation does not release controller ownership. Stop observation and the
  atomic release transition remain required.

## Focused verification

- `python3 dashboard/runtime-adapters/omarchy-native/guardian-unit.test.py` —
  6 passed.
- Guardian lifecycle and stop suites — 26 cases completed; 24 Linux-root cases
  skipped on macOS.
- Focused guardian dispatcher, native capability, and session broker Jest
  suites — 74 passed.
- Focused dispatcher and native-capability Jest rerun — 35 passed.
- Dashboard TypeScript typecheck — passed.
- Direct ESLint on the changed TypeScript files — passed.
- Python bytecode compilation and `git diff --check` — passed.

## Next integration

The server-side grant builder now converts a fresh prepared descriptor and an
already-exchanged, certificate-bound session into the exact one-use guardian
grant. It derives the guest CLOCK_BOOTTIME deadline from the descriptor,
reserves a 60-second activation budget inside the five-minute authority, and
hashes unit bytes that are cross-checked against the Python guardian's actual
unit generator. Stale clocks, unsafe integer conversion, and a lease too short
to activate fail closed. This builder is source-only and does not dispatch.

The database now also has a serialized activation claim. It admits only an
unexpired, exchanged, certificate-bound Omarchy controller whose exact current
capability still proves Sunshine route and input takeover, whose owner computer
is idle and running, and whose grant retains at least 65 seconds. The first
claim records one unique activation ID; repeats are rejected. The broker
validates the returned public certificate again and never forwards the raw
session token. This is still source-only authority, not a guest activation.

An owner-only same-origin activation route now coordinates the next boundary:
it performs a fresh read-only inspection without replacing the already-admitted
route receipt, serializes the activation claim, reloads the owner computer, and
dispatches the exact one-use guardian grant once. The guardian publishes an
immutable public readiness record only after its authenticated admin API proves
the exact paired client. The route then polls only the read-only observer, which
rechecks the active systemd invocation, populated cgroup, grant, pairing, boot,
server certificate and source identities before returning `desktopReady: true`.
Generation drift stops before dispatch; an uncertain activation is held and is
never replayed. No product UI calls this route yet.

Replace the contradictory ordinary-Sunshine capability observation with the
dormant v3 preparation/guardian identity, install the pinned guardian bundle in
the Omarchy image, and bind the native client's one-time exchanged certificate
to this dispatcher. Only after the direct or authenticated-relay path and
input/release evidence pass should the capability flags or selector open.
