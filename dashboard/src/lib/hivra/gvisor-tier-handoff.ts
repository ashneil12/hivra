import "server-only";

import { createHmac } from "node:crypto";
import { z } from "zod";
import { isCanonicalGitCanaryDeployment } from "./canonical-git-canary";
import { managedGvisorDiskAdmissionEnabled, managedGvisorIdlePilotConfig } from "./managed-gvisor-launch-config";

const id = z.string().uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.number().int().positive().safe();
export const GvisorTierArchive = z.object({
  sha256: digest,
  ciphertext_bytes: z.number().int().positive().safe(),
  entries: z.number().int().nonnegative().safe(),
  bytes: z.number().int().nonnegative().safe(),
}).strict();
const TierReceiptBase = z.object({
  version: z.literal(1), computerId: id, generation: id, connectionId: id, targetId: id,
  revision, sandboxId: id, hostIdentityDigest: digest, checkpointDigest: digest,
});
export const GvisorTierHandoff = z.object({
  computer_id: id, customer_id: z.string().min(1), operator_id: z.string().min(1), generation: id,
  source_connection_id: id, source_target_id: id, source_revision: revision, source_sandbox_id: id,
  source_host_identity_digest: digest, destination_connection_id: id, destination_target_id: id, destination_active_target_id: id,
  destination_revision: revision, destination_sandbox_id: id, destination_host_identity_digest: digest,
  adapter_sha256: digest, runtime_sha256: digest,
  phase: z.enum(["checkpointing", "sleeping", "running", "retiring"]),
  checkpoint_receipt: TierReceiptBase.extend({ state: z.literal("checkpointed"), archive: GvisorTierArchive }).strict().nullable(),
  health_receipt: TierReceiptBase.extend({ state: z.literal("running") }).strict().nullable(),
  expires_at: z.string(), created_at: z.string(), updated_at: z.string(),
}).strict().superRefine((value, ctx) => {
  const archive = value.checkpoint_receipt;
  const health = value.health_receipt;
  const same = (receipt: z.infer<typeof TierReceiptBase>, side: "source" | "destination") =>
    receipt.generation === value.generation && receipt.computerId === value.computer_id
    && receipt.connectionId === value[`${side}_connection_id`] && receipt.targetId === value[`${side}_target_id`]
    && receipt.revision === value[`${side}_revision`] && receipt.sandboxId === value[`${side}_sandbox_id`]
    && receipt.hostIdentityDigest === value[`${side}_host_identity_digest`];
  if (value.source_host_identity_digest === value.destination_host_identity_digest
    || value.source_sandbox_id === value.destination_sandbox_id
    || value.destination_active_target_id !== value.destination_target_id
    || (value.phase !== "retiring" && ((value.phase !== "checkpointing") !== Boolean(archive)
      || (value.phase === "running") !== Boolean(health)))
    || (archive && (!same(archive, "source") || archive.archive.sha256 !== archive.checkpointDigest))
    || (health && (!same(health, "destination") || health.checkpointDigest !== archive?.checkpointDigest))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid managed workspace handoff evidence" });
  }
});
export type GvisorTierHandoff = z.infer<typeof GvisorTierHandoff>;

export function gvisorTierPilot(env = process.env, now = Date.now()) {
  if (!isCanonicalGitCanaryDeployment(env) || env.HIVRA_MANAGED_GVISOR_TIER_ENABLED !== "true"
    || !managedGvisorDiskAdmissionEnabled(env)) return null;
  const pilot = managedGvisorIdlePilotConfig({ ...env, HIVRA_MANAGED_GVISOR_IDLE_PILOT_ENABLED: "true" }, now);
  const config = z.object({
    computer: id, destinationConnection: id, destinationTarget: id, destinationRevision: revision,
    key: digest, helperSha: digest, codecSha: digest,
  }).strict().safeParse({
    computer: env.HIVRA_MANAGED_GVISOR_TIER_COMPUTER_ID,
    destinationConnection: env.HIVRA_MANAGED_GVISOR_TIER_DESTINATION_CONNECTION_ID,
    destinationTarget: env.HIVRA_MANAGED_GVISOR_TIER_DESTINATION_TARGET_ID,
    destinationRevision: Number(env.HIVRA_MANAGED_GVISOR_TIER_DESTINATION_CONNECTION_REVISION),
    key: env.HIVRA_MANAGED_GVISOR_TIER_KEY,
    helperSha: env.HIVRA_MANAGED_GVISOR_TIER_HELPER_SHA256,
    codecSha: env.HIVRA_MANAGED_GVISOR_TIER_CODEC_SHA256,
  });
  if (!pilot || !config.success || config.data.destinationConnection === pilot.connectionId
    || config.data.destinationTarget === pilot.targetId) return null;
  return { ...pilot, ...config.data };
}

export function gvisorTierKey(masterHex: string, ownerHash: string, id: string, generation: string): string {
  return createHmac("sha256", Buffer.from(masterHex, "hex"))
    .update(`hivra-gvisor-workspace-generation-v1\0${ownerHash}\0${id}\0${generation}`).digest("hex");
}

export function gvisorTierIdleHours(plan: string, env = process.env): number | null {
  if (env.HIVRA_MANAGED_GVISOR_TIER_AUTO_ENABLED !== "true") return null;
  try {
    const map = z.record(z.string(), z.number().int().min(1).max(8760))
      .safeParse(JSON.parse(env.HIVRA_MANAGED_GVISOR_TIER_IDLE_HOURS ?? "{}"));
    return map.success && Object.hasOwn(map.data, plan) ? map.data[plan] : null;
  } catch { return null; }
}
