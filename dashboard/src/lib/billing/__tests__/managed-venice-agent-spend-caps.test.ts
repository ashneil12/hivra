import {
  ManagedVeniceAgentSpendCapError,
  assertManagedVeniceAgentWithinSpendCap,
  dayStartIso,
  managedVeniceSpendCapMessage,
  readAgentSpendCap,
  resolveManagedVeniceAgentSpendCapConfig,
  setManagedVeniceAgentDailySpendCap,
} from "@/lib/billing/managed-venice-agent-spend-caps";
import { ManagedVeniceSpendCapError } from "@/lib/billing/managed-venice-spend-caps";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

type Row = Record<string, unknown>;

// A tiny in-memory stand-in for the supabase query builder: eq/gte filters,
// maybeSingle, and update().eq() writes.
function fakeDb(tables: Record<string, Row[]>) {
  const updates: Array<{ table: string; patch: Row }> = [];
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const rows = () => (tables[table] ?? []).filter(r => filters.every(f => f(r)));
    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (p: Row) => { patch = p; return chain; },
      eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return chain; },
      gte: (c: string, v: string) => { filters.push(r => String(r[c]) >= v); return chain; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        if (patch) {
          for (const r of rows()) Object.assign(r, patch);
          updates.push({ table, patch });
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
      },
    };
    return chain;
  }
  return { from, updates };
}

const ON = { MANAGED_VENICE_AGENT_SPEND_CAPS_ENABLED: "true" };
const NOW = new Date("2026-11-12T15:00:00.000Z");
const KEY = "key-1";

function world(opts: { capMicroUsd?: number; spentToday?: number; spentYesterday?: number; otherKeyToday?: number } = {}) {
  const key: Row = { id: KEY, user_id: "u1", metadata: { defaultWalletType: "card", ...(opts.capMicroUsd ? { spendCap: { dailyMicroUsd: opts.capMicroUsd } } : {}) } };
  return fakeDb({
    managed_venice_proxy_keys: [key],
    managed_venice_usage_events: [
      { user_id: "u1", proxy_key_id: KEY, charged_micro_usd: opts.spentToday ?? 0, created_at: "2026-11-12T09:00:00.000Z" },
      { user_id: "u1", proxy_key_id: KEY, charged_micro_usd: opts.spentYesterday ?? 0, created_at: "2026-11-11T23:59:00.000Z" },
      { user_id: "u1", proxy_key_id: "key-2", charged_micro_usd: opts.otherKeyToday ?? 0, created_at: "2026-11-12T10:00:00.000Z" },
    ],
  });
}

describe("config", () => {
  it("is off with no default unless set", () => {
    expect(resolveManagedVeniceAgentSpendCapConfig({})).toEqual({ enabled: false, defaultDailyMicroUsd: null });
    expect(resolveManagedVeniceAgentSpendCapConfig({ ...ON, MANAGED_VENICE_AGENT_DAILY_SPEND_CAP_USD: "2.5" }))
      .toEqual({ enabled: true, defaultDailyMicroUsd: 2_500_000 });
  });
  it("reads a key's own limit defensively", () => {
    expect(readAgentSpendCap({ spendCap: { dailyMicroUsd: 5_000_000 } }).dailyMicroUsd).toBe(5_000_000);
    expect(readAgentSpendCap({ spendCap: { dailyMicroUsd: -1 } }).dailyMicroUsd).toBeNull();
    expect(readAgentSpendCap(null)).toEqual({ dailyMicroUsd: null, lastReachedAt: null });
  });
  it("starts the day at 00:00 UTC", () => {
    expect(dayStartIso(NOW)).toBe("2026-11-12T00:00:00.000Z");
  });
});

describe("assertManagedVeniceAgentWithinSpendCap", () => {
  it("never touches the database while the flag is off", async () => {
    const db = { from: () => { throw new Error("queried"); } };
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: KEY, addMicroUsd: 1e12 }, db, {})).resolves.toBeUndefined();
  });

  it("allows spend under the agent's limit and ignores yesterday and other agents", async () => {
    const db = world({ capMicroUsd: 1_000_000, spentToday: 400_000, spentYesterday: 5_000_000, otherKeyToday: 5_000_000 });
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: KEY, addMicroUsd: 500_000, now: NOW }, db, ON)).resolves.toBeUndefined();
  });

  it("refuses over the limit, logs it, and stamps the key once", async () => {
    const db = world({ capMicroUsd: 1_000_000, spentToday: 900_000 });
    const attempt = assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: KEY, addMicroUsd: 200_000, now: NOW }, db, ON);
    await expect(attempt).rejects.toBeInstanceOf(ManagedVeniceAgentSpendCapError);
    await expect(attempt).rejects.toBeInstanceOf(ManagedVeniceSpendCapError);
    expect(db.updates).toHaveLength(1);
    const { log } = jest.requireMock("@/lib/logger");
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ failureType: "managed_venice_agent_spend_cap_reached", capSource: "owner" }));
    // A second refusal the same day does not write again.
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: KEY, addMicroUsd: 200_000, now: NOW }, db, ON)).rejects.toThrow();
    expect(db.updates).toHaveLength(1);
  });

  it("falls back to the platform default when the owner set none", async () => {
    const db = world({ spentToday: 2_000_000 });
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: KEY, addMicroUsd: 1, now: NOW }, db,
      { ...ON, MANAGED_VENICE_AGENT_DAILY_SPEND_CAP_USD: "2" })).rejects.toBeInstanceOf(ManagedVeniceAgentSpendCapError);
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: KEY, addMicroUsd: 1, now: NOW }, db, ON)).resolves.toBeUndefined();
  });

  it("does nothing for a key of another user or no key", async () => {
    const db = world({ capMicroUsd: 1, spentToday: 9 });
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u2", proxyKeyId: KEY, addMicroUsd: 9, now: NOW }, db, ON)).resolves.toBeUndefined();
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: null, addMicroUsd: 9, now: NOW }, db, ON)).resolves.toBeUndefined();
  });
});

describe("setManagedVeniceAgentDailySpendCap", () => {
  it("saves and clears the owner's limit without dropping other metadata", async () => {
    const db = world();
    await setManagedVeniceAgentDailySpendCap({ userId: "u1", proxyKeyId: KEY, dailyUsd: 3.5 }, db);
    expect(db.updates[0].patch.metadata).toEqual({ defaultWalletType: "card", spendCap: { dailyMicroUsd: 3_500_000 } });
    const cleared = await setManagedVeniceAgentDailySpendCap({ userId: "u1", proxyKeyId: KEY, dailyUsd: null }, db);
    expect(cleared.dailyMicroUsd).toBeNull();
  });
  it("rejects nonsense limits", async () => {
    await expect(setManagedVeniceAgentDailySpendCap({ userId: "u1", proxyKeyId: KEY, dailyUsd: 0 }, world())).rejects.toBeInstanceOf(RangeError);
  });
});

describe("managedVeniceSpendCapMessage", () => {
  it("names the agent's daily limit or the monthly cap", () => {
    expect(managedVeniceSpendCapMessage(new ManagedVeniceAgentSpendCapError(KEY, 5_000_000, 5_000_000), "u")).toMatch(/daily inference limit of \$5\.00/);
    expect(managedVeniceSpendCapMessage(new ManagedVeniceSpendCapError(1, 1), "https://x")).toMatch(/^Monthly .*https:\/\/x$/);
  });
});
