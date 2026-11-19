const mockAuth = jest.fn();
const mockPrivacy = jest.fn();
const tables: Record<string, Array<Record<string, unknown>>> = {};

function from(table: string) {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  let patch: Record<string, unknown> | null = null;
  const rows = () => (tables[table] ?? []).filter(r => filters.every(f => f(r)));
  const chain: Record<string, unknown> = {
    select: () => {
      if (!patch) return chain;
      const changed = rows();
      for (const r of changed) Object.assign(r, patch);
      return Promise.resolve({ data: changed.map(r => ({ id: r.id })), error: null });
    },
    update: (p: Record<string, unknown>) => { patch = p; return chain; },
    eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return chain; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
  };
  return chain;
}

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (t: string) => from(t) } }));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: () => null,
  RATE_LIMIT_PRESETS: { secretWrite: {} },
}));
jest.mock("@/lib/venice/model-privacy-live", () => ({
  resolveVeniceModelPrivacy: (...args: unknown[]) => mockPrivacy(...args),
  getVeniceModelPrivacyLookup: async () => () => null,
}));

import { GET, PUT } from "../route";

const AGENT = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: AGENT }) };
const get = () => GET(new Request("https://hivra.cloud/x") as never, ctx);

function put(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://hivra.cloud/api/hivra/agents/${AGENT}/private-models`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Host: "hivra.cloud", Origin: "https://hivra.cloud", "Sec-Fetch-Site": "same-origin", ...headers },
    body: JSON.stringify(body),
  });
}

describe("/api/hivra/agents/[id]/private-models", () => {
  const env = process.env.MANAGED_VENICE_AGENT_PRIVATE_ONLY_ENABLED;
  beforeEach(() => {
    process.env.MANAGED_VENICE_AGENT_PRIVATE_ONLY_ENABLED = "true";
    mockAuth.mockResolvedValue({ userId: "u1" });
    mockPrivacy.mockImplementation(async (id: string) => (id === "claude-opus-4-8" ? "anonymized" : id === "kimi-k2-6" || id === "deepseek-v4-1-flash" ? "private" : null));
    tables.hivra_agents = [{ id: AGENT, user_id: "u1", status: "running", llm_config: { provider: "venice", mode: "managed", proxyKeyId: "key-1", model: "kimi-k2-6" } }];
    tables.managed_venice_proxy_keys = [{ id: "key-1", user_id: "u1", metadata: { defaultWalletType: "card", spendCap: { dailyMicroUsd: 5_000_000 } } }];
  });
  afterAll(() => { process.env.MANAGED_VENICE_AGENT_PRIVATE_ONLY_ENABLED = env; });

  it("is hidden while the flag is off, for reads and writes", async () => {
    process.env.MANAGED_VENICE_AGENT_PRIVATE_ONLY_ENABLED = "";
    const read = await get();
    expect(read.status).toBe(404);
    expect((await read.json()).code).toBe("feature_disabled");
    expect((await PUT(put({ enabled: true }) as never, ctx)).status).toBe(404);
    expect(tables.managed_venice_proxy_keys[0].metadata).toEqual({ defaultWalletType: "card", spendCap: { dailyMicroUsd: 5_000_000 } });
  });

  it("needs a signed-in owner", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    expect((await get()).status).toBe(401);
    expect((await PUT(put({ enabled: true }) as never, ctx)).status).toBe(401);
  });

  it("starts off and reports whether the saved model is private", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store, private");
    expect((await res.json()).data).toEqual({ enabled: false, updatedAt: null, savedModel: "kimi-k2-6", savedModelIsPrivate: true });
  });

  it("flags a saved model that is anonymized or unknown, and falls back to the default model when none is saved", async () => {
    (tables.hivra_agents[0].llm_config as Record<string, unknown>).model = "claude-opus-4-8";
    expect((await (await get()).json()).data).toMatchObject({ savedModel: "claude-opus-4-8", savedModelIsPrivate: false });
    (tables.hivra_agents[0].llm_config as Record<string, unknown>).model = "something-unlisted";
    expect((await (await get()).json()).data).toMatchObject({ savedModelIsPrivate: false });
    delete (tables.hivra_agents[0].llm_config as Record<string, unknown>).model;
    expect((await (await get()).json()).data).toMatchObject({ savedModel: "deepseek-v4-1-flash", savedModelIsPrivate: true });
  });

  it("refuses another owner's agent, a deleted agent, a bad id and non-managed agents", async () => {
    mockAuth.mockResolvedValue({ userId: "u2" });
    expect((await get()).status).toBe(404);
    expect((await PUT(put({ enabled: true }) as never, ctx)).status).toBe(404);
    mockAuth.mockResolvedValue({ userId: "u1" });
    expect((await GET(new Request("https://hivra.cloud/x") as never, { params: Promise.resolve({ id: "not-a-uuid" }) })).status).toBe(404);
    tables.hivra_agents[0].status = "deleted";
    expect((await get()).status).toBe(404);
    tables.hivra_agents[0].status = "running";
    tables.hivra_agents[0].llm_config = { provider: "venice", mode: "byok" };
    const res = await get();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_managed");
    expect(tables.managed_venice_proxy_keys[0].metadata).not.toHaveProperty("privateOnly");
  });

  it("turns the setting on and off and keeps the key's other settings", async () => {
    const on = await PUT(put({ enabled: true }) as never, ctx);
    expect(on.status).toBe(200);
    const onData = (await on.json()).data;
    expect(onData.enabled).toBe(true);
    expect(typeof onData.updatedAt).toBe("string");
    expect(tables.managed_venice_proxy_keys[0].metadata).toMatchObject({
      defaultWalletType: "card", spendCap: { dailyMicroUsd: 5_000_000 }, privateOnly: { enabled: true },
    });
    const off = await PUT(put({ enabled: false }) as never, ctx);
    expect((await off.json()).data.enabled).toBe(false);
    expect(tables.managed_venice_proxy_keys[0].metadata).toMatchObject({ spendCap: { dailyMicroUsd: 5_000_000 }, privateOnly: { enabled: false } });
  });

  it("rejects a malformed request and a request from another site", async () => {
    expect((await PUT(put({ enabled: "yes" }) as never, ctx)).status).toBe(400);
    expect((await PUT(put({ enabled: true, extra: 1 }) as never, ctx)).status).toBe(400);
    expect((await PUT(put({ enabled: true }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }) as never, ctx)).status).toBe(403);
    expect((await PUT(put({ enabled: true }, { "Content-Type": "text/plain" }) as never, ctx)).status).toBe(415);
    expect(tables.managed_venice_proxy_keys[0].metadata).not.toHaveProperty("privateOnly");
  });

  it("answers 409 when the agent's key row is gone", async () => {
    tables.managed_venice_proxy_keys = [];
    expect((await get()).status).toBe(409);
    expect((await PUT(put({ enabled: true }) as never, ctx)).status).toBe(409);
  });
});
