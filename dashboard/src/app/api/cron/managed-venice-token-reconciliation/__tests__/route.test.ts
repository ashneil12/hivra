import { NextRequest } from "next/server";

import { GET } from "../route";
import { reconcilePendingManagedVeniceTokenQuotes } from "@/lib/billing/managed-venice-token-reconciliation";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

jest.mock("@/lib/billing/managed-venice-token-reconciliation", () => ({
  reconcilePendingManagedVeniceTokenQuotes: jest.fn(),
}));

// The route now guards on a present DB client (like sibling billing crons);
// provide a truthy stub so the happy paths run.
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}) },
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

function req(authorization?: string, url = "https://example/api/cron/managed-venice-token-reconciliation") {
  return new NextRequest(url, {
    headers: authorization ? { authorization } : {},
  });
}

describe("GET /api/cron/managed-venice-token-reconciliation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
    (reconcilePendingManagedVeniceTokenQuotes as jest.Mock).mockResolvedValue({
      checked: 2,
      settled: 1,
      underconfirmed: 0,
      noMatch: 1,
      manualReview: 0,
      skipped: 0,
      failed: 0,
      results: [],
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rejects requests without the cron bearer", async () => {
    const response = await GET(req());

    expect(response.status).toBe(401);
    expect(reconcilePendingManagedVeniceTokenQuotes).not.toHaveBeenCalled();
  });

  it("runs pending token quote reconciliation with a bounded limit", async () => {
    const response = await GET(req(
      "Bearer cron-secret",
      "https://example/api/cron/managed-venice-token-reconciliation?limit=50"
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(reconcilePendingManagedVeniceTokenQuotes).toHaveBeenCalledWith({ limit: 50 });
    expect(body.data).toMatchObject({
      checked: 2,
      settled: 1,
      noMatch: 1,
      failed: 0,
    });
  });

  it("logs a warning when individual quote reconciliation fails but keeps the cron successful", async () => {
    (reconcilePendingManagedVeniceTokenQuotes as jest.Mock).mockResolvedValueOnce({
      checked: 1,
      settled: 0,
      underconfirmed: 0,
      noMatch: 0,
      manualReview: 0,
      skipped: 0,
      failed: 1,
      results: [
        {
          quoteId: "quote_1",
          userId: "user_1",
          status: "failed",
          errorName: "Error",
          errorMessage: "Base RPC timeout",
        },
      ],
    });

    const response = await GET(req("Bearer cron-secret"));

    expect(response.status).toBe(200);
    expect(log.warn).toHaveBeenCalledWith(
      "managed Venice token reconciliation completed with quote failures",
      expect.objectContaining({
        source: "cron:managed-venice-token-reconciliation",
        route: "/api/cron/managed-venice-token-reconciliation",
        failureType: "managed_venice_token_reconciliation_partial_failure",
        failed: 1,
        failedQuotes: [
          {
            quoteId: "quote_1",
            userId: "user_1",
            errorName: "Error",
            errorMessage: "Base RPC timeout",
          },
        ],
      })
    );
    // Failures must also surface on the ops feed, not just in logs.
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "cron:managed-venice-token-reconciliation",
        severity: "error",
        metadata: expect.objectContaining({
          failureType: "managed_venice_token_reconciliation_partial_failure",
          failed: 1,
        }),
      })
    );
  });

  it("clamps an oversized limit to the bounded maximum", async () => {
    const response = await GET(req(
      "Bearer cron-secret",
      "https://example/api/cron/managed-venice-token-reconciliation?limit=100000"
    ));

    expect(response.status).toBe(200);
    expect(reconcilePendingManagedVeniceTokenQuotes).toHaveBeenCalledWith({ limit: 100 });
  });

  it("returns a safe 500 when the batch query fails", async () => {
    (reconcilePendingManagedVeniceTokenQuotes as jest.Mock).mockRejectedValueOnce(
      new Error("database secret detail")
    );

    const response = await GET(req("Bearer cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to reconcile managed Venice token deposits");
    expect(JSON.stringify(body)).not.toContain("database secret detail");
    expect(log.error).toHaveBeenCalledWith(
      "managed Venice token reconciliation cron failed",
      expect.any(Error),
      expect.objectContaining({
        failureType: "managed_venice_token_reconciliation_cron_failed",
      })
    );
  });
});
