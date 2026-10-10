import { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { requireOpsAdmin } from "@/lib/hermes-releases/ops-auth";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const Body = z.object({ channel: z.enum(["stable", "canary"]) });

/**
 * POST /api/ops/hermes-releases/boxes/[id]: enrol a box in the canary release
 * channel (it then receives releases at the canary stage first) or return it to
 * stable. Ops admins only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireOpsAdmin();
    if (!admin.ok) return apiError(admin.message, admin.status);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) return apiError("Invalid box id", 400);

    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError("channel must be stable or canary", 400);

    const { data, error } = await supabaseAdmin
      .from("hermes_instances")
      .update({ release_channel: parsed.data.channel })
      .eq("id", id)
      .is("deleted_at", null)
      .select("id, release_channel")
      .maybeSingle();
    if (error) return apiError("Failed to update the box", 500);
    if (!data) return apiError("Box not found", 404);

    await reportOpsEvent({
      source: "hermes-release",
      severity: "info",
      title: `Box moved to the ${parsed.data.channel} release channel`,
      message: `An operator moved a box to the ${parsed.data.channel} release channel.`,
      route: "/api/ops/hermes-releases/boxes/[id]",
      instanceId: id,
      metadata: { channel: parsed.data.channel, actor: admin.actor },
    });
    return apiSuccess({ id, channel: parsed.data.channel });
  } catch (err) {
    return handleApiError(err);
  }
}
