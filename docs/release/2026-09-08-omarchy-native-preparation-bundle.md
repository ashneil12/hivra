# Omarchy native preparation bundle — 2026-09-08

## Result

PASS for the source-only dedicated guest preparation bundle. The v3 guardian
and ownership helper now live under the canonical remote-desktop provisioner
source tree, and a VMID-bound host action can install their exact reviewed bytes
at the fixed guest paths before creating dormant per-computer preparation.

This does not change the general Hivra provisioner release or its Ubuntu,
Windows, provider-VM, or agent runtime compatibility. No host or guest was
updated and no public API invokes this action yet.

## Boundaries

- The dedicated loader accepts only the two fixed regular files beneath the
  canonical remote-desktop source directory and verifies their SHA-256 hashes.
- The host action rechecks running VMID, exact infrastructure-binding tag, and
  configured private IP before using QEMU Guest Agent stdin.
- The guest installer accepts no URL, executable path, or user-provided source.
  It writes only the two fixed root-owned paths using exclusive creation.
- An exact existing installation is reusable; changed content, permissions,
  ownership, links, parents, or preparation results fail closed.
- The guardian's existing `prepare` operation creates credentials and immutable
  preparation only. It does not activate Sunshine, pair a client, or report the
  desktop ready.
- The action requires a current `desktop_prepare` operation bound to the exact
  owner, computer, VM, and infrastructure identity. Uncertain transport is not
  retried inside the executor.

## Focused verification

- Dedicated preparation, capability, and guardian-dispatch Jest suites — 42
  passed.
- Ownership, supervisor, and guardian-unit Python suites — 63 passed or
  platform-skipped as declared by the suites.
- Dashboard TypeScript typecheck and direct ESLint — passed.
- Extracted guest Python and generated host Bash syntax checks — passed.
- Canonical source hashes remain `6dec977b...a773b` and
  `0f988ab0...7f950`.

## Remaining integration

The desktop preparation operation must route Omarchy to this dedicated action
and then run the dormant v2 capability inspector. Transitioning an older lab
guest away from its ordinary Sunshine service needs a separately owned,
preserving reconciliation; this bundle does not stop or overwrite it. Client
grant construction, Mac handoff, direct route proof, and input/release evidence
remain closed gates.
