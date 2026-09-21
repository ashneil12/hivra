export const runtime = "nodejs";

import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { destroyWorkspaceCloudAgent } from "@/lib/services/workspace-cloud-provisioner";

const ROUTE = "/api/workspace-cloud/instances/[id]";

const PatchSchema = z.object({ name: z.string().trim().min(1).max(60) });

/** Rename a Workspace Cloud agent. Owner + lane scoped. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401, undefined, undefined, { route: ROUTE });
    if (!supabaseAdmin) return apiError("Database not configured", 500, undefined, undefined, { route: ROUTE });
    const { id } = await params;

    const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400, undefined, undefined, { route: ROUTE });

    const { data, error } = await supabaseAdmin
      .from("hermes_instances")
      .update({ name: parsed.data.name, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", userId)
      .eq("product_surface", "workspace_cloud")
      .neq("status", "deleted")
      .select("id, name")
      .maybeSingle();

    if (error) return apiError("Rename failed", 500, { code: error.code }, undefined, { route: ROUTE });
    if (!data) return apiError("Agent not found", 404, undefined, undefined, { route: ROUTE });

    return apiSuccess(data);
  } catch (err) {
    return handleApiError(err);
  }
}

/** Delete a Workspace Cloud agent (VM + caddy site + row). Owner-scoped. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401, undefined, undefined, { route: ROUTE });
    const { id } = await params;
    const result = await destroyWorkspaceCloudAgent({ instanceId: id, userId });
    if (!result.ok) return apiError(result.error, result.status, undefined, undefined, { route: ROUTE });
    return apiSuccess({ deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
