// Records that a user connected an agent to Telegram, so the activation funnel
// on /dashboard/insights has a persisted signal (boxes pause/churn — a live
// probe can't measure "what % of deployers ever connected"). Idempotent upsert
// into channel_connections + a deduped server-side PostHog event.
//
// Ownership is verified against the user's own rows before writing, so a client
// can't record a connection for an agent it doesn't own.

export const runtime = "nodejs";
export const maxDuration = 15;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { posthogClient } from "@/lib/posthog";
import { log } from "@/lib/logger";

const ID_RE = /^[a-zA-Z0-9-]+$/;
const TARGET_KINDS = new Set(["hivra", "hermes"]);
const CHANNELS = new Set(["telegram"]);

async function userOwnsTarget(userId: string, targetKind: string, targetId: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  if (targetKind === "hivra") {
    const { data } = await supabaseAdmin
      .from("hivra_agents")
      .select("id")
      .eq("id", targetId)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .maybeSingle();
    return Boolean(data);
  }
  // hermes
  const { data } = await supabaseAdmin
    .from("hermes_instances")
    .select("id")
    .eq("id", targetId)
    .eq("user_id", userId)
    .maybeSingle();
  return Boolean(data);
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const channel = String(body.channel ?? "");
    const targetKind = String(body.targetKind ?? "");
    const targetId = String(body.targetId ?? "");

    if (!CHANNELS.has(channel)) return apiError("Unsupported channel", 400);
    if (!TARGET_KINDS.has(targetKind)) return apiError("Invalid target kind", 400);
    if (!ID_RE.test(targetId)) return apiError("Invalid target id", 400);

    if (!(await userOwnsTarget(userId, targetKind, targetId))) {
      return apiError("Agent not found", 404);
    }

    const nowIso = new Date().toISOString();
    // Omit connected_at so the column default (first connect) is preserved on
    // conflict; last_connected_at is refreshed on every (re)connect.
    const { error } = await supabaseAdmin
      .from("channel_connections")
      .upsert(
        { user_id: userId, channel, target_kind: targetKind, target_id: targetId, last_connected_at: nowIso },
        { onConflict: "user_id,channel,target_kind,target_id" },
      );
    if (error) {
      log.warn("channel-connection upsert failed", {
        source: "telegram/record-connection",
        failureType: "channel_connection_upsert_failed",
        userId,
        targetKind,
        channel,
        errorMessage: error.message,
      });
      return apiError("Could not record connection", 500);
    }

    try {
      posthogClient.capture({
        distinctId: userId,
        event: "telegram_connected",
        properties: {
          channel,
          target_kind: targetKind,
          target_id: targetId,
          $insert_id: `telegram_connected_${userId}_${targetKind}_${targetId}`,
        },
      });
      await posthogClient.flush();
    } catch {
      // Best-effort analytics — the persisted row is the source of truth.
    }

    return apiSuccess({ recorded: true });
  } catch (err) {
    return handleApiError(err);
  }
}
