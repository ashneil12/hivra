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

const uuid = z.string().uuid();
const pilotSchema = z.object({
  ownerId: z.string().regex(/^user_[A-Za-z0-9]+$/),
  agentId: uuid,
  placements: z.tuple([portableKvmPlacement, portableKvmPlacement]).refine(([a, b]) =>
    a.hostId !== b.hostId && a.ip === b.ip && a.bindingTag === b.bindingTag),
  profile: z.record(z.string(), z.unknown()),
  expiresAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
}).strict();

export type PortableKvmPilot = z.infer<typeof pilotSchema>;

export async function readPortableKvmPilot(
  rpc: (name: string, params: Record<string, unknown>) => Promise<unknown>,
  { ownerId, agentId }: { ownerId?: string; agentId?: unknown } = {},
): Promise<PortableKvmPilot | null> {
  if (!isCanonicalGitCanaryDeployment() || (agentId !== undefined && !uuid.safeParse(agentId).success)) return null;
  const raw = await rpc("read_hivra_kvm_portable_pilot", { p_owner_id: ownerId ?? null, p_agent_id: agentId ?? null });
  if (raw == null) return null;
  const pilot = pilotSchema.safeParse(raw);
  if (!pilot.success || (ownerId !== undefined && pilot.data.ownerId !== ownerId)
    || (agentId !== undefined && pilot.data.agentId !== agentId)) throw new Error("Invalid portable KVM runtime pilot");
  return Date.parse(pilot.data.expiresAt) > Date.now() ? pilot.data : null;
}

export function resolvePortableKvmPilotPlacement(ownerId: string, agent: Record<string, unknown>, pilot: PortableKvmPilot | null) {
  if (!pilot || !isCanonicalGitCanaryDeployment() || !(Date.parse(pilot.expiresAt) > Date.now())
    || ownerId !== pilot.ownerId || ownerId !== agent.user_id || agent.id !== pilot.agentId) return null;
  if (agent.infrastructure_binding_token_enforced !== true
    || !isHivraInfrastructureBindingTokenHash(agent.infrastructure_binding_token_hash)) {
    throw new Error("Portable KVM pilot placement or infrastructure binding is invalid");
  }
  const index = pilot.placements.findIndex(target => target.hostId === agent.proxmox_host
    && target.vmid === agent.vmid && target.ip === agent.ip);
  if (index < 0) throw new Error("Portable KVM pilot is not on an exact configured placement");
  const bindingTag = hivraInfrastructureBindingTag(agent.infrastructure_binding_token_hash);
  if (pilot.placements.some(target => target.bindingTag !== bindingTag)) {
    throw new Error("Portable KVM pilot binding has changed");
  }
  return { current: pilot.placements[index], alternate: pilot.placements[1 - index] };
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
