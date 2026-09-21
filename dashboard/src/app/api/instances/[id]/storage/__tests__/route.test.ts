import { NextRequest } from "next/server";

import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getInstanceMeteringRollup } from "@/lib/services/instance-metering";
import { BYTES_PER_GB } from "@/lib/storage-usage";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/services/instance-metering", () => ({
  getInstanceMeteringRollup: jest.fn(),
}));

const mockAuth = auth as unknown as jest.Mock;
const mockFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;
const mockRollup = getInstanceMeteringRollup as unknown as jest.Mock;

function mockInstanceRow(result: { data: unknown; error: unknown }) {
  const builder: Record<string, jest.Mock> = {};
  builder.select = jest.fn(() => builder);
  builder.eq = jest.fn(() => builder);
  builder.neq = jest.fn(() => builder);
  builder.maybeSingle = jest.fn(() => Promise.resolve(result));
  mockFrom.mockReturnValue(builder);
  return builder;
}

function emptyRollup(overrides: Record<string, unknown> = {}) {
  return {
    sample_count: 1,
    first_sampled_at: "2026-06-11T00:00:00Z",
    last_sampled_at: "2026-06-11T06:00:00Z",
    cpu_seconds_total: 0,
    net_out_bytes: 0,
    runtime_seconds: 0,
    ram_peak_bytes: 0,
    disk_used_bytes_last: 0,
    disk_total_bytes_last: 0,
    disk_used_is_capacity_fallback_last: false,
    ...overrides,
  };
}

async function callGet(id = "inst-1") {
  const res = await GET({} as unknown as NextRequest, { params: Promise.resolve({ id }) });
  return { res, body: await res.json() };
}

describe("GET /api/instances/[id]/storage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ userId: "user_123" });
  });

  it("rejects unauthenticated requests", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    const { res } = await callGet();
    expect(res.status).toBe(401);
  });

  it("404s when the instance is not owned or missing", async () => {
    mockInstanceRow({ data: null, error: null });
    const { res, body } = await callGet();
    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
  });

  it("reports an amber warn level between 80% and 95% against the guest df total", async () => {
    mockInstanceRow({ data: { disk_size_gb: 30, resource_tier: "operator", status: "running" }, error: null });
    mockRollup.mockResolvedValue(
      emptyRollup({ disk_used_bytes_last: 25 * BYTES_PER_GB, disk_total_bytes_last: 30 * BYTES_PER_GB })
    );

    const { res, body } = await callGet();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.level).toBe("warn");
    expect(body.data.percent).toBeCloseTo((25 / 30) * 100, 5);
    expect(body.data.disk_used_bytes).toBe(25 * BYTES_PER_GB);
    expect(body.data.provisioned_bytes).toBe(30 * BYTES_PER_GB);
    expect(body.data.disk_total_bytes).toBe(30 * BYTES_PER_GB);
    expect(body.data.has_guest_total).toBe(true);
    expect(body.data.has_sample).toBe(true);
  });

  it("escalates to a red critical level at/above 95%", async () => {
    mockInstanceRow({ data: { disk_size_gb: 30, resource_tier: "operator", status: "running" }, error: null });
    mockRollup.mockResolvedValue(
      emptyRollup({ disk_used_bytes_last: 29 * BYTES_PER_GB, disk_total_bytes_last: 30 * BYTES_PER_GB })
    );

    const { body } = await callGet();

    expect(body.data.level).toBe("critical");
    expect(body.data.percent).toBeGreaterThanOrEqual(95);
  });

  it("shows no banner when the disk_size_gb reservation is smaller than real usage (the 198% regression)", async () => {
    // VM with an 800G thin disk recorded as disk_size_gb=40 — the exact shape
    // that produced "198% of its disk". The guest df total is the real disk, so
    // 79G used of ~774G is a calm ~11%/ok, NOT 197% critical.
    mockInstanceRow({ data: { disk_size_gb: 40, resource_tier: "command", status: "running" }, error: null });
    mockRollup.mockResolvedValue(
      emptyRollup({
        disk_used_bytes_last: 84_865_363_968, // ~79 GB
        disk_total_bytes_last: 830_970_236_928, // ~774 GiB real df total
      })
    );

    const { body } = await callGet();

    expect(body.data.level).toBe("ok");
    expect(body.data.percent).toBeLessThan(15);
    expect(body.data.percent).toBeGreaterThan(0);
    expect(body.data.disk_size_gb).toBe(40); // echoed for info only
    expect(body.data.has_guest_total).toBe(true);
  });

  it("shows no banner when the latest sample has no guest df total, even with high usage", async () => {
    // Guest df unavailable => disk_used falls back to maxdisk (capacity) and
    // disk_total_bytes_last is 0. We must NOT divide by the stale disk_size_gb;
    // a monitoring-only banner stays silent rather than crying wolf.
    mockInstanceRow({ data: { disk_size_gb: 30, resource_tier: "operator", status: "running" }, error: null });
    mockRollup.mockResolvedValue(
      emptyRollup({ disk_used_bytes_last: 50 * BYTES_PER_GB, disk_total_bytes_last: 0 })
    );

    const { body } = await callGet();

    expect(body.data.level).toBe("ok");
    expect(body.data.percent).toBe(0);
    expect(body.data.provisioned_bytes).toBe(0);
    expect(body.data.has_guest_total).toBe(false);
    expect(body.data.has_sample).toBe(true);
  });

  it("echoes the default disk size when disk_size_gb is null without using it as the denominator", async () => {
    mockInstanceRow({ data: { disk_size_gb: null, resource_tier: "credit_base", status: "running" }, error: null });
    mockRollup.mockResolvedValue(
      emptyRollup({ disk_used_bytes_last: 25 * BYTES_PER_GB, disk_total_bytes_last: 30 * BYTES_PER_GB })
    );

    const { body } = await callGet();

    expect(body.data.disk_size_gb).toBe(30); // info-only fallback
    expect(body.data.provisioned_bytes).toBe(30 * BYTES_PER_GB); // from guest df total
    expect(body.data.level).toBe("warn");
  });

  it("reports ok with no banner when there is no recent sample", async () => {
    mockInstanceRow({ data: { disk_size_gb: 30, resource_tier: "operator", status: "running" }, error: null });
    mockRollup.mockResolvedValue(
      emptyRollup({ sample_count: 0, disk_used_bytes_last: 0, disk_total_bytes_last: 0, last_sampled_at: null })
    );

    const { body } = await callGet();

    expect(body.data.level).toBe("ok");
    expect(body.data.percent).toBe(0);
    expect(body.data.has_sample).toBe(false);
  });

  it("divides by the REAL measured guest total, not the stale disk_size_gb", async () => {
    // The live regression: recorded disk_size_gb=40 but the real disk is 774GB.
    // 80GB used / 40GB → 200% (impossible); / 774GB → ~10% (correct, no banner).
    mockInstanceRow({ data: { disk_size_gb: 40, resource_tier: "operator", status: "running" }, error: null });
    mockRollup.mockResolvedValue(
      emptyRollup({
        disk_used_bytes_last: 80 * BYTES_PER_GB,
        disk_total_bytes_last: 774 * BYTES_PER_GB,
      })
    );

    const { body } = await callGet();

    expect(body.data.level).toBe("ok");
    expect(body.data.percent).toBeCloseTo((80 / 774) * 100, 5);
    // The denominator surfaced for observability is the real measured total.
    expect(body.data.disk_total_bytes).toBe(774 * BYTES_PER_GB);
    expect(body.data.provisioned_bytes).toBe(774 * BYTES_PER_GB);
    // disk_size_gb stays the recorded provisioned value for reference.
    expect(body.data.disk_size_gb).toBe(40);
  });

  it("clamps a true over-100% real-total reading to a 100% critical banner", async () => {
    mockInstanceRow({ data: { disk_size_gb: 40, resource_tier: "operator", status: "running" }, error: null });
    mockRollup.mockResolvedValue(
      emptyRollup({
        disk_used_bytes_last: 50 * BYTES_PER_GB,
        disk_total_bytes_last: 40 * BYTES_PER_GB,
      })
    );

    const { body } = await callGet();

    expect(body.data.level).toBe("critical");
    expect(body.data.percent).toBe(100);
    // rawPercent preserves the unclamped 125% so a denominator bug stays visible.
    expect(body.data.rawPercent).toBeCloseTo(125, 5);
  });

  it("suppresses the banner when disk_used is a capacity fallback (not a real reading)", async () => {
    // guest df was unavailable → disk_used fell back to maxdisk (=capacity), so
    // used/total would falsely read ~100%. Suppress to level ok / percent 0.
    mockInstanceRow({ data: { disk_size_gb: 40, resource_tier: "operator", status: "running" }, error: null });
    mockRollup.mockResolvedValue(
      emptyRollup({
        disk_used_bytes_last: 40 * BYTES_PER_GB,
        disk_total_bytes_last: 40 * BYTES_PER_GB,
        disk_used_is_capacity_fallback_last: true,
      })
    );

    const { res, body } = await callGet();

    expect(res.status).toBe(200);
    expect(body.data.level).toBe("ok");
    expect(body.data.percent).toBe(0);
    // rawPercent still reflects the underlying (bogus) ratio for telemetry.
    expect(body.data.rawPercent).toBeCloseTo(100, 5);
  });
});
