# Omarchy v3 private administration bootstrap

Status: bootstrap-only source checkpoint. No guardian activation, pairing,
broker/native integration or Omarchy desktop acceptance is claimed.

## Scope

The fresh v3 recipe starts in `dashboard/scripts/omarchy-native-supervisor.py`.
It uses a separate `/var/lib/hivra/omarchy-native-v3` namespace and does not
modify, migrate or activate existing ownership-v1/v2 preparations. It is not
installed in a live guest, included in a released provisioner bundle or used by
the public selector. No service unit or activation marker is created.

`prepare` exclusively reserves the original computer/operation namespace and
creates a random administrator password before emitting preparation evidence.
The plaintext credential is root-readable only. Sunshine receives a separate
service-UID-readable hash file, while pairing state has its own empty path.
The config and returned receipt contain no plaintext password. `observe`
checks original binding, file/directory identities, credential consistency and
unchanged inactive state; incomplete or replaced preparation is not adopted.

The format follows pinned Sunshine
`14ffa6fdaa53f7b51512be2b3d24f3939695403c`:
[credential loading/storage](https://github.com/LizardByte/Sunshine/blob/14ffa6fdaa53f7b51512be2b3d24f3939695403c/src/httpcommon.cpp#L62-L114),
[SHA-256](https://github.com/LizardByte/Sunshine/blob/14ffa6fdaa53f7b51512be2b3d24f3939695403c/src/crypto.cpp#L313-L316),
and [default reversed-byte uppercase hex](https://github.com/LizardByte/Sunshine/blob/14ffa6fdaa53f7b51512be2b3d24f3939695403c/src/utility.h#L203-L280).
This is source-format compatibility, not a live Sunshine authentication test.

## Verification

- `PYTHONDONTWRITEBYTECODE=1 python3 dashboard/runtime-adapters/omarchy-native/supervisor.test.py`:
  12 tests, 11 pass and one Linux identity test skipped on macOS.
- Same suite in the already-cached read-only Linux image
  `sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`:
  all 12 pass, including actual service UID reading the hash and being denied
  the root plaintext. Network disabled, repository mounted read-only, writable
  disposable tmpfs, explicit Python entrypoint, no image pull.
- Existing ownership suite: 37 tests, 33 pass and four platform skips on macOS.
- Coverage includes the standard abc hash vector, replay refusal, interrupted
  bootstrap, changed operation, widened permissions, altered/empty auth,
  pairing residue, key symlink replacement and post-probe state drift.
- Independent review reproduced a P2: replacing the new root after intent
  publication but before lock acquisition was initially accepted. The correction
  binds the lock to the root identity captured immediately after creation;
  its regression confirms no credential writes into the replacement namespace.
  Final corrected review is GREEN: the independent reviewer reran 12 tests
  (11 pass, one Linux-only skip) and the original adversarial case, with no
  remaining concrete P1/P2 in this inactive-bootstrap scope.
- `git diff --check` passed. Test directories were removed by temporary-directory
  cleanup; the named `--rm` container was absent in final Docker inventory.

Source SHA-256:
`75e4199ba5335b6d5cf3655acb2525fa8e298fa1c27104946625b8881984b78a`.
Test SHA-256:
`eca753a92a5a43250e765ff9a4ecac8d6e7c12954b6502c70141a799a8cff3f0`.

## Remaining work

The integrated guardian is still required: fresh installed/runtime identity,
one-use lease claim, boot-bound deadline and systemd backstop, supervised
unprivileged child, safe exact-client pairing, separate termination observation,
native revision admission and isolated Mac Moonlight lifecycle. The bootstrap
receipt always says activation forbidden and desktopReady false. No native
capability is widened by this checkpoint.

No live resource, account, firewall, route, standard Sunshine unit or existing
desktop was changed. No additional provider spend; conservative reservations
remain £6.90/£10. Rollback is removal/reversion of these uninstalled source files
through the branch/PR workflow; no live rollback is required.
