export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import { UUID_V1_TO_8 } from "@/app/api/hivra/managed-sessions/route-support";
import { readComputerBackupStatus } from "@/lib/hivra/computer-backups/sweep";

/** The owner's view of a computer's off-site copies: when the last one was taken, and when one was last read back. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    const { id } = await params;
    if (!UUID_V1_TO_8.test(id)) return apiError("Agent not found", 404);
    const { data: agent, error } = await supabaseAdmin
      .from("hivra_agents")
      .select("id, computer_substrate, deployment_mode")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .maybeSingle();
    if (error) return apiError("Could not load this computer.", 503);
    if (!agent) return apiError("Agent not found", 404);
    const supported = agent.computer_substrate === "proxmox-kvm" && agent.deployment_mode === "hivra-managed";
    const status = await readComputerBackupStatus(id);
    const response = apiSuccess({ supported, ...status, enabled: supported && status.enabled });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
