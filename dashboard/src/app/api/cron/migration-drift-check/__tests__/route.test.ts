import { NextRequest } from "next/server";

import { GET } from "../route";
import {
  recordCronHeartbeat,
  runCronHeartbeatWatchdog,
} from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { runMigrationDriftCheck } from "@/lib/migration-drift";
import { reportOpsEvent } from "@/lib/ops-events";
import { createManagedVeniceMemoryDb } from "@/test-utils/managed-venice-memory-db";

jest.mock("@/lib/migration-drift", () => {
  const actual = jest.requireActual("@/lib/migration-drift");
  return {
    ...actual,
    runMigrationDriftCheck: jest.fn(),
  };
});

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn().mockResolvedValue(null),
}));

const mockSupabaseAdmin = { value: null as unknown };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.value;
  },
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/cron-heartbeat", () => ({
  recordCronHeartbeat: jest.fn(),
  runCronHeartbeatWatchdog: jest.fn().mockResolvedValue({ checked: 1, stale: [] }),
}));

function buildReq(headers: Record<string, string> = {}) {
  return new NextRequest("https://example/api/cron/migration-drift-check", {
    headers: new Headers(headers),
  });
}

describe("GET /api/cron/migration-drift-check", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabaseAdmin.value = null;
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rejects missing bearer auth with 401", async () => {
    const res = await GET(buildReq());
    expect(res.status).toBe(401);
    expect(runMigrationDriftCheck).not.toHaveBeenCalled();
    expect(runCronHeartbeatWatchdog).not.toHaveBeenCalled();
  });

  it("rejects when CRON_SECRET is unset with 500", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(buildReq({ authorization: "Bearer anything" }));
    expect(res.status).toBe(500);
    expect(runMigrationDriftCheck).not.toHaveBeenCalled();
    expect(runCronHeartbeatWatchdog).not.toHaveBeenCalled();
  });

  it("starts the cron watchdog while the migration ledger is still pending", async () => {
    let resolveLedger!: (
      value: Awaited<ReturnType<typeof runMigrationDriftCheck>>
    ) => void;
    const ledgerPromise = new Promise<
      Awaited<ReturnType<typeof runMigrationDriftCheck>>
    >((resolve) => {
      resolveLedger = resolve;
    });
    jest.mocked(runMigrationDriftCheck).mockReturnValueOnce(ledgerPromise);

    const responsePromise = GET(buildReq({ authorization: "Bearer cron-secret" }));

    expect(runCronHeartbeatWatchdog).toHaveBeenCalledTimes(1);
    expect(runMigrationDriftCheck).toHaveBeenCalledTimes(1);

    resolveLedger({
      totalLocal: 0,
      totalApplied: 0,
      missing: [],
      unexpected: [],
      versionMismatched: [],
    });
    const res = await responsePromise;

    expect(res.status).toBe(200);
  });

  it("bounds the watchdog wait so a ledger failure still returns a structured 500", async () => {
    jest.useFakeTimers();
    try {
      (runCronHeartbeatWatchdog as jest.Mock).mockReturnValueOnce(
        new Promise(() => {})
      );
      jest
        .mocked(runMigrationDriftCheck)
        .mockRejectedValueOnce(new Error("migration ledger RPC failed"));

      const responsePromise = GET(
        buildReq({ authorization: "Bearer cron-secret" })
      );
      let settled = false;
      void responsePromise.then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(5000);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(true);

      const res = await responsePromise;
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        success: false,
        error: "migration ledger RPC failed",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("waits for a deferred watchdog heartbeat read before stamping the success heartbeat", async () => {
    jest.useFakeTimers();
    try {
      let resolveWatchdog!: (
        value: Awaited<ReturnType<typeof runCronHeartbeatWatchdog>>
      ) => void;
      const watchdogPromise = new Promise<
        Awaited<ReturnType<typeof runCronHeartbeatWatchdog>>
      >((resolve) => {
        resolveWatchdog = resolve;
      });
      jest
        .mocked(runCronHeartbeatWatchdog)
        .mockReturnValueOnce(watchdogPromise);
      jest.mocked(runMigrationDriftCheck).mockResolvedValueOnce({
        totalLocal: 0,
        totalApplied: 0,
        missing: [],
        unexpected: [],
        versionMismatched: [],
      });

      const responsePromise = GET(
        buildReq({ authorization: "Bearer cron-secret" })
      );

      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(5000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(recordCronHeartbeat).not.toHaveBeenCalled();

      resolveWatchdog({ checked: 1, stale: [] });
      const res = await responsePromise;

      expect(res.status).toBe(200);
      expect(recordCronHeartbeat).toHaveBeenCalledWith("migration-drift-check");
    } finally {
      jest.useRealTimers();
    }
  });

  it("waits for slow stale-cron alerts before stamping the success heartbeat", async () => {
    jest.useFakeTimers();
    try {
      const completionOrder: string[] = [];
      let finishFirstAlert!: () => void;
      const firstAlert = new Promise<void>((resolve) => {
        finishFirstAlert = resolve;
      });
      (reportOpsEvent as jest.Mock).mockImplementationOnce(() => firstAlert);
      jest.mocked(runCronHeartbeatWatchdog).mockImplementationOnce(async () => {
        await (reportOpsEvent as jest.Mock)({
          source: "synthetic.cron-dead-man",
          severity: "fatal",
          title: "Cron stalled: probe-instance-health",
          message: "first slow alert",
          route: "/api/cron/probe-instance-health",
        });
        completionOrder.push("first-alert");
        await (reportOpsEvent as jest.Mock)({
          source: "synthetic.cron-dead-man",
          severity: "fatal",
          title: "Cron stalled: migration-drift-check",
          message: "second queued alert",
          route: "/api/cron/migration-drift-check",
        });
        completionOrder.push("second-alert");
        return { checked: 2, stale: [] };
      });
      jest.mocked(recordCronHeartbeat).mockImplementationOnce(async () => {
        completionOrder.push("heartbeat");
      });
      jest.mocked(runMigrationDriftCheck).mockResolvedValueOnce({
        totalLocal: 0,
        totalApplied: 0,
        missing: [],
        unexpected: [],
        versionMismatched: [],
      });

      const responsePromise = GET(
        buildReq({ authorization: "Bearer cron-secret" })
      );

      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(5000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(completionOrder).toEqual([]);
      expect(reportOpsEvent).toHaveBeenCalledTimes(1);
      expect(recordCronHeartbeat).not.toHaveBeenCalled();

      finishFirstAlert();
      const res = await responsePromise;

      expect(res.status).toBe(200);
      expect(reportOpsEvent).toHaveBeenCalledTimes(2);
      expect(completionOrder).toEqual([
        "first-alert",
        "second-alert",
        "heartbeat",
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("returns success with no ops events when there is no drift", async () => {
    (runMigrationDriftCheck as jest.Mock).mockResolvedValue({
      totalLocal: 5,
      totalApplied: 5,
      missing: [],
      unexpected: [],
      versionMismatched: [],
    });

    const res = await GET(buildReq({ authorization: "Bearer cron-secret" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.missing).toEqual([]);
    expect(body.data.cronWatchdog).toEqual({ checked: 1, stale: [] });
    expect(reportOpsEvent).not.toHaveBeenCalled();
    expect(recordCronHeartbeat).toHaveBeenCalledWith("migration-drift-check");
    expect(
      (runCronHeartbeatWatchdog as jest.Mock).mock.invocationCallOrder[0]
    ).toBeLessThan(
      (recordCronHeartbeat as jest.Mock).mock.invocationCallOrder[0]
    );
  });

  it("emits one fatal ops event per missing migration", async () => {
    // Mirrors the 2026-05-12 incident: three repo migrations never made
    // it to prod. Each one needs its own ops-feed row so the operator
    // sees exactly which names are stuck.
    (runMigrationDriftCheck as jest.Mock).mockResolvedValue({
      totalLocal: 5,
      totalApplied: 2,
      missing: [
        { version: "20260512120000", name: "proxmox_hosts_disk_capacity" },
        { version: "20260512180000", name: "managed_venice_wallets" },
        { version: "20260512181000", name: "managed_venice_token_quotes" },
      ],
      unexpected: [{ version: "20260512000000", name: "out_of_band_change" }],
      versionMismatched: [],
    });

    const res = await GET(buildReq({ authorization: "Bearer cron-secret" }));

    expect(res.status).toBe(200);
    expect(reportOpsEvent).toHaveBeenCalledTimes(3);
    const calls = (reportOpsEvent as jest.Mock).mock.calls.map(
      (call) => call[0]
    );
    expect(calls.map((c) => c.metadata?.migrationName)).toEqual([
      "proxmox_hosts_disk_capacity",
      "managed_venice_wallets",
      "managed_venice_token_quotes",
    ]);
    for (const call of calls) {
      expect(call.severity).toBe("fatal");
      expect(call.title).toBe(
        `Supabase migration missing from the configured database ledger: ${call.metadata.migrationName}`
      );
      expect(call.message).toContain("Verify the target and actual schema");
      expect(call.metadata.failureType).toBe(
        "supabase_migration_missing_from_ledger"
      );
      expect(call.metadata.recoveryAction).toBe("verify_schema_and_ledger");
    }
    expect(log.error).toHaveBeenCalledWith(
      "migration drift detected — missing migrations in the configured database ledger",
      expect.any(Error),
      expect.objectContaining({ missingCount: 3 })
    );
    expect(log.warn).toHaveBeenCalledWith(
      "migration drift detected — unexpected migrations in the configured database ledger",
      expect.objectContaining({ unexpectedCount: 1 })
    );
  });

  it("does not derail when ops-event emission throws", async () => {
    (runMigrationDriftCheck as jest.Mock).mockResolvedValue({
      totalLocal: 1,
      totalApplied: 0,
      missing: [{ version: "20260101000000", name: "alpha" }],
      unexpected: [],
      versionMismatched: [],
    });
    (reportOpsEvent as jest.Mock).mockRejectedValueOnce(new Error("ops down"));

    const res = await GET(buildReq({ authorization: "Bearer cron-secret" }));

    expect(res.status).toBe(200);
  });

  it("still alerts on stale crons when the migration ledger RPC fails", async () => {
    const now = Date.now();
    const staleLastSuccessAt = new Date(now - 31 * 60000).toISOString();
    const memory = createManagedVeniceMemoryDb({
      ops_cron_heartbeats: [
        {
          cron_name: "probe-instance-health",
          last_success_at: staleLastSuccessAt,
          last_run_at: staleLastSuccessAt,
          ok_count: 10,
          run_count: 10,
          created_at: new Date(now - 60 * 60000).toISOString(),
        },
      ],
    });
    const ledgerRpc = jest.fn(async (name: string) => {
      if (name !== "list_applied_supabase_migrations") {
        throw new Error(`Unexpected migration ledger RPC: ${name}`);
      }
      return {
        data: null,
        error: { message: "migration ledger RPC failed" },
      };
    });
    Object.defineProperty(memory.db, "rpc", {
      configurable: true,
      value: ledgerRpc,
    });
    mockSupabaseAdmin.value = memory.db;
    const { runMigrationDriftCheck: realRunMigrationDriftCheck } =
      jest.requireActual<typeof import("@/lib/migration-drift")>(
        "@/lib/migration-drift"
      );
    const { runCronHeartbeatWatchdog: realRunCronHeartbeatWatchdog } =
      jest.requireActual<typeof import("@/lib/cron-heartbeat")>(
        "@/lib/cron-heartbeat"
      );
    jest
      .mocked(runMigrationDriftCheck)
      .mockImplementationOnce(realRunMigrationDriftCheck);
    jest
      .mocked(runCronHeartbeatWatchdog)
      .mockImplementationOnce(realRunCronHeartbeatWatchdog);

    const res = await GET(buildReq({ authorization: "Bearer cron-secret" }));

    expect(res.status).toBe(500);
    expect(runMigrationDriftCheck).toHaveBeenCalledTimes(1);
    expect(ledgerRpc).toHaveBeenCalledTimes(1);
    expect(ledgerRpc).toHaveBeenCalledWith(
      "list_applied_supabase_migrations"
    );
    expect(runCronHeartbeatWatchdog).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      "cron dead-man watchdog detected stalled crons",
      expect.any(Error),
      expect.objectContaining({
        failureType: "cron_heartbeat_stale",
        staleCrons: ["probe-instance-health"],
      })
    );
    expect(recordCronHeartbeat).not.toHaveBeenCalled();
    expect(reportOpsEvent).toHaveBeenCalledTimes(1);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "synthetic.cron-dead-man",
        severity: "fatal",
        title: "Cron stalled: probe-instance-health",
        route: "/api/cron/probe-instance-health",
        metadata: expect.objectContaining({
          failureType: "cron_heartbeat_stale",
          cronName: "probe-instance-health",
          neverReported: false,
          neverSucceeded: false,
          lastSuccessAt: staleLastSuccessAt,
        }),
      })
    );
    expect(await res.json()).toEqual({
      success: false,
      error:
        "Failed to read supabase_migrations.schema_migrations: migration ledger RPC failed",
    });
  });

  it("preserves the ledger failure when the watchdog also fails", async () => {
    jest.mocked(runMigrationDriftCheck).mockRejectedValueOnce(new Error("ledger unavailable"));
    jest.mocked(runCronHeartbeatWatchdog).mockRejectedValueOnce(new Error("watchdog unavailable"));

    const res = await GET(buildReq({ authorization: "Bearer cron-secret" }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: "ledger unavailable" });
    expect(runCronHeartbeatWatchdog).toHaveBeenCalledTimes(1);
    expect(recordCronHeartbeat).not.toHaveBeenCalled();
  });

  it("still reports drift when the watchdog is unavailable", async () => {
    (runMigrationDriftCheck as jest.Mock).mockResolvedValue({
      totalLocal: 1,
      totalApplied: 0,
      missing: [{ version: "20260101000000", name: "alpha" }],
      unexpected: [],
      versionMismatched: [],
    });
    jest.mocked(runCronHeartbeatWatchdog).mockRejectedValueOnce(
      new Error("watchdog down")
    );

    const res = await GET(buildReq({ authorization: "Bearer cron-secret" }));

    expect(res.status).toBe(200);
    expect((await res.json()).data.cronWatchdog).toBeNull();
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "fatal" })
    );
    expect(recordCronHeartbeat).toHaveBeenCalledWith("migration-drift-check");
  });
});
