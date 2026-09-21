// Gateway auto-wake Phase 1: wake-status endpoint backing the public
// /wake/[instanceId] page.
//
// GET returns a minimal owner-scoped snapshot the wake page needs to drive an
// honest progress UI: the row's status/lifecycle plus the box URL to send the
// user back to. It deliberately does NOT probe the gateway — the existing
// /api/instances/[id]/health route owns probing (and the promote-to-running
// DB flip); the wake page polls that for readiness and uses this route for
// facts + the wake_succeeded telemetry emit.
//
// Telemetry: when called with ?wake_id=<id minted by the wake page> and the
// row is running, emits wake_succeeded (deduped in PostHog via $insert_id on
// the wake_id) so reactivation campaigns can measure completed wakes.
//
// Auth: Clerk session required (the /api/instances(.*) middleware matcher
// also force-protects this path). Unauthenticated visitors never reach this —
// the wake page shows them a sign-in CTA instead.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { captureWakeEvent } from "@/lib/telemetry/wake-events";

interface WakeStatusRow {
  id: string;
  status: string | null;
  lifecycle_state: string | null;
  paused_reason: string | null;
  gateway_url: string | null;
}

/** Statuses the wake page may fire a start action for. Transitional states
 *  (provisioning/redeploying) skip straight to health polling; error rows get
 *  pointed at the dashboard where the richer recovery UI lives. */
const WAKEABLE_STATUSES = new Set(["stopped", "paused"]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { id } = await params;

    const { data: instance } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, status, lifecycle_state, paused_reason, gateway_url")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .single<WakeStatusRow>();
    if (!instance) return apiError("Instance not found or unauthorized", 404);

    const status = instance.status ?? null;
    const running = status === "running";

    const wakeId = req.nextUrl.searchParams.get("wake_id")?.trim().slice(0, 64) || null;
    if (running && wakeId) {
      const elapsedMsRaw = Number(req.nextUrl.searchParams.get("elapsed_ms"));
      captureWakeEvent("wake_succeeded", {
        userId,
        instanceId: id,
        wakeId,
        source: "wake_page",
        properties:
          Number.isFinite(elapsedMsRaw) && elapsedMsRaw >= 0
            ? { elapsed_ms: Math.floor(elapsedMsRaw) }
            : {},
      });
    }

    return apiSuccess({
      status,
      lifecycleState: instance.lifecycle_state ?? null,
      pausedReason: instance.paused_reason ?? null,
      running,
      wakeable: !running && WAKEABLE_STATUSES.has(status ?? ""),
      boxUrl: instance.gateway_url ?? null,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
