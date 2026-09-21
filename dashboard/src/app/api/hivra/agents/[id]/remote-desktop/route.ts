export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { z } from "zod";

import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  readBoundedJson,
} from "@/app/api/infrastructure/connections/request-security";
import { remoteDesktopResponse } from "@/app/api/remote-desktop/session-response";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { managedHivraProvisionerChannelForServerEnvironment } from "@/lib/hivra/managed-provisioner-channel";
import { log } from "@/lib/logger";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { inspectRemoteDesktopCapability } from "@/lib/remote-computers/capability-inspection";
import {
  installRemoteDesktopOnHivraAgent,
  type RemoteDesktopAgentRow,
} from "@/lib/remote-computers/guest-installation";
import { prepareOmarchyNativeOnHivraAgent } from "@/lib/remote-computers/omarchy-native-preparation";
import {
  resolveRemoteDesktopInspectionRuntime,
  resolveRemoteDesktopProfileRuntime,
} from "@/lib/remote-computers/profile-runtime";
import { prepareWindowsRdpOnHivraAgent } from "@/lib/remote-computers/windows-rdp-preparation";
import { supabaseAdmin } from "@/lib/supabase";

const BODY_LIMIT = 1_024;
const requestSchema = z.object({ action: z.enum(["refresh", "prepare"]) }).strict();

const AGENT_FIELDS = [
  "id", "user_id", "type", "computer_profile", "status", "desired_state", "operation_id", "operation_kind",
  "vmid", "ip", "chat_url", "computer_substrate", "provider_capacity_order_id",
  "provider_enrollment_attempt_id", "provider_server_id", "deployment_mode",
  "proxmox_host", "infrastructure_connection_id", "deployment_target_id",
  "infrastructure_connection_revision", "infrastructure_binding_token_hash",
  "infrastructure_binding_token_enforced",
  "managed_provisioner_channel",
].join(",");

function controlOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim() ?? "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && parsed.origin === raw ? raw : null;
  } catch {
    return null;
  }
}

function response(body: unknown, status: number) {
  return remoteDesktopResponse(body, status);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return response({ success: false, error: "Unauthorized" }, 401);
  if (!isHivraApiAllowed(request.headers.get("host"))) {
    return response({ success: false, error: "Not found" }, 404);
  }
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) {
    return response({ success: false, error: "Request denied" }, 403);
  }
  if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) {
    return response({ success: false, error: "JSON required" }, 415);
  }
  const body = await readBoundedJson(request, BODY_LIMIT, 5_000);
  if (!body.ok) {
    const status = body.reason === "too_large" ? 413 : body.reason === "timeout" ? 408 : 400;
    return response({ success: false, error: "Invalid request" }, status);
  }
  const parsedRequest = requestSchema.safeParse(body.body);
  if (!parsedRequest.success) {
    return response({ success: false, error: "Invalid request" }, 400);
  }
  const action = parsedRequest.data.action;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return response({ success: false, error: "Computer not found" }, 404);
  }
  // Each connected desktop refreshes every two minutes. Other computers must
  // not consume this computer's proof budget; allow opening/prefetch alongside
  // the eight scheduled refreshes possible in a fifteen-minute window.
  const limited = !enforceRateLimit(`hivra_remote_desktop_${action}:${userId}:${getIP(request)}:${id}`, {
    limit: action === "refresh" ? 12 : 3,
    windowMs: 15 * 60_000,
  }).success;
  if (limited) {
    return response({
      success: false,
      error: action === "refresh"
        ? "Wait before checking this desktop again."
        : "Wait before opening this desktop again.",
      code: "rate_limited",
    }, 429);
  }

  if (!supabaseAdmin) {
    return response({ success: false, error: "Desktop opening is unavailable.", code: "service_unavailable" }, 503);
  }
  const { data: agent, error: lookupError } = await supabaseAdmin
    .from("hivra_agents")
    .select(AGENT_FIELDS)
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (lookupError) {
    return response({ success: false, error: "Desktop opening is unavailable.", code: "service_unavailable" }, 503);
  }
  const ownerAgent = agent as unknown as RemoteDesktopAgentRow | null;
  if (!ownerAgent) return response({ success: false, error: "Computer not found" }, 404);
  // The persisted lifecycle intent wins over an apparently running VM. Never
  // turn deletion/stopping or a foreign operation into an installer attempt.
  if (ownerAgent.desired_state !== "running") {
    return response({ success: false, code: "computer_lifecycle_blocked",
      error: ownerAgent.desired_state === "deleted"
        ? "This computer is marked for deletion. Desktop cannot reopen it or change that request."
        : "This computer is not requested to run. Start it in Manage before opening Desktop." }, 409);
  }
  const resumingDesktopPrepare = ownerAgent.operation_kind === "desktop_prepare"
    && z.string().uuid().safeParse(ownerAgent.operation_id).success;
  if ((ownerAgent.operation_id != null || ownerAgent.operation_kind != null) && !resumingDesktopPrepare) {
    return response({ success: false, code: "computer_operation_blocked",
      error: "This computer has an active operation. Check its progress in Manage before opening Desktop." }, 409);
  }
  if (ownerAgent.status !== "running") {
    return response({ success: false, code: "computer_lifecycle_blocked",
      error: "This computer is not running yet. Check its status in Manage before opening Desktop." }, 409);
  }
  const profileRuntime = resolveRemoteDesktopProfileRuntime(ownerAgent);
  const inspectionRuntime = resolveRemoteDesktopInspectionRuntime(ownerAgent);
  if (!inspectionRuntime.ok) {
    return response({
      success: false,
      error: inspectionRuntime.message,
      code: inspectionRuntime.code,
      profile: inspectionRuntime.profile,
    }, 409);
  }
  if (ownerAgent.computer_substrate === "provider-vm") {
    if (ownerAgent.type !== "linux-desktop" || ownerAgent.computer_profile !== "ubuntu-desktop" || action !== "refresh") {
      return response({ success: false, code: "provider_desktop_refresh_required",
        error: "Provider Ubuntu desktops are set up during launch. Check the existing desktop; this action cannot reinstall it." }, 409);
    }
    const inspected = await inspectRemoteDesktopCapability(id, {
      loadAgent: async candidateId => candidateId === id ? ownerAgent : null,
    });
    return inspected.ok
      ? response({ success: true, data: { prepared: true } }, 200)
      : response({ success: false, code: "provider_desktop_unverified",
        error: "Could not verify this provider desktop. The original computer is unchanged; inspect its launch or lifecycle status in Manage." }, 409);
  }
  if (ownerAgent.infrastructure_binding_token_enforced !== true) {
    return response({
      success: false,
      error: "This older computer predates Hivra's ownership-bound desktop runtime. Launch a current computer to use Desktop; its existing chat, terminal, and files are unchanged.",
      code: "legacy_identity_unbound",
    }, 409);
  }
  if (ownerAgent.computer_substrate !== "proxmox-kvm") {
    return response({
      success: false,
      error: "Desktop opening is not supported on this computer type yet.",
      code: "unsupported_computer",
    }, 409);
  }
  const origin = controlOrigin();
  if (!origin) {
    return response({ success: false, error: "Desktop opening is unavailable.", code: "service_unavailable" }, 503);
  }
  let protectedCanary: boolean;
  try {
    protectedCanary = managedHivraProvisionerChannelForServerEnvironment(process.env) === "canary";
  } catch {
    return response({ success: false, error: "Desktop opening is unavailable.", code: "service_unavailable" }, 503);
  }
  const managedControlBypassRequired = protectedCanary && ownerAgent.deployment_mode === "hivra-managed";
  if (protectedCanary && ownerAgent.deployment_mode !== "hivra-managed") {
    return response({
      success: false,
      error: "Remote Desktop from protected Canary is available only on Hivra Cloud computers.",
      code: "protected_control_unavailable",
    }, 409);
  }

  const inspected = await inspectRemoteDesktopCapability(id, {
    // Capability refresh is read-only in the guest, but it has the same owner
    // and exact-computer authority boundary as installation.
    loadAgent: async candidateId => candidateId === id ? ownerAgent : null,
  });
  const omarchyDescriptorReady = inspectionRuntime.runtime.profile !== "omarchy"
    || inspected.nativeDescriptor != null;
  const windowsDescriptorReady = inspectionRuntime.runtime.profile !== "windows"
    || inspected.windowsDescriptor != null;
  if (inspected.ok && omarchyDescriptorReady && windowsDescriptorReady
    && (inspectionRuntime.runtime.profile === "omarchy" || !(action === "prepare" && managedControlBypassRequired))) {
    return response({
      success: true,
      data: {
        prepared: true,
        ...(inspected.runtimeVersion ? { runtimeVersion: inspected.runtimeVersion, upgradeAvailable: inspected.upgradeAvailable === true } : {}),
        ...(inspectionRuntime.runtime.profile === "omarchy" ? {
          accessReady: false,
          nativeDescriptor: inspected.nativeDescriptor,
        } : {}),
        ...(inspectionRuntime.runtime.profile === "windows" ? {
          accessReady: false,
          windowsDescriptor: inspected.windowsDescriptor,
        } : {}),
      },
    }, 200);
  }
  if (inspectionRuntime.runtime.profile === "omarchy" && action === "prepare") {
    const result = await prepareOmarchyNativeOnHivraAgent(id, {
      loadAgent: async candidateId => {
        if (candidateId !== id) return null;
        const { data, error } = await supabaseAdmin!.from("hivra_agents").select(AGENT_FIELDS)
          .eq("id", id).eq("user_id", userId).maybeSingle();
        if (error) throw new Error("Owner Omarchy lookup failed.");
        return data as unknown as RemoteDesktopAgentRow | null;
      },
    });
    if (!result.ok) {
      const pending = result.code === "desktop_prepare_pending";
      const notReady = result.code === "computer_not_ready";
      log.warn("owner Omarchy preparation failed", {
        source: "hivra/agents/[id]/remote-desktop",
        failureType: pending ? "omarchy_desktop_prepare_pending" : notReady
          ? "omarchy_desktop_computer_not_ready" : "omarchy_desktop_prepare_failed",
        userId,
        agentId: id,
        targetId: result.targetId,
        vmid: result.vmid,
      });
      return response({
        success: false,
        error: pending ? result.error : notReady
          ? "Wait for this computer to finish its current operation, then try again."
          : "Hivra could not prove the dormant Omarchy desktop is ready. Inspect the existing operation before retrying.",
        code: pending ? "desktop_prepare_pending" : notReady ? "computer_not_ready" : "desktop_prepare_failed",
      }, pending || notReady ? 409 : 503);
    }
    log.info("owner Omarchy preparation complete", {
      source: "hivra/agents/[id]/remote-desktop",
      userId,
      agentId: id,
      targetId: result.targetId,
      vmid: result.vmid,
    });
    return response({ success: true, data: {
      prepared: true,
      accessReady: false,
      nativeDescriptor: result.nativeDescriptor,
    } }, 200);
  }
  if (inspectionRuntime.runtime.profile === "windows" && action === "prepare") {
    const result = await prepareWindowsRdpOnHivraAgent(id, {
      loadAgent: async candidateId => {
        if (candidateId !== id) return null;
        const { data, error } = await supabaseAdmin!.from("hivra_agents").select(AGENT_FIELDS)
          .eq("id", id).eq("user_id", userId).maybeSingle();
        if (error) throw new Error("Owner Windows lookup failed.");
        return data as unknown as RemoteDesktopAgentRow | null;
      },
    });
    if (!result.ok) {
      const pending = result.code === "desktop_prepare_pending";
      const notReady = result.code === "computer_not_ready";
      log.warn("owner Windows preparation failed", {
        source: "hivra/agents/[id]/remote-desktop",
        failureType: pending ? "windows_desktop_prepare_pending" : notReady
          ? "windows_desktop_computer_not_ready" : "windows_desktop_prepare_failed",
        userId,
        agentId: id,
        targetId: result.targetId,
        vmid: result.vmid,
      });
      return response({
        success: false,
        error: pending ? result.error : notReady
          ? "Wait for this computer to finish its current operation, then try again."
          : "Hivra could not prove Windows RDP is ready. Inspect the existing operation before retrying.",
        code: pending ? "desktop_prepare_pending" : notReady ? "computer_not_ready" : "desktop_prepare_failed",
      }, pending || notReady ? 409 : 503);
    }
    log.info("owner Windows preparation complete", {
      source: "hivra/agents/[id]/remote-desktop",
      userId,
      agentId: id,
      targetId: result.targetId,
      vmid: result.vmid,
    });
    return response({ success: true, data: {
      prepared: true,
      accessReady: false,
      windowsDescriptor: result.windowsDescriptor,
    } }, 200);
  }
  if (!profileRuntime.ok) {
    return response({
      success: false,
      error: profileRuntime.message,
      code: profileRuntime.code,
      profile: profileRuntime.profile,
    }, 409);
  }
  if (action === "refresh") {
    if (inspected.code === "desktop_upgrade_required") {
      return response({ success: false, error: inspected.error, code: "desktop_upgrade_required" }, 409);
    }
    log.warn("owner remote desktop capability refresh failed", {
      source: "hivra/agents/[id]/remote-desktop",
      failureType: "remote_desktop_capability_refresh_failed",
      userId,
      agentId: id,
      targetId: inspected.targetId,
      vmid: inspected.vmid,
    });
    return response({
      success: false,
      error: "This computer's current desktop runtime could not be verified. Inspect its runtime before choosing a controlled installation or repair.",
      code: "capability_refresh_failed",
    }, 409);
  }

  const result = await installRemoteDesktopOnHivraAgent(id, origin, {
    // Every load is freshly owner-scoped; the installer atomically claims the
    // exact resulting identity and rejects drift before dispatch/completion.
    loadAgent: async candidateId => {
      if (candidateId !== id) return null;
      const { data, error } = await supabaseAdmin!.from("hivra_agents").select(AGENT_FIELDS)
        .eq("id", id).eq("user_id", userId).maybeSingle();
      if (error) throw new Error("Owner desktop lookup failed.");
      return data as unknown as RemoteDesktopAgentRow | null;
    },
  }, {
    controlBypassSecret: managedControlBypassRequired
      ? process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      : undefined,
    controlBypassRequired: managedControlBypassRequired,
  });
  if (!result.ok) {
    const notReady = result.code === "computer_not_ready" || result.error === "Agent is not in a stable, identity-bound running state.";
    const pending = result.code === "desktop_prepare_pending";
    log.warn("owner remote desktop preparation failed", {
      source: "hivra/agents/[id]/remote-desktop",
      failureType: notReady ? "remote_desktop_computer_not_ready" : "remote_desktop_prepare_failed",
      userId,
      agentId: id,
      targetId: result.targetId,
      vmid: result.vmid,
    });
    return response({
      success: false,
      error: pending ? result.error : notReady
        ? "Wait for this computer to finish its current operation, then try again."
        : "Hivra could not verify the desktop installation. Inspect Desktop before retrying; the installer may have changed its runtime configuration.",
      code: pending ? "desktop_prepare_pending" : notReady ? "computer_not_ready" : "desktop_prepare_failed",
    }, notReady || pending ? 409 : 503);
  }

  log.info("owner remote desktop preparation complete", {
    source: "hivra/agents/[id]/remote-desktop",
    userId,
    agentId: id,
    targetId: result.targetId,
    vmid: result.vmid,
  });
  return response({ success: true, data: { prepared: true } }, 200);
}
