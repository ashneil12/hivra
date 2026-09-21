export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import crypto from "node:crypto";

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";
import { isExpoPushToken } from "@/lib/push/expo-push";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * POST /api/mobile/push-tokens — register (upsert) the device's Expo push
 * token for the signed-in user; DELETE — disable it (notifications off /
 * sign-out). iOS Phase 2.
 *
 * The token is the upsert key (device-scoped): re-registering a token that a
 * DIFFERENT user previously held reassigns it, so a shared device only ever
 * notifies whoever is currently signed in. Disable flips enabled=false rather
 * than deleting, matching the sender's DeviceNotRegistered pruning semantics
 * (see lib/push/expo-push.ts + the device_tokens migration).
 */

const LOG_SOURCE = "mobile-push-tokens";

const RegisterSchema = z.object({
  expoPushToken: z.string().min(1).max(512),
  platform: z.enum(["ios", "android"]).optional().default("ios"),
});

const DisableSchema = z.object({
  expoPushToken: z.string().min(1).max(512),
});

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const json = await request.json().catch(() => null);
    const parsed = RegisterSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 400);
    }
    const { expoPushToken, platform } = parsed.data;

    if (!isExpoPushToken(expoPushToken)) {
      return apiError("Not a valid Expo push token", 400, undefined, undefined, {
        source: LOG_SOURCE,
        failureType: "invalid_expo_push_token",
        userId,
      });
    }

    const nowIso = new Date().toISOString();
    const { error } = await supabaseAdmin.from("device_tokens").upsert(
      {
        user_id: userId,
        expo_push_token: expoPushToken,
        platform,
        enabled: true,
        last_seen_at: nowIso,
      },
      { onConflict: "expo_push_token" }
    );
    if (error) {
      return apiError("Failed to register push token", 500, error, undefined, {
        source: LOG_SOURCE,
        failureType: "push_token_upsert_failed",
        userId,
      });
    }

    // Server-side mobile-funnel event (box_created pattern: $insert_id +
    // flush). The insert id is stable per (user, token) so re-registrations —
    // the app re-posts on every launch — collapse instead of inflating the
    // funnel. Best-effort: telemetry must never fail the registration.
    try {
      const tokenDigest = crypto
        .createHash("sha256")
        .update(expoPushToken)
        .digest("hex")
        .slice(0, 16);
      posthogClient.capture({
        distinctId: userId,
        event: "push_token_registered",
        properties: {
          platform,
          $insert_id: `push_token_registered_${userId}_${tokenDigest}`,
          $set_once: { hermes_user_id: userId },
        },
      });
      await posthogClient.flush();
    } catch (captureErr) {
      log.warn("failed to capture push_token_registered", {
        source: LOG_SOURCE,
        failureType: "push_token_registered_capture_failed",
        userId,
        errorMessage:
          captureErr instanceof Error ? captureErr.message : String(captureErr),
      });
    }

    return apiSuccess({ registered: true });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const json = await request.json().catch(() => null);
    const parsed = DisableSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 400);
    }

    // Owner-scoped: a user can only disable a token row that is currently
    // theirs. Disabling an unknown/foreign token is a no-op success (the
    // device's goal — "stop notifying me here" — is already true).
    const { error } = await supabaseAdmin
      .from("device_tokens")
      .update({ enabled: false })
      .eq("user_id", userId)
      .eq("expo_push_token", parsed.data.expoPushToken);
    if (error) {
      return apiError("Failed to disable push token", 500, error, undefined, {
        source: LOG_SOURCE,
        failureType: "push_token_disable_failed",
        userId,
      });
    }

    return apiSuccess({ disabled: true });
  } catch (err) {
    return handleApiError(err);
  }
}
