/**
 * The cold-storage box address is deployment configuration. The route writes the
 * `cold` ssh alias on each Proxmox host from HERMES_COLD_STORAGE_HOST and
 * HERMES_COLD_STORAGE_USER, and has no address of its own: a public source tree
 * must not name the box that holds the VM backups.
 */
import { NextRequest } from "next/server";

import { GET } from "../route";
import { resolveProxmoxHostEnv, runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => {
  const { createSupabaseMock } = jest.requireActual("@/test-utils/supabase");
  return { supabaseAdmin: createSupabaseMock().admin };
});
jest.mock("@/lib/cron-heartbeat", () => ({ recordCronHeartbeat: jest.fn() }));
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(),
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxHostEnv: jest.fn(),
  runProxmoxHostScript: jest.fn(),
}));

const INSTANCE_ID = "11111111-1111-1111-1111-111111111111";
const TEST_HOST = "box.cold-storage.example.test";
const TEST_USER = "u000000";

function makeSupabaseMock() {
  function chain() {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "not", "in", "or", "order"]) {
      builder[m] = jest.fn(() => builder);
    }
    builder.limit = jest.fn(() =>
      Promise.resolve({
        data: [
          {
            id: INSTANCE_ID,
            proxmox_node: "fixturenode1",
            proxmox_vmid: 9001,
            resource_tier: "operator",
            lifecycle_state: "active",
            status: "running",
            ipv4_address: "10.240.0.1",
          },
        ],
        error: null,
      })
    );
    builder.update = jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ error: null })) }));
    return builder;
  }
  return jest.fn(() => chain());
}

function request() {
  return new NextRequest("http://localhost/api/cron/daily-vm-backups", {
    method: "GET",
    headers: { authorization: "Bearer expected-secret" },
  });
}

describe("GET /api/cron/daily-vm-backups: cold-storage address comes from env", () => {
  const originalEnv = { ...process.env };
  const mockedFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;
  const mockedRun = runProxmoxHostScript as jest.Mock;
  const spies: jest.SpyInstance[] = [];

  const scripts = () => mockedRun.mock.calls.map((call) => String(call[0])).join("\n----\n");

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "expected-secret";
    process.env.DAILY_VM_BACKUPS_ENABLED = "true";
    process.env.HETZNER_SSH_PRIVATE_KEY_B64 = Buffer.from("synthetic-test-key").toString("base64");
    process.env.HERMES_COLD_STORAGE_HOST = TEST_HOST;
    process.env.HERMES_COLD_STORAGE_USER = TEST_USER;
    for (const m of ["error", "warn", "log"] as const) {
      spies.push(jest.spyOn(console, m).mockImplementation(() => {}));
    }
    mockedRun.mockResolvedValue({ ok: true, stdout: "BACKUP_OK", stderr: "" });
    (resolveProxmoxHostEnv as jest.Mock).mockReturnValue({ PROXMOX_EXEC_MODE: "ssh" });
    mockedFrom.mockImplementation(makeSupabaseMock());
  });

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    process.env = { ...originalEnv };
  });

  it("writes the ssh alias from the configured host and user", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);

    const sent = scripts();
    expect(sent).toContain("# BEGIN HERMES COLD STORAGE");
    expect(sent).toContain(`  HostName ${TEST_HOST}`);
    expect(sent).toContain(`  User ${TEST_USER}`);
    expect(sent).toContain("  Port 23");
  });

  it("never sends a storage box address of its own", async () => {
    await GET(request());
    expect(scripts()).not.toMatch(/your-storagebox\.de/i);
  });

  it.each([
    ["HERMES_COLD_STORAGE_HOST", "HERMES_COLD_STORAGE_HOST missing"],
    ["HERMES_COLD_STORAGE_USER", "HERMES_COLD_STORAGE_USER missing"],
  ])("skips the alias with a warning when %s is not set", async (name, reason) => {
    delete process.env[name];

    const response = await GET(request());
    expect(response.status).toBe(200);

    const sent = scripts();
    expect(sent).toContain(`WARNING: ${reason}; cold Storage Box SSH alias not installed`);
    expect(sent).not.toContain("# BEGIN HERMES COLD STORAGE");
    expect(sent).not.toContain("HostName");
  });

  it("refuses a host value that could add ssh config directives", async () => {
    process.env.HERMES_COLD_STORAGE_HOST = `${TEST_HOST}\n  ProxyCommand touch /tmp/owned`;

    await GET(request());

    const sent = scripts();
    expect(sent).toContain("WARNING: HERMES_COLD_STORAGE_HOST invalid; cold Storage Box SSH alias not installed");
    expect(sent).not.toContain("ProxyCommand");
    expect(sent).not.toContain("# BEGIN HERMES COLD STORAGE");
  });
});
