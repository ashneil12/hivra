/**
 * Tests for the cron dead-man switch.
 *
 * Vercel Cron failures are silent — a recovery/prober cron that 500s or gets
 * de-scheduled produces no signal. The heartbeat + watchdog turn that silence
 * into a fatal ops event. We lock in:
 *   - recordCronHeartbeat() calls the upsert RPC and never throws on error
 *   - the watchdog pages (fatal) for a registered cron stale > 2x its period
 *   - a fresh / never-seen cron does NOT page (no baseline)
 *   - a cron within its budget does NOT page
 */

const mockSupabaseAdmin = { value: null as unknown };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.value;
  },
}));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import {
  claimCronUtcDay,
  claimCronUtcDayOutcome,
  recordCronHeartbeat,
  runCronHeartbeatWatchdog,
  CRON_REGISTRY,
} from "../cron-heartbeat";
import { reportOpsEvent } from "@/lib/ops-events";
import { createManagedVeniceMemoryDb } from "@/test-utils/managed-venice-memory-db";

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

describe("recordCronHeartbeat", () => {
  afterEach(() => jest.clearAllMocks());

  it("calls the record_cron_heartbeat RPC with just the cron name when no outcome is given", async () => {
    const rpc = jest.fn().mockResolvedValue({ error: null });
    mockSupabaseAdmin.value = { rpc };
    await recordCronHeartbeat("probe-instance-health");
    // One-arg shape keeps working against BOTH the pre-migration
    // record_cron_heartbeat(text) and the outcome-aware function's defaults.
    expect(rpc).toHaveBeenCalledWith("record_cron_heartbeat", { p_cron_name: "probe-instance-health" });
  });

  it("passes ok:false + detail through for a run with per-item failures", async () => {
    const rpc = jest.fn().mockResolvedValue({ error: null });
    mockSupabaseAdmin.value = { rpc };
    await recordCronHeartbeat("reconcile-crypto-topups", {
      ok: false,
      detail: "recon_failed=2 credit_sweep=0 mv_sweep=0",
    });
    expect(rpc).toHaveBeenCalledWith("record_cron_heartbeat", {
      p_cron_name: "reconcile-crypto-topups",
      p_ok: false,
      p_detail: "recon_failed=2 credit_sweep=0 mv_sweep=0",
    });
  });

  it("passes p_ok:true + null detail for an explicit ok outcome", async () => {
    const rpc = jest.fn().mockResolvedValue({ error: null });
    mockSupabaseAdmin.value = { rpc };
    await recordCronHeartbeat("purge-expired", { ok: true });
    expect(rpc).toHaveBeenCalledWith("record_cron_heartbeat", {
      p_cron_name: "purge-expired",
      p_ok: true,
      p_detail: null,
    });
  });

  it("never throws when the RPC errors (best-effort)", async () => {
    const rpc = jest.fn().mockResolvedValue({ error: { message: "boom" } });
    mockSupabaseAdmin.value = { rpc };
    await expect(recordCronHeartbeat("purge-expired")).resolves.toBeUndefined();
  });
});

describe("runCronHeartbeatWatchdog", () => {
  afterEach(() => jest.clearAllMocks());

  function mockHeartbeats(
    rows: Array<{
      cron_name: string;
      last_success_at: string | null;
      last_run_at?: string | null;
      run_count?: number | null;
      created_at?: string | null;
    }>,
  ) {
    mockSupabaseAdmin.value = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue({
          data: rows.map((r) => ({
            cron_name: r.cron_name,
            last_success_at: r.last_success_at,
            last_run_at: r.last_run_at ?? r.last_success_at,
            ok_count: 10,
            run_count: r.run_count ?? 10,
            created_at: r.created_at ?? minutesAgoIso(24 * 60),
          })),
          error: null,
        }),
        upsert: jest.fn().mockResolvedValue({ error: null }),
      }),
    };
  }

  it("emits a fatal event for a cron stale beyond 2x its period", async () => {
    // probe-instance-health runs every 5 min → budget 10 min. 30 min stale pages.
    mockHeartbeats([{ cron_name: "probe-instance-health", last_success_at: minutesAgoIso(30) }]);

    const result = await runCronHeartbeatWatchdog();

    expect(result.stale.map((s) => s.name)).toEqual(["probe-instance-health"]);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "synthetic.cron-dead-man",
        severity: "fatal",
        route: "/api/cron/probe-instance-health",
        metadata: expect.objectContaining({
          failureType: "cron_heartbeat_stale",
          cronName: "probe-instance-health",
        }),
      }),
    );
  });

  it("uses a STABLE title/message (staleMinutes only in metadata) so a prolonged stall pages once", async () => {
    // Regression: the title/message used to embed Math.round(staleMinutes), which
    // grows every ~10-min watchdog tick. reportOpsEvent fingerprints on
    // (source,title,message,route) and pages only on the INSERT branch, so a
    // changing title minted a fresh fingerprint every tick and re-paged — a
    // single stalled cron became 372 admin emails over ~2.5 days. Two runs at
    // different staleness must now yield identical fingerprint inputs.
    mockHeartbeats([{ cron_name: "probe-instance-health", last_success_at: minutesAgoIso(30) }]);
    await runCronHeartbeatWatchdog();
    const first = (reportOpsEvent as jest.Mock).mock.calls[0][0];

    jest.clearAllMocks();
    mockHeartbeats([{ cron_name: "probe-instance-health", last_success_at: minutesAgoIso(240) }]);
    await runCronHeartbeatWatchdog();
    const second = (reportOpsEvent as jest.Mock).mock.calls[0][0];

    // Fingerprint inputs are identical across the two staleness levels.
    expect(first.title).toBe(second.title);
    expect(first.message).toBe(second.message);
    expect(first.route).toBe(second.route);
    // Title carries no volatile number.
    expect(first.title).toBe("Cron stalled: probe-instance-health");
    // The volatile staleness is preserved — in metadata, which is NOT fingerprinted.
    expect(first.metadata.staleMinutes).not.toBe(second.metadata.staleMinutes);
    expect(first.metadata.staleMinutes).toBeGreaterThanOrEqual(29);
  });

  it("keeps the never-reported message stable across marker ages so a dead cron pages once", async () => {
    // Regression companion to the stable-message test above: the never-reported
    // branch embedded the marker's live age (Math.round(staleMinutes)) in the
    // message, so every watchdog tick minted a fresh fingerprint and re-paged —
    // exactly the re-page-every-10-minutes failure the stable-message change
    // fixed for the stale branch. Two ticks of the same ongoing never-reported
    // stall must now produce identical fingerprint inputs.
    mockHeartbeats([
      {
        cron_name: "probe-instance-health",
        last_success_at: null,
        last_run_at: null,
        run_count: 0,
        created_at: minutesAgoIso(30),
      },
    ]);
    await runCronHeartbeatWatchdog();
    const first = (reportOpsEvent as jest.Mock).mock.calls[0][0];

    jest.clearAllMocks();
    mockHeartbeats([
      {
        cron_name: "probe-instance-health",
        last_success_at: null,
        last_run_at: null,
        run_count: 0,
        created_at: minutesAgoIso(240),
      },
    ]);
    await runCronHeartbeatWatchdog();
    const second = (reportOpsEvent as jest.Mock).mock.calls[0][0];

    expect(first.title).toBe(second.title);
    expect(first.message).toBe(second.message);
    expect(first.route).toBe(second.route);
    expect(first.metadata.neverReported).toBe(true);
    // The marker's live age is preserved — in metadata, outside the fingerprint.
    expect(first.metadata.staleMinutes).not.toBe(second.metadata.staleMinutes);
  });

  it("does NOT page a cron that is within its staleness budget", async () => {
    // 6 min stale on a 5-min cron is under the 10-min budget.
    mockHeartbeats([{ cron_name: "probe-instance-health", last_success_at: minutesAgoIso(6) }]);

    const result = await runCronHeartbeatWatchdog();

    expect(result.stale).toHaveLength(0);
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("does NOT page a never-seen cron but plants its expected-since marker", async () => {
    // No rows at all — every registered cron is unseen. First sighting is not
    // pageable (wiring may trail the registry), but the watchdog plants a
    // run_count=0 marker per missing cron so a cron that NEVER writes its
    // first heartbeat still ages toward a page instead of staying invisible.
    mockHeartbeats([]);

    const result = await runCronHeartbeatWatchdog();

    expect(result.checked).toBe(CRON_REGISTRY.length);
    expect(result.stale).toHaveLength(0);
    expect(reportOpsEvent).not.toHaveBeenCalled();
    const upsert = (
      mockSupabaseAdmin.value as { from: (name: string) => { upsert: jest.Mock } }
    ).from("ops_cron_heartbeats").upsert;
    expect(upsert).toHaveBeenCalledTimes(CRON_REGISTRY.length);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ cron_name: expect.any(String), run_count: 0 }),
      { onConflict: "cron_name", ignoreDuplicates: true },
    );
  });

  it("pages a registered cron that never reported once its marker is 3x its period old", async () => {
    // probe-instance-health runs every 5 min → never-reported budget is 3x =
    // 15 min. Its watchdog-planted marker row (run_count 0, no run ever) is
    // 30 min old: the cron always dies before its first heartbeat write —
    // exactly the invisible-failure case the marker exists for.
    mockHeartbeats([
      {
        cron_name: "probe-instance-health",
        last_success_at: null,
        last_run_at: null,
        run_count: 0,
        created_at: minutesAgoIso(30),
      },
    ]);

    const result = await runCronHeartbeatWatchdog();

    expect(result.stale.map((s) => s.name)).toEqual(["probe-instance-health"]);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "synthetic.cron-dead-man",
        severity: "fatal",
        metadata: expect.objectContaining({
          cronName: "probe-instance-health",
          neverReported: true,
          runCount: 0,
        }),
      }),
    );
  });

  it("does NOT page a never-reported cron still inside its 3x-period grace", async () => {
    // Marker only 10 min old on a 5-min cron (15 min budget): the first runs
    // may still be landing — benefit of the doubt, no page.
    mockHeartbeats([
      {
        cron_name: "probe-instance-health",
        last_success_at: null,
        last_run_at: null,
        run_count: 0,
        created_at: minutesAgoIso(10),
      },
    ]);

    const result = await runCronHeartbeatWatchdog();

    expect(result.stale).toHaveLength(0);
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("does NOT page a cron whose row exists but never ran (no baseline)", async () => {
    mockHeartbeats([{ cron_name: "purge-expired", last_success_at: null, run_count: 0 }]);

    const result = await runCronHeartbeatWatchdog();

    expect(result.stale).toHaveLength(0);
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("pages a cron that has run but never succeeded once it is 3x its period old", async () => {
    // purge-expired runs daily (1440 min) → never-succeeded budget is 3x = 3
    // days. The row was created 4 days ago, has run 10 times, never succeeded.
    // Failing runs keep last_run_at fresh, so only the created_at reference
    // can see this dead cron.
    mockHeartbeats([
      {
        cron_name: "purge-expired",
        last_success_at: null,
        last_run_at: minutesAgoIso(5),
        run_count: 10,
        created_at: minutesAgoIso(4 * 24 * 60),
      },
    ]);

    const result = await runCronHeartbeatWatchdog();

    expect(result.stale.map((s) => s.name)).toEqual(["purge-expired"]);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "synthetic.cron-dead-man",
        severity: "fatal",
        metadata: expect.objectContaining({
          cronName: "purge-expired",
          neverSucceeded: true,
        }),
      }),
    );
  });

  it("does NOT page a never-succeeded cron still inside its 3x-period grace", async () => {
    // Same shape but created 1 day ago on a daily cron: within the 3-day
    // never-succeeded budget, so it gets the benefit of the doubt.
    mockHeartbeats([
      {
        cron_name: "purge-expired",
        last_success_at: null,
        last_run_at: minutesAgoIso(5),
        run_count: 2,
        created_at: minutesAgoIso(24 * 60),
      },
    ]);

    const result = await runCronHeartbeatWatchdog();

    expect(result.stale).toHaveLength(0);
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });
});

describe("claimCronUtcDay", () => {
  afterEach(() => jest.clearAllMocks());

  // The claim is a single guarded UPDATE on the cron's heartbeat row: move
  // last_run_at into today, but only while last_run_at is still before today.
  // A matched row = this invocation owns the day's once-only work.
  function claimDb(result: { data: unknown; error: { message?: string } | null }) {
    const calls: Array<{
      patch: Record<string, unknown>;
      filters: Array<{ op: string; column: string; value: unknown }>;
    }> = [];
    const db = {
      from: (name: string) => {
        if (name !== "ops_cron_heartbeats") throw new Error(`unexpected table ${name}`);
        return {
          update: (patch: Record<string, unknown>) => {
            const call = { patch, filters: [] as Array<{ op: string; column: string; value: unknown }> };
            calls.push(call);
            const query = {
              eq: (column: string, value: string) => {
                call.filters.push({ op: "eq", column, value });
                return query;
              },
              lt: (column: string, value: string) => {
                call.filters.push({ op: "lt", column, value });
                return query;
              },
              select: () => Promise.resolve(result),
            };
            return query;
          },
        };
      },
    };
    return { db, calls };
  }

  it("moves last_run_at into today under a before-today guard and returns true", async () => {
    const { db, calls } = claimDb({ data: [{ cron_name: "reconcile-crypto-topups" }], error: null });
    const now = new Date("2026-04-24T12:00:00.000Z");

    await expect(claimCronUtcDay(db, "reconcile-crypto-topups", now)).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].patch).toEqual(
      expect.objectContaining({ last_run_at: now.toISOString(), updated_at: now.toISOString() })
    );
    // The guard is what makes overlapping invocations exclusive: only a row
    // whose last_run_at is still before today's UTC start may be moved.
    expect(calls[0].filters).toEqual([
      { op: "eq", column: "cron_name", value: "reconcile-crypto-topups" },
      { op: "lt", column: "last_run_at", value: "2026-04-24T00:00:00.000Z" },
    ]);
  });

  it("returns false when the guarded update matches nothing (day already claimed)", async () => {
    const { db } = claimDb({ data: [], error: null });

    await expect(
      claimCronUtcDay(db, "reconcile-crypto-topups", new Date("2026-04-24T12:00:00.000Z"))
    ).resolves.toBe(false);
  });

  it("returns false when the claim update fails, and never throws", async () => {
    const { db } = claimDb({ data: null, error: { message: "db exploded" } });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      claimCronUtcDay(db, "reconcile-crypto-topups", new Date("2026-04-24T12:00:00.000Z"))
    ).resolves.toBe(false);
    warnSpy.mockRestore();
  });

  it("returns false without a db instead of throwing into the cron", async () => {
    await expect(claimCronUtcDay(null, "reconcile-crypto-topups", new Date())).resolves.toBe(false);
    await expect(claimCronUtcDay(undefined, "reconcile-crypto-topups", new Date())).resolves.toBe(false);
  });
});

describe("claimCronUtcDay with a claim key", () => {
  afterEach(() => jest.clearAllMocks());

  // A keyed claim owns a dedicated heartbeat row ("<cron>:<key>") so the
  // once-daily slot is stamped by the tick that RAN the work — the run's own
  // heartbeat can land on a later UTC day without masking the next day's
  // slot. These run against the shared in-memory Supabase so the guarded
  // update, the planted baseline and the persisted rows are all real.

  it("claims the day on the dedicated row, seeded from the cron's previous heartbeat", async () => {
    const memory = createManagedVeniceMemoryDb({
      ops_cron_heartbeats: [{ cron_name: "cron-x", last_run_at: "2026-04-23T23:00:00.000Z" }],
    });
    const now = new Date("2026-04-24T00:10:00.000Z");

    await expect(
      claimCronUtcDay(memory.db, "cron-x", now, { claimKey: "daily" })
    ).resolves.toBe(true);

    const rows = memory.tables.ops_cron_heartbeats;
    expect(rows.find((row) => row.cron_name === "cron-x:daily")?.last_run_at).toBe(now.toISOString());
    // The cron's own heartbeat row is untouched by the claim.
    expect(rows.find((row) => row.cron_name === "cron-x")?.last_run_at).toBe(
      "2026-04-23T23:00:00.000Z"
    );
  });

  it("clamps an inherited same-day baseline so the day can still be claimed", async () => {
    // First sight of the claim key with the base heartbeat already inside
    // today. Planting that timestamp verbatim would stamp a claim-shaped
    // last_run_at the keyed pass never earned: if the claim write behind it
    // failed transiently, every later tick would read "held" with the day's
    // once-daily work run on none. The inherited baseline is clamped to
    // before the day start instead — the retry claims for real, at the one-
    // time cost of re-running a day the old scheme may already have covered
    // (the once-daily pass is idempotent, so at most one extra pass).
    const memory = createManagedVeniceMemoryDb({
      ops_cron_heartbeats: [{ cron_name: "cron-x", last_run_at: "2026-04-24T06:00:00.000Z" }],
    });
    const now = new Date("2026-04-24T00:10:00.000Z");

    await expect(
      claimCronUtcDay(memory.db, "cron-x", now, { claimKey: "daily" })
    ).resolves.toBe(true);
    // The row is claimed, not merely planted: its timestamp is this tick.
    expect(
      memory.tables.ops_cron_heartbeats.find((row) => row.cron_name === "cron-x:daily")?.last_run_at
    ).toBe(now.toISOString());

    // Exclusivity is preserved: a second same-day claim is held.
    await expect(
      claimCronUtcDay(memory.db, "cron-x", new Date("2026-04-24T01:00:00.000Z"), {
        claimKey: "daily",
      })
    ).resolves.toBe(false);
  });

  it("leaves the keyed day claimable when the post-plant claim write fails", async () => {
    // The poison path: earlier ticks' claim updates failed transiently while
    // the run heartbeat advanced into today, so the planted baseline reads
    // like a same-day claim. Without the clamp, the failed retry leaves that
    // row planted with "today" — every later tick answers "held" and the
    // once-daily pass runs on NO tick of this UTC day. With it, the planted
    // baseline is before the day start, so the next healthy tick claims.
    const memory = createManagedVeniceMemoryDb({
      ops_cron_heartbeats: [{ cron_name: "cron-x", last_run_at: "2026-04-24T06:00:00.000Z" }],
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    // Fail the retry claim only: the first update misses by matching no row
    // (it errors nothing), the plant upsert succeeds, the retry update is
    // the second "update" op — failNext's match sees them in order.
    let updateCalls = 0;
    memory.failNext({
      table: "ops_cron_heartbeats",
      op: "update",
      match: () => ++updateCalls === 2,
    });

    await expect(
      claimCronUtcDayOutcome(memory.db, "cron-x", new Date("2026-04-24T12:00:00.000Z"), {
        claimKey: "daily",
      })
    ).resolves.toBe("failed");
    warnSpy.mockRestore();

    // The plant landed, but with a pre-today baseline — the day was never
    // stamped as held, so the next tick's claim still wins it.
    const planted = memory.tables.ops_cron_heartbeats.find((row) => row.cron_name === "cron-x:daily");
    expect(planted?.last_run_at).toBe("2026-04-23T23:59:59.999Z");
    await expect(
      claimCronUtcDayOutcome(memory.db, "cron-x", new Date("2026-04-24T13:00:00.000Z"), {
        claimKey: "daily",
      })
    ).resolves.toBe("claimed");
  });

  it("is claimed for the day the tick ran even when the run heartbeat lands on the next day", async () => {
    // The midnight edge the key exists for: tick starts 23:59, claims 04-23;
    // the run finishes after midnight so its heartbeat lands 04-24. 04-24's
    // first tick must still get its claim — the keyed row holds 04-23.
    const memory = createManagedVeniceMemoryDb({
      ops_cron_heartbeats: [{ cron_name: "cron-x", last_run_at: "2026-04-22T12:00:00.000Z" }],
    });

    await expect(
      claimCronUtcDay(memory.db, "cron-x", new Date("2026-04-23T23:59:00.000Z"), {
        claimKey: "daily",
      })
    ).resolves.toBe(true);

    const runRow = memory.tables.ops_cron_heartbeats.find((row) => row.cron_name === "cron-x")!;
    runRow.last_run_at = "2026-04-24T00:05:00.000Z";

    await expect(
      claimCronUtcDay(memory.db, "cron-x", new Date("2026-04-24T00:10:00.000Z"), {
        claimKey: "daily",
      })
    ).resolves.toBe(true);
  });

  it("is exclusive for overlapping same-day claims on the keyed row", async () => {
    const memory = createManagedVeniceMemoryDb({
      ops_cron_heartbeats: [{ cron_name: "cron-x", last_run_at: "2026-04-23T12:00:00.000Z" }],
    });
    const now = new Date("2026-04-24T00:10:00.000Z");

    await expect(
      claimCronUtcDay(memory.db, "cron-x", now, { claimKey: "daily" })
    ).resolves.toBe(true);
    await expect(
      claimCronUtcDay(memory.db, "cron-x", now, { claimKey: "daily" })
    ).resolves.toBe(false);
  });
});

describe("claimCronUtcDayOutcome", () => {
  afterEach(() => jest.clearAllMocks());

  // The boolean claim collapses "the day is already taken" and "the claim
  // write itself failed" into the same false — but they are opposites for a
  // caller's health report: the first means the day's work ran (a clean
  // skip), the second means the once-daily pass ran on NO tick while the
  // route could still stamp a clean heartbeat. The outcome keeps them apart:
  // "claimed" owns the day, "held" skips clean, "failed" degrades.

  it("answers 'claimed' when the guarded update takes the day", async () => {
    const memory = createManagedVeniceMemoryDb({
      ops_cron_heartbeats: [{ cron_name: "cron-x", last_run_at: "2026-04-23T12:00:00.000Z" }],
    });

    await expect(
      claimCronUtcDayOutcome(memory.db, "cron-x", new Date("2026-04-24T00:10:00.000Z"))
    ).resolves.toBe("claimed");
  });

  it("answers 'held' when the day is already taken — a clean skip, not a failure", async () => {
    const memory = createManagedVeniceMemoryDb({
      ops_cron_heartbeats: [{ cron_name: "cron-x", last_run_at: "2026-04-24T06:00:00.000Z" }],
    });

    await expect(
      claimCronUtcDayOutcome(memory.db, "cron-x", new Date("2026-04-24T12:00:00.000Z"))
    ).resolves.toBe("held");
  });

  it("answers 'failed' when the claim update errors, and the day stays unclaimed", async () => {
    const memory = createManagedVeniceMemoryDb({
      ops_cron_heartbeats: [{ cron_name: "cron-x", last_run_at: "2026-04-23T12:00:00.000Z" }],
    });
    memory.failNext({ table: "ops_cron_heartbeats", op: "update" });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      claimCronUtcDayOutcome(memory.db, "cron-x", new Date("2026-04-24T12:00:00.000Z"))
    ).resolves.toBe("failed");
    warnSpy.mockRestore();
    // Nothing was claimed: the NEXT tick's claim still wins the day.
    expect(memory.tables.ops_cron_heartbeats[0].last_run_at).toBe("2026-04-23T12:00:00.000Z");
    await expect(
      claimCronUtcDayOutcome(memory.db, "cron-x", new Date("2026-04-24T13:00:00.000Z"))
    ).resolves.toBe("claimed");
  });

  it("answers 'failed' when a keyed claim's row read errors, distinct from a held day", async () => {
    const memory = createManagedVeniceMemoryDb({
      ops_cron_heartbeats: [{ cron_name: "cron-x", last_run_at: "2026-04-23T12:00:00.000Z" }],
    });
    // The claim update misses (keyed row does not exist yet); the follow-up
    // existence read is what fails.
    memory.failNext({ table: "ops_cron_heartbeats", op: "select" });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      claimCronUtcDayOutcome(memory.db, "cron-x", new Date("2026-04-24T12:00:00.000Z"), {
        claimKey: "daily",
      })
    ).resolves.toBe("failed");
    warnSpy.mockRestore();
  });

  it("answers 'held' for a keyed claim another run already owns today", async () => {
    const memory = createManagedVeniceMemoryDb({
      ops_cron_heartbeats: [
        { cron_name: "cron-x", last_run_at: "2026-04-23T12:00:00.000Z" },
        { cron_name: "cron-x:daily", last_run_at: "2026-04-24T06:00:00.000Z" },
      ],
    });

    await expect(
      claimCronUtcDayOutcome(memory.db, "cron-x", new Date("2026-04-24T12:00:00.000Z"), {
        claimKey: "daily",
      })
    ).resolves.toBe("held");
  });

  it("keeps claimCronUtcDay boolean-compatible: claimed is true, held and failed are false", async () => {
    const memory = createManagedVeniceMemoryDb({
      ops_cron_heartbeats: [{ cron_name: "cron-x", last_run_at: "2026-04-23T12:00:00.000Z" }],
    });
    const now = new Date("2026-04-24T12:00:00.000Z");

    await expect(claimCronUtcDay(memory.db, "cron-x", now)).resolves.toBe(true);
    // Second same-day claim is held → false.
    await expect(claimCronUtcDay(memory.db, "cron-x", now)).resolves.toBe(false);

    memory.failNext({ table: "ops_cron_heartbeats", op: "update" });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      claimCronUtcDay(memory.db, "cron-x", new Date("2026-04-25T12:00:00.000Z"))
    ).resolves.toBe(false);
    warnSpy.mockRestore();
  });
});

describe("CRON_REGISTRY covers the backup crons", () => {
  // Both backup crons already stamped a heartbeat but were absent from the
  // registry, so the watchdog never checked them: the one failure they exist to
  // guard against — a silent fleet-wide backup stop — was the one nothing would
  // notice. These cover PAID tenants' data, so silence is a data-loss risk.
  it.each(["daily-vm-backups", "daily-instance-backups"])("registers %s as a daily cron", (name) => {
    const entry = CRON_REGISTRY.find((c) => c.name === name);
    expect(entry).toBeDefined();
    // vercel.json schedules both daily ("30 2 * * *" / "0 4 * * *").
    expect(entry!.periodMinutes).toBe(1440);
  });
});
