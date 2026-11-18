import {
  ProxyKeyMetadataConflictError,
  updateManagedVeniceProxyKeyMetadata,
} from "@/lib/venice/proxy-key-metadata";

type Row = Record<string, unknown>;

// An in-memory stand-in for the query builder that behaves like the real
// table where it matters here: update(...).<filters>.select() answers with
// the rows it changed, and every update bumps updated_at like the trigger.
function fakeDb(rows: Row[], hooks: { beforeWrite?: () => void } = {}) {
  let tick = 0;
  const writes: Row[] = [];
  function from() {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const matching = () => rows.filter(r => filters.every(f => f(r)));
    const chain: Record<string, unknown> = {
      select: () => {
        if (!patch) return chain;
        hooks.beforeWrite?.();
        const hit = matching();
        for (const r of hit) Object.assign(r, patch, { updated_at: `2026-11-17T10:00:${String(++tick).padStart(2, "0")}.000Z` });
        if (hit.length) writes.push(patch);
        return Promise.resolve({ data: hit.map(r => ({ id: r.id })), error: null });
      },
      update: (p: Row) => { patch = p; return chain; },
      eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return chain; },
      maybeSingle: async () => ({ data: matching()[0] ? { ...matching()[0] } : null, error: null }),
    };
    return chain;
  }
  return { from, writes, bump: (row: Row, change: Row = {}) => Object.assign(row, change, { updated_at: `2026-11-17T11:00:${String(++tick).padStart(2, "0")}.000Z` }) };
}

const ids = { userId: "u1", proxyKeyId: "key-1" };
const keyRow = (metadata: Row = { defaultWalletType: "card" }): Row =>
  ({ id: "key-1", user_id: "u1", metadata, updated_at: "2026-11-17T09:00:00.000Z" });

describe("updateManagedVeniceProxyKeyMetadata", () => {
  it("saves the change and keeps the fields it does not own", async () => {
    const row = keyRow({ defaultWalletType: "card", spendCap: { dailyMicroUsd: 5_000_000 } });
    const db = fakeDb([row]);
    const stored = await updateManagedVeniceProxyKeyMetadata(db, ids, meta => ({ ...meta, privateOnly: { enabled: true } }));
    expect(stored).toEqual({ defaultWalletType: "card", spendCap: { dailyMicroUsd: 5_000_000 }, privateOnly: { enabled: true } });
    expect(row.metadata).toEqual(stored);
  });

  it("answers null for a missing key or another user's key, and writes nothing", async () => {
    const db = fakeDb([keyRow()]);
    expect(await updateManagedVeniceProxyKeyMetadata(db, { userId: "u1", proxyKeyId: "nope" }, m => m)).toBeNull();
    expect(await updateManagedVeniceProxyKeyMetadata(db, { userId: "u2", proxyKeyId: "key-1" }, m => ({ ...m, x: 1 }))).toBeNull();
    expect(db.writes).toHaveLength(0);
  });

  it("does not lose a setting another writer saved between its read and its write", async () => {
    const row = keyRow();
    let raced = false;
    const db = fakeDb([row], {
      // Another writer turns "private models only" on just before the first write lands.
      beforeWrite: () => {
        if (raced) return;
        raced = true;
        db.bump(row, { metadata: { ...(row.metadata as Row), privateOnly: { enabled: true } } });
      },
    });
    const stored = await updateManagedVeniceProxyKeyMetadata(db, ids, meta => ({ ...meta, spendCap: { lastReachedAt: "now" } }));
    expect(stored).toEqual({ defaultWalletType: "card", privateOnly: { enabled: true }, spendCap: { lastReachedAt: "now" } });
    expect(row.metadata).toEqual(stored);
    expect(db.writes).toHaveLength(1);
  });

  it("gives up with a clear error when the key keeps changing", async () => {
    const row = keyRow();
    const db = fakeDb([row], { beforeWrite: () => db.bump(row) });
    await expect(updateManagedVeniceProxyKeyMetadata(db, ids, m => ({ ...m, x: 1 }))).rejects.toBeInstanceOf(ProxyKeyMetadataConflictError);
    expect(db.writes).toHaveLength(0);
    expect(row.metadata).toEqual({ defaultWalletType: "card" });
  });

  it("treats metadata that is not an object as empty", async () => {
    const row = keyRow();
    row.metadata = null;
    const db = fakeDb([row]);
    expect(await updateManagedVeniceProxyKeyMetadata(db, ids, m => ({ ...m, a: 1 }))).toEqual({ a: 1 });
  });
});
