import { GET } from "../route";
import { calculateUsage } from "../helpers";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getCreditSummary, getPlanMonthlyCreditGrant } from "@/lib/billing/credits";

// Mock external dependencies
jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/billing/credits", () => ({
  CREDIT_UNIT_LABEL: "100 credits = $1",
  getCreditSummary: jest.fn(),
  getPlanMonthlyCreditGrant: jest.fn(),
}));

describe("calculateUsage helper", () => {
  it("does not charge pool-exempt agents while retaining their inventory size", () => {
    const result = calculateUsage(
      [{ id: "h", name: "Hermes", status: "running", cpu_limit: 2, ram_limit: 4096 }],
      [{ id: "a", name: "Aeon", status: "running", cpu: 0.5, ram: 1, type: "aeon" },
        { id: "c", name: "Codex", status: "running", cpu: 0.5, ram: 1, type: "codex" }],
    );
    expect(result.usedCpu).toBe(2.5);
    expect(result.usedRam).toBe(5120);
    expect(result.instances).toHaveLength(3);
    expect(result.instances.find((i) => i.id === "a")).toMatchObject({ cpu: 0.5, ram: 1024 });
  });
  it("computes cpu, ram, and defaults correctly", () => {
    const mockInstances = [
      { id: "1", name: "Agent 1", status: "running", cpu_limit: 4, ram_limit: 8192 },
      { id: "2", name: "Agent 2", status: "stopped", cpu_limit: 2, ram_limit: 4096, backups_enabled: true },
    ];

    const result = calculateUsage(mockInstances);
    expect(result.usedCpu).toBe(6);
    expect(result.usedRam).toBe(12288);
    expect(result.instances).toHaveLength(2);
    expect(result.instances[0].backups_enabled).toBe(false); // default
    expect(result.instances[1].backups_enabled).toBe(true);
  });
});

describe("GET /api/billing/usage", () => {
  const mockUserId = "user_123";
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBillingV2Enabled = process.env.BILLING_V2_ENABLED;
  const originalPublicBillingV2Enabled = process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
  let mockSupabaseQuery: Record<string, jest.Mock>;
  let consoleErrorSpy: jest.SpyInstance;

  function setNodeEnv(value: string | undefined) {
    (process.env as unknown as Record<string, string | undefined>).NODE_ENV = value;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    setNodeEnv(originalNodeEnv);
    delete process.env.BILLING_V2_ENABLED;
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;

    (auth as unknown as jest.Mock).mockResolvedValue({ userId: mockUserId });

    mockSupabaseQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      // 2026-05-01: yearly_token_subscriptions chain uses .in().order().limit()
      // before .maybeSingle(). Stub all three as returnThis so the mock keeps
      // chaining through any of the queries inside resolveEffectiveSubscription.
      in: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      or: jest.fn().mockResolvedValue({ data: [], error: null }),
      maybeSingle: jest.fn(),
    };
    (supabaseAdmin!.from as jest.Mock).mockReturnValue(mockSupabaseQuery);
    (getCreditSummary as jest.Mock).mockResolvedValue({
      balance: 500,
      monthlyGrant: 0,
      unit: "100 credits = $1",
    });
    (getPlanMonthlyCreditGrant as jest.Mock).mockImplementation((planKey: string | null) =>
      planKey === "operator" ? 2090 : 0
    );
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    setNodeEnv(originalNodeEnv);
    if (originalBillingV2Enabled === undefined) {
      delete process.env.BILLING_V2_ENABLED;
    } else {
      process.env.BILLING_V2_ENABLED = originalBillingV2Enabled;
    }
    if (originalPublicBillingV2Enabled === undefined) {
      delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_BILLING_V2_ENABLED = originalPublicBillingV2Enabled;
    }
  });

  function getConsoleOutput() {
    return JSON.stringify(consoleErrorSpy.mock.calls);
  }

  it("should return 401 if unauthorized", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("marks usage responses as no-store so billing plan changes do not render stale", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: { plan: "operator", status: "active", instance_limit: 3, total_cpu_budget: 2, total_ram_budget: 4096, current_period_end: null },
      error: null,
    });
    mockSupabaseQuery.not.mockReturnValueOnce(mockSupabaseQuery).mockResolvedValueOnce({ data: [], error: null });
    mockSupabaseQuery.or.mockResolvedValueOnce({ data: [], error: null });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it.each(["hermes", "hivra"])("does not present partial usage when the %s query fails", async (lane) => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: { plan: "operator", status: "active", instance_limit: 3, total_cpu_budget: 2, total_ram_budget: 4096, current_period_end: null },
      error: null,
    });
    const failed = { data: null, error: { code: "08006", message: "private database detail" } };
    const empty = { data: [], error: null };
    mockSupabaseQuery.not.mockReturnValueOnce(mockSupabaseQuery).mockResolvedValueOnce(lane === "hermes" ? failed : empty);
    mockSupabaseQuery.or.mockResolvedValueOnce(lane === "hivra" ? failed : empty);
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.data).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("private database detail");
  });

  it("should return unsubscribed payload if no active subscription", async () => {
    // resolveEffectiveSubscription queries hermes_subscriptions, then
    // apple_iap_subscriptions (added 2026-07-16), then
    // yearly_token_subscriptions (added 2026-05-01) before falling through.
    // Mock all three to return null so the helper hits the holding path.
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.subscribed).toBe(false);
    expect(body.data.credits).toEqual({
      balance: 500,
      monthlyGrant: 0,
      unit: "100 credits = $1",
    });
  });

  it("uses the resolved database entitlement limits in the usage payload", async () => {
    (getCreditSummary as jest.Mock).mockResolvedValueOnce({
      balance: 1250,
      monthlyGrant: 2090,
      unit: "100 credits = $1",
    });

    // 1. Subscription fetch. The stored limits intentionally differ from the
    // static operator plan so this catches UI drift from the provisioning gate.
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: { plan: "operator", status: "active", instance_limit: 7, total_cpu_budget: 6, total_ram_budget: 12288, current_period_end: "2024-12-31" },
      error: null,
    });

    // 2. Instances fetch
    mockSupabaseQuery.not.mockReturnValueOnce(mockSupabaseQuery).mockResolvedValueOnce({
      data: [
        { id: "1", name: "Agent 1", status: "running", cpu_limit: 2, ram_limit: 4096 },
      ],
      error: null,
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.subscribed).toBe(true);
    expect(body.data.plan.key).toBe("operator");
    expect(body.data.plan.maxAgents).toBe(7);
    expect(body.data.plan.totalCpu).toBe(6);
    expect(body.data.plan.totalRam).toBe(12288);
    expect(body.data.usage.maxAgents).toBe(7);
    expect(body.data.usage.totalCpu).toBe(6);
    expect(body.data.usage.totalRam).toBe(12288);
    expect(body.data.usage.agentCount).toBe(1);
    expect(body.data.usage.usedCpu).toBe(2);
    expect(body.data.usage.usedRam).toBe(4096);
    expect(body.data.credits).toEqual({
      balance: 1250,
      monthlyGrant: 2090,
      unit: "100 credits = $1",
    });
  });

  it("surfaces whether the current plan can be changed in place", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        plan: "operator",
        status: "active",
        instance_limit: 3,
        total_cpu_budget: 2,
        total_ram_budget: 4096,
        current_period_end: null,
        stripe_subscription_id: "manual_token_power",
      },
      error: null,
    });
    mockSupabaseQuery.not.mockReturnValueOnce(mockSupabaseQuery).mockResolvedValueOnce({ data: [], error: null });
    mockSupabaseQuery.or.mockResolvedValueOnce({ data: [], error: null });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.plan.canChangePlanInPlace).toBe(false);
  });

  it("counts Hivra agents so post-login welcome can route existing Claude users to dashboard", async () => {
    (getCreditSummary as jest.Mock).mockResolvedValueOnce({
      balance: 1250,
      monthlyGrant: 2090,
      unit: "100 credits = $1",
    });

    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: { plan: "operator", status: "active", instance_limit: 999, total_cpu_budget: 2, total_ram_budget: 4096, current_period_end: "2026-06-30" },
      error: null,
    });
    mockSupabaseQuery.not.mockReturnValueOnce(mockSupabaseQuery).mockResolvedValueOnce({ data: [], error: null });
    mockSupabaseQuery.or.mockResolvedValueOnce({
      data: [
        { id: "agent-claude", name: "Claude Code", status: "running", cpu: 0.5, ram: 1, type: "claude-code" },
      ],
      error: null,
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.usage.agentCount).toBe(1);
    expect(body.data.usage.usedCpu).toBe(0.5);
    expect(body.data.usage.usedRam).toBe(1024);
    expect(mockSupabaseQuery.or).toHaveBeenCalledWith(
      "deployment_mode.eq.hivra-managed,deployment_mode.is.null",
    );
    expect(body.data.usage.instances).toEqual([
      expect.objectContaining({
        id: "agent-claude",
        name: "Claude Code",
        source: "hivra",
        cpu: 0.5,
        ram: 1024,
      }),
    ]);
  });

  it("excludes terminal error rows from the meters and instance list (2026-06-10 incident shape)", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: { plan: "operator", status: "active", instance_limit: 1, total_cpu_budget: 512, total_ram_budget: 1024, current_period_end: null },
      error: null,
    });
    mockSupabaseQuery.not.mockReturnValueOnce(mockSupabaseQuery).mockResolvedValueOnce({ data: [], error: null });
    // The incident: 4 failed provisions (2 CPU / 4 GB each), zero live boxes —
    // the billing page showed "4/1 agents, 8 vCPU, 16 GB" for a user with nothing
    // running. The launch gate already ignored these rows; the meters must too.
    mockSupabaseQuery.or.mockResolvedValueOnce({
      data: ["a", "b", "c", "d"].map((k) => ({
        id: `agent-${k}`, name: `DEAD_${k}`, status: "error", cpu: 2, ram: 4, type: "claude-code",
      })),
      error: null,
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.usage.agentCount).toBe(0);
    expect(body.data.usage.usedCpu).toBe(0);
    expect(body.data.usage.usedRam).toBe(0);
    expect(body.data.usage.instances).toEqual([]);
  });

  it("still counts live boxes when dead rows sit alongside them (both lanes)", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: { plan: "operator", status: "active", instance_limit: 7, total_cpu_budget: 6, total_ram_budget: 12288, current_period_end: null },
      error: null,
    });
    mockSupabaseQuery.not.mockReturnValueOnce(mockSupabaseQuery).mockResolvedValueOnce({
      data: [
        { id: "h-run", name: "Legacy", status: "running", cpu_limit: 2, ram_limit: 4096 },
        { id: "h-dead", name: "LegacyDead", status: "failed", cpu_limit: 2, ram_limit: 4096 },
      ],
      error: null,
    });
    mockSupabaseQuery.or.mockResolvedValueOnce({
      data: [
        { id: "a-run", name: "Live", status: "running", cpu: 0.5, ram: 1, type: "claude-code" },
        { id: "a-dead", name: "Dead", status: "error", cpu: 2, ram: 4, type: "claude-code" },
      ],
      error: null,
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.usage.agentCount).toBe(2);
    expect(body.data.usage.usedCpu).toBe(2.5);
    expect(body.data.usage.usedRam).toBe(4096 + 1024);
    expect(
      body.data.usage.instances.map((i: { id: string }) => i.id).sort()
    ).toEqual(["a-run", "h-run"]);
  });

  it("marks plan.veniceBoost active for a paid user holding enough VVV", async () => {
    // maybeSingle #1 = subscription (paid operator); #2 = venice boost row.
    mockSupabaseQuery.maybeSingle
      .mockResolvedValueOnce({
        data: { plan: "operator", status: "active", instance_limit: 999, total_cpu_budget: 2, total_ram_budget: 4096, current_period_end: "2026-12-31" },
        error: null,
      })
      .mockResolvedValueOnce({ data: { currently_eligible: true }, error: null });
    mockSupabaseQuery.not.mockReturnValueOnce(mockSupabaseQuery).mockResolvedValueOnce({ data: [], error: null });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.plan.veniceBoost).toEqual({ active: true, cpuBonus: 1, ramBonusMb: 2048 });
  });

  it("leaves plan.veniceBoost inactive when the user holds no VVV", async () => {
    mockSupabaseQuery.maybeSingle
      .mockResolvedValueOnce({
        data: { plan: "operator", status: "active", instance_limit: 999, total_cpu_budget: 2, total_ram_budget: 4096, current_period_end: "2026-12-31" },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null });
    mockSupabaseQuery.not.mockReturnValueOnce(mockSupabaseQuery).mockResolvedValueOnce({ data: [], error: null });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.plan.veniceBoost.active).toBe(false);
  });

  it("does not touch v2 credit tables when billing v2 is disabled in production", async () => {
    setNodeEnv("production");
    delete process.env.BILLING_V2_ENABLED;
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;

    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: { plan: "operator", status: "active", instance_limit: 999, total_cpu_budget: 2, total_ram_budget: 4096, current_period_end: "2026-05-01" },
      error: null,
    });
    mockSupabaseQuery.not.mockReturnValueOnce(mockSupabaseQuery).mockResolvedValueOnce({
      data: [],
      error: null,
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.credits).toEqual({
      balance: 0,
      monthlyGrant: 2090,
      unit: "100 credits = $1",
    });
    expect(getCreditSummary).not.toHaveBeenCalled();
    expect(getPlanMonthlyCreditGrant).toHaveBeenCalledWith("operator");
  });

  it("treats Stripe trialing subscriptions as subscribed", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: { plan: "operator", status: "trialing", instance_limit: 999, total_cpu_budget: 2, total_ram_budget: 4096, current_period_end: "2026-05-12" },
      error: null,
    });
    mockSupabaseQuery.not.mockReturnValueOnce(mockSupabaseQuery).mockResolvedValueOnce({
      data: [],
      error: null,
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.subscribed).toBe(true);
    expect(body.data.plan.status).toBe("trialing");
  });

  it("passes the apple_iap source through untouched for App Store subscribers", async () => {
    // No Stripe row → resolver falls through to apple_iap_subscriptions.
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: {
        plan: "operator",
        status: "active",
        current_period_end: "2026-08-16T00:00:00.000Z",
      },
      error: null,
    });
    mockSupabaseQuery.not.mockReturnValueOnce(mockSupabaseQuery).mockResolvedValueOnce({
      data: [],
      error: null,
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.subscribed).toBe(true);
    expect(body.data.plan.source).toBe("apple_iap");
    expect(body.data.plan.key).toBe("operator");
    expect(body.data.plan.canChangePlanInPlace).toBe(false);
    expect(body.data.plan.currentPeriodEnd).toBe("2026-08-16T00:00:00.000Z");
  });

  it("hides unexpected usage errors from the client and logs", async () => {
    (auth as unknown as jest.Mock).mockRejectedValueOnce(new Error("usage-secret-leak"));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to fetch usage");
    expect(body.error).not.toContain("usage-secret-leak");
    expect(getConsoleOutput()).not.toContain("usage-secret-leak");
  });
});
