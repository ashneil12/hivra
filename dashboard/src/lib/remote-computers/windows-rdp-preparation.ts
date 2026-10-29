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
  prepareWindowsRdpGuest,
  type WindowsRdpPreparationRequest,
} from "@/lib/remote-computers/windows-rdp-preparation-host";
import { gatewaySourceCidrForWindowsComputer } from "@/lib/remote-computers/windows-rdp-gateway";
import { REMOTE_DESKTOP_AGENT_FIELDS } from "@/lib/remote-computers/agent-row";
import { supabaseAdmin } from "@/lib/supabase";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Dependencies = {
  loadAgent: (agentId: string) => Promise<RemoteDesktopAgentRow | null>;
  beginPrepare: typeof beginDesktopPrepare;
  dispatchPrepare: typeof dispatchDesktopPrepare;
  cancelPrepare: typeof cancelUndispatchedDesktopPrepare;
  prepareGuest: typeof prepareWindowsRdpGuest;
  inspectCapability: typeof inspectRemoteDesktopCapability;
  completePrepare: typeof completeDesktopPrepare;
  retainPrepare: typeof recordHivraAgentOperationFailure;
  gatewaySourceCidr: typeof gatewaySourceCidrForWindowsComputer;
  recordCertificatePin: typeof recordWindowsRdpCertificatePin;
};

export type WindowsRdpPreparationResult = {
  ok: boolean;
  agentId: string;
  targetId: string | null;
  vmid: number | null;
  changed?: boolean;
  accessReady?: false;
  windowsDescriptor?: NonNullable<Awaited<ReturnType<typeof inspectRemoteDesktopCapability>>["windowsDescriptor"]>;
  code?: "computer_not_ready" | "desktop_prepare_pending" | "desktop_prepare_failed";
  error?: string;
};

async function loadAgent(agentId: string): Promise<RemoteDesktopAgentRow | null> {
  if (!supabaseAdmin) throw new Error("Windows preparation database is unavailable.");
  const { data, error } = await supabaseAdmin.from("hivra_agents").select(REMOTE_DESKTOP_AGENT_FIELDS)
    .eq("id", agentId).maybeSingle();
  if (error) throw new Error("Windows preparation lookup failed.");
  return (data as RemoteDesktopAgentRow | null) ?? null;
}

const CERTIFICATE_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;

/**
 * Store the RDP certificate this preparation read from the guest as the one
 * the computer's sessions pin. Windows renews its self-signed certificate on
 * its own; without this a renewed certificate could never match again. The
 * write is fenced by this preparation's own operation lease, so it lands
 * only while that preparation still owns the computer.
 */
async function recordWindowsRdpCertificatePin(input: {
  userId: string; agentId: string; operationId: string; fingerprint: string;
}): Promise<boolean> {
  if (!supabaseAdmin || !CERTIFICATE_FINGERPRINT.test(input.fingerprint)) return false;
  const { data, error } = await supabaseAdmin.from("hivra_agents")
    .update({ windows_rdp_certificate_fingerprint: input.fingerprint, windows_rdp_certificate_observed_at: new Date().toISOString() })
    .eq("id", input.agentId).eq("user_id", input.userId).eq("computer_profile", "windows")
    .eq("operation_id", input.operationId).eq("operation_kind", DESKTOP_PREPARE_KIND)
    .select("id");
  return !error && Array.isArray(data) && data.length === 1;
}

const DEFAULT_DEPENDENCIES: Dependencies = {
  loadAgent,
  beginPrepare: beginDesktopPrepare,
  dispatchPrepare: dispatchDesktopPrepare,
  cancelPrepare: cancelUndispatchedDesktopPrepare,
  prepareGuest: prepareWindowsRdpGuest,
  inspectCapability: inspectRemoteDesktopCapability,
  completePrepare: completeDesktopPrepare,
  retainPrepare: recordHivraAgentOperationFailure,
  gatewaySourceCidr: gatewaySourceCidrForWindowsComputer,
  recordCertificatePin: recordWindowsRdpCertificatePin,
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

function validTarget(agent: RemoteDesktopAgentRow, gatewayCidr: string | null): { vmid: number; guestIp: string; gatewayCidr: string } | null {
  const vmid = Number(agent.vmid);
  const guestIp = typeof agent.ip === "string" ? agent.ip.trim() : "";
  const resuming = agent.operation_kind === DESKTOP_PREPARE_KIND
    && typeof agent.operation_id === "string" && UUID.test(agent.operation_id);
  return agent.type === "linux-desktop" && agent.computer_profile === "windows"
    && agent.computer_substrate === "proxmox-kvm" && agent.status === "running"
    && (resuming || agent.desired_state === "running")
    && (resuming || (agent.operation_id == null && agent.operation_kind == null))
    && Number.isSafeInteger(vmid) && vmid >= 100 && privateIpv4(guestIp)
    && typeof gatewayCidr === "string"
    && agent.infrastructure_binding_token_enforced === true
    && typeof agent.infrastructure_binding_token_hash === "string"
    && /^[a-f0-9]{64}$/.test(agent.infrastructure_binding_token_hash)
    ? { vmid, guestIp, gatewayCidr } : null;
}

export async function prepareWindowsRdpOnHivraAgent(
  agentId: string,
  dependencies: Partial<Dependencies> = {},
): Promise<WindowsRdpPreparationResult> {
  if (!UUID.test(agentId)) return { ok: false, agentId, targetId: null, vmid: null, code: "computer_not_ready", error: "Computer id is invalid." };
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const agent = await deps.loadAgent(agentId);
  if (!agent) return { ok: false, agentId, targetId: null, vmid: null, code: "computer_not_ready", error: "Computer not found." };
  const target = validTarget(agent, deps.gatewaySourceCidr({ computerId: agent.id, guestPrivateIpv4: String(agent.ip ?? "").trim() }));
  if (!target) return { ok: false, agentId, targetId: null, vmid: Number.isSafeInteger(Number(agent.vmid)) ? Number(agent.vmid) : null,
    code: "computer_not_ready", error: "Computer is not in an identity-bound Windows preparation state." };

  let claim;
  try { claim = await deps.beginPrepare(agent, randomUUID()); }
  catch {
    return { ok: false, agentId, targetId: null, vmid: target.vmid, code: "desktop_prepare_pending",
      error: "Windows preparation authority could not be confirmed. Inspect the existing operation before retrying." };
  }
  if (!claim) return { ok: false, agentId, targetId: null, vmid: target.vmid, code: "computer_not_ready",
    error: "Computer changed before Windows preparation could begin." };

  let targetId: string | null = null;
  let dispatched = claim.phase === "dispatched";
  let completed = false;
  let changed = false;
  const pending = async (reason?: string): Promise<WindowsRdpPreparationResult> => {
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
      const request: WindowsRdpPreparationRequest = {
        computerId: agent.id,
        operationId: claim.operationId,
        vmid: target.vmid,
        guestPrivateIpv4: target.guestIp,
        gatewaySourceCidrs: [target.gatewayCidr],
      };
      const prepared = await deps.prepareGuest(agent.user_id, operationAgent, request);
      if (!prepared.ok) return pending(`guest_${prepared.code}`);
      targetId = prepared.targetId;
      changed = prepared.changed;
    }

    operationAgent = await deps.loadAgent(agentId);
    if (!operationAgent || !sameAuthority(agent, operationAgent)
      || operationAgent.operation_id !== claim.operationId || operationAgent.operation_kind !== DESKTOP_PREPARE_KIND) {
      return pending("authority_changed");
    }
    const capability = await deps.inspectCapability(agentId, {
      loadAgent: async candidateId => candidateId === agentId ? operationAgent : null,
    }, { preparationOperationId: claim.operationId });
    targetId = capability.targetId ?? targetId;
    const descriptor = capability.windowsDescriptor;
    if (!capability.ok || !descriptor || descriptor.protocol !== "hivra-windows-rdp-prepared-v1"
      || descriptor.computerId !== agent.id || descriptor.vmid !== target.vmid
      || descriptor.guestPrivateIpv4 !== target.guestIp
      || descriptor.privateNetworkReachable !== false
      || JSON.stringify(descriptor.route.sourceCidrs) !== JSON.stringify([target.gatewayCidr])) {
      return pending("capability_unverified");
    }
    if (!await deps.recordCertificatePin({ userId: agent.user_id, agentId, operationId: claim.operationId,
      fingerprint: descriptor.certificateFingerprint })) {
      return pending("certificate_pin_unconfirmed");
    }
    const receipt: DesktopPrepareReceipt = {
      version: 1,
      operationId: claim.operationId,
      computerId: agent.id,
      vmid: target.vmid,
      guestIp: target.guestIp,
      bindingTag: `hivra-bind-${String(agent.infrastructure_binding_token_hash).slice(0, 32)}`,
      bootId: descriptor.bootIdentitySha256,
      exitCode: 0,
    };
    if (!await deps.completePrepare(agent.user_id, receipt)) return pending("completion_unconfirmed");
    completed = true;
    const finalAgent = await deps.loadAgent(agentId);
    if (!finalAgent || !sameAuthority(agent, finalAgent) || finalAgent.status !== "running"
      || finalAgent.desired_state !== "running" || finalAgent.operation_id != null || finalAgent.operation_kind != null) {
      return { ok: false, agentId, targetId, vmid: target.vmid, code: "computer_not_ready",
        error: "Windows preparation finished, but the current computer state could not be confirmed." };
    }
    return { ok: true, agentId, targetId, vmid: target.vmid, changed,
      accessReady: false, windowsDescriptor: descriptor };
  } catch {
    if (completed) return { ok: false, agentId, targetId, vmid: target.vmid, code: "computer_not_ready",
      error: "Windows preparation finished, but the current computer state could not be checked." };
    if (!dispatched && await deps.cancelPrepare(agent.user_id, claim.operationId).catch(() => false)) {
      return { ok: false, agentId, targetId, vmid: target.vmid, code: "computer_not_ready", error: "Windows preparation stopped before guest dispatch." };
    }
    return pending();
  }
}
