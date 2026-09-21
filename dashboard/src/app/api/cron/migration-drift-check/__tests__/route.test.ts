import { NextRequest } from "next/server";

import { GET } from "../route";
import { runMigrationDriftCheck } from "@/lib/migration-drift";
import { reportOpsEvent } from "@/lib/ops-events";

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

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

function buildReq(headers: Record<string, string> = {}) {
  return new NextRequest("https://example/api/cron/migration-drift-check", {
    headers: new Headers(headers),
  });
}

describe("GET /api/cron/migration-drift-check", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rejects missing bearer auth with 401", async () => {
    const res = await GET(buildReq());
    expect(res.status).toBe(401);
    expect(runMigrationDriftCheck).not.toHaveBeenCalled();
  });

  it("rejects when CRON_SECRET is unset with 500", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(buildReq({ authorization: "Bearer anything" }));
    expect(res.status).toBe(500);
    expect(runMigrationDriftCheck).not.toHaveBeenCalled();
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
    expect(reportOpsEvent).not.toHaveBeenCalled();
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
      unexpected: [],
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
      expect(call.metadata.failureType).toBe(
        "supabase_migration_missing_in_prod"
      );
    }
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

  it("returns 500 when the drift check itself throws", async () => {
    (runMigrationDriftCheck as jest.Mock).mockRejectedValue(
      new Error("Database not configured")
    );

    const res = await GET(buildReq({ authorization: "Bearer cron-secret" }));

    expect(res.status).toBe(500);
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });
});
