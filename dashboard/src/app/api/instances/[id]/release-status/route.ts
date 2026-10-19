// GET /api/instances/[id]/release-status
//
// What the agent page needs to show "Update available": the version the box
// last reported, the version the release registry would put it on, and the
// health of its update stack. Owner only (Clerk session + ownership).
//
// A box the registry does not govern (no release of its image repository yet)
// follows its floating tag, and its UPDATE pulls exactly that tag. It is
// offered an update when the tag now points at a different build than the one
// the box reported, so owners can update without a registered release.
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { BOX_RELEASE_COLUMNS, evaluateBoxRelease } from "@/lib/hermes-releases/box";
import { resolveFloatingImageTarget } from "@/lib/hermes-releases/floating";
import { loadReleases } from "@/lib/hermes-releases/store";
import { NOFORK_LOCAL_REPO } from "@/lib/services/no-fork-migration-builder";
import {
  resolveInstanceAgentImageRepo,
  resolveInstanceAgentUpdateImage,
} from "@/lib/services/webui-instance-builder";
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

    // Not governed: compare the box's reported build with its floating tag.
    // A box that has never reported a digest is not nagged; a box that follows
    // upstream by itself (the no-fork image) owns its updates.
    const updateImage = !state.governed && imageRepo && imageRepo !== NOFORK_LOCAL_REPO && state.currentDigest
      ? resolveInstanceAgentUpdateImage(boxRow.config)
      : null;
    const floating = updateImage ? await resolveFloatingImageTarget(updateImage) : null;
    const floatingUpdate = Boolean(floating && floating.digest !== state.currentDigest);

    return apiSuccess({
      channel: state.channel,
      governed: state.governed,
      source: state.governed ? "release" : floating ? "floating" : null,
      currentVersion: state.currentVersion,
      currentDigest: state.currentDigest,
      reportedAt: extra.agent_image_reported_at,
      updateAvailable: state.governed ? state.decision.updateAvailable : floatingUpdate,
      direction: state.governed ? state.decision.direction : floatingUpdate ? "upgrade" : "none",
      target: target
        ? { version: target.version, digest: target.digest }
        : floatingUpdate && floating ? { version: floating.tag ?? "pinned", digest: floating.digest } : null,
      updateHealth: state.updateHealth,
      updateHealthDetail: extra.update_health_detail,
      updateHealthAt: extra.update_health_at,
      updateStackVersion: extra.update_stack_version,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
