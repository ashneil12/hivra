export interface PortableKvmBinding {
  hostId: string;
  vmid: number;
  bindingTag: string;
}

export interface PortableKvmManifestExpectation {
  role: "source" | "destination";
  binding: PortableKvmBinding;
  generation: number;
  checkpointId: string;
}

export interface PortableKvmTransferExpectation {
  source: PortableKvmBinding;
  destination: PortableKvmBinding;
  generation: number;
  checkpointId: string;
}

export interface PortableKvmDisk {
  slot: string;
  volumeId: string;
  attachment: { discard: boolean; ssd: boolean; ioThread: boolean };
  bytes: number;
  sha256: string;
  snapshotId: string;
  readFrom: "snapshot" | "attached-disk";
}

export interface PortableKvmDiskManifest extends PortableKvmManifestExpectation {
  version: 1;
  boot: {
    firmware: "seabios";
    architecture: "x86_64";
    machine: string;
    osType: "l26";
    scsiController: "virtio-scsi-single";
    order: ["scsi0"];
  };
  devices: PortableKvmDisk[];
  cloudInitSlot: "ide2" | null;
  efi: "absent";
  tpm: "absent";
  savedRam: "absent";
}

type ManifestRejection = {
  ok: false;
  reason:
    | "invalid_manifest"
    | "binding_mismatch"
    | "checkpoint_mismatch"
    | "efi_unproven"
    | "tpm_unproven"
    | "saved_ram_unsupported"
    | "unsupported_boot"
    | "unsupported_device"
    | "unverified_disk"
    | "boot_mismatch"
    | "device_inventory_mismatch"
    | "disk_mismatch";
  role?: PortableKvmDiskManifest["role"];
  slot?: string;
};

type ManifestCheck = { ok: true; manifest: PortableKvmDiskManifest } | ManifestRejection;
type TransferCheck = {
  ok: true;
  source: PortableKvmDiskManifest;
  destination: PortableKvmDiskManifest;
} | ManifestRejection;

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TAG = /^hivra-bind-[a-f0-9]{32}$/;
const SCSI_SLOT = /^scsi(?:[0-9]|[12][0-9]|30)$/;
const MACHINE = /^pc-i440fx-[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\+pve[0-9]+)?$/;

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && value === value.trim() && pattern.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function checkPortableKvmDiskManifest(raw: unknown, expected: PortableKvmManifestExpectation): ManifestCheck {
  const { role } = expected;
  const reject = (reason: ManifestRejection["reason"], slot?: string): ManifestRejection =>
    slot === undefined ? { ok: false, reason, role } : { ok: false, reason, role, slot };

  if (!record(raw) || raw.version !== 1 || raw.role !== role || (role !== "source" && role !== "destination")) {
    return reject("invalid_manifest");
  }
  if (raw.efi !== "absent") return reject("efi_unproven");
  if (raw.tpm !== "absent") return reject("tpm_unproven");
  if (raw.savedRam !== "absent") return reject("saved_ram_unsupported");
  if (!exactKeys(raw, [
    "version", "role", "binding", "generation", "checkpointId", "boot", "devices", "cloudInitSlot",
    "efi", "tpm", "savedRam",
  ])) return reject("invalid_manifest");

  const { binding, generation, checkpointId, boot, cloudInitSlot } = raw;
  if (!record(binding) || !exactKeys(binding, ["hostId", "vmid", "bindingTag"])
    || !matches(binding.hostId, ID) || !matches(binding.bindingTag, TAG)
    || !positiveInteger(binding.vmid) || binding.vmid < 100 || binding.vmid > 999_999_999
    || binding.hostId !== expected.binding.hostId || binding.vmid !== expected.binding.vmid
    || binding.bindingTag !== expected.binding.bindingTag) {
    return reject("binding_mismatch");
  }
  if (!positiveInteger(generation) || generation !== expected.generation
    || !matches(checkpointId, ID) || checkpointId !== expected.checkpointId) {
    return reject("checkpoint_mismatch");
  }
  if (!record(boot) || !exactKeys(boot, ["firmware", "architecture", "machine", "osType", "scsiController", "order"])
    || boot.firmware !== "seabios" || boot.architecture !== "x86_64" || !matches(boot.machine, MACHINE)
    || boot.osType !== "l26" || boot.scsiController !== "virtio-scsi-single"
    || !Array.isArray(boot.order) || boot.order.length !== 1 || boot.order[0] !== "scsi0") {
    return reject("unsupported_boot");
  }
  if ((cloudInitSlot !== null && cloudInitSlot !== "ide2") || !Array.isArray(raw.devices)
    || raw.devices.length < 1 || raw.devices.length > 31) {
    return reject("unsupported_device");
  }

  const vmid = binding.vmid;
  const volumeIdPattern = new RegExp(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}:(?:vm-${vmid}-disk-[0-9]+|${vmid}/vm-${vmid}-disk-[0-9]+\\.(?:qcow2|raw))$`);
  const readFrom = role === "source" ? "snapshot" : "attached-disk";
  const devices: PortableKvmDisk[] = [];
  const slots = new Set<string>();
  const volumes = new Set<string>();
  const snapshots = new Set<string>();
  for (const disk of raw.devices as unknown[]) {
    if (!record(disk) || !matches(disk.slot, SCSI_SLOT)) return reject("unsupported_device");
    const { slot, volumeId, attachment, bytes, sha256, snapshotId } = disk;
    if (slots.has(slot) || !matches(volumeId, volumeIdPattern) || volumes.has(volumeId)
      || !record(attachment) || !exactKeys(attachment, ["discard", "ssd", "ioThread"])
      || typeof attachment.discard !== "boolean" || typeof attachment.ssd !== "boolean"
      || typeof attachment.ioThread !== "boolean") {
      return reject("unsupported_device", slot);
    }
    if (!exactKeys(disk, ["slot", "volumeId", "attachment", "bytes", "sha256", "snapshotId", "readFrom"])
      || !positiveInteger(bytes) || bytes % 512 !== 0 || !matches(sha256, SHA256)
      || !matches(snapshotId, ID) || snapshots.has(snapshotId) || disk.readFrom !== readFrom) {
      return reject("unverified_disk", slot);
    }
    slots.add(slot);
    volumes.add(volumeId);
    snapshots.add(snapshotId);
    devices.push({
      slot, volumeId, bytes, sha256, snapshotId, readFrom,
      attachment: { discard: attachment.discard, ssd: attachment.ssd, ioThread: attachment.ioThread },
    });
  }
  if (!slots.has("scsi0")) return reject("unsupported_boot", "scsi0");

  devices.sort((a, b) => Number(a.slot.slice(4)) - Number(b.slot.slice(4)));
  return {
    ok: true,
    manifest: {
      version: 1, role, generation, checkpointId, cloudInitSlot,
      binding: { hostId: binding.hostId, vmid, bindingTag: binding.bindingTag },
      boot: {
        firmware: "seabios", architecture: "x86_64", machine: boot.machine, osType: "l26",
        scsiController: "virtio-scsi-single", order: ["scsi0"],
      },
      devices, efi: "absent", tpm: "absent", savedRam: "absent",
    },
  };
}

export function verifyPortableKvmDiskManifests(
  source: unknown, destination: unknown, expected: PortableKvmTransferExpectation,
): TransferCheck {
  const { generation, checkpointId } = expected;
  if (expected.source.hostId === expected.destination.hostId) return { ok: false, reason: "binding_mismatch" };

  const from = checkPortableKvmDiskManifest(source, { role: "source", binding: expected.source, generation, checkpointId });
  if (from.ok === false) return from;
  const to = checkPortableKvmDiskManifest(destination, { role: "destination", binding: expected.destination, generation, checkpointId });
  if (to.ok === false) return to;

  if (from.manifest.boot.machine !== to.manifest.boot.machine) {
    return { ok: false, reason: "boot_mismatch", role: "destination" };
  }
  if (from.manifest.cloudInitSlot !== to.manifest.cloudInitSlot
    || from.manifest.devices.length !== to.manifest.devices.length) {
    return { ok: false, reason: "device_inventory_mismatch", role: "destination" };
  }
  for (const [i, disk] of from.manifest.devices.entries()) {
    const attached = to.manifest.devices[i];
    if (disk.slot !== attached.slot) {
      return { ok: false, reason: "device_inventory_mismatch", role: "destination", slot: disk.slot };
    }
    if (disk.bytes !== attached.bytes || disk.sha256 !== attached.sha256 || disk.snapshotId !== attached.snapshotId
      || disk.attachment.discard !== attached.attachment.discard || disk.attachment.ssd !== attached.attachment.ssd
      || disk.attachment.ioThread !== attached.attachment.ioThread) {
      return { ok: false, reason: "disk_mismatch", role: "destination", slot: disk.slot };
    }
  }

  return { ok: true, source: from.manifest, destination: to.manifest };
}
