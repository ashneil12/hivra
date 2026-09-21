/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

const mockReportOpsEvent = jest.fn();

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: (...args: unknown[]) => mockReportOpsEvent(...args),
  // The shared logger imports sanitizeOpsMetadata to scrub PII before
  // mirroring warnings into ops_events. Re-export a passthrough so the
  // import succeeds without re-implementing the real scrubber here.
  sanitizeOpsMetadata: (m: Record<string, unknown> | undefined) => m ?? {},
}));

import { VENICE_CHAT_MODEL_PRICES } from "@/lib/venice/pricing";
import { GET } from "../route";

const originalFetch = global.fetch;
const originalCronSecret = process.env.CRON_SECRET;
const originalApiKey = process.env.VENICE_API_KEY;
const originalInferenceKeys = process.env.MANAGED_VENICE_INFERENCE_KEYS;

function mockReq(secret = "test-cron-secret") {
  return new NextRequest("http://localhost/api/cron/venice-pricing-drift-check", {
    method: "GET",
    headers: { authorization: `Bearer ${secret}` },
  });
}

function buildLiveResponse(overrides: Record<string, { input: number; output: number; cache_input?: number }> = {}) {
  // Live response = our catalog as the baseline, with overrides applied so a
  // test can target one model's drift without redeclaring the whole table.
  const data = VENICE_CHAT_MODEL_PRICES.map((entry) => {
    const override = overrides[entry.model];
    const input =
      override?.input ?? entry.inputMicroUsdPerMillion / 1_000_000;
    const output =
      override?.output ?? entry.outputMicroUsdPerMillion / 1_000_000;
    const cacheRead =
      override && "cache_input" in override
        ? override.cache_input
        : entry.cacheReadMicroUsdPerMillion == null
          ? null
          : entry.cacheReadMicroUsdPerMillion / 1_000_000;

    const pricing: Record<string, unknown> = {
      input: { usd: input },
      output: { usd: output },
    };
    if (cacheRead != null) pricing.cache_input = { usd: cacheRead };

    return {
      id: entry.model,
      model_spec: { pricing },
    };
  });
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.VENICE_API_KEY = "venice_test_key";
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalCronSecret;
  }
  if (originalApiKey === undefined) {
    delete process.env.VENICE_API_KEY;
  } else {
    process.env.VENICE_API_KEY = originalApiKey;
  }
  if (originalInferenceKeys === undefined) {
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
  } else {
    process.env.MANAGED_VENICE_INFERENCE_KEYS = originalInferenceKeys;
  }
});

describe("GET /api/cron/venice-pricing-drift-check", () => {
  it("rejects requests without the cron bearer", async () => {
    const response = await GET(mockReq("wrong-secret"));
    expect(response.status).toBe(401);
    expect(global.fetch).toBe(originalFetch);
  });

  it("returns no drift when live prices match the catalog exactly", async () => {
    global.fetch = jest.fn().mockResolvedValue(buildLiveResponse());

    const response = await GET(mockReq());
    const body = (await response.json()) as { data: { driftedRateCount: number; liveCheckRan: boolean } };

    expect(response.status).toBe(200);
    expect(body.data.liveCheckRan).toBe(true);
    expect(body.data.driftedRateCount).toBe(0);
    // No drift → no live-drift ops event. (Staleness alert is independent.)
    const driftAlerts = mockReportOpsEvent.mock.calls.filter(
      ([arg]) => arg?.metadata?.failureType === "venice_pricing_live_drift",
    );
    expect(driftAlerts).toHaveLength(0);
  });

  it("detects per-model rate drift and fires a live-drift ops alert", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      buildLiveResponse({
        "deepseek-v4-flash": { input: 0.99, output: 0.35, cache_input: 0.028 },
      }),
    );

    const response = await GET(mockReq());
    const body = (await response.json()) as {
      data: { driftedRateCount: number; driftedModels: Array<Record<string, unknown>> };
    };

    expect(response.status).toBe(200);
    expect(body.data.driftedRateCount).toBe(1);
    expect(body.data.driftedModels[0]).toMatchObject({
      model: "deepseek-v4-flash",
      field: "input",
      catalogUsdPerMillion: 0.17,
      liveUsdPerMillion: 0.99,
    });

    const driftAlerts = mockReportOpsEvent.mock.calls.filter(
      ([arg]) => arg?.metadata?.failureType === "venice_pricing_live_drift",
    );
    expect(driftAlerts).toHaveLength(1);
    expect(driftAlerts[0][0].metadata.driftedRateCount).toBe(1);
  });

  it("flags catalog models that disappeared from Venice's live response", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: VENICE_CHAT_MODEL_PRICES.filter((p) => p.model !== "deepseek-v4-flash").map((entry) => ({
            id: entry.model,
            model_spec: {
              pricing: {
                input: { usd: entry.inputMicroUsdPerMillion / 1_000_000 },
                output: { usd: entry.outputMicroUsdPerMillion / 1_000_000 },
              },
            },
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const response = await GET(mockReq());
    const body = (await response.json()) as {
      data: { catalogModelsRemovedFromVenice: string[]; driftedRateCount: number };
    };

    expect(response.status).toBe(200);
    expect(body.data.catalogModelsRemovedFromVenice).toContain("deepseek-v4-flash");

    const driftAlerts = mockReportOpsEvent.mock.calls.filter(
      ([arg]) => arg?.metadata?.failureType === "venice_pricing_live_drift",
    );
    expect(driftAlerts).toHaveLength(1);
    expect(driftAlerts[0][0].metadata.removedModelCount).toBeGreaterThanOrEqual(1);
  });

  it("alerts on new Venice models that aren't in our catalog yet (they 503 in managed Venice until added)", async () => {
    // Start from buildLiveResponse (which includes cache_input for catalog
    // entries that have it) so we only diff one new model, not phantom cache
    // mismatches.
    const baseline = buildLiveResponse();
    const baselineJson = (await baseline.clone().json()) as { data: Array<Record<string, unknown>> };
    baselineJson.data.push({
      id: "venice-new-model-future",
      model_spec: { pricing: { input: { usd: 0.1 }, output: { usd: 0.4 } } },
    });
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify(baselineJson), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await GET(mockReq());
    const body = (await response.json()) as {
      data: { newModelsOnVeniceNotInCatalog: string[] };
    };

    expect(response.status).toBe(200);
    expect(body.data.newModelsOnVeniceNotInCatalog).toContain("venice-new-model-future");

    // A new Venice model the catalog doesn't have 503s in managed Venice until
    // added, so it IS actionable drift and now fires the live-drift alert
    // (previously it was silently swallowed unless some other drift happened).
    const driftAlerts = mockReportOpsEvent.mock.calls.filter(
      ([arg]) => arg?.metadata?.failureType === "venice_pricing_live_drift",
    );
    expect(driftAlerts).toHaveLength(1);
    expect(driftAlerts[0][0].metadata.newModelCount).toBeGreaterThanOrEqual(1);
  });

  it("skips live diff gracefully when VENICE_API_KEY isn't configured", async () => {
    delete process.env.VENICE_API_KEY;
    global.fetch = jest.fn();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const response = await GET(mockReq());
    const body = (await response.json()) as { data: { liveCheckRan: boolean; driftedRateCount: number } };

    expect(response.status).toBe(200);
    expect(body.data.liveCheckRan).toBe(false);
    expect(body.data.driftedRateCount).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("uses the managed inference key pool for live drift checks before the legacy key", async () => {
    process.env.MANAGED_VENICE_INFERENCE_KEYS = JSON.stringify(["cron_pool_key"]);
    process.env.VENICE_API_KEY = "legacy_cron_key";
    const fetchMock = jest.fn().mockResolvedValue(buildLiveResponse());
    global.fetch = fetchMock;

    const response = await GET(mockReq());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.venice.ai/api/v1/models?type=text",
      expect.objectContaining({
        headers: { Authorization: "Bearer cron_pool_key" },
      })
    );
  });

  it("skips live diff gracefully when Venice returns a non-2xx", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const response = await GET(mockReq());
    const body = (await response.json()) as { data: { liveCheckRan: boolean } };

    expect(response.status).toBe(200);
    expect(body.data.liveCheckRan).toBe(false);
    warnSpy.mockRestore();
  });
});
