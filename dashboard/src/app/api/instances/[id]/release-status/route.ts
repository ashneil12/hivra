// GET /api/instances/[id]/release-status
//
// What the agent page needs to show "Update available": the version the box
// last reported, the version the release registry would put it on, and the
// health of its update stack. Owner only (Clerk session + ownership).
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { BOX_RELEASE_COLUMNS, evaluateBoxRelease } from "@/lib/hermes-releases/box";
import { loadReleases } from "@/lib/hermes-releases/store";
import { resolveInstanceAgentImageRepo } from "@/lib/services/webui-instance-builder";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    const { id } = await params;

    const { data: row, error } = await supabaseAdmin
      .from("hermes_instances")
      .select(`${BOX_RELEASE_COLUMNS}, user_id, update_health_detail, update_health_at, update_stack_version, agent_image_reported_at`)
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .maybeSingle();
    if (error) return apiError("Failed to load instance", 500);
    if (!row) return apiError("Instance not found or unauthorized", 404);

    const extra = row as unknown as {
      update_health_detail: string | null;
      update_health_at: string | null;
      update_stack_version: number | null;
      agent_image_reported_at: string | null;
    };
    const boxRow = row as unknown as Parameters<typeof evaluateBoxRelease>[0];
    const imageRepo = resolveInstanceAgentImageRepo(boxRow.config);
    const releases = imageRepo ? await loadReleases(supabaseAdmin, imageRepo) : [];
    const state = evaluateBoxRelease(boxRow, releases, { imageRepo });
    const target = state.decision.target;

    return apiSuccess({
      channel: state.channel,
      currentVersion: state.currentVersion,
      currentDigest: state.currentDigest,
      reportedAt: extra.agent_image_reported_at,
      updateAvailable: state.decision.updateAvailable,
      direction: state.decision.direction,
      target: target ? { version: target.version, digest: target.digest } : null,
      updateHealth: state.updateHealth,
      updateHealthDetail: extra.update_health_detail,
      updateHealthAt: extra.update_health_at,
      updateStackVersion: extra.update_stack_version,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
