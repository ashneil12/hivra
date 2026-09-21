# Private attached-Codex staging — 2026-09-06

Source-only milestone on `codex/hivra-core-experience-plan`, baseline
`3b28b25a7`. Stager SHA-256:
`77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375`.

The new `dashboard/provisioner/stage-attached-codex.py` stages a private CLI
without reusing the destructive fresh-machine provisioner. It verifies one
root-owned non-symlink artifact FD against pinned size/hash, admits exactly the
expected regular archive member, creates an exclusive installation directory,
new system account and private home, then runs an actual-account home-write
probe and `codex --version`. Only after those checks does it write a root-owned
staged receipt. No network/package manager, existing user configuration edit,
service activation, authentication or inference occurs. Collisions refuse an
in-place retry; partial failures remain for explicit reconciliation.

Artifact pins came from the official [Codex 0.149.1 release](https://github.com/openai/codex/releases/tag/rust-v0.149.1)
and GitHub release asset metadata; downloaded bytes matched those hashes:

- Linux x86_64 musl archive: 99,479,490 bytes,
  `e24fb784c7d71140d67afb620f56e9137496cf7f6c9e19217fa3666dcf306278`.
- Linux aarch64 musl archive: 91,899,352 bytes,
  `14df6802e39a956de994e844b90d51d8254bcc8057b6e66f0f3e3b8f7e2da5b0`.

## Actual local runtime evidence

Owned fixture label: `00000000-0000-4000-8000-000000001062`.
Pinned existing amd64 runtime image:
`sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`.
Execution was a Linux amd64 Docker container on the local Mac, not the Canary
Ubuntu VM. Network was `none`, no host bind mounts or ports, 768 MiB memory,
one CPU and 64 PID limit. The image supplied an anonymous `/opt/data` volume.

`test-attached-codex-stage.py` ran in the container using the actual pinned
x86_64 artifact. Result: `codex-cli 0.149.1` under the new non-root account;
three fixture file hashes and the pre-existing global CLI were preserved;
private home mode was 0700; no extra groups were assigned; a protected fixture
home was inaccessible to the new account. Invalid IDs, artifact symlinks,
existing-account retries, path symlinks and inaccessible existing ancestors
were rejected. Successful staging also ran with restrictive umask 0077.

Review found that umask could make new parent directories inaccessible, and
permission bits alone did not prove actual home access. The stager now sets
permissions only on newly created directories, refuses inaccessible existing
parents without chmodding them, and runs a bounded actual-account chdir/write/
fsync probe before binary extraction. `test-attached-codex-home-denial.py`
injects denied home permissions before that real probe and passed: no binary
or staged receipt was written; exact partial installation state was retained.
Independent reviewer Pauli reviewed the corrected stager and negative fixture,
checked the pinned source digest and syntax, and returned scoped GREEN. The
reviewer did not independently rerun the container execution or teardown.

Two setup attempts preceded acceptance: an existing box image lacked Python,
and a copied archive retained host UID 501 and was correctly refused. Neither
ran the installer successfully. The accepted fresh fixture explicitly supplied
root-owned artifact bytes; validation was not relaxed.

## Cleanup and limits

Accepted container `01486473ea5bf5de57525360aadbfb2b69d53b15595054573624b1d88a72aedf`
was stopped and removed; the owner-label inventory was empty. Its exact anonymous
volume `4c39eae0dbdc4e3b0b26934b7c0d5ce19bf9f8cd4ea256f427741490a1102c91`
was confirmed absent. Earlier owned setup containers were also removed. Downloaded
archives remain in ignored `.hivra-data/attachment-artifacts/codex-0.149.1-e90cfae6`
for subsequent bounded integration work; they are not committed or published.

No VM, retained computer, credential, live deployment or provider spend changed.
ARM64 execution was not tested. This proves private CLI staging only, not
attachment-worker fencing, runtime service/access, login, useful agent work,
detach, recovery or full core acceptance. Those gates remain open. Source
rollback is a reviewed revert; no live rollback was needed or exercised.
