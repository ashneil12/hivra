const mockAuth = jest.fn();
const mockResolve = jest.fn();
const mockRun = jest.fn();
const tables: Record<string, Array<Record<string, unknown>>> = {};

function from(table: string) {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  let patch: Record<string, unknown> | null = null;
  const rows = () => (tables[table] ?? []).filter(r => filters.every(f => f(r)));
  const chain: Record<string, unknown> = {
    select: () => chain,
    update: (p: Record<string, unknown>) => { patch = p; return chain; },
    upsert: async (row: Record<string, unknown>) => {
      const list = (tables[table] ??= []);
      const existing = list.find(r => r.agent_id === row.agent_id);
      if (existing) Object.assign(existing, row); else list.push({ ...row });
      return { error: null };
    },
    eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return chain; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => {
      if (patch) for (const r of rows()) Object.assign(r, patch);
      return Promise.resolve({ data: rows(), error: null }).then(resolve);
    },
  };
  return chain;
}

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (t: string) => from(t) } }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: () => null,
  RATE_LIMIT_PRESETS: { secretWrite: {} },
}));
jest.mock("@/lib/hivra/agent-wake", () => ({ resolveSleepTarget: (...a: unknown[]) => mockResolve(...a) }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScriptWithStdin: (...a: unknown[]) => mockRun(...a) }));

import { GET, PUT } from "../route";

const AGENT = "11111111-1111-4111-8111-111111111111";
const TAG = `hivra-bind-${"a".repeat(32)}`;
const ctx = { params: Promise.resolve({ id: AGENT }) };

function put(body: unknown) {
  return new Request(`https://hivra.cloud/api/hivra/agents/${AGENT}/allowed-sites`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify(body),
  });
}

describe("/api/hivra/agents/[id]/allowed-sites", () => {
  const env = process.env.NEXT_PUBLIC_HIVRA_ALLOWED_SITES;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_HIVRA_ALLOWED_SITES = "true";
    mockAuth.mockResolvedValue({ userId: "u1" });
    tables.hivra_agents = [{ id: AGENT, user_id: "u1", status: "running", vmid: 2104, computer_substrate: "proxmox-kvm" }];
    tables.hivra_agent_allowed_sites = [];
    mockResolve.mockReset().mockResolvedValue({ ok: true, target: { vmid: 2104, bindingTag: TAG, env: { HOST: "host-a" } } });
    mockRun.mockReset().mockResolvedValue({ ok: true, stdout: 'HIVRA_EGRESS_RESULT {"ok":true,"vmid":2104,"reason":"applied"}\n', stderr: "" });
  });
  afterAll(() => { process.env.NEXT_PUBLIC_HIVRA_ALLOWED_SITES = env; });

  it("is hidden while the switch is off", async () => {
    process.env.NEXT_PUBLIC_HIVRA_ALLOWED_SITES = "";
    expect((await GET(new Request("https://hivra.cloud/x") as never, ctx)).status).toBe(404);
    expect((await PUT(put({ enabled: true, sites: [] }) as never, ctx)).status).toBe(404);
  });

  it("is a 404 for another owner's agent", async () => {
    mockAuth.mockResolvedValue({ userId: "u2" });
    expect((await GET(new Request("https://hivra.cloud/x") as never, ctx)).status).toBe(404);
  });

  it("starts unlimited", async () => {
    const json = await (await GET(new Request("https://hivra.cloud/x") as never, ctx)).json();
    expect(json.data).toMatchObject({ enabled: false, sites: [], applyState: null });
  });

  it("saves the list and writes it to the computer's host", async () => {
    const res = await PUT(put({ enabled: true, sites: ["GitHub.com", "https://pypi.org/simple"] }) as never, ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ enabled: true, sites: ["github.com", "pypi.org"], applyState: "applied" });
    const [script, stdin] = mockRun.mock.calls[0];
    expect(script).toContain("MODE=set");
    expect(JSON.parse(stdin)).toMatchObject({ version: 1, vmid: 2104, binding_tag: TAG, sites: ["github.com", "pypi.org"] });
  });

  it("refuses entries it can't enforce, and saves nothing", async () => {
    const res = await PUT(put({ enabled: true, sites: ["*.example.com", "10.250.0.1"] }) as never, ctx);
    expect(res.status).toBe(400);
    expect(tables.hivra_agent_allowed_sites).toEqual([]);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("keeps the list when the host can't be reached, and says so", async () => {
    mockResolve.mockResolvedValue({ ok: false, code: "infrastructure_unavailable", status: 503, message: "x" });
    const json = await (await PUT(put({ enabled: true, sites: ["github.com"] }) as never, ctx)).json();
    expect(json.data).toMatchObject({ enabled: true, sites: ["github.com"], applyState: "failed" });
    expect(json.data.applyError).toContain("saved");
  });

  it("removes the host policy when turned off", async () => {
    await PUT(put({ enabled: false, sites: ["github.com"] }) as never, ctx);
    expect(mockRun.mock.calls[0][0]).toContain("MODE=remove");
  });

  it("refuses a change that doesn't come from the dashboard", async () => {
    const req = new Request(`https://hivra.cloud/api/hivra/agents/${AGENT}/allowed-sites`, {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}",
    });
    expect((await PUT(req as never, ctx)).status).toBe(403);
  });
});
