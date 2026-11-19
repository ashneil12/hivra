import {
  ManagedVeniceAgentSpendCapError,
  agentSpendCapErrorFromDb,
  assertManagedVeniceAgentWithinSpendCap,
  readAgentDailyAllowance,
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
// maybeSingle, and update().eq().select() writes that answer with the rows
// they changed, like the real table.
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
      in: (c: string, vs: unknown[]) => { filters.push(r => vs.includes(r[c])); return chain; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        if (patch) {
          const changed = rows();
          for (const r of changed) Object.assign(r, patch);
          updates.push({ table, patch });
          return Promise.resolve({ data: changed.map(r => ({ id: r.id })), error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
      },
    };
    return chain;
  }
  return { from, updates, tables };
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
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: KEY, addMicroUsd: 1e12 }, db, {})).resolves.toBeNull();
  });

  it("allows spend under the agent's limit and ignores yesterday and other agents", async () => {
    const db = world({ capMicroUsd: 1_000_000, spentToday: 400_000, spentYesterday: 5_000_000, otherKeyToday: 5_000_000 });
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: KEY, addMicroUsd: 500_000, now: NOW }, db, ON)).resolves.toEqual({ agentDailyCapMicroUsd: 1_000_000 });
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
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: KEY, addMicroUsd: 1, now: NOW }, db, ON)).resolves.toBeNull();
  });

  it("does nothing for a key of another user or no key", async () => {
    const db = world({ capMicroUsd: 1, spentToday: 9 });
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u2", proxyKeyId: KEY, addMicroUsd: 9, now: NOW }, db, ON)).resolves.toBeNull();
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: null, addMicroUsd: 9, now: NOW }, db, ON)).resolves.toBeNull();
  });
});

describe("money not yet settled counts toward the limit", () => {
  const hold = (ref: string, extra: Row) => ({ user_id: "u1", reference_id: ref, proxy_key_id: null, metadata: { proxyKeyId: KEY }, ...extra });

  it("counts holds of requests still running, so parallel requests cannot all pass", async () => {
    const db = world({ capMicroUsd: 1_000_000, spentToday: 100_000 });
    db.tables.managed_venice_reservations = [
      hold("r1", { status: "active", reserved_micro_usd: 400_000 }),
      hold("r2", { status: "active", reserved_micro_usd: 400_000, proxy_key_id: KEY, metadata: {} }),
      hold("r3", { status: "active", reserved_micro_usd: 900_000, metadata: { proxyKeyId: "key-2" } }),
    ];
    // 100k spent + 800k held leaves 100k.
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: KEY, addMicroUsd: 100_000, now: NOW }, db, ON))
      .resolves.toEqual({ agentDailyCapMicroUsd: 1_000_000 });
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: KEY, addMicroUsd: 100_001, now: NOW }, db, ON))
      .rejects.toBeInstanceOf(ManagedVeniceAgentSpendCapError);
  });

  it("counts a hold captured today until its usage row is written, and only once after", async () => {
    const db = world({ capMicroUsd: 1_000_000 });
    db.tables.managed_venice_reservations = [
      hold("settling", { status: "captured", captured_micro_usd: 700_000, captured_at: "2026-11-12T14:00:00.000Z" }),
      hold("old", { status: "captured", captured_micro_usd: 700_000, captured_at: "2026-11-11T14:00:00.000Z" }),
    ];
    const allowance = await readAgentDailyAllowance({ userId: "u1", proxyKeyId: KEY, now: NOW }, db, ON);
    expect(allowance).toMatchObject({ committedMicroUsd: 700_000, remainingMicroUsd: 300_000 });
    db.tables.managed_venice_usage_events.push({ user_id: "u1", proxy_key_id: KEY, reference_id: "settling", charged_micro_usd: 700_000, created_at: "2026-11-12T14:00:01.000Z" });
    expect((await readAgentDailyAllowance({ userId: "u1", proxyKeyId: KEY, now: NOW }, db, ON))?.committedMicroUsd).toBe(700_000);
  });

  it("turns the database guard's refusal into the agent limit error", () => {
    const error = agentSpendCapErrorFromDb({ message: "managed_venice_agent_spend_cap: cap=5000000 spent=4900000 requested=200000" }, KEY);
    expect(error).toBeInstanceOf(ManagedVeniceAgentSpendCapError);
    expect(error).toMatchObject({ capMicroUsd: 5_000_000, spentMicroUsd: 4_900_000, proxyKeyId: KEY });
    expect(agentSpendCapErrorFromDb({ message: "something else" }, KEY)).toBeNull();
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
  it("keeps the owner's other settings on the key when it saves or stamps", async () => {
    const db = world({ capMicroUsd: 1_000_000, spentToday: 900_000 });
    const key = db.tables.managed_venice_proxy_keys[0];
    key.metadata = { ...(key.metadata as Row), privateOnly: { enabled: true, updatedAt: "2026-11-12T08:00:00.000Z" } };
    // The request-path stamp, then the owner's own save.
    await expect(assertManagedVeniceAgentWithinSpendCap({ userId: "u1", proxyKeyId: KEY, addMicroUsd: 200_000, now: NOW }, db, ON)).rejects.toThrow();
    await setManagedVeniceAgentDailySpendCap({ userId: "u1", proxyKeyId: KEY, dailyUsd: 2 }, db);
    expect(key.metadata).toEqual({
      defaultWalletType: "card",
      privateOnly: { enabled: true, updatedAt: "2026-11-12T08:00:00.000Z" },
      spendCap: { dailyMicroUsd: 2_000_000, lastReachedAt: NOW.toISOString() },
    });
  });
  it("says so when the key is not this owner's", async () => {
    await expect(setManagedVeniceAgentDailySpendCap({ userId: "u2", proxyKeyId: KEY, dailyUsd: 2 }, world())).rejects.toThrow("no managed inference key");
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
