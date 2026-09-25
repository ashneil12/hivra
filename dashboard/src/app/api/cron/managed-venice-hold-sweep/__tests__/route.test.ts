/**
 * @jest-environment node
 *
 * The stale-hold sweep runs hourly, on its own route (security review
 * 2026-09, #167): inside the daily reconciliation cron one failed settlement
 * held a user's balance for up to two days.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

const mockSweep = jest.fn();

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock("@/lib/venice/reservation-sweep", () => ({
  sweepStaleManagedVeniceReservations: (...args: unknown[]) => mockSweep(...args),
}));

import { GET } from "../route";

function req(secret = "test-cron-secret") {
  return new NextRequest("http://localhost/api/cron/managed-venice-hold-sweep", {
    method: "GET",
    headers: { authorization: `Bearer ${secret}` },
  });
}

describe("GET /api/cron/managed-venice-hold-sweep", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "test-cron-secret";
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    mockSweep.mockResolvedValue({
      scanned: 2,
      closed: 2,
      capturedReservations: 1,
      totalCapturedMicroUsd: 1_000,
      releasedReservations: 1,
      totalReleasedMicroUsd: 500,
      heldForOpenItem: 0,
      failed: 0,
      results: [{ disposition: "captured_hold" }, { disposition: "released_failed_request" }],
    });
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
    jest.restoreAllMocks();
  });

  it("is scheduled hourly", () => {
    const vercel = JSON.parse(readFileSync(path.join(__dirname, "../../../../../../vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const entry = vercel.crons.find((cron) => cron.path === "/api/cron/managed-venice-hold-sweep");
    expect(entry?.schedule).toMatch(/^\d{1,2} \* \* \* \*$/);
  });

  it("refuses a request without the cron secret", async () => {
    const res = await GET(req("wrong"));
    expect(res.status).toBe(401);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it("runs the sweep and reports its totals", async () => {
    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockSweep).toHaveBeenCalledTimes(1);
    expect(body.data).toMatchObject({ scanned: 2, capturedReservations: 1, releasedReservations: 1 });
    expect(body.data.sampleResults).toHaveLength(2);
  });

  it("answers 500 when the sweep throws", async () => {
    mockSweep.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(500);
  });
});
