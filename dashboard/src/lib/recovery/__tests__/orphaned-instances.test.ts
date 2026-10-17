import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ORPHAN_GRACE_HOURS,
  rotatingContainmentBatch,
  runOrphanSweep,
  type InstanceShutdownFn,
  type OrphanedInstanceRow,
} from "@/lib/recovery/orphaned-instances";
import { reportOpsEvent } from "@/lib/ops-events";

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn().mockResolvedValue({ id: "evt", fingerprint: "fp" }),
  // The logger calls sanitizeOpsMetadata on every log line; without this the
  // log.warn inside disableOrphanedInstance throws before our test asserts.
  sanitizeOpsMetadata: jest.fn((m: Record<string, unknown>) => m),
}));

function buildClerk(userIdsAlive: Set<string>) {
  return {
    // Batch lookup: return only the ids that exist (alive); absent = orphan.
    getUserList: jest.fn(async ({ userId }: { userId: string[]; limit?: number }) => ({
      data: userId.filter((id) => userIdsAlive.has(id)).map((id) => ({ id })),
    })),
  };
}

interface SupabaseMockSetup {
  rows: OrphanedInstanceRow[];
}

function buildSupabaseMock({ rows }: SupabaseMockSetup) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

  // listLiveInstances now keyset-paginates:
  //   .from().select().neq()[.eq()][.gt()].order().limit()
  // Return all rows on the first page; rows.length < pageSize ends the loop.
  const result = { data: rows, error: null };
  const queryChain: Record<string, jest.Mock> = {};
  queryChain.or = jest.fn(() => queryChain);
  queryChain.neq = jest.fn(() => queryChain);
  queryChain.eq = jest.fn(() => queryChain);
  queryChain.gt = jest.fn(() => queryChain);
  queryChain.order = jest.fn(() => queryChain);
  queryChain.limit = jest.fn(async () => result);
  const select = jest.fn(() => queryChain);

  const update = jest.fn((patch: Record<string, unknown>) => {
    let id = "";
    const chain: { eq: jest.Mock; select: jest.Mock } = {
      eq: jest.fn((column: string, value: string) => { if (column === "id") id = value; return chain; }),
      select: jest.fn(async () => { updates.push({ id, patch }); return { data: [{ id }], error: null }; }),
    };
    return chain;
  });

  const supabase = {
    from: jest.fn(() => ({
      select,
      update,
    })),
  } as unknown as SupabaseClient;

  return { supabase, updates, queryChain, update };
}

describe("runOrphanSweep", () => {
  const aliveRow: OrphanedInstanceRow = {
    id: "alive-1",
    user_id: "user_alive",
    name: "Alive",
    status: "running",
    backend: "webui",
    hetzner_server_id: 100,
    host_id: null,
    config: null,
    created_at: "2026-04-19T00:00:00Z",
  };
  const orphanRow: OrphanedInstanceRow = {
    id: "orphan-1",
    user_id: "user_gone",
    name: "Vesper",
    status: "running",
    backend: "webui",
    hetzner_server_id: 200,
    host_id: null,
    config: null,
    created_at: "2026-04-30T14:50:19Z",
  };
  const alreadyFlaggedOrphan: OrphanedInstanceRow = {
    id: "orphan-2",
    user_id: "user_alsoGone",
    name: "Orion",
    status: "scheduled_for_deletion",
    backend: "webui",
    hetzner_server_id: 300,
    host_id: null,
    config: { owner_orphaned: true, owner_orphaned_at: "2026-04-28T00:00:00Z" },
    created_at: "2026-04-19T20:51:32Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("filters legacy runtime discovery by user identity", async () => {
    const { supabase, queryChain } = buildSupabaseMock({ rows: [] });
    await runOrphanSweep({ supabase, clerk: buildClerk(new Set()), apply: false, filter: { userId: "user_old" } });
    expect(queryChain.eq).toHaveBeenCalledWith("user_id", "user_old");
  });

  it("dry-run reports counts but neither calls shutdown nor writes Supabase", async () => {
    const { supabase, updates } = buildSupabaseMock({
      rows: [aliveRow, orphanRow, alreadyFlaggedOrphan],
    });
    const clerk = buildClerk(new Set(["user_alive"]));
    const shutdownInstance: InstanceShutdownFn = jest.fn();

    const summary = await runOrphanSweep({
      supabase,
      clerk,
      apply: false,
      shutdownInstance,
    });

    expect(summary).toEqual({
      totalChecked: 3,
      alive: 1,
      orphans: 2,
      lookupFailures: 0,
      newlyDisabled: 0,
      shutdownFailures: 0,
      orphanIds: ["orphan-1", "orphan-2"],
    });
    expect(shutdownInstance).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("apply calls the row-aware shutdown, schedules deletion 3d out, and emits an ops_event", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-05-01T19:00:00Z"));

    const { supabase, updates } = buildSupabaseMock({
      rows: [aliveRow, orphanRow, alreadyFlaggedOrphan],
    });
    const clerk = buildClerk(new Set(["user_alive"]));
    const shutdownInstance: jest.MockedFunction<InstanceShutdownFn> = jest.fn().mockResolvedValue({ ok: true });

    const summary = await runOrphanSweep({
      supabase,
      clerk,
      apply: true,
      shutdownInstance,
    });

    expect(summary.newlyDisabled).toBe(1);
    expect(summary.shutdownFailures).toBe(0);
    // Caller's shutdownInstance receives the orphan row, not just an ID — that
    // is what lets the cron route branch on Proxmox vs. shared-host vs. legacy
    // Hetzner without the helper having to know any of those rules.
    expect(shutdownInstance).toHaveBeenCalledTimes(2);
    expect(shutdownInstance).toHaveBeenCalledWith(orphanRow);

    // Previously flagged rows must be checked without resetting the grace clock.
    expect(updates[1].patch).not.toHaveProperty("scheduled_deletion_at");
    expect(updates).toHaveLength(2);
    expect(updates[0].id).toBe("orphan-1");
    expect(updates[0].patch).toMatchObject({
      status: "scheduled_for_deletion",
      // 72h after the system clock above
      scheduled_deletion_at: "2026-05-04T19:00:00.000Z",
      config: expect.objectContaining({ owner_orphaned: true }),
    });

    expect(reportOpsEvent).toHaveBeenCalledTimes(2);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "orphan-1",
        userId: "user_gone",
        severity: "warn",
        metadata: expect.objectContaining({
          grace_hours: ORPHAN_GRACE_HOURS,
          shutdown_ok: true,
          shutdown_skipped: false,
        }),
      }),
    );

    jest.useRealTimers();
  });

  it("still schedules deletion when shutdown fails — provider outage shouldn't keep the row flying", async () => {
    const { supabase, updates } = buildSupabaseMock({ rows: [orphanRow] });
    const clerk = buildClerk(new Set());
    const shutdownInstance: InstanceShutdownFn = jest.fn().mockResolvedValue({
      ok: false,
      detail: "Hetzner 503",
    });

    const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const summary = await runOrphanSweep({
      supabase,
      clerk,
      apply: true,
      shutdownInstance,
    });

    expect(summary.newlyDisabled).toBe(1);
    expect(summary.shutdownFailures).toBe(1);
    expect(updates).toHaveLength(1); // still wrote scheduled_deletion_at
    expect(updates[0].patch).toMatchObject({ status: "scheduled_for_deletion" });
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          shutdown_ok: false,
          shutdown_skipped: false,
          shutdown_detail: "Hetzner 503",
        }),
      }),
    );

    consoleWarnSpy.mockRestore();
  });

  it("shared-host shutdown refusal remains an unresolved containment failure", async () => {
    const { supabase, updates } = buildSupabaseMock({ rows: [orphanRow] });
    const clerk = buildClerk(new Set());
    const shutdownInstance: InstanceShutdownFn = jest.fn().mockResolvedValue({
      ok: false,
      skipped: true,
      detail: "shared host has 2 other live instance(s)",
    });

    const summary = await runOrphanSweep({
      supabase,
      clerk,
      apply: true,
      shutdownInstance,
    });

    // Row still flagged + scheduled, but skipped shutdowns are tracked
    // separately so the operator can tell "we backed off on purpose" from
    // "Hetzner errored" in the cron summary.
    expect(summary.newlyDisabled).toBe(1);
    expect(summary.shutdownFailures).toBe(1);
    expect(updates).toHaveLength(1);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          shutdown_ok: false,
          shutdown_skipped: true,
        }),
      }),
    );
  });

  it("treats Clerk transient errors (5xx / network) as lookup-failed, not orphan", async () => {
    const { supabase, updates } = buildSupabaseMock({ rows: [orphanRow] });
    const transientErr = new Error("ECONNRESET");
    const clerk = {
      // A failing batch lookup must be treated as lookup-failed (fail-safe),
      // never as orphan — we must not schedule deletion for unverified owners.
      getUserList: jest.fn().mockRejectedValue(transientErr),
    };

    const summary = await runOrphanSweep({
      supabase,
      clerk,
      apply: true,
      shutdownInstance: jest.fn(),
    });

    expect(summary).toEqual(
      expect.objectContaining({
        orphans: 0,
        lookupFailures: 1,
        newlyDisabled: 0,
      }),
    );
    expect(updates).toEqual([]);
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("resolves ownership in ONE batched Clerk call, deduped per distinct owner (no N+1)", async () => {
    // Two instances share an owner; a third has a different owner. The sweep
    // must make a single getUserList call with the 2 DISTINCT ids — not three
    // (or two) per-instance lookups.
    const aliveRowTwo: OrphanedInstanceRow = { ...aliveRow, id: "alive-2" };
    const { supabase } = buildSupabaseMock({
      rows: [aliveRow, aliveRowTwo, orphanRow],
    });
    const clerk = buildClerk(new Set(["user_alive"]));

    const summary = await runOrphanSweep({
      supabase,
      clerk,
      apply: false,
      shutdownInstance: jest.fn(),
    });

    expect(clerk.getUserList).toHaveBeenCalledTimes(1);
    expect(clerk.getUserList).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ["user_alive", "user_gone"] }),
    );
    expect(summary).toEqual(
      expect.objectContaining({ orphans: 1, lookupFailures: 0 }),
    );
  });
});

it("rotates a bounded batch so repeated failures cannot starve later rows", () => {
  const rows = ["a", "b", "c", "d", "e"];
  const seen = new Set<string>();
  for (let tick = 0; tick < 5; tick++) {
    const selected = rotatingContainmentBatch(rows, 2, new Date(tick * 15 * 60_000));
    expect(selected).toHaveLength(2);
    selected.forEach((id) => seen.add(id));
  }
  expect([...seen].sort()).toEqual(rows);
});

it("does not persist stale orphan config after concurrent terminal deletion", async () => {
  const row = { id: "row", user_id: "user_gone", status: "running", config: {}, created_at: "2026-01-01", updated_at: "version-before-delete" } as OrphanedInstanceRow;
  const { supabase, updates, update } = buildSupabaseMock({ rows: [row] });
  const chain: { eq: jest.Mock; select: jest.Mock } = { eq: jest.fn(() => chain), select: jest.fn().mockResolvedValue({ data: [], error: null }) };
  update.mockReturnValue(chain);
  const result = await runOrphanSweep({ supabase, clerk: buildClerk(new Set()), apply: true, shutdownInstance: jest.fn().mockResolvedValue({ ok: true }) });
  expect(chain.eq).toHaveBeenCalledWith("user_id", row.user_id);
  expect(chain.eq).toHaveBeenCalledWith("status", "running");
  expect(chain.eq).toHaveBeenCalledWith("updated_at", row.updated_at);
  expect(result.newlyDisabled).toBe(0);
  expect(result.shutdownFailures).toBe(1);
  expect(updates).toHaveLength(0);
});

it("keeps the missed-webhook ownership check on a fifteen-minute schedule", () => {
  const config = require("../../../../vercel.json");
  expect(config.crons.find((entry: { path: string }) => entry.path === "/api/cron/check-orphaned-instances").schedule).toBe("*/15 * * * *");
});
