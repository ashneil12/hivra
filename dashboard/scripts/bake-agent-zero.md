# Prepared Agent Zero disk candidate

This offline build profile is not a public launch option. See
[prepared-runtime Canary verification](../../docs/release/PREPARED-RUNTIME-CANARY.md)
for the scoped validator. The image adds only Ubuntu's
signed Docker packages and one reviewed Agent Zero linux/amd64 image to the
shared QGA substrate; it does not create a container, start Agent Zero, or
write owner credentials, application data, access services or a launch intent.
Build on a disposable credential-free Linux amd64 machine with the
[shared builder tools](bake-official-hermes.md#build), `cloud-localds` and
`qemu-system-x86_64`. Allow space for both the build and sealed QCOW2 plus the
original Ubuntu image, OCI work files and the appliance. Use KVM where available.

```sh
mkdir -m 0700 agent-zero-bake-output
bash dashboard/scripts/bake-runtime-image.sh agent-zero agent-zero-bake-output
```

### Ubuntu package lock

`agent-zero-debs.lock` records the Ubuntu snapshot timestamp, SHA-256 of the
exact base image's `/var/lib/dpkg/status`, and one SHA-256, package name,
version and pool path per required amd64 package. The lock was resolved
against base `77d19e53656f87c95f1f6c6be59c789083b3f77fa08f9d88011ee04085c61f87`:
`apt-get --simulate --no-install-recommends --no-remove install docker.io qemu-guest-agent`
selected five new packages with no upgrades or removals. The signed Jammy,
Jammy Updates and Jammy Security `main` and `universe` indexes came from
[Ubuntu's 2026-11-27 20:00 UTC snapshot](https://snapshot.ubuntu.com/ubuntu/20261127T200000Z/).
APT verified the trust chain with `ubuntu-archive-keyring.gpg`; the InRelease
signatures use fingerprint `F6ECB3762474EDA9D21B7022871920D1991BC93C`. The
package hashes are the SHA-256 values in those verified indexes, not hashes
first obtained from downloaded debs.

On each build the host downloads only the locked files and verifies their
hashes. The appliance has no network; it verifies the exact base package
status and hashes again, installs only the locked local files with
`apt-get --no-remove`, with no network and empty source/index locations, checks
the installed versions, then deletes the debs. When changing the base or
refreshing Docker/QGA, re-extract the base dpkg status, resolve against a new
signed snapshot using an isolated amd64 APT state, and retest the offline
closure and both sealed-image boots.

The pinned upstream OCI index, amd64 manifest, config and layers are verified
by SHA-256. The image-only archive retains the index but carries only the
one runnable platform; no other architecture, attestations or second copy
are loaded into the persistent store. The build also checks the archive
against its recorded hash. Loading through the exact repository/index digest
uses Docker's containerd image store. OCI integrity by pinned hash does not
assert an upstream signature. The guest starts only Docker in a no-NIC build
boot and never executes the image. It removes the transient archive after
load, checks the pinned local reference, stops Docker cleanly, removes Docker's
generated engine and network identity, then reuses the shared offline
generalization before sealing. No build seed or provisioning mode remains.

The measured stock Jammy Docker 29.1.3/containerd 2.2.1 store reported 12.24
decimal GB (about 11.4 GiB) after local import, without an Ubuntu system or
the transient 3.20 GB (2.98 GiB) archive. **8 GiB cannot fit.** A 24 GiB
producer disk budgets about 9.6 GiB for Ubuntu, filesystem overhead and spare
capacity during load. The recipe fails if fewer than 5 GiB are available
after import and archive deletion. Use 40 GiB for a managed launch and verify
that cloud-init expanded the root filesystem before accepting it: the updater
still requires 12 GiB free before download and a separate data-backup space
check before swapping. The envelope is a design decision, not a measurement
of a sealed candidate.

Only the selected Agent Zero Proxmox path passes `HIVRA_AGENT_ZERO_BAKED=1`.
It checks the root-owned bake receipt and exact local linux/amd64 image
without loading an archive or contacting a registry. An explicit image
digest must agree with the receipt. A mismatch fails rather than pulling or
quietly reverting an updated service. Non-selected launches still resolve
upstream `latest` (or use the operator's digest) and pull as before. The
existing updater still fetches and inspects its new digest before changing
the unit, preserves `--pull=never`, and retains the previous image until the
new service answers; rollback restores the previous digest and data.
The baked marker is a build receipt, not the current installed app version.

## Exact two-boot gate

Do not stage or select a disk before all checks pass on its sealed bytes.

1. Select the matching manifest and QCOW2. Record `git rev-parse HEAD`,
   `sha256sum "$IMAGE"`, `qemu-img check -f qcow2 "$IMAGE"` and
   `qemu-img info --output=json "$IMAGE"`; require the filename and manifest
   digest to match, 25,769,803,776 virtual bytes, no backing/data file, and
   success from `check`. Compare the manifest (minus `format` and
   `imageSha256`) to `virt-cat -a "$IMAGE" /etc/hivra/agent-zero-bake.json`.
   Read the sealed filesystem only: `/etc/machine-id` is blank; no SSH host
   key, cloud-init seed or instance, `/root/hivra-image-bake`, OCI tar,
   `/root/.docker/config.json`, `/opt/a0`, `/home/bux`, or Agent Zero unit.
2. Boot two independent children of the same sealed file. Use separate QGA
   sockets, no NIC or cloud-init seed and SeaBIOS (the default `pc` firmware).
   Do not boot the sealed file writable or reuse the first boot's child.

   ```sh
   IMAGE="$(realpath "$IMAGE")"
   WORK="$(mktemp -d)"
   # Run the following once for n=1 and once for n=2, shutting down cleanly each time.
   n=1
   qemu-img create -f qcow2 -F qcow2 -b "$IMAGE" "$WORK/boot-$n.qcow2"
   printf '#cloud-config\nssh_pwauth: false\n' > "$WORK/user-data"
   printf 'instance-id: agent-zero-proof-%s\nlocal-hostname: agent-zero-proof-%s\n' "$n" "$n" > "$WORK/meta-data"
   printf 'version: 2\nethernets: {}\n' > "$WORK/network-config"
   cloud-localds --network-config "$WORK/network-config" "$WORK/seed-$n.iso" "$WORK/user-data" "$WORK/meta-data"
   qemu-system-x86_64 -machine pc,accel=kvm:tcg -m 4096 -smp 4 -nic none \
     -display none -monitor none -serial "file:$WORK/serial-$n.log" -no-reboot \
     -drive "file=$WORK/boot-$n.qcow2,format=qcow2,if=virtio" \
     -drive "file=$WORK/seed-$n.iso,format=raw,media=cdrom,readonly=on" \
     -device virtio-serial-pci \
     -chardev "socket,path=$WORK/qga-$n.sock,server=on,wait=off,id=qga" \
     -device virtserialport,chardev=qga,name=org.qemu.guest_agent.0
   ```

3. On each socket, require JSON QGA `{"execute":"guest-ping"}` to return
   within ten minutes. Run the checks below through `guest-exec` (path
   `/bin/bash`, arguments `["-c", "<commands>"]`, `capture-output:true`),
   polling `guest-exec-status` until exited. Decode the base64 output and
   record the exit status and identities. `cloud-init status --wait` must
   finish, the guest must have at least 5 GiB available on the store filesystem,
   and the probe must run from the pinned OCI reference with no registry.
   Capture `df -k` before and after to expose any unexpected unpacking.

   ```sh
   set -eu
   timeout 300 cloud-init status --wait
   for link in /sys/class/net/*; do test ! -e "$link/device"; done
   test -z "$(ip -4 route list default)"
   test -z "$(ip -6 route list default)"
   cat /var/lib/cloud/data/instance-id
   cat /etc/machine-id
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   systemctl start docker.service
   docker info --format '{{.ID}}'
   df -k /var/lib/containerd
   test "$(df -k --output=avail /var/lib/containerd | tail -1)" -ge 5242880
   test ! -e /root/hivra-image-bake
   test ! -e /opt/a0
   test ! -e /home/bux
   test ! -e /etc/systemd/system/hivra-agent-zero.service
   test ! -e /root/.docker/config.json
   test -z "$(docker ps -aq)"
   test -z "$(docker volume ls -q)"
   pin=sha256:0490714bf25bf481ea50d59ead21acec04344cee410a86b4e159908cb92ed8a2
   ref="agent0ai/agent-zero@$pin"
   test "$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$ref")" = "$pin linux/amd64"
   docker run --rm --pull=never --network=none --read-only --entrypoint /bin/sh "$ref" -ec 'test -d /a0'
   test -z "$(docker ps -aq)"
   test -z "$(docker volume ls -q)"
   df -k /var/lib/containerd
   ```

4. Power off each child with QGA `guest-shutdown` (`mode:"powerdown"`).
   Require the two seeded instance IDs and distinct nonempty machine IDs, SSH host key fingerprints and
   Docker engine IDs, and inspect the seal hash again after both boots.
   Remove only the owned child disks, sockets and processes; keep a
   redacted receipt with timestamps, commands and IDs/fingerprints.

After those gates, a separate authorized pilot should compare stock and baked
40 GiB launches on one host class. Include sealed artifact transfer/import
and resize, Docker, app readiness and the authenticated public Agent Zero
login/first reply. Start a tagged fresh fixture under the standing QA tenant;
verify the exact Git revision, artifact SHA and boot disk size, the pinned
startup receipt and no registry calls on the preloaded path. For update
acceptance use a reviewed different upstream digest (do not claim a swap
when `latest` still matches). Verify retained settings/chat after the real
owner Update flow. In a separate disposable update fixture force only the
new revision's readiness check to fail; verify old unit, old data and old
local image still run with `--pull=never`. Clean up the owned fixtures,
including any scoped network changes. If any step cannot be exercised,
record it as unverified, not as a launch-speed or lifecycle result.
