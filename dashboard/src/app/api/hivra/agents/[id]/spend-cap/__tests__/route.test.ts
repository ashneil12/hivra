const mockAuth = jest.fn();
const tables: Record<string, Array<Record<string, unknown>>> = {};

function from(table: string) {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  let patch: Record<string, unknown> | null = null;
  const rows = () => (tables[table] ?? []).filter(r => filters.every(f => f(r)));
  const chain: Record<string, unknown> = {
    select: () => chain,
    update: (p: Record<string, unknown>) => { patch = p; return chain; },
    eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return chain; },
    gte: (c: string, v: string) => { filters.push(r => String(r[c]) >= v); return chain; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => {
      if (patch) { for (const r of rows()) Object.assign(r, patch); return Promise.resolve({ data: null, error: null }).then(resolve); }
      return Promise.resolve({ data: rows(), error: null }).then(resolve);
    },
  };
  return chain;
}

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (t: string) => from(t) } }));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: () => null,
  RATE_LIMIT_PRESETS: { secretWrite: {} },
}));

import { GET, PUT } from "../route";

const AGENT = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: AGENT }) };

function put(body: unknown) {
  return new Request(`https://hivra.cloud/api/hivra/agents/${AGENT}/spend-cap`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify(body),
  });
}

describe("/api/hivra/agents/[id]/spend-cap", () => {
  const env = process.env.MANAGED_VENICE_AGENT_SPEND_CAPS_ENABLED;
  beforeEach(() => {
    process.env.MANAGED_VENICE_AGENT_SPEND_CAPS_ENABLED = "true";
    mockAuth.mockResolvedValue({ userId: "u1" });
    tables.hivra_agents = [{ id: AGENT, user_id: "u1", status: "running", llm_config: { provider: "venice", mode: "managed", proxyKeyId: "key-1" } }];
    tables.managed_venice_proxy_keys = [{ id: "key-1", user_id: "u1", metadata: { defaultWalletType: "card" } }];
    tables.managed_venice_usage_events = [{ user_id: "u1", proxy_key_id: "key-1", charged_micro_usd: 1_230_000, created_at: new Date().toISOString() }];
  });
  afterAll(() => { process.env.MANAGED_VENICE_AGENT_SPEND_CAPS_ENABLED = env; });

  it("is hidden while the flag is off", async () => {
    process.env.MANAGED_VENICE_AGENT_SPEND_CAPS_ENABLED = "";
    expect((await GET(new Request("https://hivra.cloud/x") as never, ctx)).status).toBe(404);
  });

  it("shows today's spend and no limit", async () => {
    const res = await GET(new Request("https://hivra.cloud/x") as never, ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ dailyLimitUsd: null, effectiveDailyLimitUsd: null, spentTodayUsd: 1.23, reachedToday: false });
    expect(json.data.days).toHaveLength(7);
  });

  it("refuses another owner's agent and non-managed agents", async () => {
    mockAuth.mockResolvedValue({ userId: "u2" });
    expect((await GET(new Request("https://hivra.cloud/x") as never, ctx)).status).toBe(404);
    mockAuth.mockResolvedValue({ userId: "u1" });
    tables.hivra_agents[0].llm_config = { provider: "venice", mode: "byok" };
    expect((await GET(new Request("https://hivra.cloud/x") as never, ctx)).status).toBe(409);
  });

  it("saves a limit", async () => {
    const res = await PUT(put({ dailyLimitUsd: 5 }) as never, ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.dailyLimitUsd).toBe(5);
    expect(tables.managed_venice_proxy_keys[0].metadata).toMatchObject({ defaultWalletType: "card", spendCap: { dailyMicroUsd: 5_000_000 } });
  });

  it("rejects a bad limit", async () => {
    expect((await PUT(put({ dailyLimitUsd: -1 }) as never, ctx)).status).toBe(400);
  });
});
