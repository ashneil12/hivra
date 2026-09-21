import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { buildOpsEventFingerprint, reportOpsEvent } from "@/lib/ops-events";
import type { OpsEventInput } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import {
  buildDroughtOpsEvent,
  buildProbeOpsEvent,
  probeManagedVeniceUpstream,
  resolveManagedVeniceHealthConfig,
  runCaptureDroughtDetector,
  wasOpsEventRecentlyReported,
} from "@/lib/ops/managed-venice-health";

const SOURCE = "cron/managed-venice-health";
const ROUTE = "/api/cron/managed-venice-health";

export const dynamic = "force-dynamic";

// Scheduled by Vercel cron (vercel.json, every 30 min). Watches managed-Venice
// UPSTREAM health — the failure mode the usage-flatline monitor can't see
// quickly: when the upstream Venice account dies (hit $0 in Jul-2026; five
// silent days of 402s), reservations keep being created but nothing captures.
// Detector 1 reads that drought straight off managed_venice_reservations;
// detector 2 probes the upstream key directly and surfaces the remaining
// balance. CRITICAL findings land as severity:'fatal' ops events (paged once
// per fingerprint via the ops-fatal transport), WARNs as 'warn' — both visible
// in /dashboard/ops and the /api/ops/events/feed.
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  const config = resolveManagedVeniceHealthConfig();
  const now = Date.now();

  let drought;
  try {
    drought = await runCaptureDroughtDetector(supabaseAdmin, config, now);
  } catch (err) {
    log.error(
      "managed-Venice health monitor could not read reservations",
      err instanceof Error ? err : new Error("capture_drought_query_failed"),
      {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        failureType: "managed_venice_health_query_failed",
      }
    );
    return apiError("Failed to query managed-Venice reservations", 500);
  }

  // The probe never throws — network/parse failures come back "inconclusive".
  const probe = await probeManagedVeniceUpstream({
    minBalanceUsd: config.minUpstreamBalanceUsd,
  });

  const candidates: OpsEventInput[] = [
    buildDroughtOpsEvent(drought, config, { source: SOURCE, route: ROUTE }),
    buildProbeOpsEvent(probe, { source: SOURCE, route: ROUTE }),
  ].filter((event): event is OpsEventInput => event !== null);

  const dedupeMs = config.dedupeHours * 3_600_000;
  const events: Array<{ title: string; severity: string; deduped: boolean }> = [];

  for (const event of candidates) {
    // Each emit is individually guarded: alerting must never 500 the cron —
    // that would lose the very signal this monitor exists to raise.
    try {
      const fingerprint = buildOpsEventFingerprint({
        source: event.source,
        title: event.title,
        message: event.message,
        route: event.route,
      });
      const recentlyReported = await wasOpsEventRecentlyReported(
        supabaseAdmin,
        fingerprint,
        dedupeMs,
        now
      );
      if (recentlyReported) {
        events.push({
          title: event.title,
          severity: event.severity ?? "error",
          deduped: true,
        });
        continue;
      }
      await reportOpsEvent(event);
      events.push({
        title: event.title,
        severity: event.severity ?? "error",
        deduped: false,
      });
    } catch (err) {
      log.error(
        "managed-Venice health monitor failed to emit an ops event",
        err instanceof Error ? err : new Error("ops_event_emit_failed"),
        {
          source: SOURCE,
          route: ROUTE,
          method: "GET",
          failureType: "managed_venice_health_emit_failed",
          eventTitle: event.title,
        }
      );
    }
  }

  return apiSuccess({
    drought: {
      level: drought.level,
      attempts: drought.attempts,
      captured: drought.captured,
      captureRatio: drought.captureRatio,
      windowStartIso: drought.windowStartIso,
      reason: drought.reason,
    },
    probe: {
      status: probe.status,
      httpStatus: probe.httpStatus,
      balanceUsd: probe.balanceUsd,
      balanceDiem: probe.balanceDiem,
      accessPermitted: probe.accessPermitted,
      keySource: probe.keySource,
      poolSize: probe.poolSize,
      reason: probe.reason,
    },
    events,
  });
}
