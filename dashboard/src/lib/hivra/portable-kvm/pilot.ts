import { isIPv4 } from "node:net";
import { z } from "zod";
import { isCanonicalGitCanaryDeployment } from "../canonical-git-canary";
import { hivraInfrastructureBindingTag, isHivraInfrastructureBindingTokenHash } from "../agent-authority";

const endpoint = z.object({
  hostId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  vmid: z.number().int().min(100).max(999_999_999).refine(vmid => vmid !== 9302),
  ip: z.string().refine(isIPv4),
}).strict();

export const portableKvmPlacement = endpoint.extend({
  bindingTag: z.string().regex(/^hivra-bind-[a-f0-9]{32}$/),
}).strict();

export type PortableKvmPlacement = z.infer<typeof portableKvmPlacement>;

const placements = z.tuple([endpoint, endpoint]).refine(([a, b]) => a.hostId !== b.hostId);

export function resolvePortableKvmPilotPlacement(ownerId: string, agent: Record<string, unknown>) {
  if (process.env.HIVRA_KVM_PORTABLE_QA_ENABLED !== "true" || !isCanonicalGitCanaryDeployment()
    || ownerId !== process.env.HIVRA_KVM_PORTABLE_QA_OWNER_ID || ownerId !== agent.user_id
    || !z.string().uuid().safeParse(agent.id).success || agent.id !== process.env.HIVRA_KVM_PORTABLE_QA_AGENT_ID) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(process.env.HIVRA_KVM_PORTABLE_QA_PLACEMENTS ?? "");
  } catch {
    throw new Error("Portable KVM pilot placement configuration is missing or invalid");
  }
  const pair = placements.safeParse(raw);
  if (!pair.success || agent.infrastructure_binding_token_enforced !== true
    || !isHivraInfrastructureBindingTokenHash(agent.infrastructure_binding_token_hash)) {
    throw new Error("Portable KVM pilot placement or infrastructure binding is invalid");
  }
  const index = pair.data.findIndex(target => target.hostId === agent.proxmox_host
    && target.vmid === agent.vmid && target.ip === agent.ip);
  if (index < 0) throw new Error("Portable KVM pilot is not on an exact configured placement");
  const bindingTag = hivraInfrastructureBindingTag(agent.infrastructure_binding_token_hash);
  return { current: { ...pair.data[index], bindingTag }, alternate: { ...pair.data[1 - index], bindingTag } };
}

export function isPortableKvmWakeClaimed(agent: Record<string, unknown>): boolean {
  if (agent.operation_kind !== "wake" || !agent.operation_id || typeof agent.operation_payload !== "object"
    || !agent.operation_payload) return false;
  return "portable_kvm" in agent.operation_payload && agent.operation_payload.portable_kvm === true;
}

export function isPortableKvmReadyToCheckpoint(agent: Record<string, unknown>): boolean {
  const cooled = typeof agent.sleep_memory_dropped_at === "string" ? Date.parse(agent.sleep_memory_dropped_at) : NaN;
  const hibernated = typeof agent.sleep_tier_changed_at === "string" ? Date.parse(agent.sleep_tier_changed_at) : NaN;
  return agent.deployment_mode === "hivra-managed" && agent.computer_substrate === "proxmox-kvm"
    && agent.seat_funding === "paid" && agent.computer_profile !== "windows" && agent.type !== "windows"
    && agent.status === "running" && agent.desired_state === "running"
    && agent.sleep_policy === "full" && agent.always_on === false && agent.sleep_state === "hibernated"
    && agent.operation_id == null && agent.sleep_stored_at == null && Number.isSafeInteger(agent.sleep_generation)
    && Number(agent.sleep_generation) >= 0 && cooled >= hibernated;
}
