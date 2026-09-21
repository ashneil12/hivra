import "server-only";

import { randomUUID } from "node:crypto";

import { recordHivraAgentOperationFailure } from "@/lib/hivra/agent-operation-store";
import { inspectRemoteDesktopCapability } from "@/lib/remote-computers/capability-inspection";
import {
  beginDesktopPrepare,
  cancelUndispatchedDesktopPrepare,
  completeDesktopPrepare,
  desktopPrepareAuthority,
  DESKTOP_PREPARE_KIND,
  DESKTOP_PREPARE_PENDING,
  dispatchDesktopPrepare,
  type DesktopPrepareReceipt,
} from "@/lib/remote-computers/desktop-prepare-operation";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import {
  prepareOmarchyNativeGuardian,
  type OmarchyNativePreparationRequest,
} from "@/lib/remote-computers/omarchy-native-preparation-host";
import { supabaseAdmin } from "@/lib/supabase";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const AGENT_FIELDS = [
  "id", "user_id", "type", "computer_profile", "status", "desired_state", "operation_id", "operation_kind",
  "vmid", "ip", "chat_url", "computer_substrate", "provider_capacity_order_id",
  "provider_enrollment_attempt_id", "provider_server_id", "deployment_mode", "proxmox_host",
  "infrastructure_connection_id", "deployment_target_id", "infrastructure_connection_revision",
  "infrastructure_binding_token_hash", "infrastructure_binding_token_enforced", "managed_provisioner_channel",
].join(",");

type Dependencies = {
  loadAgent: (agentId: string) => Promise<RemoteDesktopAgentRow | null>;
  beginPrepare: typeof beginDesktopPrepare;
  dispatchPrepare: typeof dispatchDesktopPrepare;
  cancelPrepare: typeof cancelUndispatchedDesktopPrepare;
  prepareGuest: typeof prepareOmarchyNativeGuardian;
  inspectCapability: typeof inspectRemoteDesktopCapability;
  completePrepare: typeof completeDesktopPrepare;
  retainPrepare: typeof recordHivraAgentOperationFailure;
};

export type OmarchyNativePreparationResult = {
  ok: boolean;
  agentId: string;
  targetId: string | null;
  vmid: number | null;
  changed?: boolean;
  accessReady?: false;
  nativeDescriptor?: NonNullable<Awaited<ReturnType<typeof inspectRemoteDesktopCapability>>["nativeDescriptor"]>;
  code?: "computer_not_ready" | "desktop_prepare_pending" | "desktop_prepare_failed";
  error?: string;
};

async function loadAgent(agentId: string): Promise<RemoteDesktopAgentRow | null> {
  if (!supabaseAdmin) throw new Error("Omarchy preparation database is unavailable.");
  const { data, error } = await supabaseAdmin.from("hivra_agents").select(AGENT_FIELDS)
    .eq("id", agentId).maybeSingle();
  if (error) throw new Error("Omarchy preparation lookup failed.");
  return (data as RemoteDesktopAgentRow | null) ?? null;
}

const DEFAULT_DEPENDENCIES: Dependencies = {
  loadAgent,
  beginPrepare: beginDesktopPrepare,
  dispatchPrepare: dispatchDesktopPrepare,
  cancelPrepare: cancelUndispatchedDesktopPrepare,
  prepareGuest: prepareOmarchyNativeGuardian,
  inspectCapability: inspectRemoteDesktopCapability,
  completePrepare: completeDesktopPrepare,
  retainPrepare: recordHivraAgentOperationFailure,
};

function privateIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some(part => part > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function sameAuthority(left: RemoteDesktopAgentRow, right: RemoteDesktopAgentRow): boolean {
  return JSON.stringify(desktopPrepareAuthority(left)) === JSON.stringify(desktopPrepareAuthority(right));
}

function validTarget(agent: RemoteDesktopAgentRow): { vmid: number; guestIp: string } | null {
  const vmid = Number(agent.vmid);
  const guestIp = typeof agent.ip === "string" ? agent.ip.trim() : "";
  const resuming = agent.operation_kind === DESKTOP_PREPARE_KIND
    && typeof agent.operation_id === "string" && UUID.test(agent.operation_id);
  return agent.type === "linux-desktop" && agent.computer_profile === "omarchy"
    && agent.computer_substrate === "proxmox-kvm" && agent.status === "running"
    && (resuming || agent.desired_state === "running")
    && (resuming || (agent.operation_id == null && agent.operation_kind == null))
    && Number.isSafeInteger(vmid) && vmid >= 100 && privateIpv4(guestIp)
    && agent.infrastructure_binding_token_enforced === true
    && typeof agent.infrastructure_binding_token_hash === "string"
    && /^[a-f0-9]{64}$/.test(agent.infrastructure_binding_token_hash)
    ? { vmid, guestIp } : null;
}

export async function prepareOmarchyNativeOnHivraAgent(
  agentId: string,
  dependencies: Partial<Dependencies> = {},
): Promise<OmarchyNativePreparationResult> {
  if (!UUID.test(agentId)) return { ok: false, agentId, targetId: null, vmid: null, code: "computer_not_ready", error: "Computer id is invalid." };
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const agent = await deps.loadAgent(agentId);
  if (!agent) return { ok: false, agentId, targetId: null, vmid: null, code: "computer_not_ready", error: "Computer not found." };
  const target = validTarget(agent);
  if (!target) return { ok: false, agentId, targetId: null, vmid: Number.isSafeInteger(Number(agent.vmid)) ? Number(agent.vmid) : null,
    code: "computer_not_ready", error: "Computer is not in an identity-bound Omarchy preparation state." };

  let claim;
  try { claim = await deps.beginPrepare(agent, randomUUID()); }
  catch {
    return { ok: false, agentId, targetId: null, vmid: target.vmid, code: "desktop_prepare_pending",
      error: "Omarchy preparation authority could not be confirmed. Inspect the existing operation before retrying." };
  }
  if (!claim) return { ok: false, agentId, targetId: null, vmid: target.vmid, code: "computer_not_ready",
    error: "Computer changed before Omarchy preparation could begin." };

  let targetId: string | null = null;
  let dispatched = claim.phase === "dispatched";
  let completed = false;
  const pending = async (reason?: string): Promise<OmarchyNativePreparationResult> => {
    const error = DESKTOP_PREPARE_PENDING + (reason ? ` (${reason})` : "");
    await deps.retainPrepare({ userId: agent.user_id, agentId, operationId: claim.operationId, error }).catch(() => false);
    return { ok: false, agentId, targetId, vmid: target.vmid, code: "desktop_prepare_pending", error };
  };

  try {
    if (claim.resumed && !dispatched) {
      if (!await deps.cancelPrepare(agent.user_id, claim.operationId)) return pending();
      return { ok: false, agentId, targetId, vmid: target.vmid, code: "computer_not_ready",
        error: "The previous preparation stopped before guest dispatch. Prepare again when the computer is idle." };
    }

    let operationAgent = await deps.loadAgent(agentId);
    if (!operationAgent || !sameAuthority(agent, operationAgent)
      || operationAgent.operation_id !== claim.operationId || operationAgent.operation_kind !== DESKTOP_PREPARE_KIND) {
      if (!dispatched && await deps.cancelPrepare(agent.user_id, claim.operationId)) {
        return { ok: false, agentId, targetId, vmid: target.vmid, code: "computer_not_ready", error: "Computer changed before guest dispatch." };
      }
      return pending("authority_changed");
    }

    if (!claim.resumed) {
      if (!await deps.dispatchPrepare(agent.user_id, claim.operationId)) {
        if (!await deps.cancelPrepare(agent.user_id, claim.operationId)) return pending();
        return { ok: false, agentId, targetId, vmid: target.vmid, code: "computer_not_ready", error: "Computer changed before guest dispatch." };
      }
      dispatched = true;
    }

    // A dispatched operation may be resumed after the original request timed
    // out or the guest was repaired between attempts. Re-run the idempotent
    // convergence installer before inspection; skipping it leaves the stale
    // operation permanently unable to clear its capability mismatch.
    const request: OmarchyNativePreparationRequest = {
      computerId: agent.id,
      operationId: claim.operationId,
      vmid: target.vmid,
      guestPrivateIpv4: target.guestIp,
    };
    const prepared = await deps.prepareGuest(agent.user_id, operationAgent, request);
    if (!prepared.ok) return pending(`guest_${prepared.code}${prepared.reason ? `_${prepared.reason}` : ""}`);
    targetId = prepared.targetId;
    if (prepared.binding.operationId !== claim.operationId) return pending("guest_binding_mismatch");

    operationAgent = await deps.loadAgent(agentId);
    if (!operationAgent || !sameAuthority(agent, operationAgent)
      || operationAgent.operation_id !== claim.operationId || operationAgent.operation_kind !== DESKTOP_PREPARE_KIND) {
      return pending("authority_changed");
    }
    const capability = await deps.inspectCapability(agentId, {
      loadAgent: async candidateId => candidateId === agentId ? operationAgent : null,
    }, { preparationOperationId: claim.operationId });
    targetId = capability.targetId ?? targetId;
    const descriptor = capability.nativeDescriptor;
    if (!capability.ok || !descriptor || descriptor.protocol !== "hivra-omarchy-native-prepared-v2"
      || descriptor.preparationOperationId !== claim.operationId || descriptor.computerId !== agent.id
      || descriptor.vmid !== target.vmid || descriptor.guestPrivateIpv4 !== target.guestIp
      || descriptor.privateNetworkReachable !== true || descriptor.supportsInputTakeover !== true) {
      return pending("capability_unverified");
    }
    const receipt: DesktopPrepareReceipt = {
      version: 1,
      operationId: claim.operationId,
      computerId: agent.id,
      vmid: target.vmid,
      guestIp: target.guestIp,
      bindingTag: `hivra-bind-${String(agent.infrastructure_binding_token_hash).slice(0, 32)}`,
      bootId: descriptor.guestBootId,
      exitCode: 0,
    };
    if (!await deps.completePrepare(agent.user_id, receipt)) return pending("completion_unconfirmed");
    completed = true;
    const finalAgent = await deps.loadAgent(agentId);
    if (!finalAgent || !sameAuthority(agent, finalAgent) || finalAgent.status !== "running"
      || finalAgent.desired_state !== "running" || finalAgent.operation_id != null || finalAgent.operation_kind != null) {
      return { ok: false, agentId, targetId, vmid: target.vmid, code: "computer_not_ready",
        error: "Omarchy preparation finished, but the current computer state could not be confirmed." };
    }
    return { ok: true, agentId, targetId, vmid: target.vmid, changed: !claim.resumed,
      accessReady: false, nativeDescriptor: descriptor };
  } catch {
    if (completed) return { ok: false, agentId, targetId, vmid: target.vmid, code: "computer_not_ready",
      error: "Omarchy preparation finished, but the current computer state could not be checked." };
    if (!dispatched && await deps.cancelPrepare(agent.user_id, claim.operationId).catch(() => false)) {
      return { ok: false, agentId, targetId, vmid: target.vmid, code: "computer_not_ready", error: "Omarchy preparation stopped before guest dispatch." };
    }
    return pending();
  }
}
