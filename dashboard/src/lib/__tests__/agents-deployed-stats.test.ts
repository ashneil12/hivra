import { getAgentsDeployedStats } from "@/lib/agents-deployed-stats";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: jest.fn() } }));
// Stands in for the data cache: a successful result is stored per argument list
// and a thrown error is not, which is the behaviour the stats read relies on.
jest.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => Promise<unknown>) => {
    const memo = new Map<string, unknown>();
    return async (...args: unknown[]) => {
      const key = JSON.stringify(args);
      if (!memo.has(key)) memo.set(key, await fn(...args));
      return memo.get(key);
    };
  },
}));

describe("getAgentsDeployedStats", () => {
  const rpc = supabaseAdmin!.rpc as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("normalizes Hivra source counts returned by the stats RPC", async () => {
    rpc.mockResolvedValue({
      data: {
        total: "12",
        last24h: "3",
        last7d: 5,
        generatedAt: "2026-06-07T05:00:00.000Z",
        sourceCounts: {
          hermesInstances: "7",
          hivraAgents: "4",
          archivedInstances: "1",
        },
      },
      error: null,
    });

    const stats = await getAgentsDeployedStats();

    expect(stats).toMatchObject({
      total: 12,
      last24h: 3,
      last7d: 5,
      sourceCounts: {
        hermesInstances: 7,
        hivraAgents: 4,
        archivedInstances: 1,
      },
    });
    expect(rpc).toHaveBeenCalledWith("get_agents_deployed_stats", {
      p_with_series: false,
      p_with_first_deploy: false,
    });
  });

  describe("cache window", () => {
    // A fresh module per test, so the cache starts empty each time.
    let getStats: typeof getAgentsDeployedStats;
    let freshRpc: jest.Mock;

    beforeEach(() => {
      jest.resetModules();
      getStats = require("@/lib/agents-deployed-stats").getAgentsDeployedStats;
      freshRpc = (require("@/lib/supabase").supabaseAdmin.rpc as jest.Mock);
      freshRpc.mockReset();
    });

    it("reads the RPC once per flag combination inside the window", async () => {
      freshRpc.mockResolvedValue({
        data: { total: 9, last24h: 1, last7d: 2, generatedAt: "2026-10-20T10:00:00.000Z" },
        error: null,
      });

      await getStats({ series: true, firstDeploy: true });
      await getStats({ series: true, firstDeploy: true });
      expect(freshRpc).toHaveBeenCalledTimes(1);

      await getStats();
      expect(freshRpc).toHaveBeenCalledTimes(2);
      expect(freshRpc).toHaveBeenLastCalledWith("get_agents_deployed_stats", {
        p_with_series: false,
        p_with_first_deploy: false,
      });
    });

    it("does not keep a failed read: the next view asks the database again", async () => {
      freshRpc
        .mockResolvedValueOnce({ data: null, error: { message: "boom", code: "XX000" } })
        .mockResolvedValueOnce({
          data: { total: 7, last24h: 1, last7d: 2, generatedAt: "2026-10-20T10:00:00.000Z" },
          error: null,
        });

      const failed = await getStats();
      expect(failed.total).toBe(0);

      const recovered = await getStats();
      expect(recovered.total).toBe(7);
      expect(freshRpc).toHaveBeenCalledTimes(2);
    });
  });
});
