import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
  resizeProxmoxVm,
} from "@/lib/services/proxmox-instance-service";
import { priorityToCpuUnits } from "@/lib/proxmox/cpu-priority";
import { priorityForResourceTier } from "@/lib/subscription/agent-slots";

const ResourceReallocationSchema = z.object({
  cpuLimit: z.number().min(0.5).max(8),
  ramLimit: z.number().int().min(1024).max(16384),
});

/** Owner-only shrink path for shared-plan customers. The VM resize succeeds
 * before the database allocation changes, so a failed host action never
 * advertises capacity that does not exist. Growing stays on the normal PATCH
 * path, where the complete plan/host budget checks apply. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const parsed = ResourceReallocationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return apiError(parsed.error.issues[0]?.message || "Invalid resource allocation", 400);
  const { id } = await params;
  const { data: instance, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id,user_id,cpu_limit,ram_limit,resource_tier,config,host_id,status")
    .eq("id", id).eq("user_id", userId).neq("status", "deleted").single();
  if (error || !instance) return apiError("Instance not found", 404);

  const currentCpu = Number(instance.cpu_limit ?? 0);
  const currentRam = Number(instance.ram_limit ?? 0);
  if (parsed.data.cpuLimit > currentCpu || parsed.data.ramLimit > currentRam) {
    return apiError("This action only frees capacity. Use the normal resource controls to grow an agent.", 400);
  }
  const infrastructure = getProxmoxInfrastructure(instance.config);
  if (!infrastructure) return apiError("This self-service reallocation is available for Proxmox-backed agents only.", 501);

  const result = await resizeProxmoxVm({
    vmid: infrastructure.vmid,
    node: infrastructure.node,
    cpuLimit: parsed.data.cpuLimit,
    memoryMb: parsed.data.ramLimit,
    cpuUnits: priorityToCpuUnits(priorityForResourceTier(instance.resource_tier || "credit_base")),
  }, { hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(infrastructure, { host_id: instance.host_id ?? null }) });
  if (!result.ok) {
    log.error("resource reallocation VM resize failed", new Error(result.error || result.stderr || "unknown"), {
      source: "resource-reallocation", failureType: "resource_reallocation_resize_failed", instanceId: id, userId,
    });
    return apiError("Pike could not be resized; no allocation was changed.", 502);
  }
  const { error: updateError } = await supabaseAdmin.from("hermes_instances")
    .update({ cpu_limit: parsed.data.cpuLimit, ram_limit: parsed.data.ramLimit, updated_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", userId);
  if (updateError) {
    log.error("resource reallocation database update failed after VM resize", updateError, {
      source: "resource-reallocation", failureType: "resource_reallocation_db_update_failed", instanceId: id, userId,
    });
    return apiError("Pike was resized, but its saved allocation could not be updated. Contact support before launching another agent.", 500);
  }
  return apiSuccess({ instanceId: id, cpuLimit: parsed.data.cpuLimit, ramLimit: parsed.data.ramLimit });
}
