# Omarchy inactive-preparation resume — source checkpoint

Status: **PASS for the bounded source milestone only.** Omarchy launch/native
session acceptance remains open. Nothing was deployed or activated.

## Identity and scope

- Task: `omarchy-inactive-resume-2026-09-06`.
- Source baseline: `6ffdf4721`; contribution branch
  `codex/hivra-core-experience-plan`, existing PR #600.
- Helper SHA-256:
  `2a535a2bfed8b5e73c836f731793b4bd8d1edaa564c9436370c7deb1ac82f46d`.
- Test SHA-256:
  `f66f3e37b12c77dea73a6a6337fd8e476f6ea1d25afe021a7f8bb2117a040ab4`.
- Authority: local source work under the owner's weekend continuation request.
  Canary, live guest, service, network, pairing, credentials from real users,
  and provider mutations were not needed and were not performed.
- Blast radius: high-risk preparation/recovery boundary; uninstalled private
  helper only. Independent implementation review was required and completed.

## Changed behavior

New preparations write ownership-v2 intent and eight immutable cumulative
checkpoints. Explicit `resume` receives the exact original binding on stdin,
holds the same nonblocking intent-file lock used by prepare, and verifies the
original root, intent, operation, installed Sunshine identity, service identity
and traversal, every recorded inode/hash/mode/owner, and the inactive namespace.

Completed steps retain their original evidence. The next step creates only
missing recipe-defined resources; existing credentials are never regenerated.
Interrupted steps with uncheckpointed artifacts, altered or replaced resources,
unexpected entries, missing/extra/torn checkpoints, duplicate JSON keys,
activation markers, service overrides, competing writers, or legacy intent are
refused. Refusal never deletes or adopts the residue.

The effective systemd gate is unchanged. Stale cache or a pending daemon reload
does not become a successful receipt, and resume does not reload or start a
service. It is not a session lease, pairing interface, capability publisher, or
native desktop admission. Existing v1 observation remains available; v1 resume
is deliberately refused. A disk intent is provenance, not authentication of a
future control-plane caller.

## Checks and review

Checks completed locally on 2026-09-06, by **04:12:44 UTC**:

- `PYTHONDONTWRITEBYTECODE=1 python3 dashboard/runtime-adapters/omarchy-native/ownership.test.py`
  — 37 tests, 33 passed and four Linux-only skips; exit 0.
- The same test file in already-present Linux image
  `sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`
  — 37 tests, 36 passed, one filesystem ACL skip; exit 0, 29.171 seconds.
  Docker used `--platform linux/amd64 --network none --read-only --rm`, a
  disposable `/tmp` tmpfs, two read-only source-file mounts, and explicit
  `--entrypoint python3`. No pull or image modification occurred.
- Every durable checkpoint boundary resumed with the already-sealed bytes and
  inode identities unchanged. Every pre-checkpoint interruption with unsealed
  side effects refused without modification. Tests also cover original-service
  preservation, same-operation locking, original root/intent replacement,
  changed operation/runtime, stale systemd, fixed paths, duplicate keys,
  unexpected state/credential/checkpoint entries, and legacy refusal.
- The initial resume regression failed because the operation did not exist.
  Independent review then reproduced two P2 publication races. Their new
  deterministic regressions were observed failing before correction and passing
  afterward: a later checkpoint must not rebase changed key bytes, and a final
  probe must not allow an inactive receipt after state appears.
- Reviewer `core_gap_map` independently reran the 37-test macOS suite and both
  adversarial reproducers against the helper hash above. Final verdict: GREEN,
  no remaining concrete P1/P2 in the bounded diff. This review did not establish
  Linux or live guest acceptance independently.
- `git diff --check` passed. No broad dashboard build or live deployment was
  needed for this uninstalled Python helper.

One preliminary Docker invocation retained the image's s6 entrypoint and exited
111 because its init tried to write to read-only `/run`. That invocation ran no
Python tests. The corrected explicit Python entrypoint produced the Linux result
above; the container remained read-only and network-disabled.

## Preservation, cleanup, and limits

All test-owned files lived in temporary directories, removed by test cleanup.
Docker test containers used `--rm`; an exact image-filtered `docker ps -a` at
04:12:44 UTC returned no remaining containers. No VM, native client profile,
private route, firewall, paired device, shared service or Canary deployment was
changed. No additional Hetzner spend or reservation was made; the prior
conservative campaign reservation remains £5.90 of £10, not an invoice total.

The Linux tmpfs does not support the ACL-denial fixture, which was explicitly
skipped. Actual Omarchy/systemd readiness, daemon-reload reconciliation, service
activation, exclusive lease supervision, private-route reachability,
Moonlight pairing, actual Hyprland video/input/audio, expiry, revocation,
reconnect and teardown remain unverified by this milestone.

Rollback is a source revert of this uninstalled helper/test milestone. There is
no deployed runtime, live resource or database migration to roll back. Do not
delete existing preparation state or downgrade v2 journals into v1 intent.
