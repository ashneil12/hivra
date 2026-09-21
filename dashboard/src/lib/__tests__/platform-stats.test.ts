import { getPlatformStats } from "@/lib/platform-stats";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: jest.fn() } }));

describe("getPlatformStats", () => {
  const rpc = supabaseAdmin!.rpc as jest.Mock;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("normalizes the rpc payload (coerces numbers, shapes dicts, drops malformed rows)", async () => {
    rpc.mockResolvedValue({
      data: {
        generatedAt: "2026-05-23T00:00:00.000Z",
        rangeDays: 30,
        latest: {
          stat_date: "2026-05-23",
          total_agents_deployed: "5",
          tokens_total: 100,
          model_distribution: { claude: { requests: "3", tokens: "90" } },
          tier_distribution: { command: 1 },
          agent_sessions: null,
          api_calls: 7,
        },
        series: [
          { stat_date: "2026-05-22", new_agents: 1, tokens_total: 50 },
          { not_a_day: true },
        ],
        liveTotals: {
          total_agents_deployed: "5",
          active_agents: 3,
          live_instances: 3,
          total_users: 2,
        },
      },
      error: null,
    });

    const stats = await getPlatformStats(30);

    expect(stats.rangeDays).toBe(30);
    expect(stats.liveTotals.total_agents_deployed).toBe(5);
    expect(stats.latest?.total_agents_deployed).toBe(5);
    expect(stats.latest?.model_distribution.claude).toEqual({ requests: 3, tokens: 90 });
    expect(stats.latest?.tier_distribution.command).toBe(1);
    expect(stats.latest?.agent_sessions).toBeNull();
    expect(stats.latest?.api_calls).toBe(7);
    // the malformed series row (no stat_date) is dropped
    expect(stats.series).toHaveLength(1);
    expect(stats.series[0].stat_date).toBe("2026-05-22");
    expect(stats.series[0].new_agents).toBe(1);
  });

  it("returns empty stats on rpc error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const stats = await getPlatformStats(7);

    expect(stats.series).toEqual([]);
    expect(stats.latest).toBeNull();
    expect(stats.rangeDays).toBe(7);
  });

  it("clamps the days argument into [1, 365]", async () => {
    rpc.mockResolvedValue({ data: { series: [], liveTotals: {} }, error: null });

    await getPlatformStats(9999);

    expect(rpc).toHaveBeenCalledWith("get_platform_stats", { p_days: 365 });
  });
});
