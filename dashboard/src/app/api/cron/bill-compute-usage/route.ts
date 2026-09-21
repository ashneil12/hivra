import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { billHourlyComputeUsage } from "@/lib/billing/compute-billing";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

function parseLimit(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get("limit");
  const value = raw ? Number(raw) : 50;
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("missing CRON_SECRET"), {
      source: "bill-compute-usage",
      route: "/api/cron/bill-compute-usage",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const result = await billHourlyComputeUsage({ limit: parseLimit(req) });
    return apiSuccess(result);
  } catch (error) {
    // Money path: a thrown billing failure was previously only surfaced via the
    // HTTP 500 (the catch didn't even log, unlike the missing-secret path).
    // Add a structured log breadcrumb + an ops-event so an hourly compute-billing
    // outage (which means paid VM compute is going unmetered) is visible.
    log.error("hourly compute billing failed", error, {
      source: "bill-compute-usage",
      route: "/api/cron/bill-compute-usage",
      method: "GET",
      failureType: "compute_billing_cron_failed",
    });
    await reportOpsEvent({
      source: "cron.bill-compute-usage",
      severity: "warn",
      title: "Hourly compute billing failed",
      message:
        "billHourlyComputeUsage threw — paid VM compute was NOT metered/charged this hour. " +
        "Sustained failure means under-billing. Investigate the credit-ledger debit path.",
      route: "/api/cron/bill-compute-usage",
      metadata: {
        failureType: "compute_billing_cron_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
    });
    return apiError("Failed to bill compute usage", 500, {
      failureType: "compute_billing_cron_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
