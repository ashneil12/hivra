import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { portableKvmCheckpointDigest } from "./source-fence";
import { buildPortableKvmDestinationAbortScript, parsePortableKvmDestinationAbortReceipt } from "./destination-abort";
import { buildPortableKvmDestinationRetirementWitness, parsePortableKvmDestinationRetirementWitness,
  type PortableKvmDestinationBootProfile } from "./destination-boot";
import { serializePortableKvmDestinationReservation } from "./destination-disk";
import { portableKvmAllocationOperationId, type PortableKvmDestinationPrepareInput } from "./destination-prepare";
import type { PortableKvmCheckpointReceipt } from "./handoff";
import { portableKvmPlacement, type PortableKvmPlacement } from "./pilot";
import { buildPortableKvmSourceAbortScript, parsePortableKvmSourceAbortReceipt, type PortableKvmSourceAbortInput } from "./source-abort";
import { buildPortableKvmSourceRetirementScript, parsePortableKvmSourceRetirementReceipt,
  type PortableKvmSourceRetirementInput } from "./source-retirement";

const phases = ["checkpointing", "storage_verified", "restore_claimed", "destination_verified", "finished"] as const;
const authoritySchema = z.object({
  receiptId: z.string().uuid(),
  action: z.enum(["abort", "retire"]),
  ownerId: z.string().regex(/^user_[A-Za-z0-9]+$/),
  agentId: z.string().uuid(),
  operationId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  allocationOperationId: portableKvmAllocationOperationId,
  bindingTag: z.string().regex(/^hivra-bind-[a-f0-9]{32}$/),
  phase: z.enum(phases),
  authoritative: portableKvmPlacement,
  cleanupTarget: portableKvmPlacement,
  checkpointSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  reservationSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  bootId: z.string().uuid().nullable(),
  connectorId: z.string().uuid().nullable(),
}).strict().superRefine((value, ctx) => {
  const { action, phase, authoritative, cleanupTarget, bindingTag, bootId, connectorId, checkpointSha256 } = value;
  if (authoritative.hostId === cleanupTarget.hostId || authoritative.ip !== cleanupTarget.ip
    || authoritative.vmid === 9302 || cleanupTarget.vmid === 9302
    || authoritative.bindingTag !== bindingTag || cleanupTarget.bindingTag !== bindingTag
    || (action === "retire" ? phase !== "finished" || !bootId || !connectorId || !checkpointSha256 || !value.reservationSha256
      : phase === "finished" || bootId !== null || connectorId !== null)) {
    ctx.addIssue({ code: "custom", message: "Invalid exact portable cleanup authority" });
  }
});

export type PortableKvmCleanupAuthority = z.infer<typeof authoritySchema>;
export type PortableKvmCleanupRun =
  | { action: "abort"; source: PortableKvmSourceAbortInput; destination: PortableKvmDestinationPrepareInput; checkpoint: PortableKvmCheckpointReceipt }
  | { action: "retire"; source: PortableKvmSourceRetirementInput; destination: PortableKvmDestinationBootProfile; checkpoint: PortableKvmCheckpointReceipt };

type RetirementEvidence = {
  source: PortableKvmPlacement;
  destination: PortableKvmPlacement;
  sourceVmAbsent: true;
  sourceConnectorAbsent: true;
  destinationHealthy: true;
};

type AbortEvidence = {
  source: PortableKvmPlacement;
  destination: PortableKvmPlacement;
  portableWorkQuiesced: true;
  destinationVmAbsent: true;
  destinationStorageAbsent: true;
  sourceDiskUnchanged: true;
  sourceStopped: true;
  sourceConnectorOff: true;
  sourceLegacyColdMarkerRestored: true;
};

export interface PortableKvmCleanupOperator {
  readHeldAuthority(authority: PortableKvmCleanupAuthority): Promise<unknown>;
  runExactHost(placement: PortableKvmPlacement, script: string): Promise<{ ok: boolean; stdout: string }>;
  readActiveConnectorIds(authority: PortableKvmCleanupAuthority): Promise<readonly string[]>;
  finish(authority: PortableKvmCleanupAuthority, evidence: RetirementEvidence | AbortEvidence): Promise<boolean>;
}

export async function runPortableKvmGuardedCleanup(
  claimedAuthority: PortableKvmCleanupAuthority,
  run: PortableKvmCleanupRun,
  operator: PortableKvmCleanupOperator,
) {
  const authority = authoritySchema.parse(claimedAuthority);
  const { action, authoritative, cleanupTarget, receiptId, agentId, operationId, generation, allocationOperationId } = authority;
  const sourceAbort = run.action === "abort" ? run.source : undefined;
  const sourcePlacement = action === "abort" ? authoritative : cleanupTarget;
  const sourceFence = run.action === "retire" ? run.source.fence : {
    agentId: run.source.agentId, operationId: run.source.operationId, generation: run.source.generation,
    hostId: run.source.source.hostId, vmid: run.source.source.vmid, bindingTag: run.source.source.bindingTag,
    configurationSha256: run.source.configuration.current, rawConfigurationSha256: run.source.configuration.raw,
    state: "fenced" as const,
  };
  const dest = run.action === "retire" ? run.destination.reservation : run.destination;
  const destPlacement = action === "abort" ? cleanupTarget : authoritative;
  const destinationIp = run.destination.ip;
  if (run.action !== action || sourceFence.agentId !== agentId || sourceFence.operationId !== operationId
    || sourceFence.generation !== generation || sourceFence.hostId !== sourcePlacement.hostId
    || sourceFence.vmid !== sourcePlacement.vmid || sourceFence.bindingTag !== sourcePlacement.bindingTag
    || run.source.allocationOperationId !== allocationOperationId
    || dest.agentId !== agentId || dest.operationId !== operationId || dest.generation !== generation
    || dest.hostId !== destPlacement.hostId || dest.vmid !== destPlacement.vmid || dest.bindingTag !== destPlacement.bindingTag
    || destinationIp !== destPlacement.ip || dest.checkpointSha256 !== authority.checkpointSha256
    || sourceFence.configurationSha256 !== run.checkpoint.configuration.sha256
    || portableKvmCheckpointDigest(sourceFence, run.checkpoint.configuration, run.checkpoint.disk) !== authority.checkpointSha256
    || !isDeepStrictEqual(dest.disk, run.checkpoint.disk)
    || (run.action === "abort"
      ? run.source.receiptId !== receiptId || !isDeepStrictEqual(portableKvmPlacement.parse(run.source.source), authoritative)
        || run.destination.abortScope?.ownerId !== authority.ownerId || run.destination.profile.managed?.allocationOperationId !== allocationOperationId
      : run.source.disk.bytes !== run.checkpoint.disk.bytes || run.destination.managed?.allocationOperationId !== allocationOperationId
        || createHash("sha256").update(serializePortableKvmDestinationReservation(run.destination.reservation)).digest("hex")
          !== authority.reservationSha256)) {
    throw new Error("Portable cleanup inputs do not match the held placement");
  }
  const targetScript = (mode: "cleanup" | "verify-absent") => run.action === "abort"
    ? buildPortableKvmDestinationAbortScript(mode, { preparation: run.destination })
    : buildPortableKvmSourceRetirementScript(run.source, mode);

  async function reread() {
    const held = authoritySchema.safeParse(await operator.readHeldAuthority(authority));
    if (!held.success || !isDeepStrictEqual(held.data, authority)) throw new Error("Portable cleanup authority changed");
  }

  async function verifyPreserved() {
    await reread();
    if (sourceAbort) {
      const checked = await operator.runExactHost(authoritative, buildPortableKvmSourceAbortScript("check", sourceAbort));
      if (!checked.ok || !parsePortableKvmSourceAbortReceipt(checked.stdout, sourceAbort, "check")
        || (await operator.readActiveConnectorIds(authority)).length !== 0) {
        throw new Error("Original cold source was not independently confirmed");
      }
    } else {
      if (run.action !== "retire" || !authority.bootId || !authority.connectorId) throw new Error("Retirement witness missing");
      const current = await operator.runExactHost(authoritative, buildPortableKvmDestinationRetirementWitness(run.destination,
        authority.bootId, authority.connectorId, Date.now() + 75_000));
      const connections = await operator.readActiveConnectorIds(authority);
      if (!current.ok || !parsePortableKvmDestinationRetirementWitness(current.stdout, run.destination, authority.bootId, authority.connectorId)
        || connections.length !== 1 || connections[0] !== authority.connectorId) {
        throw new Error("Only the accepted destination may be preserved for retirement");
      }
    }
  }

  async function verifyAbsence() {
    await reread();
    const observed = await operator.runExactHost(cleanupTarget, targetScript("verify-absent"));
    const absent = run.action === "abort" ? parsePortableKvmDestinationAbortReceipt(observed.stdout, { preparation: run.destination })
      : parsePortableKvmSourceRetirementReceipt(observed.stdout, run.source, "verify-absent");
    if (!observed.ok || !absent) throw new Error("Portable cleanup target absence was not independently confirmed");
  }

  await verifyPreserved();
  await reread();
  const removed = await operator.runExactHost(cleanupTarget, targetScript("cleanup"));
  if (!removed.ok) throw new Error("Portable cleanup command did not confirm success");
  await verifyAbsence();

  let evidence: RetirementEvidence | AbortEvidence;
  if (sourceAbort) {
    await verifyPreserved();
    await reread();
    const released = await operator.runExactHost(authoritative, buildPortableKvmSourceAbortScript("cleanup", sourceAbort));
    if (!released.ok) throw new Error("Original cold source fence release did not confirm success");
    await reread();
    const source = await operator.runExactHost(authoritative, buildPortableKvmSourceAbortScript("verify", sourceAbort));
    if (!source.ok || !parsePortableKvmSourceAbortReceipt(source.stdout, sourceAbort)) {
      throw new Error("Original cold source restoration was not independently confirmed");
    }
    await verifyAbsence();
    evidence = { source: authoritative, destination: cleanupTarget, portableWorkQuiesced: true,
      destinationVmAbsent: true, destinationStorageAbsent: true, sourceDiskUnchanged: true,
      sourceStopped: true, sourceConnectorOff: true, sourceLegacyColdMarkerRestored: true };
  } else {
    evidence = { source: cleanupTarget, destination: authoritative, sourceVmAbsent: true,
      sourceConnectorAbsent: true, destinationHealthy: true };
  }
  await verifyPreserved();
  await reread();
  if (!await operator.finish(authority, evidence)) throw new Error("Portable cleanup finalization was not confirmed");
  return { state: action === "abort" ? "aborted" : "retired", receiptId } as const;
}
