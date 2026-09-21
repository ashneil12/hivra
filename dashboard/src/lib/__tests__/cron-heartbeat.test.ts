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

import { recordCronHeartbeat, runCronHeartbeatWatchdog, CRON_REGISTRY } from "../cron-heartbeat";
import { reportOpsEvent } from "@/lib/ops-events";

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

describe("recordCronHeartbeat", () => {
  afterEach(() => jest.clearAllMocks());

  it("calls the record_cron_heartbeat RPC with the cron name", async () => {
    const rpc = jest.fn().mockResolvedValue({ error: null });
    mockSupabaseAdmin.value = { rpc };
    await recordCronHeartbeat("probe-instance-health");
    expect(rpc).toHaveBeenCalledWith("record_cron_heartbeat", { p_cron_name: "probe-instance-health" });
  });

  it("never throws when the RPC errors (best-effort)", async () => {
    const rpc = jest.fn().mockResolvedValue({ error: { message: "boom" } });
    mockSupabaseAdmin.value = { rpc };
    await expect(recordCronHeartbeat("purge-expired")).resolves.toBeUndefined();
  });
});

describe("runCronHeartbeatWatchdog", () => {
  afterEach(() => jest.clearAllMocks());

  function mockHeartbeats(rows: Array<{ cron_name: string; last_success_at: string | null }>) {
    mockSupabaseAdmin.value = {
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue({
          data: rows.map((r) => ({
            cron_name: r.cron_name,
            last_success_at: r.last_success_at,
            last_run_at: r.last_success_at,
            ok_count: 10,
            run_count: 10,
          })),
          error: null,
        }),
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

  it("does NOT page a cron that is within its staleness budget", async () => {
    // 6 min stale on a 5-min cron is under the 10-min budget.
    mockHeartbeats([{ cron_name: "probe-instance-health", last_success_at: minutesAgoIso(6) }]);

    const result = await runCronHeartbeatWatchdog();

    expect(result.stale).toHaveLength(0);
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("does NOT page a never-seen cron (no baseline)", async () => {
    // No rows at all — every registered cron is unseen.
    mockHeartbeats([]);

    const result = await runCronHeartbeatWatchdog();

    expect(result.checked).toBe(CRON_REGISTRY.length);
    expect(result.stale).toHaveLength(0);
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("does NOT page a cron whose row exists but never recorded a success", async () => {
    mockHeartbeats([{ cron_name: "purge-expired", last_success_at: null }]);

    const result = await runCronHeartbeatWatchdog();

    expect(result.stale).toHaveLength(0);
    expect(reportOpsEvent).not.toHaveBeenCalled();
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
