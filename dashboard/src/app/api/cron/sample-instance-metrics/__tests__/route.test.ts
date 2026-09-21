import { NextRequest } from "next/server";

import { GET } from "../route";
import { getProxmoxInstanceMetrics } from "@/lib/services/proxmox-instance-service";
import { recordInstanceMeteringSample } from "@/lib/services/instance-metering";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  getProxmoxInstanceMetrics: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-infrastructure", () => ({
  getProxmoxInfrastructure: jest.fn((config: unknown) => {
    const raw = config as { infrastructure?: unknown } | null;
    const infrastructure = raw?.infrastructure as
      | { provider?: string; vmid?: number; node?: string; hostId?: string; hostSlug?: string; hostEnvPrefix?: string }
      | undefined;
    return infrastructure?.provider === "proxmox" && typeof infrastructure.vmid === "number"
      ? infrastructure
      : null;
  }),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(
    (
      infrastructure: { hostId?: string; hostSlug?: string; hostEnvPrefix?: string; node?: string } | null,
      row?: { host_id?: string | null } | null,
    ) => {
      const hostId = infrastructure?.hostId ?? row?.host_id ?? null;
      const hostSlug = infrastructure?.hostSlug ?? infrastructure?.node ?? null;
      const envPrefix = infrastructure?.hostEnvPrefix ?? null;
      return hostId || hostSlug || envPrefix
        ? { hostId, hostSlug, envPrefix, failClosed: true }
        : null;
    },
  ),
}));

jest.mock("@/lib/services/instance-metering", () => ({
  recordInstanceMeteringSample: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

interface InstanceFixture {
  id: string;
  proxmox_vmid: number | null;
  resource_tier: string | null;
  lifecycle_state: string | null;
  infrastructure_provider: string | null;
  host_id?: string | null;
  proxmox_node?: string | null;
  config?: unknown;
}

function mockSupabaseInstanceList(rows: InstanceFixture[]) {
  const builder = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockResolvedValue({ data: rows, error: null }),
  };
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_instances") return builder;
    throw new Error(`Unexpected table ${table}`);
  });
  return builder;
}

const ORIGINAL_ENV = process.env;

const makeRequest = (
  authorization?: string,
  url = "http://localhost/api/cron/sample-instance-metrics"
) =>
  new Request(url, {
    headers: authorization ? { authorization } : {},
  }) as unknown as NextRequest;

describe("GET /api/cron/sample-instance-metrics", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "cron-secret" };
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (recordInstanceMeteringSample as jest.Mock).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    consoleErrorSpy.mockRestore();
  });

  it("returns 500 when CRON_SECRET is unset", async () => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "" };
    mockSupabaseInstanceList([]);

    const response = await GET(makeRequest("Bearer cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Cron secret is not configured");
    expect(getProxmoxInstanceMetrics).not.toHaveBeenCalled();
    expect(recordInstanceMeteringSample).not.toHaveBeenCalled();
  });

  it("returns 401 when the authorization header is wrong", async () => {
    mockSupabaseInstanceList([]);

    const response = await GET(makeRequest("Bearer wrong-secret"));
    expect(response.status).toBe(401);
    expect(getProxmoxInstanceMetrics).not.toHaveBeenCalled();
    expect(recordInstanceMeteringSample).not.toHaveBeenCalled();
  });

  it("returns 401 when no authorization header is present", async () => {
    mockSupabaseInstanceList([]);

    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
    expect(getProxmoxInstanceMetrics).not.toHaveBeenCalled();
  });

  it("samples each Proxmox instance and inserts a metering row per sample", async () => {
    // Pin the wall-clock to xx:05 (paid-tier tick) so the free-tier
    // throttle assertion below stays deterministic.
    jest.useFakeTimers().setSystemTime(new Date("2026-04-29T12:05:00Z"));

    mockSupabaseInstanceList([
      {
        id: "inst_paid_a",
        proxmox_vmid: 201,
        resource_tier: "operator",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
      },
      {
        id: "inst_paid_b",
        proxmox_vmid: 202,
        resource_tier: "fleet",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
      },
    ]);
    (getProxmoxInstanceMetrics as jest.Mock).mockResolvedValue({
      cpu_seconds_total: 123.4,
      ram_peak_bytes: 1_024 * 1024 * 512,
      disk_used_bytes: 1_024 * 1024 * 1024 * 5,
      runtime_seconds: 300,
      net_out_bytes: 1024 * 1024 * 10,
      raw: { status: "running", cpu: "0.12" },
    });

    const response = await GET(makeRequest("Bearer cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ sampled: 2, skipped: 0, errors: 0, total: 2 });
    expect(getProxmoxInstanceMetrics).toHaveBeenCalledTimes(2);
    expect(getProxmoxInstanceMetrics).toHaveBeenCalledWith(
      { vmid: 201, node: undefined },
      { hostConfig: null },
    );
    expect(getProxmoxInstanceMetrics).toHaveBeenCalledWith(
      { vmid: 202, node: undefined },
      { hostConfig: null },
    );
    expect(recordInstanceMeteringSample).toHaveBeenCalledTimes(2);
    expect(recordInstanceMeteringSample).toHaveBeenCalledWith(
      expect.objectContaining({
        instance_id: "inst_paid_a",
        cpu_seconds_total: 123.4,
        runtime_seconds: 300,
        source: "proxmox",
        metadata: expect.objectContaining({ vmid: 201, resource_tier: "operator" }),
      }),
      expect.anything()
    );

    jest.useRealTimers();
  });

  it("routes metrics sampling through each instance's persisted Proxmox host metadata", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-04-29T12:00:00Z"));

    mockSupabaseInstanceList([
      {
        id: "inst_fixturenode1",
        proxmox_vmid: 201,
        resource_tier: "operator",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
        host_id: "host-fixturenode1",
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 201,
            privateIpv4: "10.250.20.51",
            gatewayHost: "inst-fixturenode1.example.test",
            hostSlug: "fixturenode1",
          },
        },
      },
      {
        id: "inst_fixturenode2",
        proxmox_vmid: 202,
        resource_tier: "operator",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
        host_id: "host-fixturenode2",
        config: {
          infrastructure: {
            provider: "proxmox",
            vmid: 202,
            privateIpv4: "10.254.20.52",
            gatewayHost: "inst-fixturenode2.example.test",
            hostSlug: "fixturenode2",
          },
        },
      },
    ]);
    (getProxmoxInstanceMetrics as jest.Mock).mockResolvedValue({
      cpu_seconds_total: 1,
      ram_peak_bytes: 100,
      disk_used_bytes: 100,
      runtime_seconds: 1,
      net_out_bytes: 1,
      raw: { status: "running" },
    });

    const response = await GET(makeRequest("Bearer cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ sampled: 2, skipped: 0, errors: 0, total: 2 });
    expect(getProxmoxInstanceMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ vmid: 201 }),
      expect.objectContaining({
        hostConfig: expect.objectContaining({ hostId: "host-fixturenode1", hostSlug: "fixturenode1" }),
      })
    );
    expect(getProxmoxInstanceMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ vmid: 202 }),
      expect.objectContaining({
        hostConfig: expect.objectContaining({ hostId: "host-fixturenode2", hostSlug: "fixturenode2" }),
      })
    );

    jest.useRealTimers();
  });

  it("throttles free-tier instances on off-peak ticks (only :00 / :30)", async () => {
    // 12:05 is a non-throttle tick → free tier should be skipped, paid sampled.
    jest.useFakeTimers().setSystemTime(new Date("2026-04-29T12:05:00Z"));

    mockSupabaseInstanceList([
      {
        id: "inst_free",
        proxmox_vmid: 301,
        resource_tier: "credit_base",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
      },
      {
        id: "inst_paid",
        proxmox_vmid: 302,
        resource_tier: "operator",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
      },
    ]);
    (getProxmoxInstanceMetrics as jest.Mock).mockResolvedValue({
      cpu_seconds_total: 1,
      ram_peak_bytes: 100,
      disk_used_bytes: 100,
      runtime_seconds: 1,
      net_out_bytes: 1,
      raw: { status: "running" },
    });

    const offPeak = await GET(makeRequest("Bearer cron-secret"));
    const offBody = await offPeak.json();
    expect(offBody.data).toMatchObject({ sampled: 1, skipped: 1, errors: 0 });
    expect(getProxmoxInstanceMetrics).toHaveBeenCalledTimes(1);
    expect(getProxmoxInstanceMetrics).toHaveBeenCalledWith(
      { vmid: 302, node: undefined },
      { hostConfig: null },
    );

    jest.clearAllMocks();
    (recordInstanceMeteringSample as jest.Mock).mockResolvedValue({ ok: true });

    // 12:30 → both should sample.
    jest.setSystemTime(new Date("2026-04-29T12:30:00Z"));
    mockSupabaseInstanceList([
      {
        id: "inst_free",
        proxmox_vmid: 301,
        resource_tier: "credit_base",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
      },
      {
        id: "inst_paid",
        proxmox_vmid: 302,
        resource_tier: "operator",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
      },
    ]);
    (getProxmoxInstanceMetrics as jest.Mock).mockResolvedValue({
      cpu_seconds_total: 1,
      ram_peak_bytes: 100,
      disk_used_bytes: 100,
      runtime_seconds: 1,
      net_out_bytes: 1,
      raw: { status: "running" },
    });

    const onPeak = await GET(makeRequest("Bearer cron-secret"));
    const onBody = await onPeak.json();
    expect(onBody.data).toMatchObject({ sampled: 2, skipped: 0, errors: 0 });

    jest.useRealTimers();
  });

  it("passes the stored Proxmox node to the metrics helper for multi-host fleets", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-04-29T12:05:00Z"));

    mockSupabaseInstanceList([
      {
        id: "inst_fixturelegacy",
        proxmox_vmid: 300,
        proxmox_node: "fixturelegacy",
        resource_tier: "operator",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
        config: {
          infrastructure: {
            provider: "proxmox",
            node: "fixturelegacy",
            vmid: 300,
          },
        },
      },
    ]);
    (getProxmoxInstanceMetrics as jest.Mock).mockResolvedValue({
      cpu_seconds_total: 1,
      ram_peak_bytes: 100,
      disk_used_bytes: 100,
      runtime_seconds: 1,
      net_out_bytes: 1,
      raw: { status: "running" },
    });

    const response = await GET(makeRequest("Bearer cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ sampled: 1, skipped: 0, errors: 0 });
    expect(getProxmoxInstanceMetrics).toHaveBeenCalledWith(
      { vmid: 300, node: "fixturelegacy" },
      { hostConfig: { hostId: null, hostSlug: "fixturelegacy", envPrefix: null, failClosed: true } },
    );
    jest.useRealTimers();
  });

  it("skips non-Proxmox instances and instances without a VMID", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-04-29T12:00:00Z"));
    mockSupabaseInstanceList([
      {
        id: "inst_hetzner",
        proxmox_vmid: null,
        resource_tier: "operator",
        lifecycle_state: "active",
        infrastructure_provider: "hetzner",
      },
      {
        id: "inst_proxmox_no_vmid",
        proxmox_vmid: null,
        resource_tier: "operator",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
      },
    ]);

    const response = await GET(makeRequest("Bearer cron-secret"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ sampled: 0, skipped: 2, errors: 0 });
    expect(getProxmoxInstanceMetrics).not.toHaveBeenCalled();
    expect(recordInstanceMeteringSample).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("stops sampling once the per-run time budget is exhausted and reports the deferred tail", async () => {
    // :00 tick so all instances are eligible to sample.
    jest.useFakeTimers().setSystemTime(new Date("2026-04-29T12:00:00Z"));

    const rows: InstanceFixture[] = Array.from({ length: 40 }, (_, i) => ({
      id: `inst_${i}`,
      proxmox_vmid: 500 + i,
      resource_tier: "operator",
      lifecycle_state: "active",
      infrastructure_provider: "proxmox",
    }));
    mockSupabaseInstanceList(rows);

    // Each metrics fetch advances the wall-clock by 20s. The route's budget is
    // 250s, so after a fraction of the 40 rows the deadline trips and the rest
    // are deferred — the function returns cleanly instead of running all 40 past
    // maxDuration.
    (getProxmoxInstanceMetrics as jest.Mock).mockImplementation(async () => {
      jest.advanceTimersByTime(20_000);
      return {
        cpu_seconds_total: 1,
        ram_peak_bytes: 1,
        disk_used_bytes: 1,
        runtime_seconds: 1,
        net_out_bytes: 1,
        raw: { status: "running" },
      };
    });

    const response = await GET(makeRequest("Bearer cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.budgetExhausted).toBe(true);
    expect(body.data.unsampled).toBeGreaterThan(0);
    expect(body.data.sampled).toBeLessThan(40);
    expect(body.data.sampled + body.data.unsampled).toBeLessThanOrEqual(40);

    jest.useRealTimers();
  });

  it("counts errors when the Proxmox helper throws and continues to the next instance", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-04-29T12:00:00Z"));
    mockSupabaseInstanceList([
      {
        id: "inst_a",
        proxmox_vmid: 401,
        resource_tier: "operator",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
      },
      {
        id: "inst_b",
        proxmox_vmid: 402,
        resource_tier: "operator",
        lifecycle_state: "active",
        infrastructure_provider: "proxmox",
      },
    ]);
    (getProxmoxInstanceMetrics as jest.Mock)
      .mockRejectedValueOnce(new Error("ssh down"))
      .mockResolvedValueOnce({
        cpu_seconds_total: 5,
        ram_peak_bytes: 1,
        disk_used_bytes: 1,
        runtime_seconds: 1,
        net_out_bytes: 1,
        raw: { status: "running" },
      });

    const response = await GET(makeRequest("Bearer cron-secret"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ sampled: 1, skipped: 0, errors: 1 });
    expect(recordInstanceMeteringSample).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
