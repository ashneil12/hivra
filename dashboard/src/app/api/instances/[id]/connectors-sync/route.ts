import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import type { HermesInstanceRow } from "@/app/api/instances/[id]/route";
import { WebUIError } from "@/lib/webui/client";
import { mapWebUIRuntimeError } from "@/lib/webui/runtime-settings";
import { syncComposioToInstance } from "@/lib/composio/sync-connectors";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * POST /api/instances/[id]/connectors-sync
 *
 * Ensures the box carries the single `composio` MCP server entry so the agent
 * can use the apps the user connected via Composio. Fired by the command panel on
 * mount and by the post-connect callback. The Tool Router entry is dynamic, so a
 * routine sync is a no-op when the entry already exists; `force` (key rotation)
 * regenerates it. Shared with the api/cron/sync-connectors backfill.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const { id } = await params;

    // Optional body: { force?: boolean } — set on key rotation to regenerate the
    // session URL. A routine mount / post-connect sync sends no force and is a
    // no-op when the box already carries the composio entry (Tool Router is
    // dynamic, so a newly-connected app never needs the box touched).
    let force = false;
    try {
      const body = (await req.json()) as { force?: unknown } | null;
      force = body?.force === true;
    } catch {
      /* no/invalid body — routine sync */
    }

    const { data: instance, error } = await supabaseAdmin!
      .from("hermes_instances")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (error || !instance) {
      return apiError("Instance not found", 404);
    }

    try {
      const result = await syncComposioToInstance({
        instanceId: id,
        userId,
        instance: instance as HermesInstanceRow,
        force,
      });
      if (result.applied) return apiSuccess(result);
      if (result.reason === "no_public_ipv4") {
        return apiError("Server has no public IPv4", 502);
      }
      return apiSuccess({ applied: false, reason: result.reason });
    } catch (err) {
      if (err instanceof WebUIError) {
        const mapped = mapWebUIRuntimeError(err, "Could not sync connectors to the runtime.");
        return apiError(mapped.message, mapped.status, {
          failureType: mapped.failureType,
          retryable: mapped.retryable,
          upstreamStatus: mapped.upstreamStatus,
        });
      }
      // Surface the REAL reason (an SSH / config-write failure) to the instance
      // OWNER rather than a generic 500 — it's their own box, and an opaque 500 is
      // undiagnosable. Truncated to keep infra internals out of the UI; the full
      // cause is logged server-side.
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 220);
      return apiError(
        `Couldn't enable Composio on your agent: ${detail}`,
        502,
        { failureType: "connectors_sync_failed" },
        undefined,
        { cause: err instanceof Error ? err : new Error(detail), failureType: "connectors_sync_failed" },
      );
    }
  } catch (err) {
    return handleApiError(err);
  }
}
