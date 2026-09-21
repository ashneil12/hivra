/**
 * Auto-seed standing-task sweep tests. The contract this locks in:
 *   - eligibility: running + not deleted + (goal OR first_task) + not seeded
 *     (the query filters; isSeedEligible re-checks the predicate)
 *   - idempotency: a row with standing_task_seeded_at set is excluded by the
 *     query; a box that already has >= 1 job is NOT re-seeded (and is stamped so
 *     it's never re-evaluated)
 *   - fail-safe: an unreadable box job list (null) → SKIP, never seed
 *   - delivery: telegram-connected box → "telegram", else "local"
 *   - the batch cap stops the run and reports capHit
 *   - the standing-task prompt is derived from goal (falling back to first_task)
 *   - a PostHog standing_task_auto_seeded capture per seed + a flush
 */

const mockSupabaseAdmin = { value: null as unknown };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.value;
  },
}));

const captureMock = jest.fn();
const flushMock = jest.fn();
jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: (...args: unknown[]) => captureMock(...args),
    flush: (...args: unknown[]) => flushMock(...args),
  },
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

// Box/security seams are injected into runStandingTaskSeedSweep, but mock the
// modules too so importing the lib doesn't drag in ssh/hetzner/insecure-fetch.
jest.mock("@/lib/services/instance-security", () => ({
  getSecureUserInstance: jest.fn(),
}));
jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

import {
  buildStandingTaskPrompt,
  isSeedEligible,
  resolveDeliveryChannel,
  resolveSeedBatchSize,
  runStandingTaskSeedSweep,
  STANDING_TASK_SCHEDULE,
  STANDING_TASK_NAME,
  type SeedCandidateRow,
  type SecureInstanceLoader,
} from "@/lib/seed-standing-tasks";

const NOW = new Date("2026-06-15T12:00:00.000Z");

function candidate(overrides: Partial<SeedCandidateRow> = {}): SeedCandidateRow {
  return {
    id: "inst_1",
    user_id: "user_1",
    name: "Hermes",
    goal: "Grow my newsletter to 1000 subscribers",
    first_task: null,
    standing_task_seeded_at: null,
    ...overrides,
  };
}

// A minimal stub the loader returns — only the fields the sweep reads/forwards.
function secureStub(id: string) {
  return {
    instance: { id, gateway_url: `https://gw.${id}.test` },
    apiServerKey: "k".repeat(64),
    instanceIpv4: "10.240.0.1",
    error: null,
  } as unknown as Awaited<ReturnType<SecureInstanceLoader>>;
}

/**
 * Build a supabaseAdmin stub whose hermes_instances SELECT returns `rows` and
 * whose UPDATE captures the stamped ids. channel_connections SELECT returns the
 * telegram-connected target ids.
 */
function buildDbStub(params: {
  rows: SeedCandidateRow[];
  telegramIds?: string[];
  selectError?: string;
  stampError?: string;
}) {
  const stamped: string[] = [];

  const instancesSelectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.select = jest.fn().mockReturnValue(chain);
    chain.eq = jest.fn().mockReturnValue(chain);
    chain.is = jest.fn().mockReturnValue(chain);
    chain.or = jest.fn().mockReturnValue(chain);
    // .limit is terminal on the SELECT.
    chain.limit = jest.fn().mockResolvedValue(
      params.selectError
        ? { data: null, error: { message: params.selectError } }
        : { data: params.rows, error: null },
    );
    return chain;
  };

  const instancesUpdateChain = (patch: Record<string, unknown>) => {
    let capturedId = "";
    const chain: Record<string, unknown> = {};
    chain.eq = jest.fn((_col: string, val: string) => {
      capturedId = val;
      return chain;
    });
    // .is is terminal on the UPDATE (the guarded re-stamp).
    chain.is = jest.fn(async () => {
      if (params.stampError) return { data: null, error: { message: params.stampError } };
      stamped.push(capturedId);
      void patch;
      return { data: null, error: null };
    });
    return chain;
  };

  const channelSelectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.select = jest.fn().mockReturnValue(chain);
    chain.eq = jest.fn().mockReturnValue(chain);
    // .in is terminal.
    chain.in = jest.fn().mockResolvedValue({
      data: (params.telegramIds ?? []).map((id) => ({ target_id: id })),
      error: null,
    });
    return chain;
  };

  const db = {
    from: jest.fn((table: string) => {
      if (table === "channel_connections") return channelSelectChain();
      // hermes_instances: SELECT exposes .select; UPDATE exposes .update.
      return {
        select: instancesSelectChain().select,
        update: (patch: Record<string, unknown>) => instancesUpdateChain(patch),
      };
    }),
  };

  return { db, stamped };
}

describe("seed-standing-tasks pure helpers", () => {
  it("derives the prompt from goal, falling back to first_task", () => {
    expect(buildStandingTaskPrompt({ goal: "Ship the app", first_task: "x" })).toContain(
      "Ship the app",
    );
    expect(buildStandingTaskPrompt({ goal: null, first_task: "Draft the launch post" })).toContain(
      "Draft the launch post",
    );
    expect(buildStandingTaskPrompt({ goal: "  ", first_task: "  " })).toBeNull();
    expect(buildStandingTaskPrompt({ goal: null, first_task: null })).toBeNull();
  });

  it("isSeedEligible: needs a user, no prior stamp, and a goal/first_task", () => {
    expect(isSeedEligible(candidate())).toBe(true);
    expect(isSeedEligible(candidate({ goal: null, first_task: "do a thing" }))).toBe(true);
    expect(isSeedEligible(candidate({ user_id: null }))).toBe(false);
    expect(isSeedEligible(candidate({ standing_task_seeded_at: NOW.toISOString() }))).toBe(false);
    expect(isSeedEligible(candidate({ goal: null, first_task: null }))).toBe(false);
  });

  it("resolveDeliveryChannel maps telegram-connected → telegram, else local", () => {
    expect(resolveDeliveryChannel(true)).toBe("telegram");
    expect(resolveDeliveryChannel(false)).toBe("local");
  });

  it("resolveSeedBatchSize honors the env override and the cap", () => {
    const original = process.env.AUTO_SEED_STANDING_TASKS_BATCH_SIZE;
    delete process.env.AUTO_SEED_STANDING_TASKS_BATCH_SIZE;
    expect(resolveSeedBatchSize()).toBe(25);
    process.env.AUTO_SEED_STANDING_TASKS_BATCH_SIZE = "5";
    expect(resolveSeedBatchSize()).toBe(5);
    process.env.AUTO_SEED_STANDING_TASKS_BATCH_SIZE = "99999";
    expect(resolveSeedBatchSize()).toBe(200);
    if (original === undefined) delete process.env.AUTO_SEED_STANDING_TASKS_BATCH_SIZE;
    else process.env.AUTO_SEED_STANDING_TASKS_BATCH_SIZE = original;
  });
});

describe("runStandingTaskSeedSweep", () => {
  beforeEach(() => {
    captureMock.mockReset();
    flushMock.mockReset();
    mockSupabaseAdmin.value = {};
  });

  it("throws when the database is not configured", async () => {
    mockSupabaseAdmin.value = null;
    await expect(runStandingTaskSeedSweep({ now: NOW })).rejects.toThrow("Database not configured");
  });

  it("seeds one daily task on an eligible, zero-job box and stamps it", async () => {
    const rows = [candidate()];
    const { db, stamped } = buildDbStub({ rows });
    mockSupabaseAdmin.value = db;

    const createBoxStandingTask = jest.fn().mockResolvedValue(true);
    const summary = await runStandingTaskSeedSweep({
      now: NOW,
      loadSecureInstance: async (id) => secureStub(id),
      countBoxJobs: async () => 0,
      createBoxStandingTask,
      telegramConnections: async () => new Set<string>(),
    });

    expect(summary.candidates).toBe(1);
    expect(summary.seeded).toBe(1);
    expect(stamped).toEqual(["inst_1"]);
    expect(createBoxStandingTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        schedule: STANDING_TASK_SCHEDULE,
        name: STANDING_TASK_NAME,
        deliver: "local",
        prompt: expect.stringContaining("Grow my newsletter"),
      }),
    );
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "standing_task_auto_seeded" }),
    );
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  it("delivers to telegram when the box has a telegram connection", async () => {
    const rows = [candidate()];
    const { db } = buildDbStub({ rows, telegramIds: ["inst_1"] });
    mockSupabaseAdmin.value = db;

    const createBoxStandingTask = jest.fn().mockResolvedValue(true);
    const summary = await runStandingTaskSeedSweep({
      now: NOW,
      loadSecureInstance: async (id) => secureStub(id),
      countBoxJobs: async () => 0,
      createBoxStandingTask,
    });

    expect(summary.seeded).toBe(1);
    expect(createBoxStandingTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deliver: "telegram" }),
    );
  });

  it("does NOT seed a box that already has a job; stamps it and counts it skipped", async () => {
    const rows = [candidate()];
    const { db, stamped } = buildDbStub({ rows });
    mockSupabaseAdmin.value = db;

    const createBoxStandingTask = jest.fn().mockResolvedValue(true);
    const summary = await runStandingTaskSeedSweep({
      now: NOW,
      loadSecureInstance: async (id) => secureStub(id),
      countBoxJobs: async () => 1,
      createBoxStandingTask,
      telegramConnections: async () => new Set<string>(),
    });

    expect(summary.seeded).toBe(0);
    expect(summary.skipped_existing_jobs).toBe(1);
    expect(createBoxStandingTask).not.toHaveBeenCalled();
    // Stamped so the row is never re-evaluated.
    expect(stamped).toEqual(["inst_1"]);
  });

  it("fail-safe: an unreadable box job list (null) is skipped, never seeded", async () => {
    const rows = [candidate()];
    const { db, stamped } = buildDbStub({ rows });
    mockSupabaseAdmin.value = db;

    const createBoxStandingTask = jest.fn().mockResolvedValue(true);
    const summary = await runStandingTaskSeedSweep({
      now: NOW,
      loadSecureInstance: async (id) => secureStub(id),
      countBoxJobs: async () => null,
      createBoxStandingTask,
      telegramConnections: async () => new Set<string>(),
    });

    expect(summary.seeded).toBe(0);
    expect(summary.skipped_unreadable).toBe(1);
    expect(createBoxStandingTask).not.toHaveBeenCalled();
    expect(stamped).toEqual([]);
  });

  it("skips an instance that can't be securely loaded (unreachable)", async () => {
    const rows = [candidate()];
    const { db } = buildDbStub({ rows });
    mockSupabaseAdmin.value = db;

    const countBoxJobs = jest.fn();
    const createBoxStandingTask = jest.fn();
    const summary = await runStandingTaskSeedSweep({
      now: NOW,
      loadSecureInstance: async () => null,
      countBoxJobs,
      createBoxStandingTask,
      telegramConnections: async () => new Set<string>(),
    });

    expect(summary.seeded).toBe(0);
    expect(summary.skipped_unreachable).toBe(1);
    expect(countBoxJobs).not.toHaveBeenCalled();
    expect(createBoxStandingTask).not.toHaveBeenCalled();
  });

  it("caps the batch and reports capHit", async () => {
    const rows = [candidate({ id: "a" }), candidate({ id: "b" }), candidate({ id: "c" })];
    const { db } = buildDbStub({ rows });
    mockSupabaseAdmin.value = db;

    const createBoxStandingTask = jest.fn().mockResolvedValue(true);
    const summary = await runStandingTaskSeedSweep({
      now: NOW,
      batchSize: 2,
      loadSecureInstance: async (id) => secureStub(id),
      countBoxJobs: async () => 0,
      createBoxStandingTask,
      telegramConnections: async () => new Set<string>(),
    });

    expect(summary.candidates).toBe(3);
    expect(summary.capHit).toBe(true);
    expect(summary.seeded).toBe(2);
    expect(createBoxStandingTask).toHaveBeenCalledTimes(2);
  });

  it("counts a failed box create without stamping", async () => {
    const rows = [candidate()];
    const { db, stamped } = buildDbStub({ rows });
    mockSupabaseAdmin.value = db;

    const summary = await runStandingTaskSeedSweep({
      now: NOW,
      loadSecureInstance: async (id) => secureStub(id),
      countBoxJobs: async () => 0,
      createBoxStandingTask: async () => false,
      telegramConnections: async () => new Set<string>(),
    });

    expect(summary.seeded).toBe(0);
    expect(summary.failed).toBe(1);
    expect(stamped).toEqual([]);
  });

  it("throws when the candidate query errors", async () => {
    const { db } = buildDbStub({ rows: [], selectError: "boom" });
    mockSupabaseAdmin.value = db;
    await expect(runStandingTaskSeedSweep({ now: NOW })).rejects.toThrow("candidate query failed");
  });
});
