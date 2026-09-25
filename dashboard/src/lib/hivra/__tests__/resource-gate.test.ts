import { SLOT_FREEING_LIFECYCLE_IN_LIST } from "@/lib/instance-lifecycle";
import { attachPlanAgentLimitMessage, loadCurrentComputeUsage, planAgentLimitMessage, resolvePlanAgentSlots,
  validateAgentResources } from "../resource-gate";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";

jest.mock("@/lib/billing/instance-entitlement", () => ({ resolveEffectiveSubscription: jest.fn() }));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

type NotCall = { column: string; operator: string; value: string };

// The agent count is the database's slot count (hivra_owner_agent_slot_count);
// CPU and memory are still summed from the rows below.
let slotCount: unknown = 0;
beforeEach(() => {
  slotCount = 0;
  (supabaseAdmin!.rpc as jest.Mock).mockImplementation(async (name: string) => name === "hivra_owner_agent_slot_count"
    ? { data: slotCount, error: null } : { data: null, error: { message: "unexpected rpc" } });
});

/**
 * Builds a chainable PostgREST stub for one table. Records every `.not()` call
 * and resolves the terminal await to `rows` (the stub does NOT actually filter —
 * the assertions check that the right filters were *applied*).
 */
function buildTableStub(rows: unknown[]) {
  const notCalls: NotCall[] = [];
  const neqCalls: { column: string; value: string }[] = [];
  const eqCalls: { column: string; value: string }[] = [];
  const stub: Record<string, unknown> = {
    select: jest.fn(() => stub),
    eq: jest.fn((column: string, value: string) => {
      eqCalls.push({ column, value });
      return stub;
    }),
    neq: jest.fn((column: string, value: string) => {
      neqCalls.push({ column, value });
      return Promise.resolve({ data: rows, error: null });
    }),
    not: jest.fn((column: string, operator: string, value: string) => {
      notCalls.push({ column, operator, value });
      // Resolve on the SECOND .not() (the lifecycle exclusion); stay chainable
      // on the first so the production chain `.not().not()` works.
      return notCalls.length >= 2
        ? Promise.resolve({ data: rows, error: null })
        : stub;
    }),
  };
  return { stub, notCalls, neqCalls, eqCalls };
}

describe("loadCurrentComputeUsage", () => {
  beforeEach(() => jest.clearAllMocks());

  it("excludes slot-freeing lifecycle states from the hermes_instances compute query", async () => {
    const hivra = buildTableStub([]); // no Hivra agents
    const legacy = buildTableStub([]); // no live base instances

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hivra_agents") return hivra.stub;
      if (table === "hermes_instances") return legacy.stub;
      throw new Error(`Unexpected table ${table}`);
    });

    await loadCurrentComputeUsage("user_x");

    // The hermes_instances leg must drop deleted AND cold_archived rows, not
    // just status='deleted' — a gone instance left at status='stopped' would
    // otherwise inflate the user's compute usage and wrongly block a launch.
    expect(legacy.notCalls).toEqual([
      { column: "status", operator: "in", value: '("deleted")' },
      // Derived, not pinned: this asserts the query excludes whatever the
      // slot-freeing contract currently names. Pinning the literal made the test
      // fail on a CORRECT widening of that list (adding pending_deletion) while
      // saying nothing about the property that matters.
      { column: "lifecycle_state", operator: "in", value: SLOT_FREEING_LIFECYCLE_IN_LIST },
    ]);
    expect(hivra.eqCalls).toContainEqual({
      column: "deployment_mode",
      value: "hivra-managed",
    });
  });

  it("excludes user-owned self-managed computers from Cloud slots and compute", async () => {
    // PostgREST applies this filter before returning rows; the fixture models
    // the result after a self-managed sentinel row was excluded by the DB.
    const hivra = buildTableStub([
      { id: "managed", cpu: 1, ram: 2, status: "running", type: "codex" },
    ]);
    const legacy = buildTableStub([]);
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hivra_agents") return hivra.stub;
      if (table === "hermes_instances") return legacy.stub;
      throw new Error(`Unexpected table ${table}`);
    });

    slotCount = 1;
    await expect(loadCurrentComputeUsage("user_x")).resolves.toEqual({
      activeCount: 1,
      usedCpu: 1,
      usedRamGb: 2,
    });
    expect(hivra.eqCalls).toEqual(expect.arrayContaining([
      { column: "user_id", value: "user_x" },
      { column: "deployment_mode", value: "hivra-managed" },
    ]));
  });

  it("sums only the rows the query returns (gone instances already excluded by the DB filter)", async () => {
    const hivra = buildTableStub([]);
    // Simulate the post-filter result: the DB already dropped the cold_archived
    // row, so only a single live base instance is returned.
    const legacy = buildTableStub([
      { id: "inst_live", cpu_limit: 2, ram_limit: 4096, status: "running" },
    ]);

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hivra_agents") return hivra.stub;
      if (table === "hermes_instances") return legacy.stub;
      throw new Error(`Unexpected table ${table}`);
    });

    slotCount = 1;
    const usage = await loadCurrentComputeUsage("user_x");

    expect(usage.activeCount).toBe(1);
    expect(usage.usedCpu).toBe(2);
    expect(usage.usedRamGb).toBe(4); // 4096 MB / 1024
  });
});

describe("the database slot count", () => {
  beforeEach(() => {
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hivra_agents") return buildTableStub([{ id: "desktop", cpu: 2, ram: 4, status: "running", type: "linux-desktop" }]).stub;
      if (table === "hermes_instances") return buildTableStub([]).stub;
      throw new Error(`Unexpected table ${table}`);
    });
  });

  it("counts an agent attached to a computer as a slot but adds none of its compute", async () => {
    // One Ubuntu Desktop row plus Codex attached to it: the database counts two.
    slotCount = 2;
    await expect(loadCurrentComputeUsage("user_x")).resolves.toEqual({ activeCount: 2, usedCpu: 2, usedRamGb: 4 });
    expect(supabaseAdmin!.rpc).toHaveBeenCalledWith("hivra_owner_agent_slot_count", { p_owner: "user_x" });
  });

  it.each([null, "2", -1, 1.5])("refuses to guess when the slot count is %p", async value => {
    slotCount = value;
    await expect(loadCurrentComputeUsage("user_x")).rejects.toThrow("Could not verify remaining compute");
  });

  it("refuses to guess when the slot count query fails", async () => {
    (supabaseAdmin!.rpc as jest.Mock).mockResolvedValueOnce({ data: null, error: { message: "private detail" } });
    await expect(loadCurrentComputeUsage("user_x")).rejects.toThrow("Could not verify remaining compute");
  });
});

describe("attach admission", () => {
  beforeEach(() => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue({ plan: "free", source: "free", total_cpu_budget: 0.5, total_ram_budget: 1024, instance_limit: 1 });
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hivra_agents") return buildTableStub([{ id: "desktop", cpu: 0.5, ram: 1, status: "running", type: "linux-desktop" }]).stub;
      if (table === "hermes_instances") return buildTableStub([]).stub;
      throw new Error(`Unexpected table ${table}`);
    });
  });
  const attach = { userId: "user_x", type: "codex", agentLabel: "Codex", browser: false, mode: "attach" as const, cpu: 0, ram: 0 };

  it("refuses before the Review when the plan's agent limit is reached, with the plan copy", async () => {
    slotCount = 1;
    await expect(validateAgentResources(attach)).resolves.toEqual({
      ok: false, status: 403,
      message: "Your Free plan allows 1 active agent and you already have 1. Upgrade for more slots, or remove an agent first.",
    });
  });

  it("checks only the slot count: a full CPU and memory pool does not block an agent that shares the computer", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue({ plan: "operator", source: "stripe", total_cpu_budget: 0.5, total_ram_budget: 1024, instance_limit: 3 });
    slotCount = 1;
    await expect(validateAgentResources(attach)).resolves.toEqual({ ok: true });
  });

  it("requires plan access", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);
    await expect(validateAgentResources(attach)).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(resolvePlanAgentSlots("user_x")).resolves.toBeNull();
  });

  it("resolves the limit exactly as the gate does", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue({ plan: "operator", source: "stripe", instance_limit: 7 });
    await expect(resolvePlanAgentSlots("user_x")).resolves.toEqual({ agentLimit: 7, planName: expect.any(String) });
  });

  it("keeps the existing launch copy for a database refusal", () => {
    expect(planAgentLimitMessage("Free", 1)).toBe("Your Free plan allows 1 active agent.");
    expect(attachPlanAgentLimitMessage("Pro", 3, 3)).toBe("Your Pro plan allows 3 active agents and you already have 3. Upgrade for more slots, or remove an agent first.");
  });
});

describe("fixed managed dashboard admission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue({ plan: "free", source: "free", total_cpu_budget: 0.5, total_ram_budget: 1024, instance_limit: 1 });
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hivra_agents") return buildTableStub([
        { id: "other", cpu: 0.5, ram: 1, status: "running", type: "codex" },
        { id: "ours", cpu: 0.5, ram: 1, status: "running", type: "aeon" },
      ]).stub;
      if (table === "hermes_instances") return buildTableStub([]).stub;
      throw new Error(`Unexpected table ${table}`);
    });
  });
  const input = { userId: "user_x", type: "aeon", agentLabel: "Aeon", browser: false, mode: "resize" as const, excludeAgentId: "ours", poolExempt: true, floor: { cpu: 0.5, ram: 1 } };

  it("allows the fixed Aeon allocation despite a full Free compute pool", async () => {
    await expect(validateAgentResources({ ...input, cpu: 0.5, ram: 1 })).resolves.toEqual({ ok: true });
  });
  it.each([{ cpu: 8, ram: 24 }, { cpu: 1, ram: 1 }, { cpu: 0.5, ram: 2 }])("denies unmetered managed growth to %j in the real resource gate", async size => {
    await expect(validateAgentResources({ ...input, ...size })).resolves.toEqual({ ok: false, status: 403, message: "Aeon uses a fixed managed size of 0.5 CPU / 1 GB." });
  });
});

describe("managed resource envelope admission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue({
      plan: "free", source: "free", total_cpu_budget: 0.5, total_ram_budget: 1024, instance_limit: 1,
    });
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hivra_agents" || table === "hermes_instances") return buildTableStub([]).stub;
      throw new Error(`Unexpected table ${table}`);
    });
  });

  it("charges the guarantee to the pool but rejects a ceiling above the plan cap", async () => {
    await expect(validateAgentResources({
      userId: "user_x", type: "codex", browser: false, mode: "launch",
      cpu: 0.5, ram: 1, maximumCpu: 1, maximumRam: 2,
    })).resolves.toEqual({
      ok: false,
      status: 403,
      message: "Your Free plan allows up to 0.5 CPU / 1 GB per agent.",
    });
  });

  it("keeps a legacy request pinned when ceilings are omitted", async () => {
    await expect(validateAgentResources({
      userId: "user_x", type: "codex", browser: false, mode: "launch", cpu: 0.5, ram: 1,
    })).resolves.toEqual({ ok: true });
  });
});
