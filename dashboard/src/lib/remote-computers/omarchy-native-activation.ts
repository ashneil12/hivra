import "server-only";

import { randomUUID } from "node:crypto";

import { inspectRemoteDesktopCapability } from "@/lib/remote-computers/capability-inspection";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import { buildOmarchyNativeGuardianGrant } from "@/lib/remote-computers/omarchy-native-grant";
import { executeOmarchyGuardianAction } from "@/lib/remote-computers/omarchy-native-guardian-host";
import { OMARCHY_DESKTOP_SESSION_REVISION } from "@/lib/remote-computers/omarchy-native-capability";
import {
  claimOmarchyNativeActivation,
  recordOmarchyNativeActivationGrant,
} from "@/lib/remote-computers/session-broker";
import { supabaseAdmin } from "@/lib/supabase";

const AGENT_FIELDS = [
  "id", "user_id", "type", "computer_profile", "status", "desired_state", "operation_id", "operation_kind",
  "vmid", "ip", "chat_url", "computer_substrate", "provider_capacity_order_id",
  "provider_enrollment_attempt_id", "provider_server_id", "deployment_mode", "proxmox_host",
  "infrastructure_connection_id", "deployment_target_id", "infrastructure_connection_revision",
  "infrastructure_binding_token_hash", "infrastructure_binding_token_enforced", "managed_provisioner_channel",
].join(",");

type Dependencies = {
  loadAgent: (userId: string, computerId: string) => Promise<RemoteDesktopAgentRow | null>;
  inspectCapability: typeof inspectRemoteDesktopCapability;
  claimActivation: typeof claimOmarchyNativeActivation;
  recordGrant: typeof recordOmarchyNativeActivationGrant;
  executeGuardian: typeof executeOmarchyGuardianAction;
  activationId: () => string;
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
  inspectCapability: inspectRemoteDesktopCapability,
  claimActivation: claimOmarchyNativeActivation,
  recordGrant: recordOmarchyNativeActivationGrant,
  executeGuardian: executeOmarchyGuardianAction,
  activationId: randomUUID,
  wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};

const READY_ATTEMPTS = 20;

export async function activateOmarchyNativeSession(
  userId: string,
  params: { computerId: string; sessionId: string; sessionToken: string },
  dependencies: Partial<Dependencies> = {},
): Promise<
  | { ok: true; sessionId: string; activationId: string; streamingMode: "hq" | "qhd" | "uhd" | "performance";
      desktopReady: true; pairingVerified: true; guestBootId: string; serverId: string;
      guestPrivateIpv4: string; connectionIpv4: string;
      serverCertificatePem: string; serverCertificateSha256: string }
  | { ok: false; code: "computer_not_ready" | "activation_denied" | "activation_uncertain" }
> {
  const deps = { ...DEFAULTS, ...dependencies };
  let agent: RemoteDesktopAgentRow | null;
  try { agent = await deps.loadAgent(userId, params.computerId); }
  catch { return { ok: false, code: "computer_not_ready" }; }
  if (!agent) return { ok: false, code: "computer_not_ready" };

  const inspected = await deps.inspectCapability(params.computerId, {
    loadAgent: async candidateId => candidateId === params.computerId ? agent : null,
  }, { persistReceipt: false });
  if (!inspected.ok || !inspected.nativeDescriptor || !inspected.receipt) {
    return { ok: false, code: "computer_not_ready" };
  }

  const activationId = deps.activationId();
  const claimed = await deps.claimActivation({ userId, activationId, ...params });
  if (!claimed.ok) return { ok: false, code: "activation_denied" };
  if (
    claimed.claim.computerId !== params.computerId
    || claimed.claim.observedRevision !== OMARCHY_DESKTOP_SESSION_REVISION
    || claimed.claim.capabilityGeneration !== inspected.receipt.capabilityGeneration
  ) return { ok: false, code: "activation_denied" };

  const grant = buildOmarchyNativeGuardianGrant({
    session: claimed.claim,
    descriptor: inspected.nativeDescriptor,
    leaseId: activationId,
  });
  if (!grant) return { ok: false, code: "activation_denied" };
  const recorded = await deps.recordGrant({
    userId,
    sessionId: claimed.claim.sessionId,
    activationId,
    guardianGrant: grant,
  });
  if (!recorded.ok) return { ok: false, code: "activation_denied" };

  try { agent = await deps.loadAgent(userId, params.computerId); }
  catch { return { ok: false, code: "activation_uncertain" }; }
  if (!agent) return { ok: false, code: "activation_uncertain" };
  const activated = await deps.executeGuardian(userId, "activate", grant, agent);
  if (!activated.ok) return { ok: false, code: "activation_uncertain" };
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    const observed = await deps.executeGuardian(userId, "observe-ready", grant, agent);
    if (observed.ok && observed.action === "observe-ready" && "serverId" in observed.result) {
      return {
        ok: true,
        sessionId: claimed.claim.sessionId,
        activationId,
        streamingMode: claimed.claim.streamingMode,
        desktopReady: true,
        pairingVerified: true,
        guestBootId: observed.result.guestBootId,
        serverId: observed.result.serverId,
        guestPrivateIpv4: observed.result.guestPrivateIpv4,
        connectionIpv4: inspected.nativeDescriptor.route.publicIpv4,
        serverCertificatePem: observed.result.serverCertificatePem,
        serverCertificateSha256: observed.result.serverCertificateSha256,
      };
    }
    if (attempt + 1 < READY_ATTEMPTS) await deps.wait(250);
  }
  return { ok: false, code: "activation_uncertain" };
}
