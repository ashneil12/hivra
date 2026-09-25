/**
 * The holdings crons (refresh-token-holdings, refresh-token-tiers) must
 * re-read EVERY account with token standing over time, in bounded pages, and
 * must record zero holdings for an account whose standing no longer has a
 * verification wallet behind it.
 *
 * Before the fix both crons read the 100 oldest primary wallets on every run,
 * so account 101 onwards was never re-read (a sale never downgraded it), and
 * an account whose only primary was a Bankr deposit wallet came back
 * `no_verified_wallet` and kept its old standing forever.
 *
 * The fake below serves both the old wallet listing and the new cursor RPC.
 * The RPC's SQL is exercised against real PostgreSQL by
 * scripts/test-token-holding-refresh-cursor.cjs; this fake mirrors its
 * contract (keyset over candidate user ids, one cursor per lane, wraps).
 */
import {
  BASE_CHAIN_ID,
  HERMESOS_TOKEN_ADDRESS,
  VVV_TOKEN_ADDRESS,
  refreshVerifiedHermesTokenHoldings,
} from "@/lib/billing/token-holdings";

type Row = Record<string, unknown>;

type RefreshParams = Parameters<typeof refreshVerifiedHermesTokenHoldings>[0];
const refresh = (params: Record<string, unknown>) =>
  refreshVerifiedHermesTokenHoldings(params as unknown as RefreshParams);

function readColumn(row: Row, column: string): unknown {
  if (!column.includes("->")) return row[column];
  const [base, ...path] = column.split(/->>?/);
  let value: unknown = row[base];
  for (const key of path) {
    value = value && typeof value === "object" ? (value as Row)[key] : undefined;
  }
  return value;
}

function selectQuery(rows: () => Row[]) {
  const eqs: Array<[string, unknown]> = [];
  const notNull: string[] = [];
  let order: { column: string; ascending: boolean } | null = null;
  let limit: number | null = null;
  const run = () => {
    let out = rows().filter(
      (row) =>
        eqs.every(([column, value]) => readColumn(row, column) === value) &&
        notNull.every((column) => row[column] != null)
    );
    if (order) {
      const { column, ascending } = order;
      out = [...out].sort((a, b) => {
        const left = String(a[column]);
        const right = String(b[column]);
        return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
      });
    }
    return limit === null ? out : out.slice(0, limit);
  };
  const query: Row = {};
  query.select = () => query;
  query.eq = (column: string, value: unknown) => {
    eqs.push([column, value]);
    return query;
  };
  query.not = (column: string, op: string, value: unknown) => {
    if (op !== "is" || value !== null) throw new Error(`unsupported not(${column}, ${op})`);
    notNull.push(column);
    return query;
  };
  query.order = (column: string, options?: { ascending?: boolean }) => {
    order = { column, ascending: options?.ascending !== false };
    return query;
  };
  query.limit = (count: number) => {
    limit = count;
    return query;
  };
  query.maybeSingle = async () => ({ data: run()[0] ?? null, error: null });
  query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve({ data: run(), error: null }).then(resolve, reject);
  return query;
}

function createTokenWorld(seed: { wallets?: Row[]; snapshots?: Row[]; standingUserIds?: string[] }) {
  const wallets = [...(seed.wallets ?? [])];
  const snapshots = [...(seed.snapshots ?? [])];
  const cursors = new Map<string, string | null>();
  let inserted = 0;

  const candidates = () =>
    Array.from(
      new Set([
        ...wallets
          .filter((row) => row.chain_type === "evm" && row.is_primary && row.verified_at)
          .map((row) => String(row.user_id)),
        ...(seed.standingUserIds ?? []),
      ])
    ).sort();

  const rpc = jest.fn(async (name: string, args: { p_lane: string; p_limit: number }) => {
    if (name !== "claim_token_holding_refresh_batch") {
      return { data: null, error: { code: "PGRST202", message: `function ${name} not found` } };
    }
    const after = cursors.get(args.p_lane) ?? null;
    const all = candidates();
    const ordered = [
      ...all.filter((id) => after === null || id > after),
      ...all.filter((id) => after !== null && id <= after),
    ];
    const page = ordered.slice(0, Math.max(1, Math.min(args.p_limit, 100)));
    if (page.length > 0) cursors.set(args.p_lane, page[page.length - 1]);
    return { data: page.map((user_id) => ({ user_id })), error: null };
  });

  const db = {
    rpc,
    from: jest.fn((name: string) => {
      if (name === "user_wallets") return selectQuery(() => wallets);
      if (name === "token_holding_snapshots") {
        const query = selectQuery(() => snapshots);
        query.insert = (row: Row) => {
          const stored = { id: `snapshot_zero_${++inserted}`, ...row };
          snapshots.push(stored);
          return { select: () => ({ single: async () => ({ data: stored, error: null }) }) };
        };
        return query;
      }
      throw new Error(`Unexpected table ${name}`);
    }),
  };

  return { db, rpc, wallets, snapshots, cursors };
}

function signatureWallet(index: number): Row {
  const address = `0x${index.toString(16).padStart(40, "0")}`;
  return {
    id: `wallet_${index}`,
    user_id: `user_${String(index).padStart(4, "0")}`,
    address,
    normalized_address: address,
    chain_type: "evm",
    chain_id: BASE_CHAIN_ID,
    is_primary: true,
    // Wallet 0 is the oldest; the old listing always read the lowest indexes.
    verified_at: new Date(Date.UTC(2026, 3, 1) + index * 60_000).toISOString(),
    verification_method: "signature",
    metadata: {},
  };
}

describe("refreshVerifiedHermesTokenHoldings: every account is re-read over time", () => {
  it("pages through more than one run's worth of verified wallets instead of re-reading the oldest 100", async () => {
    const world = createTokenWorld({ wallets: Array.from({ length: 150 }, (_, i) => signatureWallet(i)) });
    const visited: string[][] = [];
    const runOnce = async () => {
      const seen: string[] = [];
      const result = await refresh({
        db: world.db,
        lane: "token_holdings",
        limit: 100,
        refreshUserHolding: async (userId: string) => {
          seen.push(userId);
          return { status: "refreshed", snapshot: null };
        },
      });
      visited.push(seen);
      return result;
    };

    const first = await runOnce();
    const second = await runOnce();

    // Bounded work per run.
    expect(first.checked).toBe(100);
    expect(visited[0]).toHaveLength(100);
    expect(visited[1].length).toBeLessThanOrEqual(100);
    // Every verified account was re-read within two runs.
    expect(new Set([...visited[0], ...visited[1]]).size).toBe(150);
    expect(second.refreshed).toBe(visited[1].length);
  });

  it("claims its page from the cursor of its own lane", async () => {
    const world = createTokenWorld({ wallets: [signatureWallet(1)] });
    await refresh({
      db: world.db,
      lane: "token_tiers",
      limit: 25,
      refreshUserHolding: async () => ({ status: "refreshed", snapshot: null }),
    });

    expect(world.rpc).toHaveBeenCalledWith("claim_token_holding_refresh_batch", {
      p_lane: "token_tiers",
      p_limit: 25,
    });
    expect(world.cursors.get("token_tiers")).toBe("user_0001");
    expect(world.cursors.has("token_holdings")).toBe(false);
  });

  it("fails loudly when the cursor RPC is unavailable instead of silently re-reading a fixed page", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      rpc: jest.fn(async () => ({ data: null, error: { code: "PGRST202", message: "function not found" } })),
      from: jest.fn(),
    };

    await expect(refresh({ db, lane: "token_holdings" })).rejects.toThrow(
      "Failed to claim token holding refresh batch"
    );
    expect(db.from).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe("refreshVerifiedHermesTokenHoldings: standing without a verification wallet", () => {
  const depositAddress = "0x000000000000000000000000000000000000c0fe";
  const signedAddress = "0x000000000000000000000000000000000000dead";
  // Primary is the Bankr credit deposit wallet (what a crypto payment used to
  // do); the signed wallet the tier was earned on is no longer primary.
  const unbackedWallets = (): Row[] => [
    {
      id: "wallet_deposit",
      user_id: "user_unbacked",
      address: depositAddress,
      normalized_address: depositAddress,
      chain_type: "evm",
      chain_id: BASE_CHAIN_ID,
      is_primary: true,
      verified_at: "2026-04-24T12:00:00.000Z",
      verification_method: "bankr",
      metadata: { bankr: { purpose: "credit_deposit" } },
    },
    {
      id: "wallet_signed",
      user_id: "user_unbacked",
      address: signedAddress,
      normalized_address: signedAddress,
      chain_type: "evm",
      chain_id: BASE_CHAIN_ID,
      is_primary: false,
      verified_at: "2026-04-20T12:00:00.000Z",
      verification_method: "signature",
      metadata: {},
    },
  ];
  const snapshot = (overrides: Row): Row => ({
    id: `snapshot_${String(overrides.token_address)}_${String(overrides.checked_at)}`,
    user_id: "user_unbacked",
    wallet_id: "wallet_signed",
    wallet_address: signedAddress,
    normalized_wallet_address: signedAddress,
    chain_id: BASE_CHAIN_ID,
    token_decimals: 18,
    block_number: 1,
    source: "base_rpc",
    ...overrides,
  });
  const now = new Date("2026-05-01T00:00:00.000Z");

  it("records zero holdings in every token it last saw a balance for", async () => {
    const world = createTokenWorld({
      wallets: unbackedWallets(),
      snapshots: [
        snapshot({
          token_address: HERMESOS_TOKEN_ADDRESS,
          token_symbol: "HermesOS",
          balance_raw: "0",
          checked_at: "2026-04-21T00:00:00.000Z",
        }),
        // Latest $HermesOS read is the Power-sized balance the tier was earned on.
        snapshot({
          token_address: HERMESOS_TOKEN_ADDRESS,
          token_symbol: "HermesOS",
          balance_raw: "5000000000000000000000000",
          checked_at: "2026-04-22T00:00:00.000Z",
        }),
        snapshot({
          token_address: VVV_TOKEN_ADDRESS,
          token_symbol: "VVV",
          balance_raw: "900000000000000000000",
          checked_at: "2026-04-22T00:00:00.000Z",
        }),
      ],
    });
    const fetchImpl = jest.fn();

    const result = await refresh({ db: world.db, lane: "token_holdings", fetchImpl, now });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.noVerifiedWallet).toBe(1);
    expect(result.results).toEqual([
      expect.objectContaining({ userId: "user_unbacked", status: "no_verified_wallet" }),
    ]);
    const zeroRows = world.snapshots.filter((row) => String(row.id).startsWith("snapshot_zero_"));
    expect(zeroRows).toHaveLength(2);
    for (const token of [HERMESOS_TOKEN_ADDRESS, VVV_TOKEN_ADDRESS]) {
      expect(zeroRows).toContainEqual(
        expect.objectContaining({
          user_id: "user_unbacked",
          wallet_id: null,
          normalized_wallet_address: signedAddress,
          token_address: token,
          balance_raw: "0",
          qualifies_base_tier: false,
          source: "admin",
          metadata: { reason: "no_verification_wallet" },
          checked_at: now.toISOString(),
        })
      );
    }
  });

  it("writes nothing more once the recorded holdings are already zero", async () => {
    const world = createTokenWorld({
      wallets: unbackedWallets(),
      snapshots: [
        snapshot({
          token_address: HERMESOS_TOKEN_ADDRESS,
          token_symbol: "HermesOS",
          balance_raw: "0",
          checked_at: "2026-04-22T00:00:00.000Z",
        }),
      ],
    });

    await refresh({ db: world.db, lane: "token_holdings", fetchImpl: jest.fn(), now });

    expect(world.snapshots).toHaveLength(1);
  });

  it("re-reads an account whose only link is its token standing (no primary wallet at all)", async () => {
    const world = createTokenWorld({
      wallets: unbackedWallets().map((row) => ({ ...row, is_primary: false })),
      standingUserIds: ["user_unbacked"],
    });

    const result = await refresh({ db: world.db, lane: "token_holdings", fetchImpl: jest.fn(), now });

    expect(result.results).toEqual([
      expect.objectContaining({ userId: "user_unbacked", status: "no_verified_wallet" }),
    ]);
  });
});
