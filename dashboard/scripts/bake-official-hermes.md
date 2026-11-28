# Prepared official Hermes VM candidate

This is an opt-in candidate for new managed Canary Hermes launches. It is not a template for legacy container Hermes, provider VMs, other catalog agents, restores, or existing computers. Keep the Canary opt-in unset until a candidate has passed clone tests.

## Build

On a disposable Linux amd64 builder with a runner kernel usable by libguestfs, install the distro packages providing `qemu-img`, `guestfish`, `virt-customize`, `virt-sparsify`, `virt-cat`, `curl`, and `jq`. The libguestfs appliance also needs its DHCP client (on Ubuntu 24.04, install `isc-dhcp-client` alongside `libguestfs-tools`) and outbound HTTPS and Ubuntu mirror access. Use a clean checkout of the candidate revision, with a private output directory and no deployment, account or provider credentials on the builder.

```sh
mkdir -m 0700 hermes-bake-output
bash dashboard/scripts/bake-official-hermes.sh hermes-bake-output
```

The appliance defaults to 4 GiB. On an isolated builder with spare RAM, set
`HIVRA_HERMES_BAKE_MEMORY_MB` to `6144` or `8192`.

This entry point uses the shared runtime image builder while preserving the Hermes image filename and marker contract. The [DeepSeek candidate](bake-deepseek-harness.md) uses the same sealing pipeline but is not a launch option.

The builder expands the Ubuntu root partition in place, preserving the partition number used by GRUB. Do not use an older candidate built with `virt-resize` for a pilot: a local clone of the same Ubuntu base resized by that recipe reached GRUB rescue instead of Linux.

The recipe starts from a fresh Ubuntu cloud disk, verifies the dated Ubuntu bytes and the upstream installer by SHA-256, and invokes the unmodified installer as `bux` at the recorded official Git commit. The installer builds Hermes's Dashboard (9119), then Hermes builds its Desktop Webapp (9120). After removing temporary profile state, the bake checks the entry pages and runs Hermes's own build receipt validator on both surfaces. A missing or stale build prevents sealing. The disk has QEMU Guest Agent and the launch tools preloaded. The builder clears image identities before sealing a standalone qcow2. It never provisions a tenant, starts a Hivra tunnel, or creates a live VM. Apt mirror state can change; the **output image SHA**, rather than the recipe or an upstream tag, selects one reviewed set of resulting bytes.

The script emits `hivra-hermes-<imageSha256>.qcow2` and a same-named JSON manifest. Before staging, independently recheck the artifact SHA, format and absence of backing files. Inspect the disk read-only: it must have no SSH host keys or authorized keys, initialized machine ID, cloud-init instance data, model/tunnel keys, access tokens or pre-existing gateway service. Check that the recorded release, official Git commit, CLI and Webapp are present.

Boot two disposable copy-on-write clones of the exact sealed disk using the same default BIOS and VirtIO disk as Canary. Use a different NoCloud instance ID for each clone and keep both off the network. Require both clones to reach QEMU Guest Agent and finish cloud-init, then compare the generated machine IDs and SSH host public keys: both values must differ across clones. Check that the original sealed digest is unchanged. A valid qcow2 that can be mounted read-only can still fail in GRUB, so do not stage the disk if either boot check fails.

Hermes's installer uses a detached HEAD for both a commit pin and a stock stable release. The bake checks that local `main` tracks `origin/main` on the official repository. The clone's fresh profile defaults to upstream's stable channel; its native updater resolves and moves to stable release commits without rewriting `main`.

## Activate on Canary

After release review and authority for the exact Canary host, check that the host has the sealed provisioner shipped by the served Git revision and that the revision supports this image selection. Stage the verified image at `/var/lib/vz/template/iso/hivra-hermes-<imageSha256>.qcow2` as a root-owned regular file with mode `0444` and exactly one link. Verify the final bytes at that path before changing any settings.

On a Git Canary revision that reads runtime pilot settings, use the Canary database operator to insert one `hermes` row in `public.hivra_canary_launch_pilots`. Set `host_id` to the selected Proxmox target, `image_sha256` to the manifest digest, and `owner_id` to the existing standing QA owner. Leave `standby_enabled` false for the baked cold path. Read back the exact row before launch. The host setting does not pin placement; if normal placement picks another host, that run uses stock installation and is not a baked sample. Fresh launches read the row without a new Git build. Older deployments retain their original environment snapshots and do not read this row; do not roll back to a snapshot that still selects the disk. Do not change the stock Ubuntu image or production configuration.

Use that standing QA account to launch owned fixtures. Verify the Git revision, target and baked launch marks in accepted launch evidence, then fresh SSH host keys and machine IDs across guests, distinct Hivra access tokens, public Hermes Webapp and dashboard, both terminals, and a real managed model reply. The launch log reports cumulative API milliseconds from request handling; `HIVRA_HERMES_STAGE` in the host log reports centiseconds from the preceding marker. Record click, native composer and first reply separately. Exercise Hermes's own Update entry point on an owned fixture and check model settings and gateway/terminal access survive; the pin defines the initial filesystem, not the customer update policy. Clean up only the owned fixtures. Delete only your exact pilot row and read back its absence to return new launches to stock; existing computers remain untouched. Before removing the staged disk, verify that launches already in flight with the old row have drained.

## One-guest standby experiment

This is a manual, owner-scoped Canary experiment, not a pool. Leave
`standby_enabled` false outside the experiment. Use one exact
host, standing paid QA owner, boot-proven Hermes digest and sealed provisioner.
The owner and target must already match the three baked-image settings above.
The standby uses a QA VMID 9300–9399 other than 9302 and a free private IP on
the managed subnet. Use one generation UUID per attempt and never reuse a
   claimed guest.

1. Reserve the exact generation, owner, host, VMID, IP, image and resource
   envelope with the service-only standby reservation before starting a VM.
   That charge stays in admission until it transfers to a verified paid row or
   the operator proves the exact VM and disk are absent.
2. On the approved host, verify the sealed Canary bundle and the boot-proven
   image. Check the bundle manifest and file hashes against the served Git
   revision, not just the host's version label. Run the managed host
   provisioner with `HIVRA_PROV_DIR=/root/hivra-provisioner-canary` in standby
   `stage` mode. Pass only the neutral VM settings; do not send a tenant key,
   route, token or binding.
   Require enforced local memory and CPU ceilings, with the host's registered
   CPU policy capped at the provisioner's supported maximum, plus storage
   headroom. Make the generation available only after the exact host receipt
   proves fresh SSH identity and completed cloud-init. A started VM isn't a
   receipt. If exact ownership fails, leave the selector off, quarantine the
   generation and verify physical absence before releasing its charge.
3. After the first neutral receipt, save and read back the scoped Hermes row with
   `standby_enabled = true` on Canary. Launch through the normal paid browser flow; the ordinary
   placement decision must select the staged host. Measure click, claim,
   composer and visible reply. A failed or uncertain claim must not silently
   cold-launch another VM.
4. Delete the assigned fixture through the normal launch lifecycle. Verify
   clean database state, host and storage absence, and use the standby
   provisioner's exact `retire` action to clear its host-side slot. An
   unassigned or uncertain slot stays charged until independently reconciled.
   Restage a new generation only after this proof. Delete and read back the
   removal of your exact scoped row when finished.

Make three serial paid launches on the standing QA account. Record the Git
revision at both ends of each sample, the exact claimed generation and host,
and click-to-composer and click-to-first-visible-reply times. Exclude a sample
if the revision changed or it took the cold path. Accept the experiment only
when all three valid launches show a native reply in under 60 seconds. Run
Hermes's native Update on an owned fixture and verify the model, chat and
terminal still work. Keep one redacted real-browser recording from Launch
through the first visible reply. If the pilot stops early, remove the row and
verify stock selection on a fresh request to the same Git revision.

A warm sample must show `standby_guest_attested` and `public_tunnel_ready` in
the owned launch trace, without `disk_imported` on that launch. Compare guest
machine IDs, SSH host keys and Hivra access identities across the three claims.
Use digests in the verification receipt rather than copying keys, tokens or
private guest identifiers into a report.

### 27 November 2026 Canary result

The `2026.11.27.7` pilot proved a neutral boot and one exact paid ownership
transfer. The launch API accepted the request 31.3 seconds after the click,
but the computer stayed in provisioning throughout the nine-minute browser
readiness window. The native composer and a reply were not reached. This is
one failed attempt and zero comparable warm timing samples; it doesn't
validate the 60-second goal or native Update.

The owned fixture was deleted through the normal lifecycle, then its host slot
and volumes were verified absent. The pilot settings and staged image were
removed. Keep standby off and do not replenish the slot on this result. Before
another pilot, capture the exact continued provisioner's stage log while the
failed fixture still exists: normal deletion removes that file. An allocation
receipt proves custody, not that the detached runtime installer made progress.

For a diagnostic retry, verify stock selection on the current Git build first
and stage a fresh generation on a different unoccupied QA VMID. After launch,
join the audit tag and paid owner to the exact claimed generation and operation
before collecting host evidence. Capture the launch log, worker liveness and
last completed stage through the readiness deadline; snapshot them again before
normal Delete. Keep raw logs private and record only the failure boundary and
sanitized timings. One diagnostic attempt isn't a restart of the three-sample
acceptance series, and doesn't justify replenishing the standby.

The diagnostic retry found that the launch API rewrote the running guest's
resource configuration before the detached worker finished its ownership
check. Proxmox reported pending changes and the worker stopped before reading
tenant credentials. A warm claim now verifies the staged fixed envelope and
default CPU weight without writing those fields; cold launches still apply
their requested resource caps and scheduling weight.

### Guest elapsed-time trace

The `2026.11.28.1` seal adds `HIVRA_HERMES_GUEST_PHASE <phase> <elapsed_ms>`
to the baked guest installer. Values are cumulative from the guest's `start`
marker and read from a monotonic clock; subtract neighboring values to compare
guest stages. The warm host trace also marks `standby_guest_revalidated` before
guest dispatch. Host timings are per-stage and have a different clock; don't
subtract one clock from the other.

Collect only the fixed names and integer timings from the exact owned launch's
log before normal Delete. The trace distinguishes base setup, swap and model
configuration, native service startup, local readiness and verified runtime
receipt. It does not change what readiness requires and is not proof of a
successful chat reply or native Update.
