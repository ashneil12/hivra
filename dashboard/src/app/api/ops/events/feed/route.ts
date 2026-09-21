import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import type { OpsEventSeverity } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

// Machine-readable ops alert feed. Same data the human-facing
// /dashboard/ops page reads, but bearer-authenticated against
// CRON_SECRET so external agents (your own monitoring AI, a
// per-agent-VM watchdog, a Slack-bridge worker, etc.) can pull
// without holding a Clerk session.
//
// Polling shape:
//   GET /api/ops/events/feed?since=<ISO>&severity=warn&source=managed-venice-*&limit=200
//   Authorization: Bearer $CRON_SECRET
//
// Returns `events` plus a `nextSince` cursor — feed that back as `since=`
// on the next poll to get only events that have been seen-or-re-seen
// since the last fetch. `last_seen_at` increments on every duplicate
// occurrence, so a re-fired alert will show up again with a newer
// last_seen_at even though the same fingerprint already existed.

const ROUTE = "/api/ops/events/feed";
const SOURCE = "ops-events-feed";

const VALID_SEVERITIES: readonly OpsEventSeverity[] = ["info", "warn", "error", "fatal"];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export const dynamic = "force-dynamic";

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, parsed);
}

function parseSeverity(raw: string | null): OpsEventSeverity | null {
  if (!raw) return null;
  const lower = raw.toLowerCase() as OpsEventSeverity;
  return VALID_SEVERITIES.includes(lower) ? lower : null;
}

function parseSinceIso(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to serve ops events feed",
      new Error("CRON_SECRET missing"),
      {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        failureType: "cron_secret_missing",
      },
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  const limit = parseLimit(req.nextUrl.searchParams.get("limit"));
  const severity = parseSeverity(req.nextUrl.searchParams.get("severity"));
  const since = parseSinceIso(req.nextUrl.searchParams.get("since"));
  const source = req.nextUrl.searchParams.get("source");
  const includeArchived = req.nextUrl.searchParams.get("include_archived") === "true";

  type EventsQuery = {
    eq: (col: string, val: unknown) => EventsQuery;
    gt: (col: string, val: unknown) => EventsQuery;
    is: (col: string, val: unknown) => EventsQuery;
    like: (col: string, pattern: string) => EventsQuery;
    order: (col: string, opts: { ascending: boolean }) => EventsQuery;
    limit: (n: number) => Promise<{ data: unknown; error: { message?: string } | null }>;
  };
  let query = (supabaseAdmin
    .from("ops_events") as unknown as { select: (cols: string) => EventsQuery })
    .select(
      "id, fingerprint, source, severity, title, message, route, user_id, instance_id, conversation_id, profile_name, metadata, sample_stack, environment, occurrence_count, first_seen_at, last_seen_at, archived_at, archived_by_user_id",
    )
    .order("last_seen_at", { ascending: false });

  if (!includeArchived) {
    query = query.is("archived_at", null);
  }
  if (severity) {
    query = query.eq("severity", severity);
  }
  if (since) {
    query = query.gt("last_seen_at", since);
  }
  if (source) {
    // Documented behaviour: a trailing '*' (e.g. source=managed-venice-*) is a
    // prefix match; anything else is an exact match. Escape LIKE wildcards in
    // the user-supplied prefix so '%'/'_' in the source aren't treated as
    // patterns, then append '%' for the prefix.
    if (source.endsWith("*")) {
      const prefix = source.slice(0, -1).replace(/[%_\\]/g, (ch) => `\\${ch}`);
      query = query.like("source", `${prefix}%`);
    } else {
      query = query.eq("source", source);
    }
  }

  const { data, error } = await query.limit(limit);
  if (error) {
    log.error("ops events feed query failed", error as unknown as Error, {
      source: SOURCE,
      route: ROUTE,
      failureType: "ops_events_feed_query_failed",
      errorMessage: error.message,
    });
    return apiError("Failed to fetch ops events", 500);
  }

  const events = Array.isArray(data)
    ? (data as Array<{ last_seen_at?: string | null }>)
    : [];
  // Cursor = the newest last_seen_at we returned. Caller passes it back as
  // `?since=` next time to fetch only events that have ticked since.
  const nextSince =
    events.length > 0 ? events[0].last_seen_at ?? null : since ?? null;

  return apiSuccess({
    events,
    count: events.length,
    nextSince,
    fetchedAt: new Date().toISOString(),
    filters: { severity, source, since, limit, includeArchived },
  });
}
