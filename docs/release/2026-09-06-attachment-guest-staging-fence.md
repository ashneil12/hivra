# Attachment guest staging fence — 2026-09-06

Scope: private source-only worker component on `codex/hivra-core-experience-plan`,
based on `8a06ad044`. No Canary migration/deployment, retained-computer mutation,
service activation, model inference, or spending. The existing authority and
shared database lease remain required; this journal does not authorize dispatch
or release that lease.

## Implementation

`dashboard/provisioner/run-attached-codex-stage.py` verifies and executes the
exact reviewed `stage-attached-codex.py` bytes through a fixed isolated Python
interpreter. It uses a root-owned private directory, checked non-symlink files,
an inherited exclusive flock, file/directory fsync, and atomic journal replacement.
The operation, dispatch, installation, binding, canonical computer, source row,
architecture and current guest boot are bound into the record.

Durable `started` precedes spawn. A spawn/wait failure, bad output or partial
installation keeps that record and refuses redispatch. A successful exact receipt
is recorded as `staged`, never `ready`; same-boot replay returns it without running
the installer. Other identities, old boots, malformed records and dangling
journal symlinks fail closed. There is no automatic journal reset, expiry,
installation cleanup, database unlock or service activation.

## Executed evidence

- Owned local Docker fixture: `0e2bf645b2a9cfdbb5df7194717c5d3d020e0eeee498baa53bf5aeda38fde74d`.
- Owner label: `00000000-0000-4000-8000-000000001075`.
- Existing image: `sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`,
  Linux amd64 under emulation, network none, no host mounts or published ports,
  768 MiB, one CPU, 64 PID limit, 600-second fixture deadline.
- Copied stager and archive explicitly changed to root ownership inside this
  disposable container; no relaxation of the real input ownership check.
- `python3 -I -B /tmp/test-attached-codex-worker.py`: **8 tests PASS, 3.812s**.
  Actual pinned Codex 0.149.1 staging and a discarded-return/replay check; replay
  forbids subprocess execution and preserves journal bytes and binary inode/hash.
  Additional cases: injected spawn timeout observes `started` before execution,
  no retry after uncertainty even with changed IDs, held flock, wrong installer
  digest, old-boot record, JSON null journal, dangling symlink and bad receipt shape.
- Adjacent Jest contracts: attachment receipt parser and actual PostgreSQL
  attachment lease fixture, **2 suites / 21 tests PASS, 1.372s**.
- `git diff --check`: PASS.

Worker SHA-256: `f645a509a56c8c5255fd96868a5ec25a91f49ad298323c23251e7d240af945e4`.
Final test SHA-256: `a87270e529a91e8c849a995c59721f14f663b8c54a1725f07953ec275bd62ace`.
Pinned stager SHA-256 remains `77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375`.

## Cleanup and limits

Exact owner label and container mounts inspected before stopping the owned
container. Docker `--rm` removed it and its anonymous volume
`8906060a8e5712287f3f1e8ad121be80231299075d2abbbbf11252a93e48758c`;
owner-filtered container and exact-volume inventories returned empty afterward.
All test accounts, binaries and journals were confined to that removed container.

This does not prove actual SSH observer death, VM reboot recovery, ARM execution,
public UI behavior, model authentication or useful agent work. Host integration,
terminal database recording, runtime/access lifecycle, reconciliation and detach
remain unimplemented. No database lease should be released from this receipt.
Rollback is removal/reversion of these unconnected source files; no live rollback
was necessary or exercised. Independent source review is recorded below before
promotion of this milestone.

## Review and final rerun

Independent reviewer Pauli reported no actionable P1/P2 source finding at the
worker digest above; syntax and diff checks passed independently. The reviewer
did not rerun the container tests. Their nonblocking test-quality observation
was addressed: a complete valid receipt is now accepted first, then boolean
UID/GID/version, `ready` state, wrong binary hash and out-of-range account IDs
are rejected individually instead of failing only on incomplete object shape.

Final suite: **8 tests PASS, 4.124s**, same command and image, in fresh owned
container `eb1dec271163229a33618f89517b403cf6e1fe06ffb5f979f2dcf106fa8c783a`,
owner `00000000-0000-4000-8000-000000001076`, 300-second deadline. The worker
source did not change after review. Exact label/mounts were inspected before
stopping it; owner-filtered inventory and exact anonymous-volume inventory for
`7e5c9d9bf59a92bfd0544d37b38d1999928d63bfa8a0afbc99be22eb5a71b371`
were empty after automatic removal.

Decision: **PASS for the private source component** and isolated staging/replay
checks only. Full attachment/live acceptance remains open with the limits above.
