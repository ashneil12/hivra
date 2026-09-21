# Prepared desktop image admission — staged release 2026.09.06.2

Implementation following the real candidate build/import campaign in
`2026-09-06-desktop-image-candidate-builder.md`. The source-stage gate below is
followed by a separate Canary rollout record. No performance improvement is
claimed without the actual prepared-image launch evidence.

## Implementation

- Optional host cache is a sibling of the configured provisioner directory:
  `${PROV_DIR}.desktop-images/08e5d4f557da6f037ada4630bcd4ba9bf96083cbe11f98c84105bcf08e4b8578.tar`.
  It is outside recursive bundle copies and is considered only for Linux
  Desktop. Non-desktop launches do not copy the 4.12 GB artifact.
- The private host helper walks root-owned, non-writable directories with
  no-follow descriptors. It hashes and transfers the same open regular file,
  so pathname replacement cannot disclose another host file to the guest.
  Transfer uses the existing attested SSH lane and an exclusive guest write;
  no new credential, listener, route, public registry or access surface is added.
- The guest independently checks ownership, archive size/hash and file
  stability before Docker import. Full-ID inventory selects only the pinned
  manifest/config ID; free-form load output is not authority. The original
  config, inherited labels, layer ancestry and workspace write-through checks
  remain mandatory before installation publishes credentials or capability.
- Exact UID/GID 1001 and the unchanged recipe can use this candidate. Missing
  caches, other identities, changed recipes, and different base-engine IDs
  retain actual source derivation. A supplied corrupt archive fails explicitly.
  The current capability ABI still binds the base label to the local base ID:
  a classic backend with a different base config ID therefore builds from
  source rather than weakening that binding. Fast-path acceptance across those
  backends remains future work, not a universal acceleration claim.
- The guest archive remains a root-owned cache, consuming another 4,124,832,768
  bytes. Do not claim those bytes are reclaimed automatically.

## Additive release

The new manifest contains 50 assets, including `hivra-copy-desktop-image.py`.
Bundle digest: `9ace71d709cb9aabd27f188c3a6f6ca98fe906d619f156a1b47928fa22c54aee`.
Desktop revision: `a864b6827ded1f10ffce4129ded4a97fb83d7ea4379e02d99459726d8b7e99db`.

The sealed `.06.1` manifest remains unchanged. Its worker identity, recovery
bytes, deadlines and cleanup closures remain accepted. Broker/server bytes are
unchanged, and the previous secure `a3b299…` session revision remains accepted.
Provider runtime, restart and workspace receipts now require the exact desktop
revision belonging to their retained worker version, not merely any known
revision or the latest one. Fresh provider desktop placement remains current-only.

Migration `20260906120000_desktop_prepared_image_release.sql` adds the exact new
version/bundle pairs through three checked, once-only replacements. It preserves
prior pairs and function privileges. The generated migration manifest includes
the new entry. Historical migrations and release files were not rewritten.

## Verification

- Python: 10 admission + 5 transfer + 19 phase + 8 builder tests pass. Includes
  cache absence, symlink/ownership/mode/FIFO rejection, fixed-ID lookup, altered
  config/layers, corrupted archive, failed load, and pathname replacement with
  no foreign-byte transfer. SSH/Docker are mocked in these source tests.
- Seven Jest suites: 211 tests pass, including generated Python probes, exact
  release seals and retained `.06.1` worker/receipt regressions. One subprocess
  hit its existing ten-second limit while the PostgreSQL fixture ran concurrently;
  the unchanged full suite passed in 4.1 seconds after that fixture completed.
  No timeout or assertion was weakened.
- Actual in-memory PostgreSQL migration/adapter fixture passed version
  admission, provider/native/desktop ownership, lifecycle, workspace, power,
  cancellation, cleanup, absence and teardown checks. It does not touch live
  credentials, accounts or infrastructure.
- Full TypeScript, changed-file ESLint, Bash syntax and whitespace checks pass.
- Independent source and release review passed after correcting backend ID
  lookup, host file-descriptor ownership, and retained capability parsing.

Source gate: PASS. Live gate: not run. No spend or live resource mutation.

## Next authorized Canary acceptance

Apply the additive migration only to Canary, deploy the reviewed control-plane
revision, and install the exact new Canary host bundle. Stage the verified
artifact only in the Canary bundle's root-owned sibling cache; preserve the
default/shared provisioner and all retained computers. Create one owned fixture
through the normal launch flow with a bounded cleanup deadline.

Verify the running image is the exact prepared artifact, shared terminal/files
and desktop input work, restart preserves usable access, and deletion removes
the owned guest, volumes, sessions and DNS. Measure actual launch duration before
claiming improvement. If admission fails, diagnose that original operation rather
than recreating fixtures until one passes. Other core work—attachment, Windows,
Omarchy native access and complete provider coverage—remains open.

Before any `.06.2` identities exist, rollback can use the prior Canary
control-plane and `.06.1` host bundle. Once new identities exist, the previous
control-plane does not recognize their worker and desktop revisions: retaining
SQL compatibility pairs alone is insufficient. Keep the forward-compatible
control-plane for recovery, or remove the exact owned new fixtures through the
current lifecycle flow and verify there are no retained `.06.2` identities
before reverting the application. Host bundle/cache rollback is a separate,
scoped action; disable the optional cache by moving only its owned artifact out
of the lookup path. Keep the additive database pairs. No rollback was exercised.

## Canary rollout — 2026-09-06

Exact source `77996e34f03a92256c5004d6bf6f423648e69e53` was exported into
`/tmp/hivra-prepared-deploy.ASzX0W` and built in **hermesos-canary**.
Deployment `dpl_9rgLos8QUPbmfN8bsSudBvxVGLRn` became Ready and was promoted;
fresh inspection of `https://canary.hermesos.cloud` resolved to it. URL:
`https://hermesos-canary-46sdlf4st-ashneil12s-projects.vercel.app`.
Rollback control-plane: `dpl_BgQgoW5ySZixG5n3hycdXd4YNHKi`.

Only migration `20260906120000` was executed on linked Canary database
`srrwbdvxlqvqjuexitaf`, then recorded as applied. The initial relative-file
invocation failed before execution because the CLI resolves paths under its
workdir; the absolute-file invocation succeeded. Readback confirmed all three
functions contain the new and retained release versions. Deliberately pending
older migrations were not applied.

Before the host swap, Canary had zero in-flight operations and the source-reader
scan found none. The reviewed sync helper verified all 50 assets and installed
only `/root/hivra-provisioner-canary` on `node-b`, returning `HIVRA_HOST_READY`.
Executed sync script SHA-256:
`a8cd62d05bcfd6d7a3a70fc6903915e669a877b585bf3de5387052f4578924e1`.
Preserved `.06.1` rollback bundle:
`/root/.hivra-provisioner-canary-rollbacks/2026.09.06.2.5poH0cmq/original`.

Before/after full VM inventory SHA-256:
`337f1c3b2eee15e644950801a1e886f9fd37be360b74de05b16f8e0cc2beb868`;
VM counts `29/21/50`; active Caddy and its complete file fingerprint
`ce4fc539496e362ddab5064a8da748b628a495fb3646e419304208185da4046e`;
shared-default provisioner fingerprint
`7881c0697afea1e91a686d9854e3eb9c048491726f470a587211946cfbb1f94f`;
local-lvm total/used/free `870318080/559353430/310964649`.

The app refreshed normally and still displayed the four retained computers.
### First live launch: FAIL, safely cleaned

At 10:17:35 UTC the host cache passed exact 4,124,832,768-byte SHA-256 and
root-owned/non-writable ancestry checks. The normal app launch created
`CANARY_PREPARED_UBUNTU_0906`, computer
`00000000-0000-4000-8000-000000001134`, at 10:17:57.837985 UTC. Operation
`00000000-0000-4000-8000-000000001135` owned VM 1130, binding
`hivra-bind-0e3bff5ca225a89b5811e7af29991820`, and installer PID 3993782.
The app automatically left launch confirmation and displayed setup feedback.

Boot and cloud-init completed, but the pinned-image transfer failed before
runtime installation. The exact GNU `dd` command rejected `oflag=excl`:
exclusive creation is `conv=excl`. A read-only host invocation reproduced the
same invalid-output-flag error. This was a real defect missed by the original
mocked transfer tests and static assertion, not a transient boot problem.

The original installer removed the VM and volumes. Normal Manage → Destroy
then removed the owned failed record's binding and tunnel references. Database
readback: `deleted`, null VM/operation/hostname/token/tunnel; zero desktop
sessions. VM config, all VM-1130 volumes, PID file, original PID and temporary
SSH identity were absent. Full host inventory returned to the pre-test hash;
Caddy remained active and the app returned to the four retained computers.
The external Cloudflare tunnel object was not independently enumerated.

The optional cache was disabled by renaming only the owned archive to
`/root/hivra-provisioner-canary.desktop-images/08e5d4f557da6f037ada4630bcd4ba9bf96083cbe11f98c84105bcf08e4b8578.disabled`.
The bytes remain recoverable; the existing source-build path remains available.
No new spend, retained-computer restart or second launch occurred in this
failed campaign. No prepared-image performance result is claimed.

Correction and its separate immutable release are recorded in
`2026-09-06-desktop-image-transfer-fix.md`.
