import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { runCloudflareDnsReconcile } from "@/lib/recovery/cloudflare-dns-reconcile";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

// When the destructive sweep is disabled, surface the would-delete backlog on
// the ops feed only once it crosses this size — otherwise an operator has to
// curl the route to discover records are leaking toward the zone-record cap.
const WOULD_DELETE_ALERT_THRESHOLD = 50;

/**
 * Cron-triggered Cloudflare DNS reconciliation. See
 * src/lib/recovery/cloudflare-dns-reconcile.ts.
 *
 * Lists every A record under `<sub>.<CLOUDFLARE_DNS_DOMAIN>`, joins it
 * against `hermes_instances.subdomain` for live rows, and deletes any
 * record with no matching live instance — gated by
 * CLOUDFLARE_DNS_RECONCILE_ENABLED. With the flag off the sweep returns
 * the would-delete list without touching the zone.
 *
 * Schedule: hourly. Records leak from cross-host migrations and the
 * best-effort delete fallback; hourly catches them well before any
 * zone-record cap matters.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "reconcile-cloudflare-dns",
        route: "/api/cron/reconcile-cloudflare-dns",
        method: "GET",
        failureType: "cron_secret_missing",
      },
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const summary = await runCloudflareDnsReconcile();

    // Flag-off but a real backlog of orphaned records: alert so the permanent
    // no-op doesn't silently let records accumulate toward the zone cap.
    if (!summary.enabled && summary.wouldDeleteCount >= WOULD_DELETE_ALERT_THRESHOLD) {
      await reportOpsEvent({
        source: "cron.reconcile-cloudflare-dns",
        severity: "warn",
        title: `${summary.wouldDeleteCount} orphaned Cloudflare A record(s) pending (sweep disabled)`,
        message:
          `The Cloudflare DNS reconcile sweep is DISABLED (CLOUDFLARE_DNS_RECONCILE_ENABLED off) ` +
          `but ${summary.wouldDeleteCount} orphaned A record(s) have no matching live instance. ` +
          `They keep accumulating toward the zone-record cap. Review the would-delete list, then ` +
          `enable the flag to let the sweep prune them.`,
        route: "/api/cron/reconcile-cloudflare-dns",
        metadata: {
          failureType: "cloudflare_dns_orphans_backlog",
          enabled: summary.enabled,
          wouldDeleteCount: summary.wouldDeleteCount,
          zoneRecordsScanned: summary.zoneRecordsScanned,
          liveSubdomainCount: summary.liveSubdomainCount,
        },
      });
    }

    // Enabled-path delete failures: a record we tried to remove but couldn't.
    if (summary.deleteFailedCount > 0) {
      await reportOpsEvent({
        source: "cron.reconcile-cloudflare-dns",
        severity: "warn",
        title: `${summary.deleteFailedCount} Cloudflare A record delete(s) failed`,
        message:
          `${summary.deleteFailedCount} orphaned A record delete(s) failed during the sweep. ` +
          `Those records remain in the zone and count toward the cap. Check Cloudflare API health.`,
        route: "/api/cron/reconcile-cloudflare-dns",
        metadata: {
          failureType: "cloudflare_dns_delete_failed",
          deleteFailedCount: summary.deleteFailedCount,
          deletedCount: summary.deletedCount,
        },
      });
    }

    return apiSuccess(summary);
  } catch (err) {
    log.error("cloudflare dns reconcile sweep failed", err, {
      source: "reconcile-cloudflare-dns",
      route: "/api/cron/reconcile-cloudflare-dns",
      method: "GET",
      failureType: "cloudflare_dns_reconcile_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Cloudflare DNS reconcile failed";
    return apiError(message, 500);
  }
}
