# Prepared official Hermes VM candidate

This is an opt-in candidate for new managed Canary Hermes launches. It is not a template for legacy container Hermes, provider VMs, other catalog agents, restores, or existing computers. Keep the Canary opt-in unset until a candidate has passed clone tests.

## Build

On a disposable Linux amd64 builder with a runner kernel usable by libguestfs, install the distro packages providing `qemu-img`, `virt-resize`, `virt-customize`, `virt-sparsify`, `virt-cat`, `curl`, and `jq`. The libguestfs appliance also needs its DHCP client (on Ubuntu 24.04, install `isc-dhcp-client` alongside `libguestfs-tools`) and outbound HTTPS and Ubuntu mirror access. Use a clean checkout of the candidate revision, with a private output directory and no deployment, account or provider credentials on the builder.

```sh
mkdir -m 0700 hermes-bake-output
bash dashboard/scripts/bake-official-hermes.sh hermes-bake-output
```

The recipe starts from a fresh Ubuntu cloud disk, verifies the dated Ubuntu bytes and the upstream installer by SHA-256, and invokes the unmodified installer as `bux` at the recorded official Git commit. The installer builds Hermes's Dashboard (9119), then Hermes builds its Desktop Webapp (9120). After removing temporary profile state, the bake checks the entry pages and runs Hermes's own build receipt validator on both surfaces. A missing or stale build prevents sealing. The disk has QEMU Guest Agent and the launch tools preloaded. The builder clears image identities before sealing a standalone qcow2. It never provisions a tenant, starts a Hivra tunnel, or creates a live VM. Apt mirror state can change; the **output image SHA**, rather than the recipe or an upstream tag, selects one reviewed set of resulting bytes.

The script emits `hivra-hermes-<imageSha256>.qcow2` and a same-named JSON manifest. Before staging, independently recheck the artifact SHA, format and absence of backing files. Inspect the disk read-only: it must have no SSH host keys or authorized keys, initialized machine ID, cloud-init instance data, model/tunnel keys, access tokens or pre-existing gateway service. Check that the recorded release, official Git commit, CLI and Webapp are present.

Hermes's installer uses a detached HEAD for both a commit pin and a stock stable release. The bake checks that local `main` tracks `origin/main` on the official repository. The clone's fresh profile defaults to upstream's stable channel; its native updater resolves and moves to stable release commits without rewriting `main`.

## Activate on Canary

After release review and authority for the exact Canary host, stage the reviewed `2026.11.27.2` provisioner through the normal managed Canary bundle sync. Copy the verified image to `/var/lib/vz/template/iso/hivra-hermes-<imageSha256>.qcow2` as a root-owned regular file with mode `0444`. Verify the final bytes there before setting server-only Canary variables: `HIVRA_CANARY_HERMES_IMAGE_HOST` to the selected Proxmox target ID, `HIVRA_CANARY_HERMES_IMAGE_SHA256` to the exact manifest SHA and, for the pilot, `HIVRA_CANARY_HERMES_IMAGE_USER_ID` to the existing standing QA owner. These are Git Canary settings, not browser input. Use the normal Canary Git release process; do not change the stock Ubuntu image or production configuration.

Use that standing QA account to launch owned fixtures. Verify the Git revision, target and baked launch marks in accepted launch evidence, then fresh SSH host keys and machine IDs across guests, distinct Hivra access tokens, public Hermes Webapp and dashboard, both terminals, and a real managed model reply. The launch log reports cumulative API milliseconds from request handling; `HIVRA_HERMES_STAGE` in the host log reports centiseconds from the preceding marker. Record click, native composer and first reply separately. Exercise Hermes's own Update entry point on an owned fixture and check model settings and gateway/terminal access survive; the pin defines the initial filesystem, not the customer update policy. Clean up only the owned fixtures. Unset all three Canary image variables on the next Git build to return new launches to the stock installation; existing computers remain untouched.
