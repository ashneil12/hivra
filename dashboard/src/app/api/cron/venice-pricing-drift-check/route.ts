import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { resolveManagedVeniceUpstreamKey } from "@/lib/venice/upstream-keys";
import {
  VENICE_CHAT_MODEL_PRICES,
  checkVeniceChatPricingCatalogStaleness,
} from "@/lib/venice/pricing";

const ROUTE = "/api/cron/venice-pricing-drift-check";
const SOURCE = "venice-pricing-drift-check";

// Fetch Venice's live text-model catalog so we can diff each per-token rate
// against our hardcoded numbers. Anything off — even by a fraction of a
// cent per million tokens — is real drift that we'll either over- or
// under-bill on every subsequent chat completion.
const VENICE_LIVE_MODELS_URL = "https://api.venice.ai/api/v1/models?type=text";
const FETCH_TIMEOUT_MS = 8_000;

// Tolerance band (microdollars-per-million) below which a rate delta is treated
// as float-rounding noise from the USD-float → microdollar-int conversion, not
// real drift. Without this, a sub-microdollar rounding rev fires a noisy weekly
// alert. 1 µ-USD/M is far below any meaningful price change.
const RATE_DRIFT_TOLERANCE_MICRO_USD_PER_MILLION = 1;

function rateDrifted(liveMicro: number | null, catalogMicro: number | null): boolean {
  if ((liveMicro ?? null) === (catalogMicro ?? null)) return false;
  // One side null and the other not = a real shape change (e.g. cache pricing
  // appeared/disappeared); always report.
  if (liveMicro == null || catalogMicro == null) return true;
  return Math.abs(liveMicro - catalogMicro) > RATE_DRIFT_TOLERANCE_MICRO_USD_PER_MILLION;
}

export const dynamic = "force-dynamic";

interface LiveModelPricing {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number | null;
}

interface PriceDrift {
  model: string;
  field: "input" | "output" | "cache_read";
  catalogUsdPerMillion: number;
  liveUsdPerMillion: number | null;
  deltaUsdPerMillion: number | null;
}

interface DriftReport {
  driftedModels: PriceDrift[];
  catalogModelsRemovedFromVenice: string[];
  newModelsOnVeniceNotInCatalog: string[];
}

function readUsdNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function parseLiveEntry(entry: unknown): { id: string; pricing: LiveModelPricing } | null {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  if (!id) return null;

  const spec = (obj.model_spec || {}) as Record<string, unknown>;
  // Venice has shipped two pricing shapes; tolerate both so a rev between
  // them doesn't blank the diff.
  const pricing = (spec.pricing || spec) as Record<string, unknown>;
  const inputBlock = (pricing.input || {}) as Record<string, unknown>;
  const outputBlock = (pricing.output || {}) as Record<string, unknown>;
  const cacheInputBlock = (pricing.cache_input || {}) as Record<string, unknown>;

  const inputUsd = readUsdNumber(inputBlock.usd);
  const outputUsd = readUsdNumber(outputBlock.usd);
  if (inputUsd == null || outputUsd == null) return null;

  return {
    id,
    pricing: {
      inputUsd,
      outputUsd,
      cacheReadUsd: readUsdNumber(cacheInputBlock.usd),
    },
  };
}

async function fetchLiveVenicePricing(): Promise<Map<string, LiveModelPricing> | null> {
  const resolvedKey = resolveManagedVeniceUpstreamKey({
    endpoint: "/api/v1/models?type=text",
  });
  if (!resolvedKey) {
    log.warn("venice-pricing-drift-check skipping live diff — no Venice upstream key configured", {
      source: SOURCE,
      route: ROUTE,
      failureType: "venice_upstream_key_missing",
    });
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(VENICE_LIVE_MODELS_URL, {
      headers: { Authorization: `Bearer ${resolvedKey.key}` },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    log.warn("venice-pricing-drift-check live fetch failed", {
      source: SOURCE,
      route: ROUTE,
      failureType: "venice_live_fetch_failed",
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    log.warn("venice-pricing-drift-check live fetch returned non-2xx", {
      source: SOURCE,
      route: ROUTE,
      failureType: "venice_live_fetch_non_2xx",
      status: response.status,
    });
    return null;
  }

  const json = (await response.json()) as { data?: unknown };
  const items = Array.isArray(json.data) ? json.data : [];
  const map = new Map<string, LiveModelPricing>();
  for (const item of items) {
    const parsed = parseLiveEntry(item);
    if (parsed) map.set(parsed.id, parsed.pricing);
  }
  return map;
}

function buildDriftReport(
  liveMap: Map<string, LiveModelPricing>,
): DriftReport {
  const driftedModels: PriceDrift[] = [];
  const catalogModelsRemovedFromVenice: string[] = [];

  // Catalog stores prices as microdollars-per-million (integers). Live API
  // returns USD-per-million as floats. Compare in microdollars to avoid
  // float-equality silliness; treat any non-zero delta as drift.
  for (const entry of VENICE_CHAT_MODEL_PRICES) {
    const live = liveMap.get(entry.model);
    if (!live) {
      catalogModelsRemovedFromVenice.push(entry.model);
      continue;
    }

    const liveInputMicro = Math.round(live.inputUsd * 1_000_000);
    const liveOutputMicro = Math.round(live.outputUsd * 1_000_000);
    const liveCacheMicro =
      live.cacheReadUsd == null ? null : Math.round(live.cacheReadUsd * 1_000_000);

    if (rateDrifted(liveInputMicro, entry.inputMicroUsdPerMillion)) {
      driftedModels.push({
        model: entry.model,
        field: "input",
        catalogUsdPerMillion: entry.inputMicroUsdPerMillion / 1_000_000,
        liveUsdPerMillion: live.inputUsd,
        deltaUsdPerMillion: live.inputUsd - entry.inputMicroUsdPerMillion / 1_000_000,
      });
    }
    if (rateDrifted(liveOutputMicro, entry.outputMicroUsdPerMillion)) {
      driftedModels.push({
        model: entry.model,
        field: "output",
        catalogUsdPerMillion: entry.outputMicroUsdPerMillion / 1_000_000,
        liveUsdPerMillion: live.outputUsd,
        deltaUsdPerMillion: live.outputUsd - entry.outputMicroUsdPerMillion / 1_000_000,
      });
    }
    if (rateDrifted(liveCacheMicro, entry.cacheReadMicroUsdPerMillion ?? null)) {
      driftedModels.push({
        model: entry.model,
        field: "cache_read",
        catalogUsdPerMillion:
          entry.cacheReadMicroUsdPerMillion == null
            ? 0
            : entry.cacheReadMicroUsdPerMillion / 1_000_000,
        liveUsdPerMillion: live.cacheReadUsd,
        deltaUsdPerMillion:
          live.cacheReadUsd == null || entry.cacheReadMicroUsdPerMillion == null
            ? null
            : live.cacheReadUsd - entry.cacheReadMicroUsdPerMillion / 1_000_000,
      });
    }
  }

  const catalogIds = new Set(VENICE_CHAT_MODEL_PRICES.map((p) => p.model));
  const newModelsOnVeniceNotInCatalog: string[] = [];
  for (const liveId of liveMap.keys()) {
    if (!catalogIds.has(liveId)) newModelsOnVeniceNotInCatalog.push(liveId);
  }

  return { driftedModels, catalogModelsRemovedFromVenice, newModelsOnVeniceNotInCatalog };
}

function formatDriftSummary(report: DriftReport): string {
  const lines: string[] = [];
  if (report.driftedModels.length > 0) {
    lines.push(`${report.driftedModels.length} per-token rate(s) drifted from Venice's live prices:`);
    for (const d of report.driftedModels.slice(0, 25)) {
      lines.push(
        `  - ${d.model}.${d.field}: catalog $${d.catalogUsdPerMillion}/M → live $${d.liveUsdPerMillion}/M`,
      );
    }
    if (report.driftedModels.length > 25) {
      lines.push(`  ... ${report.driftedModels.length - 25} more`);
    }
  }
  if (report.catalogModelsRemovedFromVenice.length > 0) {
    lines.push(
      `${report.catalogModelsRemovedFromVenice.length} catalog model(s) no longer in Venice's /v1/models:`,
    );
    lines.push(`  ${report.catalogModelsRemovedFromVenice.join(", ")}`);
  }
  if (report.newModelsOnVeniceNotInCatalog.length > 0) {
    lines.push(
      `${report.newModelsOnVeniceNotInCatalog.length} new model(s) on Venice not yet in our catalog (informational — they 503 in managed Venice until added):`,
    );
    lines.push(`  ${report.newModelsOnVeniceNotInCatalog.join(", ")}`);
  }
  return lines.join("\n");
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        failureType: "cron_secret_missing",
      }
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  const staleness = checkVeniceChatPricingCatalogStaleness();

  if (staleness.stale) {
    try {
      await reportOpsEvent({
        source: SOURCE,
        severity: "warn",
        title: `Venice pricing catalog has not been refreshed for ${staleness.ageDays} days`,
        message:
          `The hardcoded Venice chat pricing catalog was last updated on ` +
          `${staleness.updatedAt} (${staleness.ageDays}d ago, threshold ` +
          `${staleness.maxAgeDays}d). Verify the per-model rates against ` +
          `https://docs.venice.ai/api-reference/api-spec#text-models and ` +
          `update VENICE_CHAT_MODEL_PRICES + ` +
          `VENICE_CHAT_PRICING_CATALOG_UPDATED_AT in ` +
          `dashboard/src/lib/venice/pricing.ts.`,
        route: ROUTE,
        metadata: {
          failureType: "venice_pricing_catalog_stale",
          recoveryAction: "refresh_venice_pricing_catalog",
          catalogUpdatedAt: staleness.updatedAt,
          ageDays: staleness.ageDays,
          maxAgeDays: staleness.maxAgeDays,
          modelCount: VENICE_CHAT_MODEL_PRICES.length,
        },
      });
    } catch (err) {
      log.warn("venice-pricing-drift-check could not report ops event", {
        source: SOURCE,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const liveMap = await fetchLiveVenicePricing();
  if (liveMap === null) {
    // The live diff is the only thing that catches a Venice-side price change
    // we haven't mirrored. If it can NEVER run (missing/invalid upstream key,
    // persistent fetch failure) the route still 200s with liveCheckRan:false,
    // so drift would go undetected forever while the cron silently reports
    // success. Surface that as a warn ops event so a permanently-misconfigured
    // key is visible. Wrapped so the alert transport can't fail the cron.
    try {
      await reportOpsEvent({
        source: SOURCE,
        severity: "warn",
        title: "Venice pricing drift check could not run its live diff",
        message:
          `The live Venice /v1/models diff was skipped this run (no upstream key, ` +
          `or the fetch failed/timed out). While it can't run, a Venice-side price ` +
          `change is NOT detected even though the cron returns success. Verify a ` +
          `managed-Venice upstream key is configured and Venice is reachable.`,
        route: ROUTE,
        metadata: {
          failureType: "venice_pricing_live_diff_unavailable",
          recoveryAction: "verify_managed_venice_upstream_key_and_reachability",
          catalogModelCount: VENICE_CHAT_MODEL_PRICES.length,
        },
      });
    } catch (err) {
      log.warn("venice-pricing-drift-check could not report live-diff-unavailable ops event", {
        source: SOURCE,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  let driftReport: DriftReport | null = null;
  if (liveMap) {
    driftReport = buildDriftReport(liveMap);
    const hasDrift =
      driftReport.driftedModels.length > 0 ||
      driftReport.catalogModelsRemovedFromVenice.length > 0 ||
      // New models live on Venice but absent from our catalog 503 in managed
      // Venice until added, so they're actionable drift — include them in the
      // alert condition (they were previously only reported in metadata when
      // some OTHER drift happened to fire).
      driftReport.newModelsOnVeniceNotInCatalog.length > 0;
    if (hasDrift) {
      try {
        await reportOpsEvent({
          source: SOURCE,
          severity: "warn",
          title:
            `Venice pricing drift: ${driftReport.driftedModels.length} rate change(s), ` +
            `${driftReport.catalogModelsRemovedFromVenice.length} model(s) removed`,
          message:
            `${formatDriftSummary(driftReport)}\n\n` +
            `Resync VENICE_CHAT_MODEL_PRICES in dashboard/src/lib/venice/pricing.ts ` +
            `from Venice's live /v1/models?type=text response and bump ` +
            `VENICE_CHAT_PRICING_CATALOG_UPDATED_AT.`,
          route: ROUTE,
          metadata: {
            failureType: "venice_pricing_live_drift",
            recoveryAction: "resync_venice_pricing_catalog",
            driftedRateCount: driftReport.driftedModels.length,
            removedModelCount: driftReport.catalogModelsRemovedFromVenice.length,
            newModelCount: driftReport.newModelsOnVeniceNotInCatalog.length,
            driftedModels: driftReport.driftedModels.slice(0, 50),
            catalogModelsRemovedFromVenice: driftReport.catalogModelsRemovedFromVenice,
            newModelsOnVeniceNotInCatalog: driftReport.newModelsOnVeniceNotInCatalog,
          },
        });
      } catch (err) {
        log.warn("venice-pricing-drift-check could not report live-drift ops event", {
          source: SOURCE,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return apiSuccess({
    stale: staleness.stale,
    catalogUpdatedAt: staleness.updatedAt,
    ageDays: staleness.ageDays,
    maxAgeDays: staleness.maxAgeDays,
    modelCount: VENICE_CHAT_MODEL_PRICES.length,
    liveCheckRan: liveMap !== null,
    liveModelCount: liveMap?.size ?? 0,
    driftedRateCount: driftReport?.driftedModels.length ?? 0,
    catalogModelsRemovedFromVenice: driftReport?.catalogModelsRemovedFromVenice ?? [],
    newModelsOnVeniceNotInCatalog: driftReport?.newModelsOnVeniceNotInCatalog ?? [],
    driftedModels: driftReport?.driftedModels ?? [],
    models: VENICE_CHAT_MODEL_PRICES.map((price) => ({
      model: price.model,
      inputUsdPerMillion: price.inputMicroUsdPerMillion / 1_000_000,
      outputUsdPerMillion: price.outputMicroUsdPerMillion / 1_000_000,
      cacheReadUsdPerMillion:
        price.cacheReadMicroUsdPerMillion == null
          ? null
          : price.cacheReadMicroUsdPerMillion / 1_000_000,
    })),
  });
}
