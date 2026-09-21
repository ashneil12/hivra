# Read-only attachment receipt recovery — 2026-09-06

Source-only continuation from `f5164af61`. The pinned transport bundle now has an
internal `observe` action alongside `fetch` and `stage`. No live host, database,
route or UI caller is enabled. This is not attachment completion or readiness.

After validating every source pin and the expected identity/architecture/boot,
observation loads only the worker's validation helpers. It walks existing journal
directories through no-follow directory descriptors, requires the existing
private lock, takes a nonblocking shared flock, and reads a bounded private
journal. Only the exact staged envelope with a valid nested receipt is returned.
File metadata is checked around the read, and the root namespace, lock and
journal identities are revalidated before returning.

Missing directories, lock or journal, a busy installer, symlinks, unsafe modes,
started/malformed/foreign/old-boot records remain unresolved. There is no create,
download, installer execution, reset, lease release or permission to redispatch.
Observation is not an audit of the installed binary's current runtime health.

Runner SHA-256:
`ec5760568541f03024a10c62c884638b3ba2a0bbca26c18b91260c8130111fb3`.
The server bundle loader pins these bytes and accepts only the three named
actions. Fetcher, worker and stager pins remain unchanged.

## Executed verification

Owned root Linux amd64 container, existing image, no network/host mounts/ports:
**7 tests PASS, 3.366s**. Existing fetch/stage checks still execute the real
pinned Codex binary. The resulting real staged journal is then recovered through
`observe`, with write/create open flags, mkdir and subprocess calls forbidden;
only the worker module loads. Journal bytes/metadata and directory inventory
remain unchanged. Reads may naturally update filesystem access time, which is
not claimed preserved.

Additional cases cover missing namespace without creation, busy exclusive lock,
missing lock/journal without replacement, lock/journal symlink refusal, malformed
record, started state, changed dispatch/boot, invalid account receipt and unsafe
journal mode. Each refused record is preserved. Wrong-boot stage now explicitly
forbids any `os.open` attempt, strengthening the prior inventory-only assertion.
Namespace replacement rejection was inspected in source, not fault-injected in
this fixture. This is not live Proxmox/QGA or UI acceptance.

TypeScript bundle/result/receipt: **3 suites, 47 tests PASS, 0.342s**. Scoped
ESLint, full `tsc --noEmit --incremental false` and diff check pass.

## Fixture, review and remaining work

Container `d5913528940a865673a4b4c8ab999dcfcc86fc844c5904d5d7be672259af9554`,
owner `00000000-0000-4000-8000-000000001079`, image
`sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`,
768 MiB, one CPU, 64 PID limit, 300-second deadline. Anonymous volume
`c5494cf9a869efe82ae03d2f2096b8b35327d1e0f7cf85f616e08e01fc1251ad`.
Exact ownership label and mounts inspected. Exact owned container stopped;
post-removal owner-filtered container inventory and exact anonymous volume
inventory were both empty. No owned fixture remains.

Independent scoped review: GREEN, no concrete P1/P2 findings. Reviewer checked
the read-only branch, exact receipt/boot validation and namespace/lock/journal
revalidation; independently passed 47 Jest tests, Python AST syntax and diff
checks, and confirmed the runner digest. Linux fixtures were not independently
repeated. Cross-boot recovery and lease-release acceptance remain unimplemented.

Next: bind fetch/stage/observe to the host transport and durable database
admission/dispatch/result flow, then service/access activation, recovery/detach
and the normal owner UI. All pending attachment migrations remain unapplied;
no retained computer changed and no additional money was spent. Rollback is a
source revert before deployment; no live rollback was needed.
