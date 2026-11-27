# Cross-host KVM disk fixture

This is a disposable operator pilot, not a managed wake path or a claim of live support. Run it only as root on the two authorized Proxmox nodes, using newly reserved, distinct QA VMIDs in 9300–9399 (never 9302). Check the VMIDs against the operator's QA bookings and hosted inventories before starting. Don't attach this fixture to a shared network, HA group, storage pool, or managed Hivra record.

Use one new 32-character lowercase hex run ID and one UTC deadline on both nodes. Set the deadline 45–60 minutes ahead and keep enough time for transfer, boot and cleanup. The values shown below are arguments, not host selection: run each command on the named Proxmox node.

```bash
args=("$RUN" "$SOURCE_HOST" "$SOURCE_VMID" "$TARGET_HOST" "$TARGET_VMID")
bash kvm-portable-fixture.sh prepare "${args[@]}" "$UTC_DEADLINE"  # target, then source
bash kvm-portable-fixture.sh fence-source "${args[@]}"             # source
# Stage the verified restore on the target as described below.
bash kvm-portable-fixture.sh boot-target "${args[@]}"             # target, once
bash kvm-portable-fixture.sh cleanup "${args[@]}"                 # both hosts
```

The run directory on each node is `/var/tmp/hivra-kvm-portable-$RUN`. The script verifies the same Ubuntu Noble minimal image digest at `base.img` on both nodes; don't change the pin if the upstream moving URL has changed. The source boots a 12 GiB qcow2 overlay with literal relative backing name `base.img`. Both boots use the same fixed hardware model, MAC and SMBIOS/VM generation UUID. QEMU networking is restricted user mode with no shared bridge or route and a loopback SSH forward at port `49000 + VMID - 9300`. The only guest login uses an ephemeral fixture-only key, not an existing credential. Admission requires local disk headroom, 60 GiB MemAvailable and I/O full PSI avg10 at or below 1%; cleanup is still allowed under pressure.

## Transfer and verify

Wait for successful `fence-source` before reading the disk for upload. It asks the source guest to sync, gracefully shuts the VM down, sets the Proxmox `backup` lock, and verifies the stopped/locked state. Don't unlock, start, or delete the source until the wake attempt has been recorded. This pilot trusts the operator not to bypass the Proxmox fence, and it does not implement a distributed fencing authority.

Use the normal authenticated host channel to stage source `fence.receipt` and the ephemeral `client.key` privately on the target. Never log the key or include it as a separate file in a storage benchmark artifact. Use the approved storage benchmark path for the synthetic disk. Deliver the restored file under the exact name `guest.qcow2` in the target lease. For the **delta** lane, this is the byte-identical original overlay; for the **whole** lane, it is a standalone qcow2 of the same logical disk, without backing files. Verify logical equality for the whole export on the source before upload, for example with `qemu-img compare -f qcow2 -F qcow2 SOURCE_OVERLAY WHOLE_EXPORT`.

The source writes seven ordered lines to `fence.receipt`:

1. `hivra-kvm-fence-v1`
2. `RUN SOURCE_HOST SOURCE_VMID TARGET_HOST TARGET_VMID`, with literal spaces
3. The exact UTC deadline argument
4. SHA-256 of the pinned base
5. SHA-256 of the stopped source overlay
6. SHA-256 of the synthetic guest witness
7. Guest host SSH public key as `ssh-ed25519 BASE64` without comment

The [disk checkpoint tool](KVM-PORTABLE-DISK-QA.md) writes `verified-wake.receipt` on the target after authenticated transfer and remote hash checks. Its four lines are `hivra-kvm-verified-wake-v1`, SHA-256 of the exact source receipt bytes, the lane (`whole` or `delta`), and SHA-256 of the verified restored qcow2 bytes. Stage the source receipt and fixture key as root-owned regular files with mode 0600 (not hardlinks or symlinks). The target checks the receipts and disk locally, pins the guest's SSH host key for its own loopback port, compares the source witness, then shuts down and verifies its still-locked state.

One target boot attempt is allowed per fixture. Use separate reserved pairs and run IDs to compare independent boot trials. Cleanup removes only the exact lease and matching QA VM after checking its config; unexpected state is reported, not forced. The deadline timer runs the same guarded cleanup on each host. Inspect both hosts and remove only your exact benchmark storage object separately; the fixture script doesn't touch remote storage.
