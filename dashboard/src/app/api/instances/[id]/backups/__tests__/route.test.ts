import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { reportOpsEvent } from "@/lib/ops-events";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxHostEnv: jest.fn(() => ({ host: "fixturenode10" })),
  runProxmoxHostScript: jest.fn(),
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn(),
  sanitizeOpsMetadata: jest.fn(
    (metadata: Record<string, unknown> | undefined) => metadata ?? {}
  ),
}));

type SupabaseQueryMock = {
  select: jest.MockedFunction<() => SupabaseQueryMock>;
  eq: jest.MockedFunction<() => SupabaseQueryMock>;
  is: jest.MockedFunction<() => SupabaseQueryMock>;
  maybeSingle: jest.Mock;
};

const maybeSingle = jest.fn();
const query = {} as SupabaseQueryMock;
query.select = jest.fn(() => query);
query.eq = jest.fn(() => query);
query.is = jest.fn(() => query);
query.maybeSingle = maybeSingle;

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn(() => query),
  },
}));

const INSTANCE_ID = "00000000-0000-4000-8000-000000001032";
// restic short_id (8 hex chars)
const BACKUP_ID = "02e8a4bb";

function ownedInstance() {
  return {
    id: INSTANCE_ID,
    user_id: "user_123",
    proxmox_node: "fixturenode10",
    proxmox_vmid: 1000,
    resource_tier: "command",
    lifecycle_state: "active",
    status: "running",
  };
}

// Mirrors what buildListResticScript emits: {"snapshots":<restic snapshots --json>}.
function snapshotsStdout() {
  return JSON.stringify({
    snapshots: [
      {
        id: "02e8a4bbdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef0",
        short_id: BACKUP_ID,
        time: "2026-06-03T02:28:40Z",
        paths: [
          `/var/lib/hermes-restic-src/${INSTANCE_ID}/webui-state`,
          `/var/lib/hermes-restic-src/${INSTANCE_ID}/webui-workspace`,
        ],
        tags: ["hermes-daily", `instance:${INSTANCE_ID}`],
        hostname: INSTANCE_ID,
      },
    ],
  });
}

describe("/api/instances/[id]/backups", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedRun = runProxmoxHostScript as jest.MockedFunction<typeof runProxmoxHostScript>;
  const mockedReport = reportOpsEvent as jest.MockedFunction<typeof reportOpsEvent>;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.HERMES_RESTIC_MASTER_KEY = "test-master-key";
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("hides unexpected backup lookup errors from the client", async () => {
    mockedAuth.mockRejectedValueOnce(new Error("backups-secret-leak"));

    const response = await GET(
      new NextRequest(`http://localhost/api/instances/${INSTANCE_ID}/backups`, { method: "GET" }),
      { params: Promise.resolve({ id: INSTANCE_ID }) }
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Internal Server Error");
    expect(json.error).not.toContain("backups-secret-leak");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("backups-secret-leak");
  });

  it("lists granular restic restore points for the owned instance", async () => {
    mockedAuth.mockResolvedValueOnce({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    maybeSingle.mockResolvedValueOnce({ data: ownedInstance(), error: null });
    mockedRun.mockResolvedValueOnce({ ok: true, stdout: `noise\n${snapshotsStdout()}\n`, stderr: "" });

    const response = await GET(
      new NextRequest(`http://localhost/api/instances/${INSTANCE_ID}/backups`, { method: "GET" }),
      { params: Promise.resolve({ id: INSTANCE_ID }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.backups).toHaveLength(1);
    expect(json.data.backups[0]).toMatchObject({ id: BACKUP_ID, kind: "granular_data" });
    expect(json.data.retention_days).toBe(7);
    expect(json.data.restore_mode).toBe("granular_request");
    // the listing opens the per-instance restic repo (not the old vzdump manifest path)
    expect(mockedRun.mock.calls[0][0]).toContain(`sftp:cold:restic/${INSTANCE_ID}`);
  });

  it.each(["GET", "POST"])("denies %s backup access to another tenant before opening restic", async method => {
    mockedAuth.mockResolvedValueOnce({ userId: "foreign_user" } as Awaited<ReturnType<typeof auth>>);
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const request = new NextRequest(`http://localhost/api/instances/${INSTANCE_ID}/backups`, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify({ backupId: BACKUP_ID, confirm: "RESTORE" }) : undefined,
    });

    const response = method === "POST"
      ? await POST(request, { params: Promise.resolve({ id: INSTANCE_ID }) })
      : await GET(request, { params: Promise.resolve({ id: INSTANCE_ID }) });

    expect(response.status).toBe(404);
    expect(mockedRun).not.toHaveBeenCalled();
    expect(mockedReport).not.toHaveBeenCalled();
    expect(query.eq).toHaveBeenCalledWith("id", INSTANCE_ID);
    expect(query.eq).toHaveBeenCalledWith("user_id", "foreign_user");
  });

  it("records a restore request only after typed confirmation and existing backup proof", async () => {
    mockedAuth.mockResolvedValueOnce({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    maybeSingle.mockResolvedValueOnce({ data: ownedInstance(), error: null });
    mockedRun.mockResolvedValueOnce({ ok: true, stdout: snapshotsStdout(), stderr: "" });

    const response = await POST(
      new NextRequest(`http://localhost/api/instances/${INSTANCE_ID}/backups`, {
        method: "POST",
        body: JSON.stringify({ backupId: BACKUP_ID, confirm: "RESTORE" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: INSTANCE_ID }) }
    );
    const json = await response.json();

    // Honest contract: the request is ACCEPTED (202) but a manual restore is
    // required — we do not falsely promise an automated restore (HTTP 200).
    expect(response.status).toBe(202);
    expect(json.data.accepted).toBe(true);
    expect(json.data.restore_request_id).toContain(`${INSTANCE_ID}:${BACKUP_ID}:`);
    // restore is non-destructive: the live agent is never overwritten in place
    expect(json.data.message).toContain("your live agent is not modified");

    // A human MUST be durably notified — the restore is not automated, so the
    // ops-event is the only guarantee anyone acts on the request.
    expect(mockedReport).toHaveBeenCalledTimes(1);
    expect(mockedReport).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "instance-granular-backups",
        route: "/api/instances/[id]/backups",
        instanceId: INSTANCE_ID,
        userId: "user_123",
        metadata: expect.objectContaining({
          failureType: "granular_backup_restore_requested",
          backupId: BACKUP_ID,
        }),
      })
    );
  });

  it("rejects a restore for a snapshot that does not exist", async () => {
    mockedAuth.mockResolvedValueOnce({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    maybeSingle.mockResolvedValueOnce({ data: ownedInstance(), error: null });
    mockedRun.mockResolvedValueOnce({ ok: true, stdout: snapshotsStdout(), stderr: "" });

    const response = await POST(
      new NextRequest(`http://localhost/api/instances/${INSTANCE_ID}/backups`, {
        method: "POST",
        body: JSON.stringify({ backupId: "deadbeef", confirm: "RESTORE" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ id: INSTANCE_ID }) }
    );
    expect(response.status).toBe(404);
  });
});
