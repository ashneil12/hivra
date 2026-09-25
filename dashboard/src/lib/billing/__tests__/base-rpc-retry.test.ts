/**
 * Base RPC 429 resilience for the token-tier / token-holdings refresh
 * (issue: "[refreshVerifiedHermesTokenHoldings] refresh failed ... Base RPC
 * request failed with status 429" across many users on
 * /api/cron/refresh-token-tiers + /api/cron/refresh-token-holdings).
 *
 * Same 429 class already fixed for managed-Venice deposits (#445); the
 * retry/backoff/jitter helpers are now SHARED in @/lib/billing/base-rpc-retry
 * and reused here. These tests pin (1) the shared retry primitive, (2) that a
 * single balance read recovers from a transient 429 instead of throwing, and
 * (3) that a fleet-wide refresh throttles between users — without changing any
 * balance / tier / qualification logic.
 */
import {
  computeBackoffDelayMs,
  isRetryableRpcError,
  RpcHttpError,
  withRpcRetry,
  type RpcRetryConfig,
} from "@/lib/billing/base-rpc-retry";
import {
  fetchHermesTokenBalance,
  refreshVerifiedHermesTokenHoldings,
} from "@/lib/billing/token-holdings";

describe("base-rpc-retry: isRetryableRpcError", () => {
  it("retries on HTTP 429 (rate-limited) and 5xx server faults", () => {
    expect(isRetryableRpcError(new RpcHttpError(429))).toBe(true);
    expect(isRetryableRpcError(new RpcHttpError(502))).toBe(true);
    expect(isRetryableRpcError(new RpcHttpError(503))).toBe(true);
  });

  it("retries on raw network failures (TypeError from fetch / ECONNRESET)", () => {
    expect(isRetryableRpcError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableRpcError(new Error("read ECONNRESET"))).toBe(true);
    expect(isRetryableRpcError(new Error("socket hang up"))).toBe(true);
  });

  it("does NOT retry deterministic failures (4xx that isn't 429, JSON-RPC error, decode error)", () => {
    expect(isRetryableRpcError(new RpcHttpError(400))).toBe(false);
    expect(isRetryableRpcError(new RpcHttpError(404))).toBe(false);
    expect(isRetryableRpcError(new Error("Base RPC returned an error"))).toBe(false);
    expect(isRetryableRpcError(new Error("Invalid uint256 RPC result"))).toBe(false);
  });

  it("names the provider's JSON-RPC reason in the message and keeps a 413 non-retryable", () => {
    const error = new RpcHttpError(413, "eth_getLogs is limited to a 2,000 range");
    expect(error.message).toBe(
      "Base RPC request failed with status 413: eth_getLogs is limited to a 2,000 range"
    );
    expect(error.status).toBe(413);
    expect(isRetryableRpcError(error)).toBe(false);
    // Without a body the message keeps its stable, status-only form.
    expect(new RpcHttpError(429).message).toBe("Base RPC request failed with status 429");
  });
});

describe("base-rpc-retry: computeBackoffDelayMs", () => {
  const config: RpcRetryConfig = { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 4000 };

  it("grows exponentially across attempts (jitter pinned to the ceiling)", () => {
    const ceil = () => 1;
    expect(computeBackoffDelayMs(1, config, ceil)).toBe(250);
    expect(computeBackoffDelayMs(2, config, ceil)).toBe(500);
    expect(computeBackoffDelayMs(3, config, ceil)).toBe(1000);
    expect(computeBackoffDelayMs(4, config, ceil)).toBe(2000);
  });

  it("caps the backoff at maxDelayMs and floors at baseDelayMs", () => {
    expect(computeBackoffDelayMs(10, config, () => 1)).toBe(4000);
    expect(computeBackoffDelayMs(3, config, () => 0)).toBe(250);
  });
});

describe("base-rpc-retry: withRpcRetry", () => {
  it("retries a transient 429 and returns once the operation recovers", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const result = await withRpcRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new RpcHttpError(429);
        return "ok";
      },
      {
        retryConfig: { maxAttempts: 4, baseDelayMs: 5, maxDelayMs: 20 },
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 1,
      }
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    // Exactly one backoff sleep before the successful retry.
    expect(sleeps).toHaveLength(1);
  });

  it("re-throws the original 429 after exhausting retries (does not mask the cause)", async () => {
    let attempts = 0;
    await expect(
      withRpcRetry(
        async () => {
          attempts += 1;
          throw new RpcHttpError(429);
        },
        {
          retryConfig: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4 },
          sleepImpl: async () => {},
          random: () => 1,
        }
      )
    ).rejects.toThrow("Base RPC request failed with status 429");
    expect(attempts).toBe(3);
  });

  it("fails fast on a deterministic error (no wasted rate-limit budget)", async () => {
    let attempts = 0;
    await expect(
      withRpcRetry(
        async () => {
          attempts += 1;
          throw new Error("Invalid uint256 RPC result");
        },
        {
          retryConfig: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 4 },
          sleepImpl: async () => {},
        }
      )
    ).rejects.toThrow("Invalid uint256 RPC result");
    // No retries on a deterministic failure.
    expect(attempts).toBe(1);
  });
});

describe("token-holdings: balance read recovers from a transient 429", () => {
  it("retries the rate-limited eth_call and returns the balance instead of throwing", async () => {
    let calls = 0;
    // First call (eth_call balanceOf) is rate-limited; the retry succeeds. Then
    // eth_blockNumber succeeds. Before the fix, the 429 threw straight out as
    // "Base RPC request failed with status 429".
    const fetchMock = jest.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
      if (calls === 2) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x10" }),
      };
    });

    const balance = await fetchHermesTokenBalance({
      walletAddress: "0x000000000000000000000000000000000000dEaD",
      rpcUrl: "https://base.example",
      fetchImpl: fetchMock as never,
      rpcOptions: {
        retryConfig: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 4 },
        sleepImpl: async () => {},
        random: () => 1,
      },
    });

    // 3 fetches total: the 429 + its successful retry + eth_blockNumber.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(balance.balanceRaw).toBe("1000000000000000000");
    expect(balance.qualifiesBaseTier).toBe(true);
  });
});

describe("refreshVerifiedHermesTokenHoldings: inter-user throttle", () => {
  // The run claims one page of accounts with standing (these ids), then finds
  // nothing more in either class; each claimed id is then refreshed in turn.
  // Recording judgments and closing the run succeed.
  function claimRpc(userIds: string[]) {
    let claimed = false;
    return async (name: string) => {
      if (name === "claim_token_holding_refresh_page") {
        const page = claimed ? [] : userIds;
        claimed = true;
        return { data: page.map((user_id) => ({ user_id })), error: null };
      }
      if (name === "record_token_holding_refresh_judgments") return { data: 0, error: null };
      return {
        data: [{ standing: 0, unjudged: 0, cycle_started_at: null, cycle_seconds: 0, cycle_completed: true }],
        error: null,
      };
    };
  }

  // Self-referential mock query that is ALSO thenable. Every chainable method
  // returns the same object; the per-user verification and latest-snapshot
  // lookups terminate in `.maybeSingle()` (resolve to null → no verified
  // wallet, no earlier snapshot to zero).
  function walletQuery(rows: unknown[]) {
    type Q = {
      select: () => Q;
      eq: () => Q;
      not: () => Q;
      order: () => Q;
      limit: () => Q;
      maybeSingle: () => Promise<{ data: unknown; error: null }>;
      then: Promise<{ data: unknown; error: null }>["then"];
    };
    const query = {} as Q;
    query.select = () => query;
    query.eq = () => query;
    query.not = () => query;
    query.order = () => query;
    query.limit = () => query;
    // The batch list query awaits the chain directly → resolves to the rows.
    query.then = (resolve, reject) =>
      Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    // The per-user verification lookups terminate in .maybeSingle() → null.
    query.maybeSingle = () => Promise.resolve({ data: null, error: null });
    return query;
  }

  it("throttles between users so a fleet-wide sweep does not burst the endpoint", async () => {
    const db = {
      rpc: claimRpc(["user_1", "user_2", "user_3"]),
      from: () => walletQuery([]),
    } as never;

    const interUserSleeps: number[] = [];
    const refreshed: string[] = [];

    const result = await refreshVerifiedHermesTokenHoldings({
      lane: "token_holdings",
      db,
      // A caller-supplied refreshUserHolding owns its own pacing, so the batch
      // throttle is intentionally suppressed for it. This documents that branch.
      refreshUserHolding: async (userId: string) => {
        refreshed.push(userId);
        return { status: "no_verified_wallet" as const, snapshot: null, snapshots: [] };
      },
      interUserDelayMs: 50,
      rpcSleepImpl: async (ms: number) => {
        interUserSleeps.push(ms);
      },
    });

    expect(refreshed).toEqual(["user_1", "user_2", "user_3"]);
    expect(result.checked).toBe(3);
    expect(interUserSleeps).toEqual([]);
  });

  it("paces the DEFAULT refresher between users (throttle active on the cron path)", async () => {
    // Minimal DB: the claim RPC hands out two users, then per-user
    // getTokenVerificationWallet returns null (no primary verified wallet), so
    // the default refresher short-circuits to "no_verified_wallet" WITHOUT any
    // RPC — keeping this test focused purely on the inter-user throttle.
    const db = {
      rpc: claimRpc(["user_1", "user_2"]),
      from: (name: string) => {
        if (name === "user_wallets" || name === "token_holding_snapshots") return walletQuery([]);
        throw new Error(`Unexpected table ${name}`);
      },
    } as never;

    const sleeps: number[] = [];
    const result = await refreshVerifiedHermesTokenHoldings({
      lane: "token_holdings",
      db,
      interUserDelayMs: 40,
      rpcSleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    expect(result.checked).toBe(2);
    expect(result.noVerifiedWallet).toBe(2);
    // One throttle sleep between the two users (not before the first).
    expect(sleeps).toEqual([40]);
  });
});
