import "server-only";

import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import {
  executeOmarchyGuardianRenewalAction,
  OmarchyGuardianGrant,
  OmarchyGuardianRenewal,
} from "@/lib/remote-computers/omarchy-native-guardian-host";
import {
  claimOmarchyNativeRenewal,
  loadOmarchyNativeActivationGrant,
  recordOmarchyNativeRenewal,
  refreshOmarchyNativeCapability,
} from "@/lib/remote-computers/session-broker";
import { supabaseAdmin } from "@/lib/supabase";
import { REMOTE_DESKTOP_CAPABILITY_TTL_MS } from "@/lib/remote-computers/capability-inspection";

const AGENT_FIELDS = [
  "id", "user_id", "type", "computer_profile", "status", "desired_state", "operation_id", "operation_kind",
  "vmid", "ip", "chat_url", "computer_substrate", "provider_capacity_order_id",
  "provider_enrollment_attempt_id", "provider_server_id", "deployment_mode", "proxmox_host",
  "infrastructure_connection_id", "deployment_target_id", "infrastructure_connection_revision",
  "infrastructure_binding_token_hash", "infrastructure_binding_token_enforced", "managed_provisioner_channel",
].join(",");

type Dependencies = {
  loadAgent: (userId: string, computerId: string) => Promise<RemoteDesktopAgentRow | null>;
  loadGrant: typeof loadOmarchyNativeActivationGrant;
  claimRenewal: typeof claimOmarchyNativeRenewal;
  recordRenewal: typeof recordOmarchyNativeRenewal;
  refreshCapability: typeof refreshOmarchyNativeCapability;
  executeRenewal: typeof executeOmarchyGuardianRenewalAction;
  now: () => Date;
  wait: (milliseconds: number) => Promise<void>;
};

async function loadAgent(userId: string, computerId: string): Promise<RemoteDesktopAgentRow | null> {
  if (!supabaseAdmin) throw new Error("Native desktop database is unavailable.");
  const { data, error } = await supabaseAdmin.from("hivra_agents").select(AGENT_FIELDS)
    .eq("id", computerId).eq("user_id", userId).maybeSingle();
  if (error) throw new Error("Native desktop lookup failed.");
  return data as unknown as RemoteDesktopAgentRow | null;
}

const DEFAULTS: Dependencies = {
  loadAgent,
  loadGrant: loadOmarchyNativeActivationGrant,
  claimRenewal: claimOmarchyNativeRenewal,
  recordRenewal: recordOmarchyNativeRenewal,
  refreshCapability: refreshOmarchyNativeCapability,
  executeRenewal: executeOmarchyGuardianRenewalAction,
  now: () => new Date(),
  wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};

const OBSERVE_ATTEMPTS = 20;

export function buildOmarchyGuardianRenewal(params: {
  grant: OmarchyGuardianGrant;
  renewalId: string;
  renewalCount: number;
  expiresAt: string;
}): OmarchyGuardianRenewal | null {
  const expiresAtUnixMs = Date.parse(params.expiresAt);
  if (!Number.isFinite(expiresAtUnixMs) || expiresAtUnixMs <= params.grant.expiresAtUnixMs) return null;
  const extensionNs = BigInt(Math.floor(expiresAtUnixMs - params.grant.expiresAtUnixMs)) * 1_000_000n;
  const deadlineBoottimeNs = Number(BigInt(params.grant.deadlineBoottimeNs) + extensionNs);
  const parsed = OmarchyGuardianRenewal.safeParse({
    protocol: "hivra-omarchy-guardian-renewal-v1",
    sessionId: params.grant.sessionId,
    leaseId: params.grant.leaseId,
    capabilityGeneration: params.grant.capabilityGeneration,
    guestBootId: params.grant.guestBootId,
    renewalId: params.renewalId,
    renewalCount: params.renewalCount,
    deadlineBoottimeNs,
    continuousDeadlineBoottimeNs: params.grant.continuousDeadlineBoottimeNs,
  });
  if (!parsed.success || deadlineBoottimeNs <= params.grant.deadlineBoottimeNs
    || deadlineBoottimeNs > params.grant.continuousDeadlineBoottimeNs) return null;
  return parsed.data;
}

/** Renew one exact active Sunshine guardian without replacing its process. */
export async function renewOmarchyNativeSession(
  userId: string,
  params: { computerId: string; sessionId: string; activationId: string; renewalId: string },
  dependencies: Partial<Dependencies> = {},
): Promise<
  | { ok: true; sessionId: string; activationId: string; renewalId: string;
      renewalCount: number; expiresAt: string; continuousExpiresAt: string; desktopReady: true }
  | { ok: false; code: "renewal_denied" | "renewal_uncertain" }
> {
  const deps = { ...DEFAULTS, ...dependencies };
  const stored = await deps.loadGrant({ userId, sessionId: params.sessionId, activationId: params.activationId });
  if (!stored.ok) return { ok: false, code: "renewal_denied" };
  const parsedGrant = OmarchyGuardianGrant.safeParse(stored.guardianGrant);
  if (!parsedGrant.success || parsedGrant.data.ownerId !== userId
    || parsedGrant.data.binding.computerId !== params.computerId
    || parsedGrant.data.sessionId !== params.sessionId || parsedGrant.data.leaseId !== params.activationId) {
    return { ok: false, code: "renewal_denied" };
  }
  const grant = parsedGrant.data;
  let agent: RemoteDesktopAgentRow | null;
  try { agent = await deps.loadAgent(userId, params.computerId); }
  catch { return { ok: false, code: "renewal_uncertain" }; }
  if (!agent) return { ok: false, code: "renewal_uncertain" };
  const claimed = await deps.claimRenewal({ userId, ...params, ttlMs: 240_000 });
  if (!claimed.ok) return { ok: false, code: "renewal_denied" };
  let renewal: OmarchyGuardianRenewal;
  if (claimed.renewal.guardianRenewal) {
    const parsed = OmarchyGuardianRenewal.safeParse(claimed.renewal.guardianRenewal);
    if (!parsed.success) return { ok: false, code: "renewal_denied" };
    renewal = parsed.data;
  } else {
    const built = buildOmarchyGuardianRenewal({
      grant, renewalId: params.renewalId, renewalCount: claimed.renewal.renewalCount,
      expiresAt: claimed.renewal.expiresAt,
    });
    if (!built) return { ok: false, code: "renewal_denied" };
    const recorded = await deps.recordRenewal({
      userId, sessionId: params.sessionId, activationId: params.activationId,
      renewalId: params.renewalId, guardianRenewal: built,
    });
    if (!recorded.ok) return { ok: false, code: "renewal_denied" };
    renewal = built;
  }
  const accepted = await deps.executeRenewal(userId, "renew", grant, renewal, agent);
  if (!accepted.ok) return { ok: false, code: "renewal_uncertain" };
  for (let attempt = 0; attempt < OBSERVE_ATTEMPTS; attempt += 1) {
    const observed = await deps.executeRenewal(userId, "observe-renew", grant, renewal, agent);
    if (observed.ok && observed.action === "observe-renew" && "renewal" in observed.result
      && observed.result.renewal === "applied") {
      const observedAt = deps.now();
      const refreshed = await deps.refreshCapability({
        userId, computerId: params.computerId, capabilityGeneration: grant.capabilityGeneration,
        observedRevision: grant.observedRevision, observedAt: observedAt.toISOString(),
        expiresAt: new Date(observedAt.getTime() + REMOTE_DESKTOP_CAPABILITY_TTL_MS).toISOString(),
      });
      if (!refreshed.ok) return { ok: false, code: "renewal_uncertain" };
      return { ok: true, sessionId: params.sessionId, activationId: params.activationId,
        renewalId: params.renewalId, renewalCount: claimed.renewal.renewalCount,
        expiresAt: claimed.renewal.expiresAt,
        continuousExpiresAt: claimed.renewal.continuousExpiresAt, desktopReady: true };
    }
    if (attempt + 1 < OBSERVE_ATTEMPTS) await deps.wait(250);
  }
  return { ok: false, code: "renewal_uncertain" };
}
