/**
 * POST /api/support/report
 *
 * Lightweight "Report this" sink. The dashboard's ReportProblemLink calls
 * this fire-and-forget when a user reports a dead-end (failed start, stuck
 * checkout, etc.) so the report shows up in /dashboard/ops as a
 * `support_request` ops event — the founder sees it without waiting for an
 * email. The mailto: path the same component opens is the primary channel;
 * this is the in-app breadcrumb, so any failure here is non-fatal and the
 * client ignores the outcome.
 *
 * Auth'd via Clerk. The user id is taken from the session (server truth),
 * never the body.
 */

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

// Same text rules as POST /api/ops/events, so a report reads the same way.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVISIBLE_FORMAT_CHARS = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const CONTROL_CHARS_EXCEPT_TAB_AND_NEWLINE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const TITLE_MAX_CHARS = 160;
const MESSAGE_MAX_CHARS = 1000;

function clampChars(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("")}…`;
}

/** One plain line: no line breaks, no control or invisible characters. */
function plainTitle(value: string): string {
  const flattened = value
    .replace(INVISIBLE_FORMAT_CHARS, "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clampChars(flattened || "Support report", TITLE_MAX_CHARS);
}

/** Plain text that keeps its line breaks and tabs and drops other control or invisible characters. */
function plainMessage(value: string): string {
  const cleaned = value
    .replace(INVISIBLE_FORMAT_CHARS, "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS_EXCEPT_TAB_AND_NEWLINE, "")
    .trim();
  return clampChars(cleaned || "Support report", MESSAGE_MAX_CHARS);
}

/**
 * Whether the signed-in user owns this Hermes instance or Hivra agent. An
 * ops event's instance_id decides whose dashboard reads it, so a report may
 * only be attached to the caller's own instance.
 */
async function callerOwnsInstance(userId: string, instanceId: string): Promise<boolean> {
  if (!supabaseAdmin || !UUID_PATTERN.test(instanceId)) return false;
  const owned = await Promise.all(["hermes_instances", "hivra_agents"].map(async (table) => {
    const { data, error } = await supabaseAdmin!
      .from(table)
      .select("id")
      .eq("id", instanceId)
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    // A failed lookup counts as not owned, so the id is dropped rather than trusted.
    return !error && Boolean(data);
  }));
  return owned.some(Boolean);
}

const ReportSchema = z.object({
  // Where the report originated, e.g. "agent-start-failure" | "billing-checkout" | "deploy".
  surface: z.string().trim().min(1).max(80),
  // Short human summary (mirrors the mailto subject).
  summary: z.string().trim().min(1).max(200),
  instanceId: z.string().trim().max(120).optional().nullable(),
  errorContext: z.string().trim().max(2000).optional().nullable(),
});

export async function POST(req: NextRequest) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) return apiError("Unauthorized", 401);

    // Cap how fast a single authed user can mint distinct ops_events rows by
    // spamming unique surface/summary combos. Mirrors sibling write routes
    // (settings/global, managed-venice/keys). Best-effort feed, so a quiet 429
    // is fine — the client ignores the outcome.
    const rateLimitError = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "support_report_post",
      userId: clerkUserId,
      ...RATE_LIMIT_PRESETS.settingsWrite,
    });
    if (rateLimitError) {
      return rateLimitError;
    }

    let parsedBody: unknown;
    try {
      parsedBody = await req.json();
    } catch {
      return apiError("Invalid JSON body", 400);
    }

    const parsed = ReportSchema.safeParse(parsedBody);
    if (!parsed.success) {
      return apiError("Invalid report payload", 400, parsed.error);
    }

    const { surface, summary, instanceId, errorContext } = parsed.data;

    // An unowned instance id would file this report under someone else's
    // instance feed, so drop it and say so in the metadata.
    let attachedInstanceId: string | null = null;
    let instanceIdDropped = false;
    if (instanceId) {
      if (await callerOwnsInstance(clerkUserId, instanceId)) {
        attachedInstanceId = instanceId;
      } else {
        instanceIdDropped = true;
      }
    }

    // 'info' severity: a user-initiated report is a signal, not an incident.
    // reportOpsEvent dedupes by fingerprint, so repeat reports of the same
    // dead-end roll up into one row with an occurrence count.
    await reportOpsEvent({
      source: "support-report",
      severity: "info",
      title: plainTitle(`Support report: ${summary}`),
      message: plainMessage(
        errorContext?.trim()
          ? `User reported a problem from "${surface}". Error: ${errorContext.trim()}`
          : `User reported a problem from "${surface}".`
      ),
      route: "/api/support/report",
      userId: clerkUserId,
      instanceId: attachedInstanceId,
      metadata: {
        surface,
        summary,
        ...(instanceIdDropped ? { instanceIdDropped: true } : {}),
      },
    });

    return apiSuccess({ recorded: true });
  } catch (error) {
    // Swallow into a 500 — the client treats this endpoint as best-effort.
    return apiError("Failed to record report", 500, undefined, undefined, {
      source: "support-report",
      route: "/api/support/report",
      method: "POST",
      failureType: "support_report_unexpected_error",
      cause: error instanceof Error ? error : undefined,
    });
  }
}
