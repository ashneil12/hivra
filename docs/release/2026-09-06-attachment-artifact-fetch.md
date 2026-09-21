# Pinned attachment artifact acquisition — 2026-09-06

Scope: guest artifact fetcher and isolated download-to-staging acceptance,
baseline `bad6c0f45`. No Canary deployment/migration, retained-computer mutation,
provider purchase, model inference, login or service activation.

The existing VMID QGA input limit is 1 MiB; it cannot carry the roughly 100 MB
archive. `fetch-attached-codex.py` obtains only the fixed Codex 0.149.1 release
archive for the exact Linux architecture and expected boot. URLs cannot be
chosen by a caller. HTTPS redirects are restricted to GitHub release hosts,
environment proxies are disabled, TLS verification stays enabled, and HTTP
size/status, byte count and pinned SHA-256 are checked. A 180-second process
alarm bounds acquisition in addition to a 20-second socket timeout.

The root-private cache uses descriptor-relative directories, a checked exclusive
lock and exclusive temporary files. Verified publication cannot overwrite an
existing entry. Normal failed downloads remove only their own created temporary
file, never a pre-existing collision. Existing files are verified rather than
replaced. A crash between exclusive link/unlink can leave multi-link state that
requires reconciliation; no blind replacement or installer retry follows.

Independent review identified a namespace race: verifying through the old root
FD was insufficient if the directory pathname changed during acquisition. The
fixed code rewalks without creation/symlink following and checks root and final
entry identities before reporting `available`. File metadata is also checked
before/after hashing. Replacements remain preserved on refusal.

## Executed evidence

- Actual HTTPS download from the fixed GitHub release URL: 99,479,490 bytes,
  SHA-256 `e24fb784c7d71140d67afb620f56e9137496cf7f6c9e19217fa3666dcf306278`.
- The resulting root-owned cache archive was passed to the existing pinned
  durable worker and stager. Actual non-root Codex 0.149.1 version execution
  succeeded, returning `staged`, UID/GID 999, private home/account and expected
  executable SHA-256 `73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba`.
- Captured output is retained in
  `dashboard/src/lib/agent-computers/__tests__/fixtures/attachment-network-staging-result.json`.
  The TypeScript decoder accepts it against the explicitly launched identities
  and independently read fixture boot, not expected values inferred from output.
- The namespace-replacement test failed before the correction with
  `ValueError not raised`. Final Linux suite: **8 tests PASS, 2.618s**, including
  cached replay without network/inode/mtime mutation, URL guard, boot refusal,
  truncated-download cleanup, injected real SIGALRM, collision/symlink
  preservation, and directory replacement during a stream of real archive bytes.
- The final fetcher bytes then performed a second cold HTTPS acquisition
  successfully. The earlier cache was moved to an exact sibling path inside the
  owned container to preserve it while forcing that final cold check.
- Final TypeScript pin/receipt suites: **2 suites / 42 tests PASS, 0.318s**.
  ESLint and diff checks pass. The fetcher has an exact source SHA drift check.

Final fetcher SHA-256:
`252f4037e8bdc3ba4f3cfe68633031cb4abe1e2f1215ab72eda5510067b9b1b3`.
Worker SHA-256 remains `2a0aee3e5e3fc0d4403d41a93dbece648648c8a84ab4349a71d7fe87243121ab`;
stager remains `77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375`.

## Fixture, cleanup and limits

Owned container `8dfd63779657408d3caa43e06e9dc3dd898d3a78b00e3d9cccf2822bd3605a85`,
owner label `00000000-0000-4000-8000-000000001073`, existing image
`sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`.
Linux amd64 emulation, bridge network for HTTPS acquisition, no host mounts or
published ports, 256 MiB, one CPU, 32 PID limit, 600-second fixture deadline.
Boot observed before fetch/worker: `00000000-0000-4000-8000-000000001008`.
All accounts, cache copies and negative-test namespaces are disposable container
state. Exact label/mounts were inspected before stopping it.

This is real acquisition/staging evidence, not live QGA, browser attachment,
ARM execution, model work, runtime readiness or full core completion. Host
orchestration/asset delivery, activation and recovery/detach remain to be wired.
Rollback before deployment is a source revert; no live rollback was exercised.

Independent final review: no remaining actionable P1/P2; syntax, pure URL guards
and diff checked independently. Acquisition/container staging were performed by
the primary agent, not rerun by the reviewer. No reviewer resources remain.

Post-stop owner-filtered container inventory and exact anonymous-volume inventory
for `e2a22531925f611158e030202b74258f9426e516a1cc7ae324e5fa9d81c3b508`
were empty. All fixture state was removed. Decision: **PASS for the isolated
artifact-acquisition/staging milestone**, with live integration limits above.
