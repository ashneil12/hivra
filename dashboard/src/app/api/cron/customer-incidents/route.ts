import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { runCustomerIncidentScan } from "@/lib/recovery/customer-incidents";

/**
 * Cron-triggered customer-impact incident detection. Evaluates the rules in
 * src/lib/recovery/customer-incidents.ts (box down, launch failed, lifecycle
 * stuck, cron unhealthy), pages an admin with a full diagnosis bundle for each
 * newly-open incident, and resolves incidents whose condition cleared.
 *
 * Schedule: every 5 minutes via vercel.json.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "customer-incidents",
        route: "/api/cron/customer-incidents",
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
    const summary = await runCustomerIncidentScan();
    // A pass that aborted on a collection failure or could not read some
    // subjects' watchdog events recorded an incomplete picture — that is a
    // degraded run, not a clean one.
    const problems: string[] = [];
    if (summary.failed > 0) problems.push(`failed=${summary.failed}`);
    if (summary.degraded > 0) problems.push(`degraded=${summary.degraded}`);
    await recordCronHeartbeat(
      "customer-incidents",
      problems.length > 0 ? { ok: false, detail: problems.join(" ") } : undefined,
    );
    return apiSuccess(summary);
  } catch (err) {
    log.error("customer incident scan failed", err, {
      source: "customer-incidents",
      route: "/api/cron/customer-incidents",
      method: "GET",
      failureType: "customer_incident_scan_failed",
    });
    // A thrown scan recorded nothing — count it as a failed run so repeated
    // exceptions advance the heartbeat's failure streak. recordCronHeartbeat
    // never throws.
    await recordCronHeartbeat("customer-incidents", { ok: false, detail: "scan threw" });
    const message = err instanceof Error ? err.message : "Customer incident scan failed";
    return apiError(message, 500);
  }
}
