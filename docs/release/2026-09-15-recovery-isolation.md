# Recovery and tenant isolation acceptance — 2026-09-15

Status: bounded source and local recovery acceptance complete; coordinated
Canary fix publication and ready-guest/session acceptance remain pending.
Source checks, Canary API checks, local recovery, and guest recovery are separate
acceptance claims.

## Target and preservation

- Isolated branch: `codex/recovery-isolation-20260915`, based on
  `5ed3785d76ae2a367ced02037c013e4d5ea440c5`.
- Canary was independently inspected through Vercel: deployment
  `dpl_H7Sv6mF5VWajNmVdGQL2RwkRxiRg`, READY, alias
  `canary.hermesos.cloud`, deployment metadata `gitCommitSha: 5ed3785d7`.
- Concurrent edits in the original checkout are preserved. Publishing is
  coordinated with the server-configuration task; no deployment from this task
  has occurred at this checkpoint.
- Retained desktops, shared hosts, and shared brokers are excluded from failure
  testing. Local Docker recovery uses installation-owned disposable resources.

## Browser observation

The authenticated Canary Home rendered the existing agents and computers.
Opening the retained Ubuntu computer and selecting Manage exposed Restore points
and Hivra folder recovery. No restore, snapshot, power action, terminal command,
or desktop input was applied to that retained computer.

The rendered copy correctly distinguishes same-host restore points from off-host
backup. Folder recovery describes an encrypted export into a different empty
Ubuntu computer, limited to 2 MiB and 512 file/directory entries. Seeing these
controls does not establish a successful restore.

## Source and public API results

- `ef1760727` adds controlled snapshot/backup owner-scope regressions and checks
  the durable restore record's computer and infrastructure bindings.
- `9a13358ac` fixes the observed foreign workspace upload response: a confirmed
  missing owner-scoped row now returns 404 before SSH. Database lookup failures
  and an owned computer missing its host address remain operational errors.
- `da716d8da` adds exact instance-token binding regressions. The focused
  security/recovery suite passed 198 tests; profile/upload passed 19 tests and
  TypeScript passed.
- [Actual Canary API checks](2026-09-15-tenant-api-checks.md) record owner 200
  versus foreign 404 for instance, backup, restore request, desktop credential,
  and terminal access. Hostless desktop/workspace issuance returned 409 with no
  token; those checks do not substitute for a ready-capability owner/foreign
  pair. Six synthetic instance rows were verified absent after cleanup.
- [Legacy native Desktop token boundary](2026-09-15-legacy-desktop-token-boundary.md)
  records the remaining durable per-computer key and missing expiry/revocation
  protocol. No live valid-token replay acceptance is claimed.

The newer configuration deployment `dpl_CksP52MTYVYEVdX7PnythJQYhWR9` was
independently verified READY with metadata revision `ec14a71ba`. It does not
contain the upload fix. It is preserved; coordinated publishing and the fixed
upload response's live retest remain pending.

## Recovery run integrity

The first local run generated a 255,680-byte encrypted backup, SHA-256
`3a550f2e6a8ddb54bc808de8865535cf9a40bea708ba200f1aae17524f9b0753`,
but restore failed. The crash proof had added an unmigrated test table; the
product's data-only SQL archive restores into the migrated Hivra schema. This
was an invalid test fixture, not an established product defect. Both disposable
installations and the archive were removed. A separate manual SQL crash recovery
in that run did recover its exact marker, but does not establish restore.

The second run placed its marker in the migrated schema. After SIGKILL and
manual restart, data readback succeeded before Docker reported the service
healthy, so the backup CLI refused the not-yet-ready database. That harness
sequencing failure was retained separately, and its owned state was cleaned.
The corrected harness requires both healthy state and exact data readback.

### Accepted clean run

The [machine-readable receipt](2026-09-15-self-host-recovery-receipt.json) records
the successful run from 19:32:24 to 19:42:00 UTC, against exact committed source
`a6570be35b8bc9fe16a6df9aed27cefc76aebf3e`. The encrypted 255,168-byte backup
had SHA-256
`fbaa68f40dc9af7fcc3354f98c6bdf617790d96457d07bcd29211c9710d571f3`.
It was restored from disposable local project `hivra-70342d14df` into separate
project `hivra-4871bcfc6d`; no original or retained installation was overwritten.

Actual checks passed:

- Restored operator login, exact database marker, infrastructure registry access,
  and exclusion of hosted billing endpoints from the self-hosted application.
- Exact readback of the 131,073-byte storage fixture after restore.
- SIGKILL of only the owned database container, observed API failure, explicit
  manual restart, and exact marker recovery in approximately 12 seconds. Storage
  mounts were preserved and its original restart policy was restored.
- SIGTERM of only the owned restored dashboard launcher, observed HTTP outage,
  explicit start, fresh authentication, and the same database/file readbacks.
- Master-key rotation rewrapped ciphertext, rejected the old secret key, and
  preserved the launch-fingerprint key. Uninstall refused a synthetic retained
  computer until that test-only blocker was removed.

Both test projects have no remaining containers, stopped containers, volumes,
or networks. Their state directories and encrypted archives were removed, and
port 3000 was free. All 24 pre-existing containers remained running with their
original container IDs. Only non-secret evidence/log files were retained.
Five focused harness regressions passed, including readiness-race and wrong
marker rejection checks.

This is real local self-hosted control-plane recovery through Docker, SQL/storage,
and the restored HTTP application. It is not Canary restore, guest disk restore,
browser-session recovery, or automatic failover. Historical acceptance and the
two invalid earlier runs are not reused as successful restore evidence.

## Coordination and remaining acceptance

The reliability task owns guest boot/session recovery and disposable desktop
launches. Security review requires a freshly inspected, exact guest boot change;
same-boot capability refresh must not release a live old controller. Review also
identified the older-generation/same-boot session edge case for that task's
regression. No shared broker or retained guest is stopped for these tests.
The bounded follow-up review of its commit `0f43b659f` found the earlier-generation
case addressed, with service-only recording and stale-observation rejection.
This is source review, not live guest acceptance. Its disposable VM was running
while Hivra still reported provisioning at the final coordination checkpoint;
no guest snapshot/restore was attempted on that unaccepted target.

The integration task owns Files/Terminal functionality and legacy browser input
behavior. A read-only UI default is not itself a server-enforced input boundary.
Ready-capability token replay, guest snapshot/restore, and input authority still
require their own live acceptance on an owned disposable guest.

## CI distinction

PR #621's `Current tree safety` and `inventory-tests` checks both fail the same
reviewed-fixture hash assertion in `public-release-metadata.test.mjs:369`.
The expected hash begins `0f8ac474`; the actual hash begins `b9a78d8f` and was
independently reproduced from base revision `ec14a71ba`. This patch does not
change `.gitleaksignore`, `.gitleaks.toml`, that test, or any fingerprinted path.
No expected hash or security gate was weakened. `Verify Dashboard` was still
running at this checkpoint; passing focused tests is not an all-CI-green claim.
