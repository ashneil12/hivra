import {
  PLANS,
  WORKSPACE_CLOUD_PLANS,
  DEFAULT_WORKSPACE_CLOUD_PLAN_KEY,
  getWorkspaceCloudPlan,
  hasDedicatedWorkspaceCloudPrice,
} from "@/lib/subscription/plans";

describe("workspace cloud plans", () => {
  it("mirrors the Hivra Pro/Power compute specs", () => {
    // Lane plans are deliberately the same compute as the Hivra tiers, just
    // separately named/keyed so records stay distinguishable.
    expect(WORKSPACE_CLOUD_PLANS.ws_cloud_pro.totalCpu).toBe(PLANS.operator.totalCpu);
    expect(WORKSPACE_CLOUD_PLANS.ws_cloud_pro.totalRam).toBe(PLANS.operator.totalRam);
    expect(WORKSPACE_CLOUD_PLANS.ws_cloud_power.totalCpu).toBe(PLANS.fleet.totalCpu);
    expect(WORKSPACE_CLOUD_PLANS.ws_cloud_power.totalRam).toBe(PLANS.fleet.totalRam);
  });

  it("keeps lane plans out of the Hivra catalog", () => {
    expect(PLANS).not.toHaveProperty("ws_cloud_pro");
    expect(PLANS).not.toHaveProperty("ws_cloud_power");
  });

  it("defaults to the entry (Pro) lane plan and falls back for unknown keys", () => {
    expect(DEFAULT_WORKSPACE_CLOUD_PLAN_KEY).toBe("ws_cloud_pro");
    expect(getWorkspaceCloudPlan().key).toBe("ws_cloud_pro");
    expect(getWorkspaceCloudPlan("ws_cloud_power").key).toBe("ws_cloud_power");
    expect(getWorkspaceCloudPlan("nonsense").key).toBe("ws_cloud_pro");
  });

  describe("hasDedicatedWorkspaceCloudPrice", () => {
    const ENV_KEYS = [
      "WORKSPACE_CLOUD_PRO_PRICE_ID",
      "WORKSPACE_CLOUD_PRO_YEARLY_PRICE_ID",
      "WORKSPACE_CLOUD_POWER_PRICE_ID",
      "WORKSPACE_CLOUD_POWER_YEARLY_PRICE_ID",
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of ENV_KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    });
    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it("is false when only the shared Hivra fallback price is available", () => {
      // Guards F185: a "Workspace Cloud" sub must not silently bill on the Hivra
      // operator/fleet price when no dedicated lane price env is set.
      expect(hasDedicatedWorkspaceCloudPrice("ws_cloud_pro", "monthly")).toBe(false);
      expect(hasDedicatedWorkspaceCloudPrice("ws_cloud_pro", "yearly")).toBe(false);
      expect(hasDedicatedWorkspaceCloudPrice("ws_cloud_power", "monthly")).toBe(false);
      expect(hasDedicatedWorkspaceCloudPrice("ws_cloud_power", "yearly")).toBe(false);
    });

    it("is true once the dedicated lane price env is set for that cadence", () => {
      process.env.WORKSPACE_CLOUD_PRO_PRICE_ID = "price_ws_pro_monthly";
      process.env.WORKSPACE_CLOUD_POWER_YEARLY_PRICE_ID = "price_ws_power_yearly";
      expect(hasDedicatedWorkspaceCloudPrice("ws_cloud_pro", "monthly")).toBe(true);
      expect(hasDedicatedWorkspaceCloudPrice("ws_cloud_pro", "yearly")).toBe(false);
      expect(hasDedicatedWorkspaceCloudPrice("ws_cloud_power", "monthly")).toBe(false);
      expect(hasDedicatedWorkspaceCloudPrice("ws_cloud_power", "yearly")).toBe(true);
    });
  });
});
