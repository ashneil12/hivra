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

    // 'info' severity: a user-initiated report is a signal, not an incident.
    // reportOpsEvent dedupes by fingerprint, so repeat reports of the same
    // dead-end roll up into one row with an occurrence count.
    await reportOpsEvent({
      source: "support-report",
      severity: "info",
      title: `Support report: ${summary}`,
      message: errorContext?.trim()
        ? `User reported a problem from "${surface}". Error: ${errorContext.trim()}`
        : `User reported a problem from "${surface}".`,
      route: "/api/support/report",
      userId: clerkUserId,
      instanceId: instanceId ?? null,
      metadata: { surface, summary },
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
