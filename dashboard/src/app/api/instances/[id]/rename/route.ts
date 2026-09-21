import { NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

const ROUTE = "/api/instances/[id]/rename";
const MAX_INSTANCE_NAME_LENGTH = 60;

// Rename is a DISPLAY-LABEL change only (hermes_instances.name). It does not
// touch the agent on the box — no SSH push, no gateway restart — so it is
// always safe and instant. The agent's runtime identity (honcho peer, system
// prompt) is intentionally left alone here.
const RenameSchema = z.object({
  name: z
    .string()
    .transform((raw) =>
      // Replace any control character (newlines, tabs, etc.) with a space, then
      // collapse runs of whitespace, so a label can never carry formatting that
      // breaks dashboard rendering. \p{Cc} = the Unicode "Control" category.
      raw.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim()
    )
    .pipe(
      z
        .string()
        .min(1, "Name cannot be empty")
        .max(
          MAX_INSTANCE_NAME_LENGTH,
          `Name must be ${MAX_INSTANCE_NAME_LENGTH} characters or fewer`
        )
    ),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { id } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError("Invalid request body", 400);
    }

    const parsed = RenameSchema.safeParse(body);
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400);
    const name = parsed.data.name;

    // Ownership check mirrors getInstanceOrError(): the row must belong to the
    // caller and not be soft-deleted. Scoping the later UPDATE by user_id too
    // means a mismatched caller can never rename someone else's instance.
    const { data: instance, error: loadErr } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, name")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .single<{ id: string; name: string }>();

    if (loadErr || !instance) return apiError("Instance not found", 404);

    // No-op when unchanged — avoids a needless write + updated_at bump.
    if (instance.name === name) return apiSuccess({ name });

    const { error: updateErr } = await supabaseAdmin
      .from("hermes_instances")
      .update({ name, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", userId);

    if (updateErr) {
      log.error("instance rename failed", updateErr, {
        source: "instances",
        route: ROUTE,
        method: "PATCH",
        instanceId: id,
        userId,
        failureType: "instance_rename_update_failed",
      });
      return apiError("Failed to rename instance", 500);
    }

    log.info("instance renamed", {
      source: "instances",
      route: ROUTE,
      method: "PATCH",
      instanceId: id,
      userId,
    });

    return apiSuccess({ name });
  } catch (err) {
    return handleApiError(err);
  }
}
