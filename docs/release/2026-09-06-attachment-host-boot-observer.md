# Attachment host boot observer — 2026-09-06

Scope: source-only read-only guest observation path, baseline `90ae2c213`.
No live execution, guest installation, database mutation, deployment or spending.

`attachment-host-observer.ts` connects the existing Hivra execution-context
resolver and Proxmox host-script service to a new bounded boot probe. It requires
the owner's source row to hold the exact attachment operation and be a running,
identity-bound Ubuntu Proxmox computer. Unavailable or unenforced host authority
cannot execute the probe. Host failures and malformed/foreign results return
categorical errors without reflecting raw potentially private output.

`attachment-host-observation.ts` validates the full target before generating
commands. The script acquires the existing `/run/lock/hivra-allocation.lock`, then
checks running VM status, exact infrastructure binding tag and configured IP.
It executes a fixed root/Linux/architecture/boot probe through the existing
VMID-scoped QEMU Guest Agent transport, not guest-IP SSH. Each `qm` invocation
has a 20-second timeout with forced-stop escalation five seconds later, and
allocation-lock wait is limited to 10 seconds;
the server host call is bounded to 90 seconds and 16 KiB output. The parsed
observation is at most 4 KiB and must match every requested target field.

No caller-provided command, installer, package manager or guest write is involved.
Host lock and temporary QGA-result files use the existing transport mechanics.
The orchestrator must still load the request from its durable authorized claim,
save the observation in SQL and obtain the separate dispatch decision. This
observer cannot itself grant installation or release a lifecycle operation.

## Verification and limits

Focused tests exercise generated Bash syntax, bounded QGA selection, target
validation, exact receipt correspondence, owner/lease/profile checks, rejected
authority, transport uncertainty and private-output suppression. The host runner
and context resolver are mocked: these tests are not actual Proxmox/QGA or live
browser evidence. The separate local lock fixture is recorded below.

The first full TypeScript check caught an incomplete mock execution-context
fixture; it was replaced with a complete typed managed-Canary fixture rather
than weakening the production type. No production code changed for that error.

Application dispatch integration, artifact transfer, installer execution,
runtime/access activation, recovery/detach and normal UI acceptance remain open.
This is not an enabled Attach Agent workflow. Rollback is reverting these
unconnected source files; no live rollback was exercised.

## Review corrections and final checks

Independent review identified two gaps before commit: caller mutation during
asynchronous context resolution could retarget the admitted read, and a
TERM-ignoring `qm` needed forced-stop escalation. The observer now freezes copies
of its scalar source/request fields before any await. A deferred-resolver
regression changes owner, operation, source, computer, VMID and IP on the original
objects; execution and result validation still use the admitted snapshot.
The host wrapper now uses `timeout --kill-after=5 20 qm`.

Final focused suites: **2 suites / 26 tests PASS, 0.337s**. Full dashboard
TypeScript, ESLint and diff checks pass. These are source/mocked-host checks, not
actual signal escalation or live QGA acceptance; no guest termination is claimed.

Probe source SHA-256: `d4e637e5d86a076da8f9142bf1adf1cd37d263ad40344a8471beb91bc57af5bd`.
Observer source SHA-256: `8634f5aec18e79dfc6972d767a58124797a6427a380892c53b160ec2813bb34b`.

The reviewer reproduced the mutable-input defect by an in-memory reversal of
only the snapshot fix, and confirmed the fixed admitted-target behavior. No
reviewer-owned process/resource remains. Explicit UUID/tag lengths additionally
reject full valid values with trailing newlines; both have focused regressions.

A further preservation finding was fixed before commit: `install -d` could
chmod the shared lock directory, and shell redirection could truncate/follow an
existing lock path. The fixed Python opener pins both directories by descriptor,
preserves mode/content, requires a root-owned sticky directory if it is writable,
opens without following symlinks or truncating, validates a root-owned regular
single-link non-writable lock, acquires it with a bounded wait, and inherits that
descriptor into the generated host script.

`test-attachment-host-lock.py` ran the exact embedded opener in an isolated root
Linux container: **PASS** for preserving `1777` directory mode, lock inode/mode/
bytes, and refusing writable, foreign-owned and symlink locks without changing
the victim bytes. This is real local Linux filesystem evidence, not Proxmox/QGA.
Fixture `7cfa91bc5c161804417814ded5f3f77d928dd237bf0bba5a2327df6989c82398`,
owner `00000000-0000-4000-8000-000000001078`, existing image
`sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`,
Linux amd64 emulation, network none, no host mounts/ports, 256 MiB, one CPU,
32 PID limit and 300-second deadline. Exact label/mounts inspected before stop.
Post-stop owner-filtered container and exact anonymous-volume
`6a49b8b360b43c7c185fe014f43a4943f973bdbbc26bdb6cebe959270d202f53`
inventories were empty. No owned fixture remains.

Decision: **PASS for the source observer and isolated lock-preservation checks**.
Independent final review found the lock correction resolved the remaining P2
and reported no residual actionable P1/P2; 26 Jest tests and diff checks passed
independently. Descriptor inheritance is source-reviewed, not directly exercised
by a competing child lock test. Live QGA and full attachment remain unverified.
