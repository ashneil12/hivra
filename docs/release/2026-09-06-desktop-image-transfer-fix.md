# Desktop image transfer correction — 2026.09.06.3

The first `.06.2` live launch exposed invalid GNU `dd` syntax; see the original
failure and cleanup in `2026-09-06-prepared-desktop-image-admission.md`.
The root-cause change is `oflag=excl` → `conv=excl`. Exclusive creation remains
mandatory; it is not replaced by an overwriting write or retry.

The new regression extracts the actual guest writer command from the provisioner
and executes it against owned temporary files with GNU `dd`. It failed on the
original command, then passed creation, mode 0600, refusal to overwrite, and
refusal to follow an existing symlink. All six transfer tests passed on Linux.
On macOS five pass and this explicitly Linux-specific test skips; BSD `dd` is
not substituted as guest acceptance. The owned Linux test directory was removed.

Release `.06.2` remains immutable. New `.06.3` seals 50 assets with bundle digest
`5ea99797e6a1f7b105d1af07c191585c386df5590bd65a3389f045a41466dbef`.
The guest installer, broker and server are unchanged: desktop revision remains
`a864b6827ded1f10ffce4129ded4a97fb83d7ea4379e02d99459726d8b7e99db`.
Provider workers use a new version while retained `.06.2` workers, manifests,
runtime/workspace probes, cleanup identities and deadlines remain bound to
their original bytes. Fresh provider desktop placement remains current-only.
SQL `20260906130000_desktop_image_transfer_release.sql` adds only the new exact
version/bundle pairs through three checked replacements; it removes no old pair.

The five focused release/provider suites passed 155 tests, including retained
`.06.2` worker/runtime/workspace regressions. Full TypeScript, changed-file lint,
Bash syntax and the actual in-memory PostgreSQL migration/adapter fixture passed.
One generated wrapper hit its unchanged ten-second subprocess deadline while
the PostgreSQL fixture ran concurrently; the unchanged full five-suite run
passed in 3.386 seconds after PostgreSQL completed. No limit was increased.
Independent source/release review passed: all 50 asset identities, retained
compatibility, migration changes and regression scope were checked. It did not
re-execute the live campaign or substitute for the pending launch acceptance.
Live acceptance still
requires a new normal Canary launch, exact prepared-image identity, usable
desktop/terminal/files, restart persistence and owned-fixture cleanup.

Rollback must preserve a control plane that understands any retained new
identities. The optional cache can be disabled independently to retain source
builds. Do not treat retaining database pairs alone as old-app compatibility.

## Corrected Canary rollout

Source `f89a5c932d7bf5def6e0e1fab5de1cbfdd6f3fda` was deployed from clean export
`/tmp/hivra-transfer-fix-deploy.gJb1VX` to **hermesos-canary**. Deployment
`dpl_Cr3HhhaBsMwvtuvYeJGG16CaUziC` became Ready, was promoted, and fresh alias
inspection confirmed `https://canary.hermesos.cloud` resolves to it. URL:
`https://hermesos-canary-8wtjhllfg-ashneil12s-projects.vercel.app`.

Only migration `20260906130000` was executed and recorded on verified Canary
project `srrwbdvxlqvqjuexitaf`. Readback confirmed all three functions retain
`.06.2` and admit `.06.3`; unrelated pending migrations were untouched.

The host sync verified all 50 assets, found no source readers, and updated only
`node-b:/root/hivra-provisioner-canary`. Script SHA-256:
`869ac958aabde9dd41c617655e35fee64b64129d63dacc24fd251164ee9a5deb`.
Readiness returned `HIVRA_HOST_READY`. Preserved `.06.2` bundle:
`/root/.hivra-provisioner-canary-rollbacks/2026.09.06.3.BBpZljYo/original`.
Full VM inventory, Caddy and shared-default provisioner fingerprints remained
identical to the preceding campaign's baseline. VM counts stayed `29/21/50`;
local-lvm total/used/free stayed `870318080/559440461/310877618` across the swap.

The same archive's full hash and 4,124,832,768-byte/root-owned 0600 metadata were
reverified before moving it from `.disabled` back to its fixed `.tar` name under
the corrected bundle. No new upload, artifact change or purchase was needed.

### Corrected transfer passed; prepared image admission still failed

The normal launch created `CANARY_PREPARED_FIXED_0906`, computer
`00000000-0000-4000-8000-000000001107`, at 10:38:31.392651 UTC. Operation
`00000000-0000-4000-8000-000000001108` owned VM 1130 with binding
`hivra-bind-97fe5f37f1eb1d20bb394cf097f6d284` and installer PID 4007514.
After boot/cloud-init, transfer completed and QGA readback at 10:42:56 UTC
confirmed the guest archive had all 4,124,832,768 bytes. The original installer
advanced past transfer into runtime installation. This verifies the `dd` fix.

The desktop installer pulled the base image and entered Docker image processing,
then rejected admission with `desktop_prepared_image_identity_missing`.
Neither pinned ID was returned by its inventory query. The failed guest was
automatically destroyed, so its final raw image inventory was not captured;
the reason for the import discrepancy is not yet established. The code did not
weaken identity checks, retry, or falsely publish a ready desktop.

Normal Manage → Destroy cleaned the failed record: deleted status, null VM,
operation, token and tunnel references. VM config/volumes/PID file/PID were
absent, and full host VM inventory returned to the original hash. Both
authoritative DNS servers returned NXDOMAIN for
`agents-canary-box-redacted.hermesos.cloud`. No retained VM was restarted.

The archive is again retained as `.disabled`, leaving the existing source-build
path available. Prepared-image live gate remains FAIL; no speed improvement
or usable prepared desktop is claimed. A separate, bounded source-built
diagnostic fixture will check current Canary functionality and collect actual
Docker import metadata without repeated prepared-launch retries.

### Source-build live acceptance

With the optional archive disabled, normal application launch created
`CANARY_IMAGE_IMPORT_DIAG_0906` (`00000000-0000-4000-8000-000000001109`)
at 10:49:09.952313 UTC, on the existing included 2 CPU / 4 GB allocation.
Operation `00000000-0000-4000-8000-000000001110` owned VM 1130 with binding
`hivra-bind-3d4c659d2079440cb7ef7d97eeaf6d88`. No capacity was purchased.
The source-built desktop reached Running and displayed a real KDE desktop in
the native Hivra application. Source image:
`sha256:e712b58f95f54b686adc24a09c8f7a3577e84ddef51324b8feeb45177b06dcc5`.

Actual desktop Konsole input created `~/Hivra/import-diag-check.txt` containing
`canary-source-path-ok`; output also confirmed UID 1001. The Files tab listed
the 22-byte file and rendered its exact contents. Normal Manage → Restart
completed through operation `00000000-0000-4000-8000-000000001111`.
Guest boot ID changed from `00000000-0000-4000-8000-000000001112` to
`00000000-0000-4000-8000-000000001113`; machine identity stayed unchanged.
After restart, the public Box Terminal command read the same file and again
returned UID 1001. These are functional desktop/files/restart/terminal checks,
not just health probes. Some initial desktop app openings were slow; no latency
or smoothness improvement is claimed.

After restart the source container was healthy, ID
`9eeecad06c806910a95a84a127fba3fe199c02b63dd4e818908a42bb2b1b082c`.
The diagnostic image load does not replace that running container. Its backend
is Ubuntu Docker `29.1.3-0ubuntu3~22.04.2`, containerd 2.2.1, overlayfs with
`io.containerd.snapshotter.v1`; post-restart kernel is `5.15.0-191-generic`.

### Import root cause captured; test fixture removed

One diagnostic load streamed the existing verified archive through the existing
QGA-attested SSH lane into Docker, with output retained in a private guest
directory. It finished at 11:13 UTC with exit 0, empty stderr, and exactly:
`Loaded image ID: sha256:ee596064f9a341a3a75841027e8d0a5f251b299ac144fab6ce7d1421f6c8a34b`.
The default full-ID image listing omitted it; the same query with `--all`
included that exact manifest. Exact manifest inspection returned matching
Id/OCI descriptor, Linux amd64, ubuntu user and 34 layers. Config and index
digests were not valid image lookup aliases on this backend.

This establishes a filtered-inventory defect, not a corrupt archive or rewritten
image identity. The running source container kept the exact same ID/image and
healthy state across import. The native application's desktop reconnected and
displayed KDE after restart and import. The source correction adds `--all` only;
it does not admit IDs by label or similarity. The new regression failed against
the original code, then all 13 admission tests passed. Separate cases preserve
rejection of successful loads with no pinned entry and a foreign inspected ID
despite matching labels. Independent review reproduced red/green results.

Normal Manage → Destroy removed only `CANARY_IMAGE_IMPORT_DIAG_0906` before
11:18 UTC. Database status is deleted with null VM/operation; both desktop
sessions are revoked with input released. VM config, disks and original
installer process are absent. Both authoritative DNS servers return NXDOMAIN.
The full host VM list hash is restored to
`337f1c3b2eee15e644950801a1e886f9fd37be360b74de05b16f8e0cc2beb868`.
The temporary host known-hosts directory and diagnostic archive hardlink were
removed; their parent directories are absent. Guest diagnostic files and the
test marker were permanently removed with its owned disk. The UI again shows
the four retained computers running; none were restarted or updated.

The earlier `.06.2` local deployment export was moved to the user's Trash at
`/Users/example/.Trash/hivra-prepared-deploy.ASzX0W` and is recoverable. The actual
image candidate remains retained and disabled. No new Hetzner spending occurred.
The `--all` fix requires a new immutable release and fresh prepared-launch
acceptance; diagnostic success alone does not satisfy that gate.
