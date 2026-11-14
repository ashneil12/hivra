jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: jest.fn() } }));
// Stands in for the data cache: a successful result is stored and a thrown error is not.
jest.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => Promise<unknown>) => {
    let stored: { value: unknown } | null = null;
    return async (...args: unknown[]) => {
      if (!stored) stored = { value: await fn(...args) };
      return stored.value;
    };
  },
}));

describe("getPublicStats", () => {
  // A fresh module per test, so the cache starts empty each time.
  let getPublicStats: () => Promise<unknown>;
  let rpc: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    getPublicStats = require("@/lib/public-stats").getPublicStats;
    rpc = require("@/lib/supabase").supabaseAdmin.rpc as jest.Mock;
    rpc.mockReset();
  });

  const payload = {
    generatedAt: "2026-10-20T10:00:00.000Z",
    agentsDeployed: "2517",
    runningNow: 4,
    builders: 3,
    tokensProcessed: 1000,
    tokensAnchorPrev: null,
    tokensAnchorPrevAt: null,
    tokensAnchorCurr: 900,
    tokensAnchorCurrAt: "2026-10-20T10:00:00.000Z",
    countries: 12,
    models: 5,
    providers: 3,
    last7dDeployed: 40,
  };

  it("maps the RPC payload and reads it once inside the window", async () => {
    rpc.mockResolvedValue({ data: payload, error: null });

    const first = await getPublicStats();
    const second = await getPublicStats();

    expect(first).toMatchObject({ agentsDeployed: 2517, runningNow: 4, tokensAnchorCurr: 900 });
    expect(second).toEqual(first);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("get_public_stats");
  });

  it("returns null on a failed read and asks again on the next view", async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: "boom", code: "XX000" } })
      .mockResolvedValueOnce({ data: payload, error: null });

    expect(await getPublicStats()).toBeNull();
    expect(await getPublicStats()).toMatchObject({ agentsDeployed: 2517 });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
