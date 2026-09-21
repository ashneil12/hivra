export const runtime = "nodejs";

import { auth } from "@clerk/nextjs/server";

import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";

const ROUTE = "/api/workspace-cloud/instances/[id]/health";

/**
 * Liveness probe for a Workspace Cloud agent — server-side so the browser
 * never has to reach the agent gateway directly (CORS / mixed-content safe).
 * Owner + lane scoped. Hits the agent's unauthenticated /health endpoint with
 * a short timeout and reports whether it actually answers (distinct from the
 * VM lifecycle status).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401, undefined, undefined, { route: ROUTE });
    if (!supabaseAdmin) return apiError("Database not configured", 500, undefined, undefined, { route: ROUTE });
    const { id } = await params;

    const { data: inst } = await supabaseAdmin
      .from("hermes_instances")
      .select("gateway_url")
      .eq("id", id)
      .eq("user_id", userId)
      .eq("product_surface", "workspace_cloud")
      .neq("status", "deleted")
      .maybeSingle<{ gateway_url: string | null }>();

    if (!inst) return apiError("Agent not found", 404, undefined, undefined, { route: ROUTE });
    if (!inst.gateway_url) return apiSuccess({ healthy: false, reason: "no_gateway" });

    const url = `${inst.gateway_url.replace(/\/$/, "")}/health`;
    const started = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000), cache: "no-store" });
      return apiSuccess({
        healthy: res.ok,
        code: res.status,
        latencyMs: Date.now() - started,
      });
    } catch {
      return apiSuccess({ healthy: false, reason: "unreachable", latencyMs: Date.now() - started });
    }
  } catch (err) {
    return handleApiError(err);
  }
}
