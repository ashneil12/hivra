/**
 * Auto-seed daily-brief sweep tests. Locks in:
 *   - eligibility: running + not deleted + not seeded (query filters; predicate re-checks)
 *   - idempotency: a box that already has a "Daily brief" job is NOT re-seeded (and is stamped)
 *   - fail-safe: an unreadable box job list (null) → SKIP, never seed
 *   - the batch cap stops the run and reports capHit
 *   - the read-back text extraction probes the common run shapes
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

jest.mock("@/lib/services/instance-security", () => ({ getSecureUserInstance: jest.fn() }));
jest.mock("@/lib/agent-gateway", () => ({ fetchFirstReachableGatewayResponse: jest.fn() }));

import {
  buildDailyBriefPrompt,
  isDailyBriefJob,
  isPlatformDailyBriefJob,
  isBriefSeedEligible,
  extractBriefRunText,
  runDailyBriefSeedSweep,
  DAILY_BRIEF_NAME,
  DAILY_BRIEF_SCHEDULE,
  type BriefCandidateRow,
  type SecureInstanceLoader,
} from "@/lib/daily-brief";

const NOW = new Date("2026-07-05T12:00:00.000Z");

function candidate(overrides: Partial<BriefCandidateRow> = {}): BriefCandidateRow {
  return { id: "inst_1", user_id: "user_1", daily_brief_seeded_at: null, ...overrides };
}

function secureStub(id: string) {
  return {
    instance: { id, gateway_url: `https://gw.${id}.test` },
    apiServerKey: "k".repeat(64),
    instanceIpv4: "10.240.0.1",
    error: null,
  } as unknown as Awaited<ReturnType<SecureInstanceLoader>>;
}

function buildDbStub(params: { rows: BriefCandidateRow[]; selectError?: string; stampError?: string }) {
  const stamped: string[] = [];
  const instancesSelectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.select = jest.fn().mockReturnValue(chain);
    chain.eq = jest.fn().mockReturnValue(chain);
    chain.is = jest.fn().mockReturnValue(chain);
    chain.limit = jest.fn().mockResolvedValue(
      params.selectError
        ? { data: null, error: { message: params.selectError } }
        : { data: params.rows, error: null },
    );
    return chain;
  };
  const instancesUpdateChain = () => {
    let capturedId = "";
    const chain: Record<string, unknown> = {};
    chain.eq = jest.fn((_col: string, val: string) => {
      capturedId = val;
      return chain;
    });
    chain.is = jest.fn(async () => {
      if (params.stampError) return { data: null, error: { message: params.stampError } };
      stamped.push(capturedId);
      return { data: null, error: null };
    });
    return chain;
  };
  const db = {
    from: jest.fn(() => ({
      select: instancesSelectChain().select,
      update: () => instancesUpdateChain(),
    })),
  };
  return { db, stamped };
}

describe("daily-brief pure helpers", () => {
  it("buildDailyBriefPrompt returns brief-shaped copy", () => {
    expect(buildDailyBriefPrompt().toLowerCase()).toContain("brief");
    expect(buildDailyBriefPrompt().length).toBeGreaterThan(40);
  });

  it("isDailyBriefJob matches only the marker name", () => {
    expect(isDailyBriefJob({ name: DAILY_BRIEF_NAME })).toBe(true);
    expect(isDailyBriefJob({ name: "Something else" })).toBe(false);
    expect(isDailyBriefJob(null)).toBe(false);
    expect(isDailyBriefJob("Daily brief")).toBe(false);
  });

  it("isPlatformDailyBriefJob requires BOTH name and schedule (no free-ride by name)", () => {
    expect(isPlatformDailyBriefJob({ name: DAILY_BRIEF_NAME, schedule: DAILY_BRIEF_SCHEDULE })).toBe(true);
    // A user's own task merely NAMED "Daily brief" (different schedule) is NOT excluded.
    expect(isPlatformDailyBriefJob({ name: DAILY_BRIEF_NAME, schedule: "0 12 * * *" })).toBe(false);
    expect(isPlatformDailyBriefJob({ name: "Other", schedule: DAILY_BRIEF_SCHEDULE })).toBe(false);
    expect(isPlatformDailyBriefJob(null)).toBe(false);
  });

  it("isBriefSeedEligible needs a user and no prior stamp", () => {
    expect(isBriefSeedEligible(candidate())).toBe(true);
    expect(isBriefSeedEligible(candidate({ user_id: null }))).toBe(false);
    expect(isBriefSeedEligible(candidate({ daily_brief_seeded_at: NOW.toISOString() }))).toBe(false);
  });

  it("extractBriefRunText probes common fields + messages, else null", () => {
    expect(extractBriefRunText({ final_message: "hi" })).toBe("hi");
    expect(extractBriefRunText({ summary: "  s  " })).toBe("s");
    expect(extractBriefRunText({ messages: [{ content: "a" }, { content: "b" }] })).toBe("b");
    expect(extractBriefRunText({ messages: [{ content: "a" }, { role: "x" }] })).toBe("a");
    expect(extractBriefRunText({})).toBeNull();
    expect(extractBriefRunText(null)).toBeNull();
  });
});

describe("runDailyBriefSeedSweep", () => {
  beforeEach(() => {
    captureMock.mockReset();
    flushMock.mockReset();
    mockSupabaseAdmin.value = {};
  });

  it("throws when the database is not configured", async () => {
    mockSupabaseAdmin.value = null;
    await expect(runDailyBriefSeedSweep({ now: NOW })).rejects.toThrow("Database not configured");
  });

  it("seeds a brief on an eligible box with no brief job, stamps + captures", async () => {
    const { db, stamped } = buildDbStub({ rows: [candidate()] });
    mockSupabaseAdmin.value = db;
    const create = jest.fn().mockResolvedValue(true);
    const summary = await runDailyBriefSeedSweep({
      now: NOW,
      loadSecureInstance: async () => secureStub("inst_1"),
      listBoxJobs: async () => [],
      createBoxBriefJob: create,
    });
    expect(summary.seeded).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(stamped).toEqual(["inst_1"]);
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "daily_brief_auto_seeded" }),
    );
  });

  it("skips + stamps a box that already has a Daily brief job (idempotent)", async () => {
    const { db, stamped } = buildDbStub({ rows: [candidate()] });
    mockSupabaseAdmin.value = db;
    const create = jest.fn();
    const summary = await runDailyBriefSeedSweep({
      now: NOW,
      loadSecureInstance: async () => secureStub("inst_1"),
      listBoxJobs: async () => [{ id: "j1", name: DAILY_BRIEF_NAME }],
      createBoxBriefJob: create,
    });
    expect(summary.seeded).toBe(0);
    expect(summary.skipped_existing).toBe(1);
    expect(create).not.toHaveBeenCalled();
    expect(stamped).toEqual(["inst_1"]);
  });

  it("fails safe (skipped_unreadable) when the box job list can't be read", async () => {
    const { db } = buildDbStub({ rows: [candidate()] });
    mockSupabaseAdmin.value = db;
    const create = jest.fn();
    const summary = await runDailyBriefSeedSweep({
      now: NOW,
      loadSecureInstance: async () => secureStub("inst_1"),
      listBoxJobs: async () => null,
      createBoxBriefJob: create,
    });
    expect(summary.skipped_unreadable).toBe(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("skips_unreachable when the instance can't be loaded", async () => {
    const { db } = buildDbStub({ rows: [candidate()] });
    mockSupabaseAdmin.value = db;
    const summary = await runDailyBriefSeedSweep({
      now: NOW,
      loadSecureInstance: async () => null,
      listBoxJobs: async () => [],
      createBoxBriefJob: async () => true,
    });
    expect(summary.skipped_unreachable).toBe(1);
  });

  it("reports capHit when candidates exceed the batch size", async () => {
    const rows = [candidate({ id: "a" }), candidate({ id: "b" }), candidate({ id: "c" })];
    const { db } = buildDbStub({ rows });
    mockSupabaseAdmin.value = db;
    const summary = await runDailyBriefSeedSweep({
      now: NOW,
      batchSize: 2,
      loadSecureInstance: async (id) => secureStub(id),
      listBoxJobs: async () => [],
      createBoxBriefJob: async () => true,
    });
    expect(summary.capHit).toBe(true);
    expect(summary.candidates).toBe(3);
    expect(summary.seeded).toBe(2);
  });
});
