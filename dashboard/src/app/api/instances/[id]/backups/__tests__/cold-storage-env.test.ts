/**
 * The cold-storage box address is deployment configuration. The restore-point
 * listing writes the `cold` ssh alias on the Proxmox host from
 * HERMES_COLD_STORAGE_HOST and HERMES_COLD_STORAGE_USER, and has no address of
 * its own: a public source tree must not name the box that holds the backups.
 */
import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { GET } from "../route";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxHostEnv: jest.fn(() => ({ host: "fixturenode10" })),
  runProxmoxHostScript: jest.fn(),
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn(),
  sanitizeOpsMetadata: jest.fn((metadata: Record<string, unknown> | undefined) => metadata ?? {}),
}));

const maybeSingle = jest.fn();
type QueryMock = Record<string, jest.Mock>;
const query: QueryMock = {};
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
const TEST_HOST = "box.cold-storage.example.test";
const TEST_USER = "u000000";

describe("GET /api/instances/[id]/backups: cold-storage address comes from env", () => {
  const originalEnv = { ...process.env };
  const mockedAuth = auth as unknown as jest.Mock;
  const mockedRun = runProxmoxHostScript as jest.Mock;
  let consoleErrorSpy: jest.SpyInstance;

  const list = () =>
    GET(new NextRequest(`http://localhost/api/instances/${INSTANCE_ID}/backups`, { method: "GET" }), {
      params: Promise.resolve({ id: INSTANCE_ID }),
    });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.HERMES_RESTIC_MASTER_KEY = "test-master-key";
    process.env.HETZNER_SSH_PRIVATE_KEY_B64 = Buffer.from("synthetic-test-key").toString("base64");
    process.env.HERMES_COLD_STORAGE_HOST = TEST_HOST;
    process.env.HERMES_COLD_STORAGE_USER = TEST_USER;
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockedAuth.mockResolvedValue({ userId: "user_123" });
    maybeSingle.mockResolvedValue({
      data: {
        id: INSTANCE_ID,
        user_id: "user_123",
        proxmox_node: "fixturenode10",
        proxmox_vmid: 1000,
        resource_tier: "command",
        lifecycle_state: "active",
        status: "running",
      },
      error: null,
    });
    mockedRun.mockResolvedValue({ ok: true, stdout: '{"snapshots":[]}', stderr: "" });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  it("writes the ssh alias from the configured host and user", async () => {
    const response = await list();
    expect(response.status).toBe(200);

    const script = String(mockedRun.mock.calls[0][0]);
    expect(script).toContain("# BEGIN HERMES COLD STORAGE");
    expect(script).toContain(`  HostName ${TEST_HOST}`);
    expect(script).toContain(`  User ${TEST_USER}`);
    expect(script).toContain("  Port 23");
    expect(script).not.toMatch(/your-storagebox\.de/i);
  });

  it.each([
    ["HERMES_COLD_STORAGE_HOST", "HERMES_COLD_STORAGE_HOST missing"],
    ["HERMES_COLD_STORAGE_USER", "HERMES_COLD_STORAGE_USER missing"],
  ])("stops the host script with a clear error when %s is not set", async (name, reason) => {
    delete process.env[name];

    await list();

    const script = String(mockedRun.mock.calls[0][0]);
    expect(script).toContain(`${reason}; cold storage alias unavailable`);
    expect(script).toContain("exit 20");
    expect(script).not.toContain("# BEGIN HERMES COLD STORAGE");
    expect(script).not.toContain("HostName");
  });

  it("refuses a host value that could add ssh config directives", async () => {
    process.env.HERMES_COLD_STORAGE_HOST = `${TEST_HOST} ProxyCommand=touch`;

    await list();

    const script = String(mockedRun.mock.calls[0][0]);
    expect(script).toContain("HERMES_COLD_STORAGE_HOST invalid; cold storage alias unavailable");
    expect(script).not.toContain("ProxyCommand");
  });
});
