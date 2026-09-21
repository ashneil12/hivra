import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { syncProviderModelCatalogs } from "@/lib/services/provider-model-sync";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("missing CRON_SECRET"), {
      source: "sync-provider-models",
      route: "/api/cron/sync-provider-models",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  let results: Awaited<ReturnType<typeof syncProviderModelCatalogs>>;
  try {
    results = await syncProviderModelCatalogs();
  } catch (error) {
    // The helper records per-provider failures internally, but if the WHOLE
    // helper throws there was previously no structured log + the route 500'd
    // bare. Log + ops-event so a total catalog-sync outage is visible.
    log.error("provider model catalog sync threw", error, {
      source: "sync-provider-models",
      route: "/api/cron/sync-provider-models",
      method: "GET",
      failureType: "provider_model_sync_failed",
    });
    await reportOpsEvent({
      source: "cron.sync-provider-models",
      severity: "warn",
      title: "Provider model catalog sync failed",
      message:
        "syncProviderModelCatalogs threw before returning. The dashboard's model pickers and " +
        "pricing may go stale until the next successful run.",
      route: "/api/cron/sync-provider-models",
      metadata: {
        failureType: "provider_model_sync_failed",
        errorName: error instanceof Error ? error.name : typeof error,
      },
    });
    return apiError("Failed to sync provider model catalogs", 500, {
      failureType: "provider_model_sync_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }

  const changedProviders = results.filter((result) => result.changed).map((result) => result.provider);
  const failedProviders = results.filter((result) => !result.checked).map((result) => result.provider);

  // Per-provider failures were surfaced only in the JSON body — a provider
  // whose catalog fetch breaks every run was invisible. Breadcrumb it.
  if (failedProviders.length > 0) {
    await reportOpsEvent({
      source: "cron.sync-provider-models",
      severity: "warn",
      title: `Provider model sync: ${failedProviders.length} provider(s) failed`,
      message:
        `${failedProviders.length} provider catalog(s) failed to refresh this run ` +
        `(${failedProviders.join(", ")}). If the same provider keeps failing, its model picker / ` +
        `pricing drifts stale.`,
      route: "/api/cron/sync-provider-models",
      metadata: {
        failureType: "provider_model_sync_partial_failure",
        failedProviders,
        checked: results.length,
      },
    });
  }

  return apiSuccess({
    checked: results.length,
    changed: changedProviders.length,
    failed: failedProviders.length,
    changedProviders,
    failedProviders,
    results,
  });
}
