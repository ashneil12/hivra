import {
  PLAN_LADDER_ID,
  activePlanLadder,
  ladderPlanForPriceId,
  ladderPlanLimits,
  ladderPriceId,
  ladderSubscriptionColumns,
  planLadderConfigProblem,
  publicPlanLadder,
  readLadderSubscription,
  readPlanLadderConfig,
  sellsLadderTo,
} from "../plan-ladder";

// Test-only numbers. Real values live in deployment settings.
const CONFIG = {
  plans: {
    operator: { name: "A", monthlyCents: 100, monthlyPriceId: "price_a", agents: 2, alwaysOn: 0, agentCpu: 1, agentRamMb: 1024 },
    fleet: {
      name: "B", monthlyCents: 200, monthlyPriceId: "price_b", yearlyCents: 2000, yearlyPriceId: "price_by",
      agents: 4, alwaysOn: 1, agentCpu: 2, agentRamMb: 2048, aiAllowanceCents: 500, popular: true,
    },
    command: {
      name: "C", monthlyCents: 300, monthlyPriceId: "price_c", agents: 6, alwaysOn: 2, agentCpu: 4, agentRamMb: 4096,
      poolCpu: 8, poolRamMb: 8192, aiAllowanceCents: 1500,
    },
  },
  alwaysOnExtra: { priceId: "price_x", monthlyCents: 50, maxPerAccount: 3 },
};

const env = (over: Record<string, string | undefined> = {}) => ({
  HIVRA_PLAN_LADDER: "on",
  HIVRA_PLAN_LADDER_CONFIG: JSON.stringify(CONFIG),
  ...over,
});

describe("plan ladder settings", () => {
  it("is off unless switched on and configured", () => {
    expect(activePlanLadder(env({ HIVRA_PLAN_LADDER: undefined }))).toBeNull();
    expect(activePlanLadder(env({ HIVRA_PLAN_LADDER: "true" }))).toBeNull();
    expect(activePlanLadder(env({ HIVRA_PLAN_LADDER_CONFIG: undefined }))).toBeNull();
    expect(activePlanLadder(env())).not.toBeNull();
  });

  it("rejects broken settings without throwing and says why", () => {
    expect(readPlanLadderConfig(env({ HIVRA_PLAN_LADDER_CONFIG: "{not json" }))).toBeNull();
    const bad = { ...CONFIG, plans: { ...CONFIG.plans, fleet: { ...CONFIG.plans.fleet, yearlyPriceId: null } } };
    const badEnv = env({ HIVRA_PLAN_LADDER_CONFIG: JSON.stringify(bad) });
    expect(readPlanLadderConfig(badEnv)).toBeNull();
    expect(planLadderConfigProblem(badEnv)).toMatch(/yearly/);
    expect(planLadderConfigProblem(env())).toBeNull();
  });

  it("works out limits, defaulting the pool to one computer per agent", () => {
    const config = readPlanLadderConfig(env())!;
    expect(ladderPlanLimits(config, "fleet")).toEqual({
      name: "B", maxAgents: 4, alwaysOn: 1, maxCpuPerAgent: 2, maxRamPerAgent: 2048,
      totalCpu: 8, totalRam: 8192, aiAllowanceMicroUsd: 5_000_000,
    });
    expect(ladderPlanLimits(config, "command").totalCpu).toBe(8);
    expect(ladderPlanLimits(config, "operator").aiAllowanceMicroUsd).toBe(0);
  });

  it("maps prices both ways, yearly only where configured", () => {
    const config = readPlanLadderConfig(env())!;
    expect(ladderPriceId(config, "fleet", "yearly")).toBe("price_by");
    expect(ladderPriceId(config, "operator", "yearly")).toBeNull();
    expect(ladderPlanForPriceId(config, "price_by")).toEqual({ planKey: "fleet", cadence: "yearly" });
    expect(ladderPlanForPriceId(config, "price_old")).toBeNull();
  });

  it("finds the plan item by price and counts always-on extras, whatever the item order", () => {
    const config = readPlanLadderConfig(env())!;
    const read = readLadderSubscription(config, {
      metadata: {},
      items: { data: [{ id: "si_x", quantity: 2, price: { id: "price_x" } }, { id: "si_p", price: { id: "price_c" } }] },
    });
    expect(read.isLadder).toBe(true);
    expect(read.planItem?.id).toBe("si_p");
    expect(read.plan).toEqual({ planKey: "command", cadence: "monthly" });
    expect(read.alwaysOnExtras).toBe(2);
    const cols = ladderSubscriptionColumns(config, "command", read.alwaysOnExtras);
    expect(cols).toMatchObject({ plan_ladder: PLAN_LADDER_ID, instance_limit: 6, always_on_limit: 4, always_on_extra: 2 });
    // Extras never exceed the per-account cap.
    expect(ladderSubscriptionColumns(config, "command", 99).always_on_extra).toBe(3);
  });

  it("leaves subscriptions from before the ladder alone", () => {
    const config = readPlanLadderConfig(env())!;
    const read = readLadderSubscription(config, { metadata: { plan: "fleet" }, items: { data: [{ id: "si", price: { id: "price_legacy" } }] } });
    expect(read.isLadder).toBe(false);
    expect(readLadderSubscription(null, { metadata: { plan_ladder: PLAN_LADDER_ID } }).isLadder).toBe(true);
  });

  it("sells the ladder to new sign-ups and ladder subscribers only", () => {
    expect(sellsLadderTo(null, false)).toBe(true);
    expect(sellsLadderTo({ plan: "free", status: "active" }, false)).toBe(true);
    expect(sellsLadderTo({ plan: "fleet", status: "canceled" }, false)).toBe(true);
    expect(sellsLadderTo({ plan: "fleet", status: "active", plan_ladder: null }, true)).toBe(false);
    expect(sellsLadderTo({ plan: "fleet", status: "active", plan_ladder: PLAN_LADDER_ID }, true)).toBe(true);
  });

  it("never exposes Stripe price IDs to the page", () => {
    const view = publicPlanLadder(readPlanLadderConfig(env())!);
    expect(JSON.stringify(view)).not.toMatch(/price_/);
    expect(view.plans.find((p) => p.key === "fleet")).toMatchObject({ yearlyCents: 2000, popular: true, agentRamGb: 2 });
    expect(view.plans.find((p) => p.key === "operator")?.yearlyCents).toBeNull();
  });
});

describe("free section", () => {
  it("is optional and validated", () => {
    expect(readPlanLadderConfig(env())!.free).toBeUndefined();
    const withFree = env({ HIVRA_PLAN_LADDER_CONFIG: JSON.stringify({ ...CONFIG, free: { agents: 1, channels: false, linePriority: "low" } }) });
    expect(readPlanLadderConfig(withFree)!.free).toEqual({ agents: 1, channels: false, linePriority: "low" });
    const bad = env({ HIVRA_PLAN_LADDER_CONFIG: JSON.stringify({ ...CONFIG, free: { linePriority: "vip" } }) });
    expect(readPlanLadderConfig(bad)).toBeNull();
  });
});
