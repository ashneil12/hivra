import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_ACTIVITY_RETENTION_DAYS,
  MIN_ACTIVITY_RETENTION_DAYS,
  activityRetentionCutoff,
  resolveActivityRetentionConfig,
  runActivityRetention,
} from "@/lib/ops/activity-retention";

type Counts = { expiredEvents: number; deletedComputerEvents: number; deletedComputerCollectors: number };

function fakeClient(responses: { dryRun: Counts; batches: Counts[] }) {
  const calls: Array<{ p_cutoff: string; p_batch_size: number; p_dry_run: boolean }> = [];
  let batch = 0;
  const rpc = jest.fn(async (name: string, args: (typeof calls)[number]) => {
    expect(name).toBe("prune_hivra_activity");
    calls.push(args);
    if (args.p_dry_run) return { data: responses.dryRun, error: null };
    const next = responses.batches[batch++] ?? { expiredEvents: 0, deletedComputerEvents: 0, deletedComputerCollectors: 0 };
    return { data: next, error: null };
  });
  return { client: { rpc } as unknown as SupabaseClient, calls };
}

const counts = (e: number, d: number, c: number): Counts => ({
  expiredEvents: e,
  deletedComputerEvents: d,
  deletedComputerCollectors: c,
});

describe("resolveActivityRetentionConfig", () => {
  it("defaults to OFF and 90 days", () => {
    expect(resolveActivityRetentionConfig({})).toEqual({
      enabled: false,
      retentionDays: DEFAULT_ACTIVITY_RETENTION_DAYS,
    });
    expect(DEFAULT_ACTIVITY_RETENTION_DAYS).toBe(90);
  });

  it("enables only on an explicit true", () => {
    expect(resolveActivityRetentionConfig({ ACTIVITY_RETENTION_ENABLED: "true" }).enabled).toBe(true);
    expect(resolveActivityRetentionConfig({ ACTIVITY_RETENTION_ENABLED: " TRUE " }).enabled).toBe(true);
    for (const value of ["1", "yes", "on", "false", ""]) {
      expect(resolveActivityRetentionConfig({ ACTIVITY_RETENTION_ENABLED: value }).enabled).toBe(false);
    }
  });

  it("clamps the window to 30..90 days and ignores garbage", () => {
    expect(resolveActivityRetentionConfig({ ACTIVITY_RETENTION_DAYS: "0" }).retentionDays).toBe(MIN_ACTIVITY_RETENTION_DAYS);
    expect(resolveActivityRetentionConfig({ ACTIVITY_RETENTION_DAYS: "45" }).retentionDays).toBe(45);
    // Never longer than the Privacy Policy's 90 days.
    expect(resolveActivityRetentionConfig({ ACTIVITY_RETENTION_DAYS: "365" }).retentionDays).toBe(90);
    expect(resolveActivityRetentionConfig({ ACTIVITY_RETENTION_DAYS: "-5" }).retentionDays).toBe(90);
    expect(resolveActivityRetentionConfig({ ACTIVITY_RETENTION_DAYS: "abc" }).retentionDays).toBe(90);
  });
});

describe("runActivityRetention", () => {
  const now = new Date("2026-09-23T00:00:00.000Z");

  it("only counts when disabled (dry run) and deletes nothing", async () => {
    const { client, calls } = fakeClient({ dryRun: counts(12, 3, 1), batches: [] });
    const summary = await runActivityRetention(client, {
      config: { enabled: false, retentionDays: 90 },
      now,
    });
    expect(summary).toEqual({
      dryRun: true,
      enabled: false,
      retentionDays: 90,
      cutoff: "2026-06-25T00:00:00.000Z",
      eligible: counts(12, 3, 1),
      deleted: counts(0, 0, 0),
      batches: 0,
      complete: true,
    });
    expect(calls.every((call) => call.p_dry_run)).toBe(true);
    expect(calls[0].p_cutoff).toBe(activityRetentionCutoff(now, 90).toISOString());
  });

  it("stays a dry run when forced even if enabled", async () => {
    const { client, calls } = fakeClient({ dryRun: counts(1, 0, 0), batches: [counts(1, 0, 0)] });
    const summary = await runActivityRetention(client, {
      config: { enabled: true, retentionDays: 90 },
      forceDryRun: true,
      now,
    });
    expect(summary.dryRun).toBe(true);
    expect(summary.deleted).toEqual(counts(0, 0, 0));
    expect(calls.some((call) => !call.p_dry_run)).toBe(false);
  });

  it("deletes in bounded batches until a partial batch", async () => {
    const { client, calls } = fakeClient({
      dryRun: counts(250, 10, 2),
      batches: [counts(100, 10, 2), counts(100, 0, 0), counts(50, 0, 0)],
    });
    const summary = await runActivityRetention(client, {
      config: { enabled: true, retentionDays: 90 },
      now,
      batchSize: 100,
    });
    expect(summary.dryRun).toBe(false);
    expect(summary.deleted).toEqual(counts(250, 10, 2));
    expect(summary.batches).toBe(3);
    expect(summary.complete).toBe(true);
    expect(calls.filter((call) => !call.p_dry_run)).toHaveLength(3);
  });

  it("stops at the batch cap and reports the run as incomplete", async () => {
    const { client } = fakeClient({
      dryRun: counts(1000, 0, 0),
      batches: Array.from({ length: 10 }, () => counts(100, 0, 0)),
    });
    const summary = await runActivityRetention(client, {
      config: { enabled: true, retentionDays: 90 },
      now,
      batchSize: 100,
      maxBatches: 3,
    });
    expect(summary.batches).toBe(3);
    expect(summary.deleted.expiredEvents).toBe(300);
    expect(summary.complete).toBe(false);
  });

  it("surfaces an RPC failure instead of reporting success", async () => {
    const client = {
      rpc: jest.fn(async () => ({ data: null, error: { message: "permission denied" } })),
    } as unknown as SupabaseClient;
    await expect(
      runActivityRetention(client, { config: { enabled: true, retentionDays: 90 }, now })
    ).rejects.toThrow("prune_hivra_activity failed: permission denied");
  });
});
