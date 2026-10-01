/**
 * The cold-storage box address is deployment configuration. The route writes the
 * `cold` ssh alias on each Proxmox host from HERMES_COLD_STORAGE_HOST and
 * HERMES_COLD_STORAGE_USER, and has no address of its own: a public source tree
 * must not name the box that holds the restic repositories.
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
            last_instance_backup_at: null,
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
  return new NextRequest("http://localhost/api/cron/daily-instance-backups", {
    method: "GET",
    headers: { authorization: "Bearer expected-secret" },
  });
}

describe("GET /api/cron/daily-instance-backups: cold-storage address comes from env", () => {
  const originalEnv = { ...process.env };
  const mockedFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;
  const mockedRun = runProxmoxHostScript as jest.Mock;
  const spies: jest.SpyInstance[] = [];

  // The per-instance backup run, as distinct from the orphan-mirror reconcile
  // script that shares the same host lane.
  const backupScripts = () =>
    mockedRun.mock.calls.map((call) => String(call[0])).filter((script) => script.includes("backup-vm-restic.sh"));

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "expected-secret";
    process.env.HERMES_RESTIC_MASTER_KEY = "test-master-key";
    process.env.DAILY_INSTANCE_BACKUPS_ENABLED = "true";
    process.env.HETZNER_SSH_PRIVATE_KEY_B64 = Buffer.from("synthetic-test-key").toString("base64");
    process.env.HERMES_COLD_STORAGE_HOST = TEST_HOST;
    process.env.HERMES_COLD_STORAGE_USER = TEST_USER;
    for (const m of ["error", "warn", "log"] as const) {
      spies.push(jest.spyOn(console, m).mockImplementation(() => {}));
    }
    mockedRun.mockResolvedValue({ ok: true, stdout: "RESTIC_BACKUP_OK", stderr: "" });
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

    const scripts = backupScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("# BEGIN HERMES COLD STORAGE");
    expect(scripts[0]).toContain(`  HostName ${TEST_HOST}`);
    expect(scripts[0]).toContain(`  User ${TEST_USER}`);
    expect(scripts[0]).toContain("  Port 23");
    expect(scripts[0]).not.toMatch(/your-storagebox\.de/i);
  });

  it.each([
    ["HERMES_COLD_STORAGE_HOST", "HERMES_COLD_STORAGE_HOST missing"],
    ["HERMES_COLD_STORAGE_USER", "HERMES_COLD_STORAGE_USER missing"],
  ])("stops the host script with a clear error when %s is not set", async (name, reason) => {
    delete process.env[name];

    await GET(request());

    const scripts = backupScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(`${reason}; cold storage alias unavailable`);
    expect(scripts[0]).toContain("exit 20");
    // It checks for an alias installed earlier (so a missing setting cannot stop a set-up host) but never writes one.
    expect(scripts[0]).not.toContain("cat >> /root/.ssh/config");
    expect(scripts[0]).toContain("keeping the cold storage alias already installed on this host");
    expect(scripts[0]).not.toContain("HostName");
  });

  it("refuses a user value that could add ssh config directives", async () => {
    process.env.HERMES_COLD_STORAGE_USER = `${TEST_USER}\n  ProxyCommand touch /tmp/owned`;

    await GET(request());

    const scripts = backupScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("HERMES_COLD_STORAGE_USER invalid; cold storage alias unavailable");
    expect(scripts[0]).not.toContain("ProxyCommand");
  });
});
