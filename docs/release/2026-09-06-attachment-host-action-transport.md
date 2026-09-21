# Attachment host action transport — 2026-09-06

Source-only continuation from `f95bab179`, high-risk transport scope. This adds
the internal host builder/executor for pinned `fetch`, `stage` and `observe`
bundles. It does not enable a route, grant SQL dispatch, apply migrations, change
Canary or authorize a stage outside the durable orchestrator.

The builder validates matching operation/computer/source/architecture in the host
target and guest expectation. It uses the same existing allocation-lock program
as the boot observer, then checks running VMID, binding tag and configured IP.
Only the fixed pinned runner and bounded JSON stdin go through VMID-scoped QGA;
there is no private-IP SSH, arbitrary command, download URL or path escape hatch.
Host metadata calls have 20-second deadlines. Guest command deadlines are
fetch 210s, stage 330s and observe 20s; SSH deadlines are respectively 290s,
410s and 100s. The existing guest fetch/stage limits remain 180s/300s.

The executor snapshots row/expectation before awaiting host resolution. It
requires exact owner/source/held `agent_attach` operation, running Ubuntu on
Proxmox and enforced binding. Pending deletion permits only observe. Host output
is bounded; successful fetch must match exact architecture, boot, archive
hash/size/cache path, while stage/observe use the existing strict receipt parser.
Errors retain uncertainty without automatic retry, activation or lease release;
raw host output/errors are not returned in failure results.

This adapter is not an authority boundary on its own: its future durable caller
must load authoritative rows and win the stage dispatch CAS exactly once. It
must not be attached directly to a browser-provided request. Stage must run in
a durable worker, not a short synchronous HTTP request. Lost acknowledgements
must use observe, never rerun stage. These integration requirements remain open.

## Verification

Five focused Jest suites: **54 tests PASS, 0.489s**. Cases cover each action,
generated shell syntax, bound transport/check ordering, malformed/cross-target
requests, both architecture acquisition contracts, source pins, authority denial,
input mutation during async host resolution, pending deletion, foreign results,
transport failure without replay, and the unchanged boot observer behavior.
Host calls are mocked; these tests do not establish real QGA or UI acceptance.
Full TypeScript, scoped ESLint and diff checks pass.

The exact shared Python lock program was executed in a unique root Linux
container: PASS, preserving shared directory mode and lock inode/mode/bytes and
rejecting writable, foreign-owned and symlink locks. The program bytes are
unchanged; its export and the fixture's extraction delimiter were updated.
This fixture did not run Proxmox, fetch/stage an agent or exercise a real VM.

Source SHA-256 values:

- `attachment-host-action.ts`: `8cd041081107284f009756721aca8ae6a4fa687d07ea24653b97e5c72e518036`
- `attachment-host-executor.ts`: `4d5b10efeb5a3256c0eb7d53ae9264b0bc449c61de1e3869cd5bf57b7b001b12`
- `attachment-artifact-result.ts`: `1e15c01c85268735903eb47c08722f39327a19ab04119688d9653f4c8678b535`

## Ownership and limits

Container `ab0eff24144479e78cb26de9674e70146e2609104af16497ecfa4efa0f7e2fdf`,
owner `00000000-0000-4000-8000-000000001077`, existing image
`sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`,
Linux amd64 emulation, network none, no host mounts/ports, 256 MiB, one CPU,
32 PID limit, 180-second deadline. Exact label/mount inventory inspected;
anonymous volume `c4fc9bd6e52d1df06b7d163799d3cca08264f84841804c93dc5b4f9356f7501e`.
Exact owned container stopped and removed; owner-filtered container inventory
and exact anonymous-volume inventory were both empty afterward.

Independent scoped review: GREEN, no concrete P1/P2 findings. Reviewer passed
54 focused tests (0.371s), diff checks and an extracted old/new lock-program
byte comparison. No live host execution was performed by the reviewer. Scoped
source milestone: PASS; live integration remains unverified. A host/QGA timeout
is not proof of guest termination, and must leave the operation held for
reconciliation rather than release or redispatch.

No additional spending or retained-computer changes. Rollback is a source
revert before deployment; no live rollback needed. Durable DB orchestration,
service/access activation, detach/recovery and normal Canary UI acceptance are
still required. A staged receipt does not prove runtime health or model work.
