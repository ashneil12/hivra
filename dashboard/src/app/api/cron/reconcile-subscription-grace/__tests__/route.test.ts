/** @jest-environment node */
import { NextRequest } from "next/server";
import { GET } from "../route";
import { runHivraLapseSweep } from "@/lib/recovery/hivra-lapse-enforce";
import { sweepBillingSuspendedCompute } from "@/lib/recovery/dunning-grace-enforce";
import { reconcileSubscriptionGrace } from "@/lib/billing/subscription-grace-reconciler";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn() }));
jest.mock("@/lib/billing/subscription-grace-reconciler", () => ({
  GRACE_RECONCILER_LOG_SOURCE: "subscription-grace-reconciler",
  reconcileSubscriptionGrace: jest.fn(),
}));
jest.mock("@/lib/recovery/dunning-grace-enforce", () => ({ sweepBillingSuspendedCompute: jest.fn() }));
jest.mock("@/lib/recovery/hivra-lapse-enforce", () => ({ runHivraLapseSweep: jest.fn() }));

const original = process.env.CRON_SECRET;
const call = () => GET(new NextRequest("https://hivra.cloud/api/cron/reconcile-subscription-grace", { headers: { authorization: "Bearer cron-secret" } }));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "cron-secret";
  (reconcileSubscriptionGrace as jest.Mock).mockResolvedValue({ scanned: 3, syncedCanceled: 0, skipped: 3, errors: 0 });
  (runHivraLapseSweep as jest.Mock).mockResolvedValue({ live: false, running: 0, lapsed: 0, stopped: 0, failed: 0 });
  (sweepBillingSuspendedCompute as jest.Mock).mockResolvedValue({ live: false, picked: 0, stopped: 0, failed: 0 });
});
afterAll(() => { if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original; });

describe("reconcile-subscription-grace cron", () => {
  it("runs the unpaid-computer sweep after the reconcile", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(runHivraLapseSweep).toHaveBeenCalledTimes(1);
  });

  it("is not broken by a sweep failure", async () => {
    (runHivraLapseSweep as jest.Mock).mockRejectedValue(new Error("sweep exploded"));
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { scanned: 3 } });
  });

  it("runs the cancelled-computer sweep, and a failure in it breaks neither the route nor the other sweep", async () => {
    (sweepBillingSuspendedCompute as jest.Mock).mockRejectedValue(new Error("sweep exploded"));
    const response = await call();
    expect(response.status).toBe(200);
    expect(sweepBillingSuspendedCompute).toHaveBeenCalledTimes(1);
    expect(runHivraLapseSweep).toHaveBeenCalledTimes(1);
  });

  it("does not run the sweep for an unauthorised caller", async () => {
    const response = await GET(new NextRequest("https://hivra.cloud/api/cron/reconcile-subscription-grace"));
    expect(response.status).toBe(401);
    expect(runHivraLapseSweep).not.toHaveBeenCalled();
    expect(sweepBillingSuspendedCompute).not.toHaveBeenCalled();
  });
});
