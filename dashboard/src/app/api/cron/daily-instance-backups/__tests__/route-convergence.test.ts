import { NextRequest } from "next/server";

import { GET } from "../route";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxHostEnv: jest.fn().mockReturnValue({ PROXMOX_EXEC_MODE: "ssh" }),
  runProxmoxHostScript: jest.fn(),
}));

const VALID_ID_A = "11111111-1111-1111-1111-111111111111";
const VALID_ID_B = "22222222-2222-2222-2222-222222222222";

type Candidate = {
  id: string;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  resource_tier: string | null;
  lifecycle_state: string | null;
  status: string | null;
  ipv4_address?: string | null;
  last_instance_backup_at?: string | null;
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: VALID_ID_A,
    proxmox_node: "fixturenode1",
    proxmox_vmid: 9001,
    resource_tier: "operator",
    lifecycle_state: "active",
    status: "running",
    ipv4_address: "10.240.0.1",
    last_instance_backup_at: null,
    ...overrides,
  };
}

/**
 * Chainable supabase mock. The SELECT chain records every builder call (so we
 * can assert the cursor ordering + due filter) and resolves to `selectData`.
 * The UPDATE chain (`.update().eq()`) resolves successfully and is captured in
 * `updateCalls` so we can assert the success-path cursor stamp.
 */
function makeSupabaseMock(selectData: Candidate[]) {
  const selectCalls: Array<{ method: string; args: unknown[] }> = [];
  const updateCalls: Array<{ payload: unknown; eqArgs: unknown[] }> = [];

  function selectChain() {
    const builder: Record<string, unknown> = {};
    const passthrough = (method: string) =>
      jest.fn((...args: unknown[]) => {
        selectCalls.push({ method, args });
        return builder;
      });
    for (const m of ["select", "eq", "is", "not", "in", "or", "order"]) {
      builder[m] = passthrough(m);
    }
    // `limit` terminates the SELECT chain and resolves the query.
    builder.limit = jest.fn((...args: unknown[]) => {
      selectCalls.push({ method: "limit", args });
      return Promise.resolve({ data: selectData, error: null });
    });
    return builder;
  }

  function updateChain() {
    const eq = jest.fn((...eqArgs: unknown[]) => {
      updateCalls[updateCalls.length - 1].eqArgs = eqArgs;
      return Promise.resolve({ data: null, error: null });
    });
    const update = jest.fn((payload: unknown) => {
      updateCalls.push({ payload, eqArgs: [] });
      return { eq };
    });
    return { update };
  }

  const from = jest.fn(() => ({
    ...selectChain(),
    ...updateChain(),
  }));

  return { from, selectCalls, updateCalls };
}

function request(authorization = "Bearer expected-secret") {
  return new NextRequest("http://localhost/api/cron/daily-instance-backups", {
    method: "GET",
    headers: { authorization },
  });
}

describe("GET /api/cron/daily-instance-backups — rotation cursor convergence", () => {
  const originalEnv = { ...process.env };
  const mockedSupabaseAdmin = supabaseAdmin as unknown as { from: jest.Mock };
  const mockedRunHostScript = runProxmoxHostScript as jest.MockedFunction<typeof runProxmoxHostScript>;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "expected-secret";
    process.env.HERMES_RESTIC_MASTER_KEY = "test-master-key";
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    mockedRunHostScript.mockResolvedValue({ ok: true, stdout: "RESTIC_BACKUP_OK", stderr: "" });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  it("orders candidates by the rotation cursor ascending NULLS FIRST + breaks ties by id", async () => {
    const mock = makeSupabaseMock([candidate()]);
    mockedSupabaseAdmin.from.mockImplementation(mock.from);

    const response = await GET(request());
    expect(response.status).toBe(200);

    const orderCalls = mock.selectCalls.filter((c) => c.method === "order");
    expect(orderCalls[0].args[0]).toBe("last_instance_backup_at");
    expect(orderCalls[0].args[1]).toEqual({ ascending: true, nullsFirst: true });
    // deterministic tiebreak so partial batches don't reshuffle between runs.
    expect(orderCalls[1].args[0]).toBe("id");
    expect(orderCalls[1].args[1]).toEqual({ ascending: true });
    // the legacy created_at ordering must be gone.
    expect(orderCalls.some((c) => c.args[0] === "created_at")).toBe(false);
  });

  it("filters to rows that are due (cursor NULL or older than the cutoff)", async () => {
    const mock = makeSupabaseMock([candidate()]);
    mockedSupabaseAdmin.from.mockImplementation(mock.from);

    await GET(request());

    const orCalls = mock.selectCalls.filter((c) => c.method === "or");
    expect(orCalls).toHaveLength(1);
    const filter = orCalls[0].args[0] as string;
    expect(filter).toContain("last_instance_backup_at.is.null");
    expect(filter).toMatch(/last_instance_backup_at\.lt\.\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps the existing tier/lifecycle/status/soft-delete filters", async () => {
    const mock = makeSupabaseMock([candidate()]);
    mockedSupabaseAdmin.from.mockImplementation(mock.from);

    await GET(request());

    const eqCalls = mock.selectCalls.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["lifecycle_state", "active"] },
        { method: "eq", args: ["status", "running"] },
      ])
    );
    const isCalls = mock.selectCalls.filter((c) => c.method === "is");
    expect(isCalls).toEqual(expect.arrayContaining([{ method: "is", args: ["deleted_at", null] }]));
    const inCalls = mock.selectCalls.filter((c) => c.method === "in");
    expect(inCalls[0].args[0]).toBe("resource_tier");
  });

  it("stamps last_instance_backup_at on each successfully-backed-up row when enabled", async () => {
    process.env.DAILY_INSTANCE_BACKUPS_ENABLED = "true";
    const mock = makeSupabaseMock([
      candidate({ id: VALID_ID_A }),
      candidate({ id: VALID_ID_B, proxmox_node: "fixturenode2", proxmox_vmid: 9002 }),
    ]);
    mockedSupabaseAdmin.from.mockImplementation(mock.from);

    const response = await GET(request());
    const body = (await response.json()).data;

    expect(response.status).toBe(200);
    expect(body.mode).toBe("applied");
    expect(body.backedUp).toBe(2);

    // one UPDATE per successful row, each stamping the cursor + scoped by id.
    expect(mock.updateCalls).toHaveLength(2);
    for (const call of mock.updateCalls) {
      expect(call.payload).toHaveProperty("last_instance_backup_at");
      expect(typeof (call.payload as { last_instance_backup_at: unknown }).last_instance_backup_at).toBe("string");
      expect(call.eqArgs[0]).toBe("id");
    }
    const stampedIds = mock.updateCalls.map((c) => c.eqArgs[1]);
    expect(stampedIds).toEqual(expect.arrayContaining([VALID_ID_A, VALID_ID_B]));
  });

  it("advances the rotation cursor even for a FAILED backup (anti-starvation)", async () => {
    // Anti-starvation fix (F229): a perpetually-slow/failing instance used to
    // never advance its cursor, so it stayed NULLS-FIRST/oldest and was
    // re-picked first EVERY run — permanently starving the rest of the fleet.
    // The cursor now advances on every processed row (success OR failure) so a
    // stuck row rotates to the back; the honest failure is still reported via
    // body.failed (and an ops-event), not by withholding the cursor stamp.
    process.env.DAILY_INSTANCE_BACKUPS_ENABLED = "true";
    mockedRunHostScript.mockResolvedValue({ ok: false, stdout: "", stderr: "boom", error: "boom" });
    const mock = makeSupabaseMock([candidate()]);
    mockedSupabaseAdmin.from.mockImplementation(mock.from);

    const response = await GET(request());
    const body = (await response.json()).data;

    // The run is still honestly reported as failed — the cursor stamp is for
    // rotation/convergence, not a success signal.
    expect(body.failed).toBe(1);
    expect(body.backedUp).toBe(0);
    // Cursor IS advanced so the failing row rotates to the back of the queue.
    expect(mock.updateCalls).toHaveLength(1);
    expect(mock.updateCalls[0].payload).toHaveProperty("last_instance_backup_at");
    expect(mock.updateCalls[0].eqArgs[0]).toBe("id");
  });

  it("does not run or stamp anything when disabled (dry run is the default)", async () => {
    delete process.env.DAILY_INSTANCE_BACKUPS_ENABLED;
    const mock = makeSupabaseMock([candidate()]);
    mockedSupabaseAdmin.from.mockImplementation(mock.from);

    const response = await GET(request());
    const body = (await response.json()).data;

    expect(body.mode).toBe("dry_run");
    expect(mockedRunHostScript).not.toHaveBeenCalled();
    expect(mock.updateCalls).toHaveLength(0);
  });
});
