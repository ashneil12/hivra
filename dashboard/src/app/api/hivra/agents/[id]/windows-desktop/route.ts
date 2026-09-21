export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

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
import { log } from "@/lib/logger";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { inspectRemoteDesktopCapability } from "@/lib/remote-computers/capability-inspection";
import { parseWindowsRdpInspectionFailure } from "@/lib/remote-computers/windows-rdp-capability";
import {
  buildWindowsGatewayToken,
  guacamoleClientIdentifier,
  readWindowsRdpGatewayConfig,
  windowsDescriptorMatchesGateway,
} from "@/lib/remote-computers/windows-rdp-gateway";
import { supabaseAdmin } from "@/lib/supabase";
import { windowsDesktopDimensions } from "@/lib/remote-computers/windows-desktop-viewport";

const BODY_LIMIT = 1_024;
const Body = z.object({
  streamingMode: z.enum(["hq", "qhd", "uhd", "performance"]),
  viewport: z.object({ width: z.number().int().min(1).max(16_384), height: z.number().int().min(1).max(16_384) }).strict().optional(),
}).strict().refine(body => windowsDesktopDimensions(body.streamingMode, body.viewport) !== null);
const AGENT_FIELDS = [
  "id", "user_id", "type", "computer_profile", "status", "desired_state", "operation_id", "operation_kind",
  "vmid", "ip", "chat_url", "computer_substrate", "provider_capacity_order_id",
  "provider_enrollment_attempt_id", "provider_server_id", "deployment_mode", "proxmox_host",
  "infrastructure_connection_id", "deployment_target_id", "infrastructure_connection_revision",
  "infrastructure_binding_token_hash", "infrastructure_binding_token_enforced", "managed_provisioner_channel",
].join(",");

function response(body: unknown, status: number) {
  return remoteDesktopResponse(body, status);
}

// Never log the inspector's raw error: only recognize its complete, fixed
// diagnostic envelope and tokens already allowlisted by the Windows inspector.
function inspectionFailureReason(error: unknown): string {
  if (error === "Remote desktop inspection authority is unavailable.") return "inspection_authority_unavailable";
  if (error === "Remote desktop inspection failed.") return "inspection_failed";
  if (error === "Agent is not in a stable, identity-bound running state.") return "inspection_agent_unstable";
  if (error === "Remote desktop capability could not be recorded.") return "inspection_record_failed";
  const code = typeof error === "string"
    ? /^Remote desktop capability could not be verified \(([a-z0-9_]+)\)\.$/.exec(error)?.[1]
    : undefined;
  if (!code) return "inspection_unknown";
  if (["host_timeout", "host_output_limit", "host_ssh", "guest_remote_exit",
    "capability_marker_absent", "capability_marker_duplicate", "capability_marker_invalid",
    "identity_mismatch"].includes(code)) return code;
  const guestCode = code.startsWith("guest_") ? code.slice(6) : null;
  const qgaCode = code.startsWith("qga_") ? code.slice(4) : null;
  const hostPhase = code.startsWith("host_phase_") ? code.slice(11) : null;
  const marker = guestCode ? `HIVRA_CAPABILITY_FAILURE ${guestCode}`
    : qgaCode ? `HIVRA_QGA_FAILURE ${qgaCode}`
      : hostPhase ? `HIVRA_WINDOWS_INSPECTION_HOST_FAILURE ${hostPhase}` : "";
  if (marker && parseWindowsRdpInspectionFailure(marker) === code) return code;
  const remoteExit = /^host_remote_exit_(undefined|[0-9]{1,3})$/.exec(code)?.[1];
  if (remoteExit && (remoteExit === "undefined" || Number(remoteExit) <= 255)) return code;
  return "inspection_unknown";
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return response({ success: false, error: "Unauthorized" }, 401);
  if (!isHivraApiAllowed(request.headers.get("host"))) return response({ success: false, error: "Not found" }, 404);
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) {
    return response({ success: false, error: "Request denied" }, 403);
  }
  if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) {
    return response({ success: false, error: "JSON required" }, 415);
  }
  const body = await readBoundedJson(request, BODY_LIMIT, 5_000);
  const parsedBody = body.ok ? Body.safeParse(body.body) : null;
  if (!parsedBody?.success) return response({ success: false, error: "Invalid request" }, body.ok ? 400 : body.reason === "too_large" ? 413 : 400);

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return response({ success: false, error: "Computer not found" }, 404);
  if (!enforceRateLimit(`hivra_windows_desktop:${userId}:${getIP(request)}`, { limit: 12, windowMs: 60_000 }).success) {
    return response({ success: false, error: "Wait before opening this desktop again." }, 429);
  }
  const config = readWindowsRdpGatewayConfig();
  if (!config || config.computerId !== id || !supabaseAdmin) {
    return response({ success: false, error: "Fast Windows desktop is unavailable." }, 503);
  }

  const { data, error } = await supabaseAdmin.from("hivra_agents").select(AGENT_FIELDS)
    .eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) return response({ success: false, error: "Fast Windows desktop is unavailable." }, 503);
  const agent = data as Record<string, unknown> | null;
  if (!agent) return response({ success: false, error: "Computer not found" }, 404);
  if (agent.type !== "linux-desktop" || agent.computer_profile !== "windows"
    || agent.computer_substrate !== "proxmox-kvm" || agent.status !== "running"
    || agent.desired_state !== "running"
    || agent.ip !== config.guestPrivateIpv4 || agent.infrastructure_binding_token_enforced !== true) {
    return response({ success: false, error: "This Windows computer is not ready." }, 409);
  }
  if (agent.operation_id != null || agent.operation_kind != null) {
    // Resume only this owner's retained preparation through the existing
    // operation coordinator. Other lifecycle operations cannot be retried here.
    const resumable = agent.operation_kind === "desktop_prepare"
      && typeof agent.operation_id === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agent.operation_id);
    return resumable
      ? response({ success: false, code: "windows_prepare_resume_required",
        error: "The retained Windows preparation needs to be checked before opening." }, 409)
      : response({ success: false, error: "This Windows computer is not ready." }, 409);
  }

  const inspected = await inspectRemoteDesktopCapability(id, {
    loadAgent: async candidateId => candidateId === id ? agent as never : null,
  });
  // Only a verified configuration defect permits preparation. Transport,
  // missing/invalid receipts, and authority failures must stay read-only.
  const repairableInspectionFailure = !inspected.ok && typeof inspected.error === "string"
    && /\(guest_(?:console_autologon_enabled|rdp_disabled|rdp_nla_disabled|rdp_port_mismatch|rdp_service_unready|rdp_listener_unready|rdp_firewall_rule_mismatch|rdp_firewall_port_mismatch|rdp_firewall_service_mismatch|rdp_firewall_program_mismatch|rdp_firewall_source_missing)\)\.$/.test(inspected.error);
  if ((!inspected.ok && !repairableInspectionFailure) || (inspected.ok && !inspected.windowsDescriptor)) {
    log.warn("Windows desktop inspection unconfirmed", {
      source: "hivra/agents/[id]/windows-desktop",
      instanceId: id,
      status: 503,
      failureType: "inspection_unconfirmed",
      phase: "capability_inspection",
      reason: inspected.ok ? "windows_descriptor_missing" : inspectionFailureReason(inspected.error),
    });
    return response({ success: false, error: "Windows RDP inspection could not be confirmed. Try opening it again." }, 503);
  }
  if (!inspected.ok || !inspected.windowsDescriptor
    || !windowsDescriptorMatchesGateway(inspected.windowsDescriptor, config)) {
    return response({ success: false, code: "windows_prepare_required", error: "Windows RDP needs to be prepared again." }, 409);
  }

  const expires = Date.now() + 45_000;
  const encrypted = buildWindowsGatewayToken({ config, ownerId: userId,
    expires, streamingMode: parsedBody.data.streamingMode, viewport: parsedBody.data.viewport });
  if (!encrypted) return response({ success: false, error: "The Windows handoff could not be created." }, 503);
  let gatewayResponse: Response;
  try {
    gatewayResponse = await fetch(`${config.gatewayOrigin}/guacamole/api/tokens`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: encrypted }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return response({ success: false, error: "The Windows gateway did not respond." }, 503);
  }
  const gatewayBody = await gatewayResponse.json().catch(() => null) as { authToken?: unknown } | null;
  if (!gatewayResponse.ok || typeof gatewayBody?.authToken !== "string"
    || !/^[A-F0-9]{64}$/.test(gatewayBody.authToken)) {
    return response({ success: false, error: "The Windows gateway rejected the handoff." }, 503);
  }
  const client = guacamoleClientIdentifier(config.connectionName);
  const launchUrl = `${config.gatewayOrigin}/guacamole/#/client/${client}?token=${gatewayBody.authToken}`;
  return response({ success: true, data: { launchUrl, streamingMode: parsedBody.data.streamingMode } }, 200);
}
