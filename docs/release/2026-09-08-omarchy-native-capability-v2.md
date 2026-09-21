# Omarchy dormant guardian capability v2 — 2026-09-08

## Result

PASS for the source capability-boundary correction. Omarchy inspection no
longer treats the ordinary always-on Sunshine user service as preparation for a
per-lease native session. The VMID-bound observer now admits only the dormant
v3 Hivra guardian preparation and retains both native readiness flags as false.

This is source-only. It does not install the guardian bundle in a guest, prove
the direct UDP path, suspend agent input, call the guardian dispatcher, or open
the public Omarchy selector.

## Changed observation

- Requires the fixed root-owned guardian and ownership-helper paths and their
  exact source hashes before executing the guardian's read-only `observe` path.
- Revalidates the original computer, VMID, preparation operation, service UID,
  private IPv4 address, and Wayland display from the immutable v3 preparation.
- Requires no ordinary Sunshine process, no Sunshine TCP/UDP listener, and no
  active v3 lease before publishing a prepared descriptor.
- Revalidates pinned Omarchy/Sunshine packages, the Sunshine executable hash,
  root-owned preparation hash, guest boot identity, and scoped UFW rules.
- Publishes the fixed current native session protocol revision separately from
  the capability generation. The generation changes for boot, preparation,
  runtime, binding, or route identity changes, but not for a later observation
  timestamp or monotonic-boottime sample.
- Keeps `privateNetworkReachable` and `supportsInputTakeover` false. Those gates
  require their own route and input-lifecycle evidence.

## Focused verification

- Native capability, session broker, and guardian-host Jest suites — 74 passed.
- Dashboard TypeScript typecheck — passed.
- The extracted guest observer compiles as Python and its containing host
  script passes `bash -n` in the capability regression suite.

## Remaining integration

The pinned guardian sources must be included in the reviewed Omarchy guest
preparation and installed at the fixed paths. The native client's exchanged
certificate then needs an exact grant builder and lifecycle route around the
existing dispatcher. Direct or authenticated-relay route proof and controller
input/release acceptance remain required before native capability can open.
