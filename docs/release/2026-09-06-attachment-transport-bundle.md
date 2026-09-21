# Pinned attachment transport bundle — 2026-09-06

Scope: source-only bounded script packaging and isolated guest execution,
baseline `7c5f5a606`. No live QGA call, Canary change, provider purchase or model
inference. No application route/caller is enabled by this milestone.

`attachment-guest-bundle.ts` validates and snapshots the expected operation and
boot, reads four fixed source files, copies and verifies their exact SHA-256,
then produces the pinned runner plus a JSON stdin packet limited to 65,536 bytes.
The three base64 script assets fit within the existing 1 MiB VMID QGA stdin
limit. No caller-selected path, URL, command or additional asset is accepted.
UUID expectations now reject trailing-newline suffixes through an exact length.

`run-attached-codex-bundle.py` verifies every asset before loading any code,
checks bound Linux architecture/root/boot, and distinguishes two internal actions:

- `fetch` invokes only the pinned archive cache acquisition. It cannot install.
- `stage` requires the already verified cache and never downloads. It creates
  only an exclusive root-owned temporary stager, invokes the pinned durable
  worker, and removes only that exact temporary inode. Directory/file namespace
  revalidation and FD-relative cleanup preserve replacements and collisions.

This packet is not an authorization token. The orchestrator must obtain the
durable dispatch grant before stage, retain the shared lease on uncertainty, and
use a separate read-only journal observation path for lost acknowledgements.
Do not turn the local replay test into permission to redispatch when a journal
may be missing after recovery. Read-only journal reconciliation remains to be
connected before exposing attachment.

## Executed checks

Owned Linux container with networking disabled and a seeded, previously verified
release archive: **6 tests PASS, 3.390s**. Cases cover fetch without installation,
malformed/tampered bundles rejected before source loading, missing-cache stage
without fetch or journal creation, actual pinned non-root Codex staging, replay
with subprocess execution forbidden and unchanged journal bytes, temporary-file
cleanup/collision preservation, and wrong-boot refusal with unchanged temporary
inventory. The latter does not independently detect create-then-clean behavior;
the pre-creation gate was checked in source review.

TypeScript bundle/result/receipt suites: **3 suites / 46 tests PASS, 0.338s**.
Full dashboard TypeScript, scoped ESLint and diff checks pass. Source digest
checks cover the runner plus fetcher, worker and stager. These tests do not prove
actual Proxmox transport, UI behavior or database orchestration.

Runner SHA-256: `15ebb4534cecafa1b60ac0b3d5e73b00111a54a572516bd67ca84104a30ececa`.
Fetcher: `252f4037e8bdc3ba4f3cfe68633031cb4abe1e2f1215ab72eda5510067b9b1b3`.
Worker: `2a0aee3e5e3fc0d4403d41a93dbece648648c8a84ab4349a71d7fe87243121ab`.
Stager: `77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375`.

## Fixture and limits

Container `f13b2bfe713dff68a492da0c7006128f6cda4febb0e80710a53a1d21bdf7107c`,
owner `00000000-0000-4000-8000-000000001090`, existing image
`sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`,
Linux amd64 emulation, no network/host mounts/ports, 768 MiB, one CPU, 64 PID
limit and 300-second deadline. Exact label/mounts inspected before stop. All
guest accounts/installations/cache state are confined to the disposable fixture.

Exact owned container stopped and removed. Post-stop owner-filtered container
inventory was empty, and anonymous volume
`8a16f63b2b344b422d397dc8edaf97a8cb795a68827a8ea5ee69b4a07787f759`
was absent. No retained computer was changed and no additional money was spent.

Independent scoped review: GREEN, no actionable P1/P2 findings. Reviewer
independently passed the 46 TypeScript tests and diff check; Linux execution was
not independently repeated. Optional wrong-boot test strengthening remains a
test-quality improvement, not evidence of a source defect.

Host action orchestration, read-only lost-result reconciliation, activation,
recovery/detach and normal UI acceptance remain open. Rollback is a source
revert before deployment; no live rollback was needed or exercised.
