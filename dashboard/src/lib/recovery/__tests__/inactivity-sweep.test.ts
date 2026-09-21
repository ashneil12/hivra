import { runInactivitySweep } from "@/lib/recovery/inactivity-sweep";
import { supabaseAdmin } from "@/lib/supabase";
import {
  shutdownProxmoxInstance,
  getProxmoxInfrastructure,
  getProxmoxHostRoutingConfigFromInfrastructure,
  isProxmoxVmMissingResult,
  isProxmoxVmStillRunningResult,
} from "@/lib/services/proxmox-instance-service";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  shutdownProxmoxInstance: jest.fn(),
  getProxmoxInfrastructure: jest.fn(),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => null),
  isProxmoxVmMissingResult: jest.fn(() => false),
  isProxmoxVmStillRunningResult: jest.fn(() => false),
}));

type CandidateRow = {
  id: string;
  user_id: string;
  resource_tier: string | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
  last_activity_at: string;
  created_at?: string | null;
  last_lifecycle_transition_at?: string | null;
  // Agent-side signal (harvest-agent-usage). `last_agent_probe_at` is the coverage
  // marker: absent/stale => activity UNKNOWN => the sweep must not pause.
  last_agent_activity_at?: string | null;
  last_agent_probe_at?: string | null;
};

type RecheckOverride = {
  lifecycle_state?: string;
  last_activity_at?: string | null;
  last_agent_activity_at?: string | null;
  last_agent_probe_at?: string | null;
};

// Two fixed clocks the suite runs against.
const NOW_EARLY = new Date("2026-05-10T12:00:00.000Z");
const NOW_LATE = new Date("2026-05-14T18:15:00.000Z");

function buildSweepStub(params: {
  freeRows: CandidateRow[];
  paidRows: CandidateRow[];
  tokenRows?: CandidateRow[];
  // instanceId -> newest stat_date with sessions>0, as instance_usage_snapshots
  // would report it.
  agentUsage?: Record<string, string>;
  // when set, the instance_usage_snapshots query errors (fail-closed path).
  agentUsageError?: string;
  // instance ids with a row in channel_connections (Telegram/Discord connected).
  channelConnectedIds?: string[];
  // when set, the channel_connections query errors (fail-closed path).
  channelError?: string;
  // Simulate the pre-shutdown re-read returning a CHANGED row (e.g. the user
  // resumed since selection), keyed by instance id, to exercise the raced path.
  recheckOverrides?: Record<string, RecheckOverride>;
  // The sweep now REFUSES to pause an instance whose agent activity it cannot
  // see, so every fixture needs a probe stamp or it would be spared as UNKNOWN.
  // Default to a fresh one (1h before `now`) and let the probe-specific tests
  // override it per row. `now` must match what the test hands runInactivitySweep.
  now?: Date;
}) {
  type Filter = { tier: string[]; cutoff: string; agentActivityOr: string | null };
  const filters: Filter[] = [];
  const updates: Array<{
    id: string;
    patch: Record<string, unknown>;
    or: string | null;
    // Terminal .select() on the pause write. Captured because PostgREST resolves
    // a mutation's `or=` against this projection, not the base table — see the
    // "keeps every .or() column in the pause write's projection" test.
    select: string | null;
  }> = [];
  const now = params.now ?? NOW_EARLY;
  const freshProbeAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  // Fill in a fresh probe for any row that doesn't state one, so legacy fixtures
  // keep exercising what they were written to exercise (shutdown mechanics,
  // TOCTOU, budgets) instead of all collapsing into the UNKNOWN fail-safe.
  const withProbe = (row: CandidateRow): CandidateRow => ({
    last_agent_probe_at: freshProbeAt,
    ...row,
  });
  const freeRows = params.freeRows.map(withProbe);
  const tokenRows = (params.tokenRows ?? []).map(withProbe);
  const paidRows = params.paidRows.map(withProbe);
  const allRows = [...freeRows, ...tokenRows, ...paidRows];
  const agentUsage = params.agentUsage ?? {};
  const channelConnectedIds = new Set(params.channelConnectedIds ?? []);

  // instance_usage_snapshots: the corroborating agent-side activity gate.
  //   .select().in(ids).gt('sessions',0).gte('stat_date',day) — .gte is terminal.
  const agentUsageQuery = () => {
    let requestedIds: string[] = [];
    const query: Record<string, unknown> = {};
    query.select = jest.fn().mockReturnValue(query);
    query.in = jest.fn((_col: string, values: string[]) => {
      requestedIds = values;
      return query;
    });
    query.gt = jest.fn().mockReturnValue(query);
    query.gte = jest.fn(async (_col: string, cutoffDay: string) => {
      if (params.agentUsageError) {
        return { data: null, error: { message: params.agentUsageError } };
      }
      const data = requestedIds
        .filter((id) => agentUsage[id] && agentUsage[id] >= cutoffDay)
        .map((id) => ({ instance_id: id, stat_date: agentUsage[id] }));
      return { data, error: null };
    });
    return query;
  };

  // channel_connections: .select("target_id").in("target_id", ids) — .in terminal.
  const channelQuery = () => {
    const query: Record<string, unknown> = {};
    query.select = jest.fn().mockReturnValue(query);
    query.eq = jest.fn().mockReturnValue(query);
    query.in = jest.fn(async (_col: string, values: string[]) => {
      if (params.channelError) {
        return { data: null, error: { message: params.channelError } };
      }
      return {
        data: values
          .filter((id) => channelConnectedIds.has(id))
          .map((id) => ({ target_id: id })),
        error: null,
      };
    });
    return query;
  };

  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "instance_usage_snapshots") return agentUsageQuery();
    if (table === "channel_connections") return channelQuery();
    if (table !== "hermes_instances") {
      throw new Error(`Unexpected table lookup: ${table}`);
    }
    const filter: Filter = { tier: [], cutoff: "", agentActivityOr: null };
    const captured: {
      patch: Record<string, unknown>;
      or: string | null;
      select: string | null;
    } = {
      patch: {},
      or: null,
      select: null,
    };
    // Three chain shapes share this builder:
    //  - candidate fetch:  .select("id, user_id, …").eq("lifecycle_state").in().lt().or().limit()
    //  - pre-shutdown read: .select("lifecycle_state, …").eq("id").maybeSingle()
    //  - pause/error write: .update().eq("id")[.eq().lt().or().select("id")]  (awaited directly)
    // Distinguish the two selects by their column list (only the candidate fetch
    // selects user_id); update chains resolve via the thenable below. Candidate
    // rows are routed by the requested TIER, not by call order — the sweep now
    // issues a variable number of selects (free, token, and paid only when opted in).
    let mode: "select-candidates" | "select-recheck" | "update" | null = null;
    let rows: CandidateRow[] = [];
    let recheckId: string | null = null;
    let updateId: string | null = null;
    const query: Record<string, unknown> = {};
    query.select = jest.fn((cols?: string) => {
      if (mode === "update") {
        // terminal .select(...) on the pause update — record the projection, it
        // is what PostgREST resolves the mutation's or= against.
        captured.select = typeof cols === "string" ? cols : null;
        return query;
      }
      mode =
        typeof cols === "string" && cols.includes("user_id")
          ? "select-candidates"
          : "select-recheck";
      return query;
    });
    query.update = jest.fn((patch: Record<string, unknown>) => {
      mode = "update";
      captured.patch = patch;
      return query;
    });
    query.in = jest.fn((_column: string, values: string[]) => {
      filter.tier = values;
      if (values.includes("token_base")) rows = tokenRows;
      else if (values.includes("credit_base")) rows = freeRows;
      else rows = paidRows;
      return query;
    });
    query.lt = jest.fn((_column: string, value: string) => {
      if (mode === "select-candidates") filter.cutoff = value;
      return query;
    });
    query.or = jest.fn((expr: string) => {
      if (mode === "select-candidates") filter.agentActivityOr = expr;
      if (mode === "update") captured.or = expr;
      return query;
    });
    query.eq = jest.fn((col: string, value: string) => {
      if (mode === "update" && col === "id") updateId = value;
      if (mode === "select-recheck" && col === "id") recheckId = value;
      return query;
    });
    query.limit = jest.fn(async () => {
      filters.push(filter);
      return { data: rows, error: null };
    });
    query.maybeSingle = jest.fn(async () => {
      const row = allRows.find((r) => r.id === recheckId);
      const override = params.recheckOverrides?.[recheckId ?? ""];
      if (!row && !override) return { data: null, error: null };
      return {
        data: {
          lifecycle_state: override?.lifecycle_state ?? "active",
          last_activity_at:
            override?.last_activity_at ?? row?.last_activity_at ?? null,
          last_agent_activity_at:
            override?.last_agent_activity_at ?? row?.last_agent_activity_at ?? null,
          last_agent_probe_at:
            override && "last_agent_probe_at" in override
              ? override.last_agent_probe_at
              : (row?.last_agent_probe_at ?? null),
        },
        error: null,
      };
    });
    // Update chains are awaited directly; resolve them here and record the
    // write. The conditional pause update returns the matched row(s) so a
    // non-empty data array means "the row was still pausable".
    query.then = (resolve: (value: unknown) => void) => {
      if (mode === "update") {
        updates.push({
          id: updateId ?? "",
          patch: captured.patch,
          or: captured.or,
          select: captured.select,
        });
        resolve({ data: updateId ? [{ id: updateId }] : [], error: null });
      } else {
        resolve({ data: null, error: null });
      }
    };
    return query;
  });

  return { filters, updates };
}

const baseProxmoxInfra = {
  provider: "proxmox" as const,
  node: "fixturenode1",
  vmid: 200,
  privateIpv4: "10.250.21.50",
  gatewayHost: "abc.agents.hermesos.cloud",
};

describe("runInactivitySweep", () => {
  const originalEnv = process.env.HERMES_INACTIVITY_SWEEP_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.HERMES_INACTIVITY_SWEEP_ENABLED = "true";
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(baseProxmoxInfra);
    (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
    });
    (getProxmoxHostRoutingConfigFromInfrastructure as jest.Mock).mockReturnValue(
      null
    );
    (isProxmoxVmMissingResult as jest.Mock).mockReturnValue(false);
    (isProxmoxVmStillRunningResult as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.HERMES_INACTIVITY_SWEEP_ENABLED;
    } else {
      process.env.HERMES_INACTIVITY_SWEEP_ENABLED = originalEnv;
    }
  });

  it("does not sweep when the production opt-in is not enabled", async () => {
    delete process.env.HERMES_INACTIVITY_SWEEP_ENABLED;
    const staleRow: CandidateRow = {
      id: "inst_stale_backfill",
      user_id: "user_stale",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 200,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-10T15:55:09.653586Z",
    };

    buildSweepStub({ freeRows: [staleRow], paidRows: [], now: NOW_LATE });

    const summary = await runInactivitySweep({ now: NOW_LATE });

    expect(summary).toEqual({
      scanned: 0,
      swept: 0,
      failed: 0,
      skipped: 0,
      vmMissing: 0,
      agentActive: 0,
      activityUnknown: 0,
      channelGuarded: 0,
      freeIdleDays: 4,
      tokenIdleDays: 30,
      paidIdleDays: null,
      enabled: false,
      timedOut: false,
    });
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it("uses a 4-day cutoff for free tiers and exempts paid tiers by default", async () => {
    const { filters } = buildSweepStub({ freeRows: [], paidRows: [] });
    const summary = await runInactivitySweep({ now: NOW_EARLY });

    expect(summary).toEqual({
      scanned: 0,
      swept: 0,
      failed: 0,
      skipped: 0,
      vmMissing: 0,
      agentActive: 0,
      activityUnknown: 0,
      channelGuarded: 0,
      freeIdleDays: 4,
      tokenIdleDays: 30,
      paidIdleDays: null,
      enabled: true,
      timedOut: false,
    });

    const free = filters.find((f) => f.tier.includes("credit_base"));
    const paid = filters.find((f) => f.tier.includes("operator"));
    expect(free?.cutoff).toBe("2026-05-06T12:00:00.000Z");
    expect(paid).toBeUndefined();
  });

  it("gives token_base its own 30-day idle window, separate from the 4-day free window", async () => {
    // $HERMES holders were promised a 30-day grace and were nevertheless swept on
    // the 4-day free schedule, because token_base sat inside FREE_TIER_VALUES.
    // The two tiers must be scanned against different cutoffs.
    const { filters } = buildSweepStub({ freeRows: [], paidRows: [] });
    const summary = await runInactivitySweep({ now: NOW_EARLY });

    expect(summary.freeIdleDays).toBe(4);
    expect(summary.tokenIdleDays).toBe(30);

    const free = filters.find((f) => f.tier.includes("credit_base"));
    const token = filters.find((f) => f.tier.includes("token_base"));

    // credit_base and token_base are no longer scanned together.
    expect(free?.tier).not.toContain("token_base");
    expect(token?.tier).toEqual(["token_base"]);

    expect(free?.cutoff).toBe("2026-05-06T12:00:00.000Z"); // now - 4d
    expect(token?.cutoff).toBe("2026-04-10T12:00:00.000Z"); // now - 30d
  });

  it("does not pause a token_base instance idle for only 10 days", async () => {
    // Inside the 30-day grace. Under the old code this row sat in the free scan
    // and was paused at day 4.
    const tokenRow: CandidateRow = {
      id: "inst_token_young",
      user_id: "user_token",
      resource_tier: "token_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 210,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-04-30T12:00:00.000Z", // 10 days before NOW_EARLY
      created_at: "2026-04-01T12:00:00.000Z",
    };

    buildSweepStub({ freeRows: [], paidRows: [], tokenRows: [tokenRow] });

    const summary = await runInactivitySweep({ now: NOW_EARLY });

    expect(summary.scanned).toBe(1);
    expect(summary.swept).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
  });

  it("pauses a token_base instance once it passes 30 days idle", async () => {
    const tokenRow: CandidateRow = {
      id: "inst_token_old",
      user_id: "user_token",
      resource_tier: "token_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 211,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-04-01T12:00:00.000Z", // 39 days before NOW_EARLY
      created_at: "2026-03-01T12:00:00.000Z",
    };

    buildSweepStub({ freeRows: [], paidRows: [], tokenRows: [tokenRow] });

    const summary = await runInactivitySweep({ now: NOW_EARLY });

    expect(summary.scanned).toBe(1);
    expect(summary.swept).toBe(1);
    expect(shutdownProxmoxInstance).toHaveBeenCalledTimes(1);
  });

  it("judges each tier's agent-side usage against ITS OWN cutoff, not the widest one", async () => {
    // The usage table is read once against the OLDEST cutoff (token's 30 days).
    // A free-tier box whose last session was 20 days ago is inside that read but
    // well outside its own 4-day window — it must still be paused.
    const freeRow: CandidateRow = {
      id: "inst_free_old_session",
      user_id: "user_free",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 212,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-04-20T12:00:00.000Z",
      created_at: "2026-04-01T12:00:00.000Z",
    };

    buildSweepStub({
      freeRows: [freeRow],
      paidRows: [],
      // 20 days before NOW_EARLY: inside the 30d read window, outside the 4d one.
      agentUsage: { inst_free_old_session: "2026-04-20" },
    });

    const summary = await runInactivitySweep({ now: NOW_EARLY });

    expect(summary.agentActive).toBe(0);
    expect(summary.swept).toBe(1);
  });

  it("sweeps paid tiers only when HERMES_INACTIVITY_PAID_DAYS is explicitly set", async () => {
    process.env.HERMES_INACTIVITY_PAID_DAYS = "7";
    try {
      const { filters } = buildSweepStub({ freeRows: [], paidRows: [] });
      const summary = await runInactivitySweep({ now: NOW_EARLY });

      expect(summary.paidIdleDays).toBe(7);
      const paid = filters.find((f) => f.tier.includes("operator"));
      expect(paid?.cutoff).toBe("2026-05-03T12:00:00.000Z");
    } finally {
      delete process.env.HERMES_INACTIVITY_PAID_DAYS;
    }
  });

  it("pushes the agent-activity anchor into the candidate SELECT and the pause UPDATE", async () => {
    // SWEEP_BATCH_LIMIT caps the batch at 50. If agent-active rows were filtered
    // out only in memory, a fleet of Telegram-only users with stale dashboard
    // activity would fill every batch and genuinely-idle boxes would never be
    // reached. NULL stays in the candidate set so the in-memory fail-safe (not
    // this filter) decides what to do with an unprobed instance.
    const freeRow: CandidateRow = {
      id: "inst_or_filter",
      user_id: "user_or",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 213,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-01T12:00:00.000Z",
    };

    const { filters, updates } = buildSweepStub({ freeRows: [freeRow], paidRows: [] });

    await runInactivitySweep({ now: NOW_EARLY });

    const free = filters.find((f) => f.tier.includes("credit_base"));
    expect(free?.agentActivityOr).toBe(
      "last_agent_activity_at.is.null,last_agent_activity_at.lt.2026-05-06T12:00:00.000Z"
    );
    // The conditional pause write carries the same guard, so a Telegram message
    // landing between the recheck and the write cannot be labelled 'inactivity'.
    expect(updates).toHaveLength(1);
    expect(updates[0].or).toBe(
      "last_agent_activity_at.is.null,last_agent_activity_at.lt.2026-05-06T12:00:00.000Z"
    );
  });

  it("keeps every .or() column in the pause write's projection (PostgREST 42703 guard)", async () => {
    // REGRESSION (prod, 2026-07-09 -> 2026-07-16, introduced by #525).
    //
    // On a mutation asking for a representation back, PostgREST resolves `or=`
    // against the RETURNING projection rather than the base table. So filtering
    // the pause UPDATE on last_agent_activity_at while selecting only "id"
    // raised, on every single sweep tick:
    //   42703 column hermes_instances.last_agent_activity_at does not exist
    // ...for a column that plainly exists. Because the qm shutdown runs BEFORE
    // this write, the VM went down, the pause never got stamped, the row stayed
    // lifecycle_state='active' with a dead VM, and
    // recover-unhealthy-active-instances dutifully restarted it — an hourly
    // stop/fail/restart loop across ~33 free-tier boxes, surfacing to their
    // owners as intermittent gateway 503s.
    //
    // Asserting the exact string would just pin today's column list, so assert
    // the INVARIANT instead: every column the update filters on via .or() must
    // appear in the update's own .select(). That is the rule PostgREST actually
    // enforces, so this fails for the next column someone adds too. The plain
    // .eq()/.lt() filters resolve against the base table and are exempt.
    const freeRow: CandidateRow = {
      id: "inst_or_projection",
      user_id: "user_or_projection",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 214,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-01T12:00:00.000Z",
    };

    const { updates } = buildSweepStub({ freeRows: [freeRow], paidRows: [] });

    await runInactivitySweep({ now: NOW_EARLY });

    expect(updates).toHaveLength(1);
    const write = updates[0];
    expect(write.or).toBeTruthy();
    expect(write.select).toBeTruthy();

    // "col.op.value" / "col.is.null" -> "col", for each comma-joined branch.
    const orColumns = write
      .or!.split(",")
      .map((branch) => branch.trim().split(".")[0])
      .filter(Boolean);
    const projected = new Set(
      write.select!.split(",").map((col) => col.trim())
    );

    expect(orColumns.length).toBeGreaterThan(0);
    for (const column of orColumns) {
      // If this fails, the sweep will 42703 in prod AFTER powering the VM off.
      expect(projected).toContain(column);
    }
  });

  it("pauses Proxmox-backed candidates and writes paused_reason='inactivity'", async () => {
    const freeRow: CandidateRow = {
      id: "inst_free",
      user_id: "user_free",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 200,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-01T12:00:00.000Z",
    };
    const paidRow: CandidateRow = {
      ...freeRow,
      id: "inst_paid",
      user_id: "user_paid",
      resource_tier: "operator",
    };

    // Paid tiers are exempt by default; opt them into the sweep so this test
    // exercises pausing across BOTH a free and a paid candidate.
    process.env.HERMES_INACTIVITY_PAID_DAYS = "7";
    try {
      const { updates } = buildSweepStub({
        freeRows: [freeRow],
        paidRows: [paidRow],
      });

      const summary = await runInactivitySweep({
        now: new Date("2026-05-10T12:00:00.000Z"),
      });

      expect(summary.scanned).toBe(2);
      expect(summary.swept).toBe(2);
      expect(summary.failed).toBe(0);
      expect(shutdownProxmoxInstance).toHaveBeenCalledTimes(2);

      const ids = updates.map((u) => u.id).sort();
      expect(ids).toEqual(["inst_free", "inst_paid"]);
      for (const update of updates) {
        expect(update.patch).toEqual(
          expect.objectContaining({
            lifecycle_state: "paused",
            paused_reason: "inactivity",
            status: "stopped",
          })
        );
        expect(update.patch.last_lifecycle_transition_at).toEqual(
          expect.any(String)
        );
      }
    } finally {
      delete process.env.HERMES_INACTIVITY_PAID_DAYS;
    }
  });

  it("does NOT shut down a candidate that was resumed since selection (TOCTOU)", async () => {
    const freeRow: CandidateRow = {
      id: "inst_resumed",
      user_id: "user_resumed",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 200,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-01T12:00:00.000Z",
    };

    const { updates } = buildSweepStub({
      freeRows: [freeRow],
      paidRows: [],
      // The user resumed between candidate selection and the shutdown: the
      // pre-shutdown re-read now reports the row no longer 'active'.
      recheckOverrides: { inst_resumed: { lifecycle_state: "running" } },
    });

    const summary = await runInactivitySweep({
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary.scanned).toBe(1);
    expect(summary.swept).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
    // The irreversible qm shutdown must NOT fire for a row that changed since
    // selection, and no paused write should clobber the user's resume.
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("pauses a dormant instance even after a recent PLATFORM lifecycle transition", async () => {
    // Regression for the 2026-06-08 starvation: a fleet-wide maintenance pass
    // (webfree migration) bumped last_lifecycle_transition_at on ~599 idle
    // instances, which the old anchor logic treated as activity and refused to
    // pause for days. The user has been gone since 05-01 (stale last_activity_at
    // AND created_at); only the platform touched the row on 05-14. It must be
    // swept — last_lifecycle_transition_at is not a user-activity signal.
    const platformTouchedRow: CandidateRow = {
      id: "inst_recent_transition",
      user_id: "user_recent",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 200,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-01T12:00:00.000Z",
      created_at: "2026-05-01T12:00:00.000Z",
      last_lifecycle_transition_at: "2026-05-14T17:50:00.000Z",
    };

    buildSweepStub({ freeRows: [platformTouchedRow], paidRows: [], now: NOW_LATE });

    const summary = await runInactivitySweep({ now: NOW_LATE });

    expect(summary.scanned).toBe(1);
    expect(summary.swept).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(shutdownProxmoxInstance).toHaveBeenCalledTimes(1);
  });

  it("still skips an instance with genuinely recent user activity", async () => {
    // The guard that matters is preserved: real user activity (last_activity_at)
    // within the cutoff window keeps an instance off the chopping block.
    const recentlyActiveRow: CandidateRow = {
      id: "inst_recent_activity",
      user_id: "user_active",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 201,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-14T17:50:00.000Z",
      created_at: "2026-05-01T12:00:00.000Z",
      last_lifecycle_transition_at: "2026-05-14T17:50:00.000Z",
    };

    buildSweepStub({ freeRows: [recentlyActiveRow], paidRows: [], now: NOW_LATE });

    const summary = await runInactivitySweep({ now: NOW_LATE });

    expect(summary.scanned).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.swept).toBe(0);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
  });

  it("spares an instance with stale dashboard activity but recent AGENT-side usage", async () => {
    // The Telegram/Discord/standalone-webui case: last_activity_at (dashboard
    // only) is well past the cutoff, so the instance looks idle — but the agent
    // ran sessions inside the idle window (instance_usage_snapshots.sessions>0).
    // It must NOT be paused.
    const agentActiveRow: CandidateRow = {
      id: "inst_agent_active",
      user_id: "user_telegram",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 202,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-01T12:00:00.000Z",
      created_at: "2026-05-01T12:00:00.000Z",
      last_lifecycle_transition_at: "2026-05-01T12:00:00.000Z",
    };

    buildSweepStub({
      freeRows: [agentActiveRow],
      paidRows: [],
      now: NOW_LATE,
      // Inside the 4-day window (cutoff day 2026-05-10).
      agentUsage: { inst_agent_active: "2026-05-13" },
    });

    const summary = await runInactivitySweep({ now: NOW_LATE });

    expect(summary.scanned).toBe(1);
    expect(summary.agentActive).toBe(1);
    expect(summary.swept).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
  });

  it("spares an instance whose AGENT-side message watermark is recent (long-lived Telegram thread)", async () => {
    // The gap instance_usage_snapshots cannot see: the session STARTED before the
    // window (so it produces no in-window stat_date row) but messages kept flowing
    // inside it. last_agent_activity_at is the anchor that catches this.
    const threadRow: CandidateRow = {
      id: "inst_long_thread",
      user_id: "user_telegram",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 214,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-01T12:00:00.000Z",
      created_at: "2026-05-01T12:00:00.000Z",
      // Session started 2026-05-01 (no in-window row), last message yesterday.
      last_agent_activity_at: "2026-05-13T22:00:00.000Z",
    };

    buildSweepStub({
      freeRows: [threadRow],
      paidRows: [],
      now: NOW_LATE,
      agentUsage: {},
    });

    const summary = await runInactivitySweep({ now: NOW_LATE });

    expect(summary.scanned).toBe(1);
    expect(summary.swept).toBe(0);
    // Recent agent activity makes the row not-dormant at the anchor stage.
    expect(summary.skipped).toBe(1);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
  });

  it("still pauses a dashboard-idle instance with NO agent-side usage", async () => {
    // Control for the tests above: same stale row, a fresh probe proving we can see
    // the agent, no channel, no sessions. Genuinely idle — it must be swept.
    const idleRow: CandidateRow = {
      id: "inst_truly_idle",
      user_id: "user_idle",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 203,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-01T12:00:00.000Z",
      created_at: "2026-05-01T12:00:00.000Z",
      last_lifecycle_transition_at: "2026-05-01T12:00:00.000Z",
    };

    buildSweepStub({
      freeRows: [idleRow],
      paidRows: [],
      now: NOW_LATE,
      agentUsage: {},
      channelConnectedIds: [],
    });

    const summary = await runInactivitySweep({ now: NOW_LATE });

    expect(summary.scanned).toBe(1);
    expect(summary.agentActive).toBe(0);
    expect(summary.activityUnknown).toBe(0);
    expect(summary.channelGuarded).toBe(0);
    expect(summary.swept).toBe(1);
    expect(shutdownProxmoxInstance).toHaveBeenCalledTimes(1);
  });

  it("fails CLOSED and pauses nothing when the agent-usage signal is unreadable", async () => {
    // A blind pause pass could destroy actively-used-over-Telegram agents, so an
    // unreadable instance_usage_snapshots query aborts the whole pause pass.
    const idleRow: CandidateRow = {
      id: "inst_blind",
      user_id: "user_blind",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 204,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-01T12:00:00.000Z",
      created_at: "2026-05-01T12:00:00.000Z",
      last_lifecycle_transition_at: "2026-05-01T12:00:00.000Z",
    };

    buildSweepStub({
      freeRows: [idleRow],
      paidRows: [],
      now: NOW_LATE,
      agentUsageError: "permission denied for table instance_usage_snapshots",
    });

    const summary = await runInactivitySweep({ now: NOW_LATE });

    expect(summary.scanned).toBe(1);
    expect(summary.swept).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.agentActive).toBe(0);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
  });

  it("fails CLOSED and pauses nothing when the channel-connection signal is unreadable", async () => {
    // Same reasoning as the usage table: if we cannot tell who talks to their agent
    // over Telegram, we cannot tell who is idle.
    const idleRow: CandidateRow = {
      id: "inst_blind_channel",
      user_id: "user_blind",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 205,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-01T12:00:00.000Z",
      created_at: "2026-05-01T12:00:00.000Z",
    };

    buildSweepStub({
      freeRows: [idleRow],
      paidRows: [],
      now: NOW_LATE,
      channelError: "permission denied for table channel_connections",
    });

    const { reportOpsEvent } = await import("@/lib/ops-events");

    const summary = await runInactivitySweep({ now: NOW_LATE });

    expect(summary.scanned).toBe(1);
    expect(summary.swept).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "inactivity_sweep_agent_usage_unreadable",
        metadata: expect.objectContaining({ signal: "channel_connections" }),
      })
    );
  });

  // ── FAIL-SAFE: silence is never idleness ──────────────────────────────────
  //
  // An idle agent and an unreachable agent produce byte-identical evidence in
  // instance_usage_snapshots: nothing. Pausing on that ambiguity is what paused →
  // reclaimed → cold-archived agents whose owners were using them over Telegram
  // every day. Every path below must SPARE the instance.

  describe("fail-safe: never pause on an undeterminable activity signal", () => {
    function dashboardIdleRow(overrides: Partial<CandidateRow> = {}): CandidateRow {
      return {
        id: "inst_unknown",
        user_id: "user_unknown",
        resource_tier: "credit_base",
        proxmox_node: "fixturenode1",
        proxmox_vmid: 220,
        host_id: null,
        config: { infrastructure: baseProxmoxInfra },
        last_activity_at: "2026-05-01T12:00:00.000Z",
        created_at: "2026-05-01T12:00:00.000Z",
        ...overrides,
      };
    }

    it("does NOT pause an instance the harvester has never probed", async () => {
      // last_agent_probe_at IS NULL. We have no idea what this agent has been
      // doing. This is also the fleet's state on the very first deploy, before
      // the harvester has run once — the sweep must pause nothing, not everything.
      const row = dashboardIdleRow({ last_agent_probe_at: null });
      const { updates } = buildSweepStub({ freeRows: [row], paidRows: [], now: NOW_LATE });

      const summary = await runInactivitySweep({ now: NOW_LATE });

      expect(summary.scanned).toBe(1);
      expect(summary.activityUnknown).toBe(1);
      expect(summary.swept).toBe(0);
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it("does NOT pause an instance whose probe has gone stale (harvester broken)", async () => {
      // The 2026-06-07 scenario: the harvester silently stopped reaching the fleet.
      // Its last successful read of this box was 5 days ago; the default tolerance
      // is 36h. Unknown, therefore spared.
      const row = dashboardIdleRow({
        last_agent_probe_at: "2026-05-09T18:15:00.000Z", // 5 days before NOW_LATE
      });
      buildSweepStub({ freeRows: [row], paidRows: [], now: NOW_LATE });

      const summary = await runInactivitySweep({ now: NOW_LATE });

      expect(summary.activityUnknown).toBe(1);
      expect(summary.swept).toBe(0);
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    });

    it("pauses the same instance once the probe is fresh again", async () => {
      // Control: identical row, probe inside the 36h tolerance. The fail-safe is a
      // guard on an unknown signal, not a blanket refusal to ever pause.
      const row = dashboardIdleRow({
        last_agent_probe_at: "2026-05-14T06:15:00.000Z", // 12h before NOW_LATE
      });
      buildSweepStub({ freeRows: [row], paidRows: [], now: NOW_LATE });

      const summary = await runInactivitySweep({ now: NOW_LATE });

      expect(summary.activityUnknown).toBe(0);
      expect(summary.swept).toBe(1);
      expect(shutdownProxmoxInstance).toHaveBeenCalledTimes(1);
    });

    it("aborts the pause when the probe goes stale between selection and shutdown", async () => {
      // The last fail-safe, inside pauseInstance. A slow batch of SSH shutdowns can
      // span minutes; the re-read immediately before the irreversible `qm shutdown`
      // is the only thing that notices the signal went blind mid-run.
      const row = dashboardIdleRow({ id: "inst_stale_at_pause" });
      const { updates } = buildSweepStub({
        freeRows: [row],
        paidRows: [],
        now: NOW_LATE,
        recheckOverrides: {
          inst_stale_at_pause: { last_agent_probe_at: "2026-05-01T00:00:00.000Z" },
        },
      });

      const summary = await runInactivitySweep({ now: NOW_LATE });

      expect(summary.scanned).toBe(1);
      expect(summary.activityUnknown).toBe(1);
      expect(summary.swept).toBe(0);
      expect(summary.failed).toBe(0);
      // The irreversible shutdown must not have fired, and nothing was written.
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it("aborts the pause when the probe is missing at shutdown time", async () => {
      const row = dashboardIdleRow({ id: "inst_null_at_pause" });
      buildSweepStub({
        freeRows: [row],
        paidRows: [],
        now: NOW_LATE,
        recheckOverrides: { inst_null_at_pause: { last_agent_probe_at: null } },
      });

      const summary = await runInactivitySweep({ now: NOW_LATE });

      expect(summary.activityUnknown).toBe(1);
      expect(summary.swept).toBe(0);
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
    });

    it("does NOT pause a channel-connected instance with stale dashboard activity", async () => {
      // The headline bug. The owner talks to this agent over Telegram; the dashboard
      // has not been opened in two weeks. There is no agent-side watermark to prove
      // use either way — so we cannot prove idleness, and we do not pause.
      const row = dashboardIdleRow({ id: "inst_telegram_only" });
      const { updates } = buildSweepStub({
        freeRows: [row],
        paidRows: [],
        now: NOW_LATE,
        agentUsage: {},
        channelConnectedIds: ["inst_telegram_only"],
      });

      const summary = await runInactivitySweep({ now: NOW_LATE });

      expect(summary.scanned).toBe(1);
      expect(summary.channelGuarded).toBe(1);
      expect(summary.swept).toBe(0);
      expect(summary.activityUnknown).toBe(0);
      expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    });

    it("DOES pause a channel-connected instance once its agent watermark proves it idle", async () => {
      // The channel guard is not a permanent exemption. Connect Telegram, then stop
      // using the agent for two weeks, and the watermark says so plainly.
      const row = dashboardIdleRow({
        id: "inst_telegram_lapsed",
        last_agent_activity_at: "2026-05-02T12:00:00.000Z", // 12 days stale
      });
      buildSweepStub({
        freeRows: [row],
        paidRows: [],
        now: NOW_LATE,
        channelConnectedIds: ["inst_telegram_lapsed"],
      });

      const summary = await runInactivitySweep({ now: NOW_LATE });

      expect(summary.channelGuarded).toBe(0);
      expect(summary.swept).toBe(1);
      expect(shutdownProxmoxInstance).toHaveBeenCalledTimes(1);
    });

    it("checks the UNKNOWN fail-safe before the channel guard and the usage gate", async () => {
      // Ordering matters: an unprobed, channel-connected box is UNKNOWN, not merely
      // channel-guarded. Counting it as the latter would hide a broken harvester.
      const row = dashboardIdleRow({
        id: "inst_unknown_and_channel",
        last_agent_probe_at: null,
      });
      buildSweepStub({
        freeRows: [row],
        paidRows: [],
        now: NOW_LATE,
        channelConnectedIds: ["inst_unknown_and_channel"],
      });

      const summary = await runInactivitySweep({ now: NOW_LATE });

      expect(summary.activityUnknown).toBe(1);
      expect(summary.channelGuarded).toBe(0);
      expect(summary.swept).toBe(0);
    });
  });

  it("counts a Hetzner-backed candidate as skipped, not failed", async () => {
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(null);
    const hetznerRow: CandidateRow = {
      id: "inst_legacy",
      user_id: "user_legacy",
      resource_tier: "credit_base",
      proxmox_node: null,
      proxmox_vmid: null,
      host_id: null,
      config: {},
      last_activity_at: "2026-05-01T12:00:00.000Z",
    };

    buildSweepStub({ freeRows: [hetznerRow], paidRows: [] });

    const summary = await runInactivitySweep({
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary.scanned).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.swept).toBe(0);
    expect(summary.failed).toBe(0);
    expect(shutdownProxmoxInstance).not.toHaveBeenCalled();
  });

  it("counts a failed graceful shutdown without aborting the sweep", async () => {
    (shutdownProxmoxInstance as jest.Mock)
      .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "boom" })
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" });

    const rowA: CandidateRow = {
      id: "inst_fails",
      user_id: "user_a",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 200,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-01T12:00:00.000Z",
    };
    const rowB: CandidateRow = { ...rowA, id: "inst_ok", user_id: "user_b" };

    buildSweepStub({ freeRows: [rowA, rowB], paidRows: [] });

    const summary = await runInactivitySweep({
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary.scanned).toBe(2);
    expect(summary.swept).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(0);
  });

  it("marks a missing-VM candidate failed instead of emitting an ops error", async () => {
    // Mirrors the production exit-64 path: qm shutdown on a destroyed VM
    // returns ok=false but the stdout carries HERMES_VM_MISSING. Previously
    // the sweep threw "Remote bash exited with code 64" and kept retrying
    // the phantom row forever.
    (shutdownProxmoxInstance as jest.Mock).mockResolvedValueOnce({
      ok: false,
      stdout: "HERMES_VM_MISSING\n",
      stderr: "",
      error: "Proxmox host script exited with code 64",
    });
    (isProxmoxVmMissingResult as jest.Mock).mockReturnValueOnce(true);

    const row: CandidateRow = {
      id: "inst_phantom",
      user_id: "user_phantom",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 7777,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-01T12:00:00.000Z",
    };

    const { updates } = buildSweepStub({ freeRows: [row], paidRows: [] });

    const { reportOpsEvent } = await import("@/lib/ops-events");

    const summary = await runInactivitySweep({
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary.scanned).toBe(1);
    expect(summary.vmMissing).toBe(1);
    expect(summary.swept).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(0);

    // Row flipped to lifecycle_state='failed' via buildInstanceLifecyclePatch.
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("inst_phantom");
    expect(updates[0].patch).toEqual(
      expect.objectContaining({
        lifecycle_state: "failed",
        status: "error",
      })
    );

    // Crucially, no ops-error event — the previous bug emitted these on
    // every sweep, drowning the ops feed in inactivity_sweep_pause_failed.
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("never records paused/stopped for a VM the shutdown script says is STILL running", async () => {
    // The shutdown script polls qm status and fails with HERMES_STILL_RUNNING
    // when the guest won't power off. Writing paused/stopped here would mint the
    // exact paused-but-running ghost the reconciler has to clean up, so the
    // pause must be refused (counted failed) and leave the row untouched.
    (shutdownProxmoxInstance as jest.Mock).mockResolvedValueOnce({
      ok: false,
      stdout: "HERMES_STILL_RUNNING\n",
      stderr: "",
      error: "Proxmox host script exited with code 65",
    });
    (isProxmoxVmStillRunningResult as jest.Mock).mockReturnValueOnce(true);

    const row: CandidateRow = {
      id: "inst_wedged",
      user_id: "user_wedged",
      resource_tier: "credit_base",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 250,
      host_id: null,
      config: { infrastructure: baseProxmoxInfra },
      last_activity_at: "2026-05-01T12:00:00.000Z",
    };

    const { updates } = buildSweepStub({ freeRows: [row], paidRows: [] });

    const summary = await runInactivitySweep({
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(summary.scanned).toBe(1);
    expect(summary.swept).toBe(0);
    expect(summary.failed).toBe(1);
    // The row was NOT written to paused/stopped — no ghost minted.
    expect(
      updates.some((u) => u.patch?.status === "stopped" || u.patch?.lifecycle_state === "paused")
    ).toBe(false);
  });

  describe("time budget", () => {
    function dormantRow(i: number): CandidateRow {
      return {
        id: `inst_budget_${i}`,
        user_id: `user_budget_${i}`,
        resource_tier: "credit_base",
        proxmox_node: "fixturenode1",
        proxmox_vmid: 300 + i,
        host_id: null,
        config: { infrastructure: baseProxmoxInfra },
        // Well past the 4-day free cutoff so every row is confirmed-dormant.
        last_activity_at: "2026-05-01T12:00:00.000Z",
        created_at: "2026-04-01T12:00:00.000Z",
        last_lifecycle_transition_at: "2026-05-01T12:00:00.000Z",
      };
    }

    it("stops starting new pauses once the wall-clock budget is exhausted", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => dormantRow(i));
      buildSweepStub({ freeRows: rows, paidRows: [] });

      // Clock advances 100ms each read; a 250ms budget should allow only the
      // first couple of pauses before the gate trips.
      let t = 0;
      const clock = () => {
        t += 100;
        return t;
      };

      const summary = await runInactivitySweep({
        now: new Date("2026-05-10T12:00:00.000Z"),
        timeBudgetMs: 250,
        clock,
      });

      expect(summary.timedOut).toBe(true);
      // Far fewer than all 10 were paused — the budget truncated the run.
      expect(summary.swept).toBeGreaterThan(0);
      expect(summary.swept).toBeLessThan(10);
      // Only the paused prefix hit Proxmox; the deferred tail was never touched.
      expect((shutdownProxmoxInstance as jest.Mock).mock.calls.length).toBe(
        summary.swept
      );
    });

    it("processes the whole batch and reports timedOut=false when the budget is ample", async () => {
      const rows = Array.from({ length: 5 }, (_, i) => dormantRow(i));
      buildSweepStub({ freeRows: rows, paidRows: [] });

      const summary = await runInactivitySweep({
        now: new Date("2026-05-10T12:00:00.000Z"),
        timeBudgetMs: 1_000_000,
        clock: () => 0,
      });

      expect(summary.timedOut).toBe(false);
      expect(summary.swept).toBe(5);
      expect((shutdownProxmoxInstance as jest.Mock).mock.calls.length).toBe(5);
    });
  });
});
