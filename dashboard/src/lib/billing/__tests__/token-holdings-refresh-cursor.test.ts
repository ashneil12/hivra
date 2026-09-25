/**
 * The holdings crons (refresh-token-holdings, refresh-token-tiers) must re-read
 * EVERY account with token standing on every run, however many accounts
 * without standing exist, and must only move an account back once it has
 * actually been judged.
 *
 * Before this, both crons paged through ONE pool in user_id order, 100 per
 * run: sign-ups that each verify a fresh wallet pushed an account with a
 * Pro/Power qualification back by pool/400 days while it kept its tier. And
 * the cursor moved past a page when it was handed out, so a failed read (or a
 * page whose evaluation threw) waited a whole cycle, not one run.
 *
 * The fake below mirrors the SQL contract of
 * supabase/migrations/20260925194500_token_holding_refresh_standing_first.sql
 * (classes, least recently judged first, ten-minute lease, cycle close); the
 * SQL itself runs against real PostgreSQL in
 * scripts/test-token-holding-refresh-standing-first.cjs.
 */
import {
  BASE_CHAIN_ID,
  HERMESOS_TOKEN_ADDRESS,
  TOKEN_STANDING_REREAD_OVERDUE_HOURS,
  VVV_TOKEN_ADDRESS,
  refreshVerifiedHermesTokenHoldings,
} from "@/lib/billing/token-holdings";
import { REQUALIFICATION_GRACE_HOURS } from "@/lib/billing/tier-thresholds";
import { reportOpsEvent } from "@/lib/ops-events";

jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn(async () => null) }));

type Row = Record<string, unknown>;

type RefreshParams = Parameters<typeof refreshVerifiedHermesTokenHoldings>[0];
const refresh = (params: Record<string, unknown>) =>
  refreshVerifiedHermesTokenHoldings(params as unknown as RefreshParams);

const HOUR = 3_600_000;
const LEASE_MS = 10 * 60_000;

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

interface AccountState {
  claimedAt: number;
  judgedAt: number | null;
}

/**
 * Wallets, snapshots, and the refresh RPCs over a fake database clock
 * (`world.now`, advanced by the test between runs).
 */
function createTokenWorld(seed: { wallets?: Row[]; snapshots?: Row[]; standingUserIds?: string[] }) {
  const wallets = [...(seed.wallets ?? [])];
  const snapshots = [...(seed.snapshots ?? [])];
  const standing = new Set(seed.standingUserIds ?? []);
  const accounts = new Map<string, AccountState>();
  const cycleStartedAt = new Map<string, number>();
  const clock = { now: Date.UTC(2026, 8, 25) };
  let inserted = 0;

  const key = (lane: string, userId: string) => `${lane}:${userId}`;
  const candidates = (withStanding: boolean) => {
    const pool = new Set([
      ...wallets
        .filter((row) => row.chain_type === "evm" && row.is_primary && row.verified_at)
        .map((row) => String(row.user_id)),
      ...standing,
    ]);
    return [...pool].filter((userId) => standing.has(userId) === withStanding);
  };

  const rpc = jest.fn(async (name: string, args: Record<string, unknown>) => {
    const lane = String(args.p_lane);
    if (name === "claim_token_holding_refresh_page") {
      if (!cycleStartedAt.has(lane)) cycleStartedAt.set(lane, clock.now);
      const limit = Math.max(1, Math.min(Number(args.p_limit), 100));
      const page = candidates(args.p_standing === true)
        .filter((userId) => {
          const state = accounts.get(key(lane, userId));
          return !state || state.claimedAt < clock.now - LEASE_MS;
        })
        .sort((a, b) => {
          const left = accounts.get(key(lane, a))?.judgedAt ?? null;
          const right = accounts.get(key(lane, b))?.judgedAt ?? null;
          if (left !== right) {
            if (left === null) return -1;
            if (right === null) return 1;
            return left - right;
          }
          return a < b ? -1 : a > b ? 1 : 0;
        })
        .slice(0, limit);
      for (const userId of page) {
        const state = accounts.get(key(lane, userId));
        accounts.set(key(lane, userId), { claimedAt: clock.now, judgedAt: state?.judgedAt ?? null });
      }
      return { data: page.map((user_id) => ({ user_id })), error: null };
    }
    if (name === "record_token_holding_refresh_judgments") {
      let recorded = 0;
      for (const userId of args.p_user_ids as string[]) {
        const state = accounts.get(key(lane, userId));
        if (!state) continue;
        state.judgedAt = clock.now;
        recorded += 1;
      }
      return { data: recorded, error: null };
    }
    if (name === "close_token_holding_refresh_run") {
      const started = cycleStartedAt.get(lane) ?? clock.now;
      const withStanding = candidates(true);
      const unjudged = withStanding.filter((userId) => {
        const judgedAt = accounts.get(key(lane, userId))?.judgedAt ?? null;
        return judgedAt === null || judgedAt < started;
      }).length;
      cycleStartedAt.set(lane, unjudged === 0 ? clock.now : started);
      return {
        data: [
          {
            standing: withStanding.length,
            unjudged,
            cycle_started_at: new Date(started).toISOString(),
            cycle_seconds: Math.floor((clock.now - started) / 1000),
            cycle_completed: unjudged === 0,
          },
        ],
        error: null,
      };
    }
    return { data: null, error: { code: "PGRST202", message: `function ${name} not found` } };
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

  const judgedAt = (lane: string, userId: string) => accounts.get(key(lane, userId))?.judgedAt ?? null;
  // The next scheduled run: six hours on, well past the claim lease.
  const nextRun = () => {
    clock.now += 6 * HOUR;
  };

  return { db, rpc, wallets, snapshots, standing, clock, judgedAt, nextRun };
}

function signatureWallet(userId: string, index: number): Row {
  const address = `0x${index.toString(16).padStart(40, "0")}`;
  return {
    id: `wallet_${index}`,
    user_id: userId,
    address,
    normalized_address: address,
    chain_type: "evm",
    chain_id: BASE_CHAIN_ID,
    is_primary: true,
    verified_at: new Date(Date.UTC(2026, 3, 1) + index * 60_000).toISOString(),
    verification_method: "signature",
    metadata: {},
  };
}

/** `count` sign-ups, each with one verified primary wallet and no standing. */
function junkWallets(count: number): Row[] {
  return Array.from({ length: count }, (_, i) =>
    signatureWallet(`acct_junk_${String(i).padStart(5, "0")}`, i + 1)
  );
}

const refreshed = async () => ({ status: "refreshed" as const, snapshot: null });

beforeEach(() => {
  (reportOpsEvent as jest.Mock).mockClear();
});

describe("refreshVerifiedHermesTokenHoldings: accounts with standing come first", () => {
  it("re-reads an eligible Power account on every run, first, despite 1,000 accounts without standing", async () => {
    // The Power account sorts after every junk account: with the user_id
    // cursor it was first re-read on run 11 (about three days).
    const world = createTokenWorld({
      wallets: [...junkWallets(1000), signatureWallet("zz_power", 9999)],
      standingUserIds: ["zz_power"],
    });

    for (let run = 1; run <= 3; run++) {
      const reads: string[] = [];
      const result = await refresh({
        db: world.db,
        lane: "token_holdings",
        limit: 100,
        clock: () => world.clock.now,
        refreshUserHolding: async (userId: string) => {
          reads.push(userId);
          return refreshed();
        },
      });

      expect(reads[0]).toBe("zz_power");
      expect(reads.filter((userId) => userId === "zz_power")).toHaveLength(1);
      // Leftover capacity for accounts without standing stays bounded.
      expect(result.standing).toEqual({ claimed: 1, read: 1, judged: 1 });
      expect(result.withoutStanding).toEqual({ claimed: 100, read: 100, judged: 100 });
      expect(result.cycle).toMatchObject({ standing: 1, unjudged: 0, completed: true, overdue: false });
      expect(world.judgedAt("token_holdings", "zz_power")).toBe(world.clock.now);
      world.nextRun();
    }
  });

  it("reads every account with standing within one run, page after page", async () => {
    const standingIds = Array.from({ length: 250 }, (_, i) => `standing_${String(i).padStart(3, "0")}`);
    const world = createTokenWorld({ wallets: junkWallets(300), standingUserIds: standingIds });
    const reads: string[] = [];

    const result = await refresh({
      db: world.db,
      lane: "token_holdings",
      limit: 100,
      clock: () => world.clock.now,
      refreshUserHolding: async (userId: string) => {
        reads.push(userId);
        return refreshed();
      },
    });

    expect(reads.slice(0, 250).sort()).toEqual(standingIds);
    expect(result.standing).toEqual({ claimed: 250, read: 250, judged: 250 });
    expect(result.withoutStanding.claimed).toBe(100);
    const claims = world.rpc.mock.calls.filter(([name]) => name === "claim_token_holding_refresh_page");
    expect(claims.map(([, args]) => [args.p_standing, args.p_limit])).toEqual([
      [true, 100],
      [true, 100],
      [true, 100],
      [false, 100],
    ]);
  });

  it("reaches every account without standing over later runs, least recently judged first", async () => {
    const world = createTokenWorld({ wallets: junkWallets(250) });
    const seen: string[][] = [];
    for (let run = 1; run <= 4; run++) {
      const reads: string[] = [];
      await refresh({
        db: world.db,
        lane: "token_tiers",
        limit: 100,
        clock: () => world.clock.now,
        refreshUserHolding: async (userId: string) => {
          reads.push(userId);
          return refreshed();
        },
      });
      seen.push(reads);
      world.nextRun();
    }

    expect(new Set(seen.slice(0, 3).flat()).size).toBe(250);
    // Run 3 finishes the never-judged accounts, then starts again with run 1's.
    expect(seen[2].slice(50)).toEqual(seen[0].slice(0, 50));
    expect(seen[3]).toEqual([...seen[0].slice(50), ...seen[1].slice(0, 50)]);
  });
});

describe("refreshVerifiedHermesTokenHoldings: only judged accounts move back", () => {
  it("retries a failed read first on the next run instead of after a whole cycle", async () => {
    const world = createTokenWorld({ wallets: junkWallets(300) });
    const failing = "acct_junk_00009";
    const runReads: string[][] = [];
    for (let run = 1; run <= 2; run++) {
      const reads: string[] = [];
      const result = await refresh({
        db: world.db,
        lane: "token_holdings",
        limit: 100,
        clock: () => world.clock.now,
        refreshUserHolding: async (userId: string) => {
          reads.push(userId);
          if (run === 1 && userId === failing) throw new Error("429 from the public Base RPC");
          return refreshed();
        },
      });
      runReads.push(reads);
      if (run === 1) {
        expect(result.failed).toBe(1);
        expect(result.withoutStanding.judged).toBe(99);
        expect(world.judgedAt("token_holdings", failing)).toBeNull();
      }
      world.nextRun();
    }

    expect(runReads[0]).toContain(failing);
    // Next run, not after the other 200 accounts: it was never judged, so it
    // sorts ahead of every judged account and, by user id, of the unread ones.
    expect(runReads[1][0]).toBe(failing);
  });

  it("records only the accounts the judge returns, and leaves the cycle open for the rest", async () => {
    const world = createTokenWorld({
      wallets: [signatureWallet("power_a", 1), signatureWallet("power_b", 2), signatureWallet("power_c", 3)],
      standingUserIds: ["power_a", "power_b", "power_c"],
    });
    const judgePage = jest.fn(async (reads: Array<{ userId: string; status: string }>) => [
      // power_b's evaluation failed; an id the page never read is ignored.
      ...reads.map((read) => read.userId).filter((userId) => userId !== "power_b"),
      "someone_else",
    ]);

    const result = await refresh({
      db: world.db,
      lane: "token_holdings",
      clock: () => world.clock.now,
      judgePage,
      refreshUserHolding: async (userId: string) =>
        userId === "power_c" ? Promise.reject(new Error("rpc down")) : refreshed(),
    });

    expect(judgePage).toHaveBeenCalledWith([
      expect.objectContaining({ userId: "power_a", standing: true, status: "refreshed" }),
      expect.objectContaining({ userId: "power_b", standing: true, status: "refreshed" }),
      expect.objectContaining({ userId: "power_c", standing: true, status: "failed" }),
    ]);
    expect(world.rpc).toHaveBeenCalledWith("record_token_holding_refresh_judgments", {
      p_lane: "token_holdings",
      p_user_ids: ["power_a"],
    });
    expect(result.judged).toBe(1);
    expect(result.cycle).toMatchObject({ standing: 3, unjudged: 2, completed: false });

    world.nextRun();
    const reads: string[] = [];
    await refresh({
      db: world.db,
      lane: "token_holdings",
      clock: () => world.clock.now,
      judgePage: async (page: Array<{ userId: string }>) => page.map((read) => read.userId),
      refreshUserHolding: async (userId: string) => {
        reads.push(userId);
        return refreshed();
      },
    });
    expect(reads).toEqual(["power_b", "power_c", "power_a"]);
  });

  it("records nothing for a page whose judge throws, still closes the run, and fails loudly", async () => {
    const world = createTokenWorld({
      wallets: [signatureWallet("power_a", 1)],
      standingUserIds: ["power_a"],
    });

    await expect(
      refresh({
        db: world.db,
        lane: "token_holdings",
        clock: () => world.clock.now,
        judgePage: async () => {
          throw new Error("token access lookup failed");
        },
        refreshUserHolding: refreshed,
      })
    ).rejects.toThrow("token access lookup failed");

    const names = world.rpc.mock.calls.map(([name]) => name);
    expect(names).not.toContain("record_token_holding_refresh_judgments");
    expect(names[names.length - 1]).toBe("close_token_holding_refresh_run");
    expect(world.judgedAt("token_holdings", "power_a")).toBeNull();
  });

  it("stops starting reads when the time budget runs out, and reads the rest first next run", async () => {
    const standingIds = Array.from({ length: 12 }, (_, i) => `standing_${String(i).padStart(2, "0")}`);
    const world = createTokenWorld({ wallets: junkWallets(5), standingUserIds: standingIds });
    let ms = 0;
    const clock = () => ms;
    const reads: string[] = [];

    const result = await refresh({
      db: world.db,
      lane: "token_holdings",
      clock,
      timeBudgetMs: 5_000,
      refreshUserHolding: async (userId: string) => {
        reads.push(userId);
        ms += 1_000;
        return refreshed();
      },
    });

    expect(result.budgetExhausted).toBe(true);
    expect(reads).toEqual(standingIds.slice(0, 5));
    expect(result.unread).toBe(7);
    expect(result.withoutStanding.claimed).toBe(0);
    expect(result.cycle).toMatchObject({ standing: 12, unjudged: 7, completed: false });

    world.nextRun();
    const nextReads: string[] = [];
    await refresh({
      db: world.db,
      lane: "token_holdings",
      clock: () => world.clock.now,
      refreshUserHolding: async (userId: string) => {
        nextReads.push(userId);
        return refreshed();
      },
    });
    expect(nextReads.slice(0, 7)).toEqual(standingIds.slice(5));
  });
});

describe("refreshVerifiedHermesTokenHoldings: overdue re-reads reach ops", () => {
  it("raises an ops event once a lane's cycle over accounts with standing outlasts the breach grace", async () => {
    expect(TOKEN_STANDING_REREAD_OVERDUE_HOURS).toBe(REQUALIFICATION_GRACE_HOURS);
    const world = createTokenWorld({
      wallets: [signatureWallet("power_a", 1)],
      standingUserIds: ["power_a"],
    });
    const failingRun = () =>
      refresh({
        db: world.db,
        lane: "token_tiers",
        clock: () => world.clock.now,
        refreshUserHolding: async () => {
          throw new Error("every read fails");
        },
      });

    // Four runs at six-hour intervals: the cycle is 18h old, inside the grace.
    for (let run = 1; run <= 4; run++) {
      const result = await failingRun();
      expect(result.cycle.overdue).toBe(false);
      world.nextRun();
    }
    expect(reportOpsEvent).not.toHaveBeenCalled();

    // The fifth run closes a cycle that has been open for 24h: still inside.
    // The sixth sees 30h without a complete re-read.
    await failingRun();
    world.nextRun();
    const overdue = await failingRun();

    expect(overdue.cycle).toMatchObject({ standing: 1, unjudged: 1, completed: false, overdue: true });
    expect(reportOpsEvent).toHaveBeenCalledTimes(1);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "cron.refresh-token-tiers",
        severity: "error",
        title: "Token standing re-reads overdue",
        route: "/api/cron/refresh-token-tiers",
        metadata: expect.objectContaining({
          failureType: "token_standing_reread_overdue",
          lane: "token_tiers",
          standing: 1,
          unjudged: 1,
          cycleHours: 30,
          cycleCompleted: false,
        }),
      })
    );
  });
});

describe("refreshVerifiedHermesTokenHoldings: lanes and failures", () => {
  it("claims from its own lane", async () => {
    const world = createTokenWorld({ wallets: [signatureWallet("user_0001", 1)] });
    await refresh({
      db: world.db,
      lane: "token_tiers",
      limit: 25,
      clock: () => world.clock.now,
      refreshUserHolding: refreshed,
    });

    expect(world.rpc).toHaveBeenCalledWith("claim_token_holding_refresh_page", {
      p_lane: "token_tiers",
      p_standing: true,
      p_limit: 25,
    });
    expect(world.rpc).toHaveBeenCalledWith("claim_token_holding_refresh_page", {
      p_lane: "token_tiers",
      p_standing: false,
      p_limit: 25,
    });
    expect(world.judgedAt("token_tiers", "user_0001")).toBe(world.clock.now);
    expect(world.judgedAt("token_holdings", "user_0001")).toBeNull();
  });

  it("fails loudly when the refresh RPCs are unavailable instead of silently re-reading a fixed page", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      rpc: jest.fn(async () => ({ data: null, error: { code: "PGRST202", message: "function not found" } })),
      from: jest.fn(),
    };

    await expect(refresh({ db, lane: "token_holdings" })).rejects.toThrow(
      "Failed to claim a token holding refresh page (PGRST202: function not found)"
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
      standingUserIds: ["user_unbacked"],
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

    const result = await refresh({ db: world.db, lane: "token_holdings", fetchImpl, now, clock: () => 0 });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.noVerifiedWallet).toBe(1);
    expect(result.results).toEqual([
      expect.objectContaining({ userId: "user_unbacked", standing: true, status: "no_verified_wallet" }),
    ]);
    // A zero balance is a definitive read: the account is judged.
    expect(result.judged).toBe(1);
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
      standingUserIds: ["user_unbacked"],
      snapshots: [
        snapshot({
          token_address: HERMESOS_TOKEN_ADDRESS,
          token_symbol: "HermesOS",
          balance_raw: "0",
          checked_at: "2026-04-22T00:00:00.000Z",
        }),
      ],
    });

    await refresh({ db: world.db, lane: "token_holdings", fetchImpl: jest.fn(), now, clock: () => 0 });

    expect(world.snapshots).toHaveLength(1);
  });

  it("re-reads an account whose only link is its token standing (no primary wallet at all)", async () => {
    const world = createTokenWorld({
      wallets: unbackedWallets().map((row) => ({ ...row, is_primary: false })),
      standingUserIds: ["user_unbacked"],
    });

    const result = await refresh({ db: world.db, lane: "token_holdings", fetchImpl: jest.fn(), now, clock: () => 0 });

    expect(result.results).toEqual([
      expect.objectContaining({ userId: "user_unbacked", standing: true, status: "no_verified_wallet" }),
    ]);
  });
});
