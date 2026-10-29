/**
 * Host command output that goes into a response body is redacted by the shared
 * command-output redactor, so a bare provider key, bot token or AWS key that a
 * backup script echoes is masked the same way on every sink. This route used to
 * carry its own PEM-only copy, which let all three through (F066).
 */
import { NextRequest } from "next/server";

import { GET } from "../route";
import { runProxmoxHostScript, resolveProxmoxHostEnv } from "@/lib/services/proxmox-instance-service";
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

// Built from parts so the fixture never sits in source as one literal token.
const ANTHROPIC_KEY = ["sk", "ant", "api03", "Q".repeat(40)].join("-");
const TELEGRAM_TOKEN = `123456789:${"A".repeat(35)}`;
const AWS_KEY = `AKIA${"ABCDEFGH23456789"}`;
const LEAKED = [ANTHROPIC_KEY, TELEGRAM_TOKEN, AWS_KEY];

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

function request(action: string) {
  return new NextRequest(`http://localhost/api/cron/daily-instance-backups?action=${action}`, {
    method: "GET",
    headers: { authorization: "Bearer expected-secret" },
  });
}

describe("GET /api/cron/daily-instance-backups: host output is redacted with the shared redactor", () => {
  const originalEnv = { ...process.env };
  const mockedFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;
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
    (resolveProxmoxHostEnv as jest.Mock).mockReturnValue({ PROXMOX_EXEC_MODE: "ssh" });
    mockedFrom.mockImplementation(makeSupabaseMock());
  });

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    process.env = { ...originalEnv };
  });

  it("masks bare tokens echoed on stdout in a successful run-one response", async () => {
    mockedRun.mockResolvedValue({
      ok: true,
      stdout: `backup env ${LEAKED.join(" ")} done`,
      stderr: "",
    });

    const response = await GET(request("run-one"));
    const body = await response.text();

    expect(response.status).toBe(200);
    for (const secret of LEAKED) expect(body).not.toContain(secret);
    expect(body).toContain("[REDACTED]");
  });

  it("masks bare tokens in stderr and in the error message of a failed run-one", async () => {
    mockedRun.mockResolvedValue({
      ok: false,
      stdout: `stdout ${ANTHROPIC_KEY}`,
      stderr: `stderr ${TELEGRAM_TOKEN} ${AWS_KEY}`,
    });

    const response = await GET(request("run-one"));
    const body = await response.text();

    expect(response.status).toBe(500);
    for (const secret of LEAKED) expect(body).not.toContain(secret);
  });
});
