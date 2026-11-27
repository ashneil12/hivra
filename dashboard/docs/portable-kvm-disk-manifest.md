# Portable KVM disk manifest v1

This is an offline verification contract for a first managed KVM disk-and-boot
profile, not a shipped restore path or evidence that a restored computer booted.
The checker consumes two JSON reports from independently authenticated hosts. It
does not authenticate reports, discover hardware, create snapshots, or read disks.
Never accept this shape as evidence from a browser, a guest, a transfer artifact,
or an echo of the source report.

`checkPortableKvmDiskManifest` validates one report against an expected role,
binding, generation, and checkpoint ID from the caller's durable placement state.
`verifyPortableKvmDiskManifests` validates both reports against a shared generation
and checkpoint ID and independently expected source and destination bindings.
Every JSON property below is required, including explicit absence fields. Keys
not listed here are rejected. This is a minimal **source** example:

```json
{
  "version": 1,
  "role": "source",
  "binding": {
    "hostId": "host-a",
    "vmid": 9301,
    "bindingTag": "hivra-bind-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "generation": 4,
  "checkpointId": "checkpoint-4",
  "boot": {
    "firmware": "seabios",
    "architecture": "x86_64",
    "machine": "pc-i440fx-9.2",
    "osType": "l26",
    "scsiController": "virtio-scsi-single",
    "order": ["scsi0"]
  },
  "cloudInitSlot": "ide2",
  "efi": "absent",
  "tpm": "absent",
  "savedRam": "absent",
  "devices": [
    {
      "slot": "scsi0",
      "volumeId": "local:9301/vm-9301-disk-0.qcow2",
      "attachment": { "discard": true, "ssd": true, "ioThread": false },
      "bytes": 42949672960,
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "snapshotId": "checkpoint-4-scsi0",
      "readFrom": "snapshot"
    }
  ]
}
```

The destination uses `role: "destination"`, its own host/VMID/tag and local
volume IDs, and `readFrom: "attached-disk"` for each disk. The hypervisor node
identity mapped to `hostId` must come from the authenticated host channel, and
the VMID and tag must reflect the specific observed VM, not arguments echoed
back to the caller. A checkpoint ID names one immutable, coherent capture for a
positive safe-integer generation. Each disk's unique `snapshotId` identifies
its immutable **source** snapshot object within that checkpoint. Record the
source snapshot lineage on the destination during the restore; do not invent a
destination snapshot with the same name. Host, checkpoint, and snapshot IDs
use a leading alphanumeric and up to 127 following ASCII alphanumerics or
`._:-`. The exact lowercase Hivra binding tag and the Proxmox VMID are mandatory.

**Host producer requirements**

- Inspect the complete effective VM configuration under the lifecycle fence:
  the source config for the immutable checkpoint and the destination config
  for the actual stopped VM on which the restored volumes are attached. Check
  pending changes as well; do not attest a staged config different from what
  will boot. Resolve defaults and aliases to the effective values, including the
  versioned i440fx machine (including its PVE suffix when present). This profile
  supports Linux on x86-64 SeaBIOS, `virtio-scsi-single`, and only `scsi0` in the
  boot order.
- Enumerate every disk-like device and storage dependency, including detached
  or unused volumes, attached media, EFI and TPM volumes, saved RAM, and custom
  QEMU arguments or passthrough that can introduce additional state. Fail the
  report if any of these are unsupported or cannot be accounted for. Do **not**
  reuse a shell filter that drops media, skipped disks, or unknown keys. EFI,
  TPM, and saved RAM may be marked `"absent"` only when established through the
  complete inspection, never by assuming a missing observation means absent.
- List `scsi0` and each additional attached managed SCSI disk (`scsi1` through
  `scsi30`) once, even if backup configuration would have excluded it. Attach
  options are restricted to normalized discard, SSD, and I/O-thread booleans,
  apart from metadata such as the independently measured size. Fail closed on
  other non-default device-affecting options or unknown defaults.
  Volume IDs must use the bound VMID's managed `storage:vm-VMID-disk-N` or
  `storage:VMID/vm-VMID-disk-N.{qcow2,raw}` naming, and the host must resolve the
  volume to validate ownership and reject aliases or non-managed devices.
- The only permitted non-disk media is Proxmox-generated cloud-init at
  `ide2`. Report its presence at both ends, or `null` if neither has it. The
  destination must generate it from its own approved configuration; no source
  cloud-init bytes or secrets belong in this manifest. Arbitrary ISOs and other
  CD devices are unsupported. This checker compares media type and slot, not
  cloud-init settings or content.
- Source measurement reads each immutable snapshot in the same coherent
  checkpoint. Destination measurement independently reads each actual attached
  restored disk before first boot. On each host count and SHA-256 hash the
  **entire logical guest-visible byte stream** starting at offset zero,
  including zero-filled regions and resolved backing data. Do not hash a QCOW
  container, changed extents, a copied digest, or a staging file. The byte count
  must be a positive safe integer and a multiple of 512. Keep the verified
  configuration and destination bytes fenced until handoff to boot.

Matching proves only the asserted boot profile, complete disk inventory, and
byte-for-byte equality of the reported device snapshots and destination
attachments; it is conditional on the host producer following these rules.
It does not prove that a host tool was truthful, the guest filesystem was
application-consistent, credentials/networking were rebound, or the computer
booted and served its expected user path.
