import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  isPortableKvmReadyToCheckpoint, isPortableKvmWakeClaimed, portableKvmPlacement, resolvePortableKvmPilotPlacement,
  type PortableKvmPlacement,
} from "./pilot";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const snapshot = z.object({ sha256: digest, snapshotId: digest }).strict();
const checkpointReceipt = z.object({
  configuration: snapshot,
  disk: snapshot.extend({ key: z.literal("scsi0"), bytes: z.number().int().positive().max(40 * 1024 ** 3) }).strict(),
});
const handoffSchema = z.object({
  owner_id: z.string().min(1),
  agent_id: z.string().uuid(),
  operation_id: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  source: portableKvmPlacement,
  destination: portableKvmPlacement,
  expires_at: z.string().refine(value => Number.isFinite(Date.parse(value))),
  phase: z.enum(["checkpointing", "storage_verified", "restore_claimed", "destination_verified", "placement_committed", "connector_verified", "finished"]),
  checkpoint_sha256: digest.nullable(),
  storage_evidence: checkpointReceipt.nullable(),
  destination_evidence: z.object({ bootId: z.string().uuid(), reservationSha256: digest }).nullable().optional(),
  connector_evidence: z.object({ bootId: z.string().uuid(), connectorId: z.string().uuid() }).nullable().optional(),
});

export type PortableKvmHandoff = z.infer<typeof handoffSchema>;
export type PortableKvmCheckpointReceipt = z.infer<typeof checkpointReceipt>;
type ScopedCheckpoint = PortableKvmCheckpointReceipt & { checkpointSha256: string };
type AdvanceAction = "verify_storage" | "claim_restore" | "verify_destination" | "commit_placement" | "confirm_connector" | "finish_wake";
type Outcome = { state: "awake" | "waking" | "failed"; reason: string };

export interface PortableKvmWakeDriver {
  rpc(name: string, parameters: Record<string, unknown>): Promise<unknown>;
  preflight(agent: Record<string, unknown>, placement: { current: PortableKvmPlacement; alternate: PortableKvmPlacement }): Promise<boolean>;
  checkpoint(agent: Record<string, unknown>, handoff: PortableKvmHandoff): Promise<ScopedCheckpoint | null>;
  verifyFencedSource(agent: Record<string, unknown>, handoff: PortableKvmHandoff): Promise<boolean>;
  restoreAndColdBoot(agent: Record<string, unknown>, handoff: PortableKvmHandoff, checkpoint: ScopedCheckpoint):
    Promise<{ bootId: string; reservationSha256: string } | null>;
  verifyQuarantinedDestination(agent: Record<string, unknown>, handoff: PortableKvmHandoff): Promise<boolean>;
  enableDestinationConnector(agent: Record<string, unknown>, handoff: PortableKvmHandoff): Promise<{bootId: string; connectorId: string} | null>;
  releaseDestinationLock(agent: Record<string, unknown>, handoff: PortableKvmHandoff): Promise<boolean>;
}

function samePlacement(a: PortableKvmPlacement, b: PortableKvmPlacement): boolean {
  return a.hostId === b.hostId && a.vmid === b.vmid && a.ip === b.ip && a.bindingTag === b.bindingTag;
}

export async function advancePortableKvmOwnerWake(
  ownerId: string, agent: Record<string, unknown>, driver: PortableKvmWakeDriver,
): Promise<Outcome | null> {
  const claimed = isPortableKvmWakeClaimed(agent);
  if (ownerId !== agent.user_id || typeof agent.id !== "string") return null;
  const placement = resolvePortableKvmPilotPlacement(ownerId, agent);
  if (!placement) return claimed ? { state: "failed", reason: "portable_kvm_pilot_disabled" } : null;
  if (!claimed && !isPortableKvmReadyToCheckpoint(agent)) return null;
  const agentId = agent.id;
  const scope = { p_owner_id: ownerId, p_agent_id: agentId };
  const waiting: Outcome = { state: "waking", reason: "portable_kvm_in_progress" };
  const denied: Outcome = { state: "failed", reason: "portable_kvm_lease_refused" };
  if (!claimed) {
    if (!await driver.preflight(agent, placement)) return { state: "failed", reason: "portable_kvm_preflight_refused" };
    const result = handoffSchema.safeParse(await driver.rpc("begin_hivra_kvm_portable_handoff", {
      ...scope, p_operation_id: randomUUID(), p_expected_generation: agent.sleep_generation,
      p_source: placement.current, p_destination: placement.alternate,
      p_expires_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    }));
    return result.success && result.data.phase === "checkpointing" ? waiting : denied;
  }

  const result = handoffSchema.safeParse(await driver.rpc("read_hivra_kvm_portable_handoff", scope));
  if (!result.success) return denied;
  const handoff = result.data;
  const committed = handoff.phase === "placement_committed" || handoff.phase === "connector_verified";
  if (handoff.owner_id !== ownerId || handoff.agent_id !== agentId || handoff.operation_id !== agent.operation_id
    || handoff.generation !== agent.sleep_generation || Date.parse(handoff.expires_at) <= Date.now()
    || handoff.phase === "finished"
    || !samePlacement(placement.current, committed ? handoff.destination : handoff.source)
    || !samePlacement(placement.alternate, committed ? handoff.source : handoff.destination)) return denied;

  async function advance(action: AdvanceAction, evidence: unknown, phase: PortableKvmHandoff["phase"]): Promise<Outcome> {
    const next = handoffSchema.safeParse(await driver.rpc("advance_hivra_kvm_portable_handoff", {
      ...scope, p_operation_id: handoff.operation_id, p_generation: handoff.generation, p_action: action, p_evidence: evidence,
    }));
    if (!next.success || next.data.phase !== phase || next.data.operation_id !== handoff.operation_id
      || next.data.generation !== handoff.generation || next.data.owner_id !== handoff.owner_id
      || next.data.agent_id !== handoff.agent_id || !samePlacement(next.data.source, handoff.source)
      || !samePlacement(next.data.destination, handoff.destination)) return waiting;
    return phase === "finished" ? { state: "awake", reason: "portable_kvm_wake" } : waiting;
  }

  const sourceProof = { source: handoff.source, sourceStopped: true, sourceFenced: true, sourceConnectorOff: true };
  if (handoff.phase === "checkpointing") {
    const proof = await driver.checkpoint(agent, handoff);
    if (!proof || !await driver.verifyFencedSource(agent, handoff)) return waiting;
    const { configuration, disk, checkpointSha256 } = proof;
    return advance("verify_storage", { ...sourceProof, checkpointSha256, configuration, disk, storageReadbackVerified: true }, "storage_verified");
  }
  if (!handoff.checkpoint_sha256 || !handoff.storage_evidence) return denied;
  const checkpoint = { ...handoff.storage_evidence, checkpointSha256: handoff.checkpoint_sha256 };
  if (handoff.phase === "storage_verified") return advance("claim_restore", null, "restore_claimed");
  if (handoff.phase === "restore_claimed") {
    const proof = await driver.restoreAndColdBoot(agent, handoff, checkpoint);
    if (!proof) return waiting;
    return advance("verify_destination", { destination: handoff.destination, checkpointSha256: checkpoint.checkpointSha256,
      coldBootVerified: true, destinationConnectorBlocked: true, ...proof }, "destination_verified");
  }
  if (handoff.phase === "destination_verified") {
    if (!await driver.verifyFencedSource(agent, handoff) || !await driver.verifyQuarantinedDestination(agent, handoff)) return waiting;
    return advance("commit_placement", { ...sourceProof, destination: handoff.destination,
      checkpointSha256: checkpoint.checkpointSha256, destinationConnectorBlocked: true }, "placement_committed");
  }
  if (!await driver.verifyFencedSource(agent, handoff)) return waiting;
  const connectorProof = { destination: handoff.destination, sourceFenced: true, sourceConnectorOff: true,
    destinationConnectorReady: true };
  if (handoff.phase === "placement_committed") {
    const proof = await driver.enableDestinationConnector(agent, handoff);
    if (!proof || proof.bootId !== handoff.destination_evidence?.bootId) return waiting;
    return advance("confirm_connector", { ...connectorProof, ...proof }, "connector_verified");
  }
  if (!handoff.connector_evidence || !await driver.releaseDestinationLock(agent, handoff)) return waiting;
  return advance("finish_wake", { ...connectorProof, ...handoff.connector_evidence, destinationLockReleased: true }, "finished");
}
