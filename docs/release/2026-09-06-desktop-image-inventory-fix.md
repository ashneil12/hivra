# Prepared image inventory correction — 2026.09.06.4

Final status: **PASS for the owned Canary prepared-Ubuntu launch campaign** on
`5a557ae8efd514df8cd834601d1e1aae5c79f02a`. Desktop input, Files readback,
restart persistence, public Box Terminal and desktop reconnect passed; the
fixture was removed. This does not complete Windows, Omarchy, agent attachment,
all-provider coverage or physical input-latency acceptance.

The live diagnostic in `2026-09-06-desktop-image-transfer-fix.md` established
that Docker successfully imported the exact pinned manifest but omitted the
untagged image from its default listing. The installer now requests `--all`.
Archive verification, exact pinned manifest/config selection, inspection,
inherited configuration, labels, layer checks and workspace probing remain
unchanged. No load-output parsing, foreign-ID admission or retry was added.

The hidden-image regression failed on the original code and passed after the
fix. All 13 prepared-image tests and eight candidate-builder tests passed.
Successful loads with no pinned inventory entry and foreign inspected IDs
with matching labels remain rejected. Independent review reproduced red/green.

New immutable release `.06.4` seals 50 assets, bundle
`a832ddf64c1d7f35bf80f2886d00579580befd03d8c025e9f638cc5fff1761db`.
Installer bytes change the desktop capability revision to
`83c169e7381627993d7602d4efbc4f295f6698a44de5fde4ee6969eddede964d`.
The `.06.2` and `.06.3` runtime mappings are explicitly frozen to their original
`a864b6827ded1f10ffce4129ded4a97fb83d7ea4379e02d99459726d8b7e99db`.
Old manifests, worker hashes, cleanup closures and deadlines stay pinned.
Broker/server byte equality is tested before retaining session compatibility.

All four compatibility lists retain `.06.3`, while fresh provider desktop
placement remains current-only. An initial omission in the provider/model
lists was caught by tests and independent review and corrected before release.
Migration `20260906140000` adds the exact new version/bundle pair through three
checked replacements; older identities and unrelated migrations remain intact.
The actual in-memory PostgreSQL migration/adapter campaign passed all groups.
Full TypeScript, changed-file lint and diff checks passed.

The seven focused release, provider and desktop-session suites passed all 219
tests in 3.872 seconds. A repeated native-wrapper timeout was traced once to
Python waiting inside `sys.stdin.read()` before any wrapper executed. That test
now reads the identical fixture through a private regular-file stdin descriptor,
closed and removed in `finally`, with the same ten-second deadline and all 42
wrapper executions/assertions. No runtime timeout was increased. A separate
minimal pipe probe passed, so no universal Node/macOS pipe defect is asserted.
The temporary stack-trace instrumentation was removed. An accidental Vitest
invocation could not load these Jest suites and was not treated as a code test;
the reported results are from the repository's configured Jest runner.

Deployment and a fresh normal prepared-image launch remain pending at this
checkpoint. The optional host cache is disabled, the diagnostic fixture has
been cleaned, and the already-deployed `.06.3` source-build path remains live.
No prebuilt-desktop or startup-time improvement is claimed yet.

## Canary rollout

Source `5a557ae8efd514df8cd834601d1e1aae5c79f02a` was committed and pushed to
PR #600. Only migration `20260906140000` was applied and recorded on Canary
`srrwbdvxlqvqjuexitaf`; readback confirms all three functions contain both `.06.3`
and `.06.4`. The clean deployment export is
`/tmp/hivra-inventory-release.Da0BeSN1`.

The exact Canary host sync script SHA is
`1f152fa680e55398766041c6adab49e9b343c095756628d3ebfaeba9b5dfa23d`.
It found zero source readers, verified all 50 assets, and updated only
`node-b:/root/hivra-provisioner-canary`. Host readiness passed. Prior `.06.3` is
retained at `/root/.hivra-provisioner-canary-rollbacks/2026.09.06.4.XQULiNFJ/original`.
Full VM list, shared-default provisioner and Caddy fingerprints were unchanged;
VM counts stayed 29/21/50 and local-lvm total/used/free stayed
870318080/559614525/310703554 across the bundle swap.

Deployment `dpl_HAxsTsp6Ks13iigMkhfEYtRvytHU` became Ready and was promoted;
fresh alias inspection confirmed `https://canary.hermesos.cloud` targets it.
Deployment URL:
`https://hermesos-canary-j4zpndczx-ashneil12s-projects.vercel.app`.
The host archive's full SHA, size and root-owned 0600 metadata were reverified;
the exact cache name was enabled at 11:29:32 UTC.

One normal application launch created `CANARY_PREPARED_ACCEPT_0906`, computer
`00000000-0000-4000-8000-000000001102`, at 11:31:01.242339 UTC. The review screen
confirmed existing included Command allowance, 2 CPU / 4 GB, and no purchase.
Operation `00000000-0000-4000-8000-000000001103` owns VM 1130 with binding
`hivra-bind-e1206248dceb881f3076d24b1d5cf692`, installer PID 4044326.
The fixture has a 12:05 UTC cleanup deadline. The application transitioned to
the selected computer's setup screen and showed fresh status-response times.

### Fresh prepared desktop functional checks

The same installer completed successfully, and the normal UI reached Running
and displayed KDE. Guest capability revision is exactly `83c169e7…`; runtime
image is the pinned manifest `sha256:ee596064f9a341a3a75841027e8d0a5f251b299ac144fab6ce7d1421f6c8a34b`,
not a newly source-built image. Guest UID/GID are 1001 and recipe digest remains
`fb3ff9f7074c8f021f2470f13fff72f6fc6063be12494d0e66646f413d577b39`.
Container `f8eb7baefed0b450ea02a2c3aa2ec6e7d0503394e38a4c9ebf00ca64aadb17c8`
was healthy. All 4,124,832,768 archive bytes had reached the guest.

Actual desktop launcher clicks opened Konsole. Typed commands created
`~/Hivra/prepared-check.txt`, printed `prepared-image-ok`, and returned UID
1001. Hivra Files listed the 18-byte file and displayed that exact content.
Initial launcher/application interactions recorded stalls, so functional
acceptance is not a claim of improved input latency or startup performance.
Normal Manage → Restart then began operation
`00000000-0000-4000-8000-000000001104`; its result remains to be recorded below.

Restart completed with the same VM and machine identity. Boot ID changed from
`00000000-0000-4000-8000-000000001105` to
`00000000-0000-4000-8000-000000001106`; machine-ID hash remained
`fcff08f010b4c2150d09fe04f097a6adbecbe12753601d4a91f19bd032d3689f`.
The new healthy container still uses the exact prepared manifest. Database
operation returned to null. The public Box Terminal connected and the actual
command `cat ~/Hivra/prepared-check.txt; id -u` returned `prepared-image-ok`
and `1001`. The file's host path is `/home/bux/Hivra`, mounted as
`/home/ubuntu/Hivra` inside the desktop; an initial host diagnostic using the
container path correctly reported no such file, then the actual host path and
public terminal confirmed persistence. Original installer PID and PID file
were absent. Desktop reconnect was then requested through the normal UI.

The reconnect displayed KDE successfully. Normal Manage → Destroy then removed
only `CANARY_PREPARED_ACCEPT_0906`, before 11:44 UTC: database status deleted,
null VM/operation, token and tunnel references cleared. VM configuration,
volumes, installer PID/PID file and temporary guest SSH identity directory are
absent. Both desktop sessions are revoked with input released. Both
authoritative DNS servers return NXDOMAIN for the fixture hostname.

The full host VM list hash again matches
`337f1c3b2eee15e644950801a1e886f9fd37be360b74de05b16f8e0cc2beb868`;
Caddy and default provisioner fingerprints remain unchanged. The native UI
shows the original four computers Running. No retained computer was modified.
The fixture's marker and diagnostic data were permanently removed with its
owned disk. No new capacity, model charge or Hetzner spend was incurred.

The `.06.3` and `.06.4` clean local deployment exports were moved to the user's
Trash under their original basenames and are recoverable. The approved pinned
archive remains enabled only in the Canary host cache, root-owned 0600, and
missing-cache/other-identity source builds remain supported. No measured
startup-speed improvement or smooth-input claim is made from this one launch.

Rollback keeps a control plane that understands retained `.06.4` identities.
Disabling the optional cache is separate from rolling back the host bundle;
do not roll the application below a live retained identity's compatibility
floor. The previous host bundle is preserved at the exact path above.
