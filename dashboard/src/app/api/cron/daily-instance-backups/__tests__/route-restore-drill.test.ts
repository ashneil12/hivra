import { NextRequest } from "next/server";

import { GET } from "../route";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxHostEnv: jest.fn().mockReturnValue({ PROXMOX_EXEC_MODE: "ssh" }),
  runProxmoxHostScript: jest.fn(),
}));

const INSTANCE_ID = "11111111-1111-1111-1111-111111111111";

type Target = { id: string; proxmox_node: string | null; proxmox_vmid: number | null } | null;

/** The candidate query resolves on `limit`, the drill lookup on `maybeSingle`. */
function makeSupabaseMock(target: Target) {
  const lookups: Array<{ method: string; args: unknown[] }> = [];
  const from = jest.fn(() => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "not", "in", "or", "order"]) {
      builder[m] = jest.fn((...args: unknown[]) => {
        lookups.push({ method: m, args });
        return builder;
      });
    }
    builder.limit = jest.fn(() => Promise.resolve({ data: [], error: null }));
    builder.maybeSingle = jest.fn(() => Promise.resolve({ data: target, error: null }));
    builder.update = jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ data: null, error: null })) }));
    return builder;
  });
  return { from, lookups };
}

function request(query: string) {
  return new NextRequest(`http://localhost/api/cron/daily-instance-backups?${query}`, {
    method: "GET",
    headers: { authorization: "Bearer expected-secret" },
  });
}

const PASSING_RESULT = {
  pass: true,
  instance: INSTANCE_ID,
  snapshot: "abcd1234",
  snapshot_time: "2026-10-29T04:03:12+01:00",
  files: 42,
  bytes: 1024,
  databases: [{ path: "state.db", ok: true, result: "ok" }],
  compare: { status: "compared", sampled: 3, matched: 3, changed: 0, missing: 0 },
  cleanup: "removed",
};

describe("GET /api/cron/daily-instance-backups?action=restore-drill", () => {
  const originalEnv = { ...process.env };
  const mockedSupabaseAdmin = supabaseAdmin as unknown as { from: jest.Mock };
  const mockedRunHostScript = runProxmoxHostScript as jest.MockedFunction<typeof runProxmoxHostScript>;
  let spies: jest.SpyInstance[];

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "expected-secret";
    process.env.HERMES_RESTIC_MASTER_KEY = "test-master-key";
    spies = (["error", "warn", "log"] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation(() => {})
    );
  });

  afterEach(() => {
    spies.forEach((spy) => spy.mockRestore());
    process.env = { ...originalEnv };
  });

  it("requires a valid instance id", async () => {
    mockedSupabaseAdmin.from.mockImplementation(makeSupabaseMock(null).from);
    const response = await GET(request("action=restore-drill&instanceId=not-an-id"));
    expect(response.status).toBe(400);
    expect(mockedRunHostScript).not.toHaveBeenCalled();
  });

  it("returns 404 for an instance that is missing or not on a host", async () => {
    mockedSupabaseAdmin.from.mockImplementation(
      makeSupabaseMock({ id: INSTANCE_ID, proxmox_node: null, proxmox_vmid: 1300 }).from
    );
    const response = await GET(request(`action=restore-drill&instanceId=${INSTANCE_ID}`));
    expect(response.status).toBe(404);
    expect(mockedRunHostScript).not.toHaveBeenCalled();
  });

  it("runs the drill on the instance's host and returns the result", async () => {
    const mock = makeSupabaseMock({ id: INSTANCE_ID, proxmox_node: "fixturenode1", proxmox_vmid: 1300 });
    mockedSupabaseAdmin.from.mockImplementation(mock.from);
    mockedRunHostScript.mockResolvedValue({
      ok: true,
      stdout: `RESTORE_DRILL_BEGIN\nRESTORE_DRILL_RESULT ${JSON.stringify(PASSING_RESULT)}\nRESTORE_DRILL_OK\n`,
      stderr: "",
    });

    const response = await GET(request(`action=restore-drill&instanceId=${INSTANCE_ID}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain('"snapshot":"abcd1234"');

    expect(mockedRunHostScript).toHaveBeenCalledTimes(1);
    const script = mockedRunHostScript.mock.calls[0][0];
    expect(script).toContain(`INSTANCE_ID='${INSTANCE_ID}'`);
    expect(script).toContain("VMID='1300'");
    expect(script).toContain("export RESTIC_PASSWORD=");
    expect(script).not.toContain("test-master-key");
    // The lookup is by id, not the rotation query, so any placed instance can be drilled.
    expect(mock.lookups).toContainEqual({ method: "eq", args: ["id", INSTANCE_ID] });
    // A drill never moves the backup rotation cursor.
    expect(JSON.stringify(mock.from.mock.results.map((r) => r.value.update.mock.calls))).toBe("[[],[]]");
  });

  it("reports a failed drill as an error with the drill details", async () => {
    mockedSupabaseAdmin.from.mockImplementation(
      makeSupabaseMock({ id: INSTANCE_ID, proxmox_node: "fixturenode1", proxmox_vmid: 1300 }).from
    );
    mockedRunHostScript.mockResolvedValue({
      ok: false,
      error: "Remote bash exited with code 11",
      stdout: `RESTORE_DRILL_RESULT ${JSON.stringify({ ...PASSING_RESULT, pass: false })}\n`,
      stderr: "RESTORE_DRILL_FAILED",
    });
    const response = await GET(request(`action=restore-drill&instanceId=${INSTANCE_ID}`));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).toContain('"pass":false');
  });
});
