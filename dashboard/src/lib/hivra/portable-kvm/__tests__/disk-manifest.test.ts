import {
  checkPortableKvmDiskManifest,
  verifyPortableKvmDiskManifests,
  type PortableKvmDiskManifest,
  type PortableKvmTransferExpectation,
} from "../disk-manifest";

const expected: PortableKvmTransferExpectation = {
  source: { hostId: "host-a", vmid: 9301, bindingTag: `hivra-bind-${"a".repeat(32)}` },
  destination: { hostId: "host-b", vmid: 9303, bindingTag: `hivra-bind-${"b".repeat(32)}` },
  generation: 4,
  checkpointId: "checkpoint-4",
};

function manifest(role: PortableKvmDiskManifest["role"], slots = ["scsi0"]): PortableKvmDiskManifest {
  const binding = { ...expected[role] };
  return {
    version: 1,
    role,
    binding,
    generation: expected.generation,
    checkpointId: expected.checkpointId,
    boot: {
      firmware: "seabios",
      architecture: "x86_64",
      machine: "pc-i440fx-9.2",
      osType: "l26",
      scsiController: "virtio-scsi-single",
      order: ["scsi0"],
    },
    cloudInitSlot: "ide2",
    devices: slots.map((slot) => {
      const index = slot.slice(4);
      return {
        slot,
        volumeId: role === "source"
          ? `local:${binding.vmid}/vm-${binding.vmid}-disk-${index}.qcow2`
          : `local-lvm:vm-${binding.vmid}-disk-${index}`,
        attachment: { discard: true, ssd: true, ioThread: false },
        bytes: 42_949_672_960,
        sha256: (slot === "scsi0" ? "a" : "b").repeat(64),
        snapshotId: `snapshot-${index}`,
        readFrom: role === "source" ? "snapshot" : "attached-disk",
      };
    }),
    efi: "absent",
    tpm: "absent",
    savedRam: "absent",
  };
}

const verify = (destination: unknown, source: unknown = manifest("source")) =>
  verifyPortableKvmDiskManifests(source, destination, expected);

it("checks a host manifest individually and matches different storage and VMIDs", () => {
  const source = manifest("source");
  const destination = manifest("destination");
  expect(checkPortableKvmDiskManifest(source, {
    role: "source",
    binding: expected.source,
    generation: expected.generation,
    checkpointId: expected.checkpointId,
  })).toEqual({ ok: true, manifest: source });
  expect(verify(destination, source)).toEqual({ ok: true, source, destination });
});

it("checks each extra disk independently by slot, not evidence array order", () => {
  const source = manifest("source", ["scsi8", "scsi0", "scsi11"]);
  const destination = manifest("destination", ["scsi11", "scsi8", "scsi0"]);
  expect(verify(destination, source)).toEqual({
    ok: true,
    source: manifest("source", ["scsi0", "scsi8", "scsi11"]),
    destination: manifest("destination", ["scsi0", "scsi8", "scsi11"]),
  });
  expect(source.devices.map(({ slot }) => slot)).toEqual(["scsi8", "scsi0", "scsi11"]);
});

it.each([
  { hostId: "host-c" },
  { vmid: 9302 },
  { bindingTag: expected.source.bindingTag },
])("rejects a report from the wrong destination binding: %p", (change) => {
  const destination = manifest("destination");
  expect(verify({ ...destination, binding: { ...destination.binding, ...change } }))
    .toEqual({ ok: false, reason: "binding_mismatch", role: "destination" });
});

it("rejects same-host placement and source evidence presented as destination", () => {
  expect(verifyPortableKvmDiskManifests(manifest("source"), manifest("destination"), {
    ...expected, destination: { ...expected.destination, hostId: expected.source.hostId },
  })).toEqual({ ok: false, reason: "binding_mismatch" });
  expect(verify(manifest("source"))).toEqual({ ok: false, reason: "invalid_manifest", role: "destination" });
});

it.each([{ generation: 3 }, { checkpointId: "another-checkpoint" }])(
  "rejects stale or unrelated checkpoint evidence: %p", (change) => {
    expect(verify({ ...manifest("destination"), ...change }))
      .toEqual({ ok: false, reason: "checkpoint_mismatch", role: "destination" });
  },
);

it.each([
  ["efi", "efi_unproven"],
  ["tpm", "tpm_unproven"],
  ["savedRam", "saved_ram_unsupported"],
])("rejects present or unproven %s state on either host", (key, reason) => {
  for (const state of ["present", "unknown", undefined]) {
    expect(verify(manifest("destination"), { ...manifest("source"), [key]: state }))
      .toEqual({ ok: false, reason, role: "source" });
    expect(verify({ ...manifest("destination"), [key]: state }))
      .toEqual({ ok: false, reason, role: "destination" });
  }
});

it.each([
  { firmware: "ovmf" },
  { machine: "q35" },
  { machine: "pc-i440fx" },
  { scsiController: "virtio-scsi-pci" },
  { osType: "win11" },
  { order: ["scsi0", "net0"] },
])("rejects unsupported boot settings: %p", (change) => {
  const destination = manifest("destination");
  expect(verify({ ...destination, boot: { ...destination.boot, ...change } }))
    .toEqual({ ok: false, reason: "unsupported_boot", role: "destination" });
});

it("rejects different effective machine versions even when both are supported", () => {
  const destination = manifest("destination");
  destination.boot.machine = "pc-i440fx-9.1";
  expect(verify(destination)).toEqual({ ok: false, reason: "boot_mismatch", role: "destination" });
});

it.each(["virtio0", "unused0", "efidisk0", "tpmstate0", "ide2", "scsi31", "scsi00"])(
  "doesn't silently skip unsupported device slots: %s", (slot) => {
    expect(verify(manifest("destination", ["scsi0", slot])))
      .toEqual({ ok: false, reason: "unsupported_device", role: "destination" });
  },
);

it("requires the boot device, matches generated cloud-init presence, and rejects unknown media", () => {
  const destination = manifest("destination");
  expect(verify(manifest("destination", ["scsi1"])))
    .toEqual({ ok: false, reason: "unsupported_boot", role: "destination", slot: "scsi0" });
  expect(verify({ ...destination, cloudInitSlot: null }))
    .toEqual({ ok: false, reason: "device_inventory_mismatch", role: "destination" });
  expect(verify({ ...destination, cloudInitSlot: "ide3" }))
    .toEqual({ ok: false, reason: "unsupported_device", role: "destination" });
  expect(verify({ ...destination, cloudInitSlot: null }, { ...manifest("source"), cloudInitSlot: null }))
    .toMatchObject({ ok: true });
});

it("rejects missing, injected or re-slotted destination disks", () => {
  const source = manifest("source", ["scsi0", "scsi1"]);
  for (const slots of [["scsi0"], ["scsi0", "scsi1", "scsi2"], ["scsi0", "scsi2"]]) {
    expect(verify(manifest("destination", slots), source))
      .toMatchObject({ ok: false, reason: "device_inventory_mismatch", role: "destination" });
  }
});

it("rejects passthrough, foreign VM volumes, unknown attachment options and duplicate slots/volumes", () => {
  const destination = manifest("destination", ["scsi0", "scsi1"]);
  const [boot, extra] = destination.devices;
  for (const disk of [
    { ...extra, volumeId: "/dev/sda" },
    { ...extra, volumeId: "local-lvm:vm-9301-disk-1" },
    { ...extra, volumeId: boot.volumeId },
    { ...extra, slot: boot.slot },
    { ...extra, attachment: { ...extra.attachment, media: "cdrom" } },
  ]) {
    expect(verify({ ...destination, devices: [boot, disk] }))
      .toMatchObject({ ok: false, reason: "unsupported_device", role: "destination" });
  }
});

it("rejects missing or malformed per-disk evidence and destination copies of source evidence", () => {
  const source = manifest("source", ["scsi0", "scsi1"]);
  const destination = manifest("destination", ["scsi0", "scsi1"]);
  const [boot, extra] = destination.devices;
  for (const change of [
    { sha256: undefined }, { sha256: "z".repeat(64) }, { sha256: `${extra.sha256}\n` },
    { bytes: 12 }, { bytes: 2 ** 53 }, { snapshotId: "../snapshot" },
    { snapshotId: boot.snapshotId }, { readFrom: "snapshot" },
  ]) {
    expect(verify({ ...destination, devices: [boot, { ...extra, ...change }] }, source))
      .toEqual({ ok: false, reason: "unverified_disk", role: "destination", slot: "scsi1" });
  }
  source.devices[1].readFrom = "attached-disk";
  expect(verify(destination, source))
    .toEqual({ ok: false, reason: "unverified_disk", role: "source", slot: "scsi1" });
});

it("rejects changed size, digest, snapshot lineage or attachment on an extra disk", () => {
  const source = manifest("source", ["scsi0", "scsi1"]);
  const destination = manifest("destination", ["scsi0", "scsi1"]);
  const [boot, extra] = destination.devices;
  for (const change of [
    { sha256: "c".repeat(64) },
    { bytes: extra.bytes + 512 },
    { snapshotId: "different-snapshot" },
    { attachment: { ...extra.attachment, ioThread: true } },
  ]) {
    expect(verify({ ...destination, devices: [boot, { ...extra, ...change }] }, source))
      .toEqual({ ok: false, reason: "disk_mismatch", role: "destination", slot: "scsi1" });
  }
});
