import { createHash } from "node:crypto";
import { runPortableKvmGuardedCleanup, type PortableKvmCleanupAuthority, type PortableKvmCleanupRun } from "../cleanup";
import { serializePortableKvmDestinationBootProfile } from "../destination-boot";
import { serializePortableKvmDestinationReservation } from "../destination-disk";
import { serializePortableKvmDestinationPreparePermit } from "../destination-prepare";
import { portableKvmCheckpointDigest } from "../source-fence";

jest.mock("server-only", () => ({}));

const uuid = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const [receiptId, agentId, operationId, allocationOperationId, bootId, connectorId] = "123456".split("").map(uuid);
const generation = 8;
const ownerId = "user_CleanupFixture";
const bindingTag = "hivra-bind-" + "a".repeat(32);
const source = { hostId: "fixture-source", vmid: 9321, ip: "10.251.25.41", bindingTag };
const destination = { ...source, hostId: "fixture-destination", vmid: 9322 };
const fence = { agentId, operationId, generation, hostId: source.hostId, vmid: source.vmid, bindingTag,
  configurationSha256: sha("effective"), rawConfigurationSha256: sha("raw"), state: "fenced" as const };
const bytes = 1024 ** 3;
const configuration = { sha256: fence.configurationSha256, snapshotId: sha("config snapshot") };
const disk = { key: "scsi0" as const, bytes, sha256: sha("disk"), snapshotId: sha("disk snapshot") };
const checkpoint = { configuration, disk };
const checkpointSha256 = portableKvmCheckpointDigest(fence, configuration, disk);
const common = { ...destination, agentId, operationId, generation, checkpointSha256, storageId: "local-lvm", volumeGroup: "pve", disk };
const resources = { balloonMb: 4096, cpuUnits: 100 };
const managed = { allocationOperationId, resources, cpuLimit: 2, cpu: { vendor: "GenuineIntel" as const,
  requiredFlags: ["aes", "cx16", "pni", "popcnt", "sse4_1", "sse4_2", "ssse3"] as ("aes" | "cx16" | "pni" | "popcnt" | "sse4_1" | "sse4_2" | "ssse3")[] },
  cloudInit: { instanceId: "a".repeat(40), gateway: "10.251.25.1", nameservers: ["10.251.25.1"] } };
const preparation = { ...common, expiresAt: "2026-11-29T00:00:00.000Z", thinPool: "data", abortScope: { ownerId },
  profile: { machine: "pc-i440fx-9.2", cores: 2, memoryMb: 4096, network: { bridge: "vmbr1", macAddress: "02:23:45:AB:CD:EF" },
    attachment: { discard: true, ssd: true, ioThread: true }, managed } };
const { ip, ...target } = common;
const volume = "vm-9321-disk-0";
const lvUuid = "aaaaaa-bbbb-cccc-dddd-eeee-ffff-gggggg";
const retire = { action: "retire" as const, checkpoint,
  source: { fence, allocationOperationId, resources, disk: { volumeId: "local-lvm:" + volume, volumeGroup: "pve", thinPool: "data", lvUuid, bytes } },
  destination: { ip, managed, machineId: "b".repeat(32), reservation: { ...target, configurationSha256: sha("prepared effective"),
    rawConfigurationSha256: sha("prepared raw"), volumeName: "vm-9322-disk-0", deviceMapperUuid: "LVM-" + "X".repeat(64), resources } } };
const abort = { action: "abort" as const, checkpoint, destination: preparation,
  source: { receiptId, agentId, operationId, generation, source, allocationOperationId, resources,
    configuration: { raw: fence.rawConfigurationSha256, current: fence.configurationSha256,
      unlockedRaw: sha("restored raw"), unlockedCurrent: sha("restored effective") },
    disk: { storage: "local-lvm", vg: "pve", volume, uuid: lvUuid } } };

function fixture(run: PortableKvmCleanupRun, failAt?: "authority" | "absence" | "connector") {
  const authority: PortableKvmCleanupAuthority = { receiptId, agentId, operationId, generation, allocationOperationId, bindingTag, ownerId,
    checkpointSha256, ...run.action === "retire" ? { action: "retire", phase: "finished", authoritative: destination, cleanupTarget: source,
      bootId, connectorId, reservationSha256: sha(serializePortableKvmDestinationReservation(run.destination.reservation)) }
      : { action: "abort", phase: "restore_claimed", authoritative: source, cleanupTarget: destination, bootId: null, connectorId: null, reservationSha256: null } };
  const events: string[] = [];
  let read = 0;
  const operator = {
    readHeldAuthority: jest.fn(async () => ++read === 2 && failAt === "authority" ? { ...authority, generation: generation + 1 } : authority),
    runExactHost: jest.fn(async (placement: typeof source, script: string) => {
      const verified = script.includes("'verify-absent'") || script.includes(',"verify-absent"]');
      if (placement.hostId === authority.cleanupTarget.hostId) {
        events.push(verified ? "target verify" : "target cleanup");
        if (!verified || failAt === "absence") return { ok: true, stdout: "" };
        const proof = run.action === "retire" ? ["HIVRA_KVM_PORTABLE_SOURCE_RETIREMENT_V1",
          { input: run.source, mode: "verify-absent", state: "retired", sourceVmAbsent: true, sourceDiskAbsent: true }]
          : ["HIVRA_KVM_PORTABLE_DESTINATION_ABORT_V1",
            { state: "destination_abort_absent", preparationSha256: sha(serializePortableKvmDestinationPreparePermit({ ...run.destination })) }];
        return { ok: true, stdout: proof[0] + " " + JSON.stringify(proof[1]) + "\n" };
      }
      if (run.action === "retire") {
        events.push("destination witness");
        return { ok: true, stdout: "HIVRA_KVM_PORTABLE_BOOT_V1 " + JSON.stringify({ state: "destination_lock_released",
          profileSha256: sha(serializePortableKvmDestinationBootProfile(run.destination)), bootId, connectorId }) + "\n" };
      }
      const mode = script.includes("'check'") ? "check" : script.includes("'verify'") ? "verify" : "cleanup";
      events.push("source " + mode);
      return { ok: true, stdout: "HIVRA_KVM_PORTABLE_SOURCE_ABORT_V1 " + JSON.stringify({ mode, authority: run.source }) + "\n" };
    }),
    readActiveConnectorIds: async () => failAt === "connector" ? [connectorId, uuid("8")] : run.action === "retire" ? [connectorId] : [],
    finish: jest.fn(async () => { events.push("finalize"); return true; }),
  };
  return { authority, operator, events, run: () => runPortableKvmGuardedCleanup(authority, run, operator) };
}

test("aborts only after native destination absence and then restores the original source", async () => {
  const f = fixture(abort);
  await expect(f.run()).resolves.toMatchObject({ state: "aborted" });
  expect(f.events).toEqual(["source check", "target cleanup", "target verify", "source check", "source cleanup", "source verify",
    "target verify", "source check", "finalize"]);
  expect(f.operator.finish).toHaveBeenCalledWith(f.authority, expect.objectContaining({ destinationVmAbsent: true, sourceLegacyColdMarkerRestored: true }));
});

test.each(["authority", "absence", "connector"] as const)("refuses to release the original source when %s cannot be proven", async failure => {
  const f = fixture(abort, failure);
  await expect(f.run()).rejects.toThrow();
  expect(f.events).not.toContain("source cleanup");
  expect(f.operator.finish).not.toHaveBeenCalled();
});

test("refuses stale source or destination before invoking any operator transport", async () => {
  const { authority, operator } = fixture(abort);
  await expect(runPortableKvmGuardedCleanup(authority, { ...abort, destination: { ...preparation, vmid: 9327 } }, operator)).rejects.toThrow();
  expect(operator.readHeldAuthority).not.toHaveBeenCalled();
  expect(operator.runExactHost).not.toHaveBeenCalled();
});

test("retires only after the accepted boot and sole connector are independently reconfirmed", async () => {
  const f = fixture(retire);
  await expect(f.run()).resolves.toMatchObject({ state: "retired" });
  expect(f.events).toEqual(["destination witness", "target cleanup", "target verify", "destination witness", "finalize"]);
  expect(f.operator.finish).toHaveBeenCalledWith(f.authority, { source, destination, sourceVmAbsent: true,
    sourceConnectorAbsent: true, destinationHealthy: true });
  const ambiguous = fixture(retire, "connector");
  await expect(ambiguous.run()).rejects.toThrow("accepted destination");
  expect(ambiguous.events).toEqual(["destination witness"]);
});
