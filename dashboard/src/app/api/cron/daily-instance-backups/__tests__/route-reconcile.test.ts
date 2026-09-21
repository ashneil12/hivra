/**
 * The daily backup run reclaims orphan restic mirrors on each host before backing
 * up, so deleted/migrated instances stop accumulating on the ~80G host root (the
 * fixturenodea host_script_failed incident, 2026-07-17). It must be best-effort: a
 * reconcile failure can never block or fail the actual backups.
 */
import { NextRequest } from "next/server";

import { GET } from "../route";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { resolveProxmoxHostEnv, runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/cron-heartbeat", () => ({ recordCronHeartbeat: jest.fn() }));
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(),
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxHostEnv: jest.fn(),
  runProxmoxHostScript: jest.fn(),
}));

const HOST = "fixturenode7";
const CAND_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_LIVE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function candidate() {
  return {
    id: CAND_ID,
    proxmox_node: HOST,
    proxmox_vmid: 9001,
    resource_tier: "operator",
    lifecycle_state: "active",
    status: "running",
    ipv4_address: "10.240.0.1",
    last_instance_backup_at: null,
  };
}

// A supabase query builder that is BOTH chainable and thenable: the candidate
// query terminates on .limit() (resolves candidates); the reconcile keep-set
// query is awaited directly (resolves the keep rows via .then).
function makeMock(candidates: unknown[], keepIds: string[]) {
  return jest.fn(() => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "not", "in", "or", "order"]) {
      builder[m] = jest.fn(() => builder);
    }
    builder.limit = jest.fn(() => Promise.resolve({ data: candidates, error: null }));
    builder.update = jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ error: null })) }));
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: keepIds.map((id) => ({ id })), error: null });
    return builder;
  });
}

function request() {
  return new NextRequest("http://localhost/api/cron/daily-instance-backups", {
    method: "GET",
    headers: { authorization: "Bearer expected-secret" },
  });
}

describe("GET /api/cron/daily-instance-backups — mirror reconcile", () => {
  const originalEnv = { ...process.env };
  const mockedFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;
  const mockedResolve = resolveProxmoxHostEnv as jest.Mock;
  const mockedRun = runProxmoxHostScript as jest.Mock;
  const spies: jest.SpyInstance[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "expected-secret";
    process.env.HERMES_RESTIC_MASTER_KEY = "test-master-key";
    process.env.DAILY_INSTANCE_BACKUPS_ENABLED = "true";
    for (const m of ["error", "warn", "log"] as const) {
      spies.push(jest.spyOn(console, m).mockImplementation(() => {}));
    }
    mockedResolve.mockReturnValue({ PROXMOX_EXEC_MODE: "ssh" });
    // Distinguish the two script kinds the route sends to a host.
    mockedRun.mockImplementation((script: string) => {
      if (typeof script === "string" && script.includes("backup-vm-restic.sh")) {
        return Promise.resolve({ ok: true, stdout: "RESTIC_BACKUP_OK", stderr: "" });
      }
      return Promise.resolve({
        ok: true,
        stdout: `RECONCILE_DONE host=${HOST} removed=2 freed_mb=5 mirror_root=/var/lib/hermes-restic-src`,
        stderr: "",
      });
    });
    mockedFrom.mockImplementation(makeMock([candidate()], [CAND_ID, OTHER_LIVE_ID]));
  });

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    process.env = { ...originalEnv };
  });

  it("reconciles each host and reports reclaimed mirrors in the response", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();

    // The backup still ran and succeeded.
    expect(body.data.backedUp).toBe(1);
    expect(body.data.failed).toBe(0);

    // Reconcile ran and its reclaim is surfaced.
    expect(body.data.reconciledMirrors).toBe(2);
    expect(body.data.reconciledFreedMb).toBe(5);

    // One reconcile call + one backup call to the host.
    const scripts = mockedRun.mock.calls.map((c) => c[0] as string);
    const reconcileScript = scripts.find((s) => s.includes("HERMES_RESTIC_KEEP_SET"));
    expect(reconcileScript).toBeDefined();
    // The keep-set carried both live ids.
    expect(reconcileScript).toContain(CAND_ID);
    expect(reconcileScript).toContain(OTHER_LIVE_ID);
    expect(scripts.some((s) => s.includes("backup-vm-restic.sh"))).toBe(true);
  });

  it("still backs up when the reconcile step fails (best-effort)", async () => {
    mockedRun.mockImplementation((script: string) => {
      if (typeof script === "string" && script.includes("backup-vm-restic.sh")) {
        return Promise.resolve({ ok: true, stdout: "RESTIC_BACKUP_OK", stderr: "" });
      }
      // reconcile blows up — must not touch the backup
      return Promise.reject(new Error("ssh blew up during reconcile"));
    });

    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.backedUp).toBe(1);
    expect(body.data.failed).toBe(0);
    expect(body.data.reconciledMirrors).toBe(0);
    expect(recordCronHeartbeat).toHaveBeenCalledWith("daily-instance-backups");
  });

  it("does not run reconcile when the keep-set comes back empty (never wipes all)", async () => {
    mockedFrom.mockImplementation(makeMock([candidate()], [])); // empty keep-set
    await GET(request());
    const scripts = mockedRun.mock.calls.map((c) => c[0] as string);
    // no reconcile script was sent to the host
    expect(scripts.some((s) => s.includes("HERMES_RESTIC_KEEP_SET"))).toBe(false);
    // the backup still ran
    expect(scripts.some((s) => s.includes("backup-vm-restic.sh"))).toBe(true);
  });
});
