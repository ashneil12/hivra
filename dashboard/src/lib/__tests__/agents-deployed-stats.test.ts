import { getAgentsDeployedStats } from "@/lib/agents-deployed-stats";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: jest.fn() } }));

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
});
