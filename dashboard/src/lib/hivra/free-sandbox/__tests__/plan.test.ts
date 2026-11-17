import { sandboxTierFor } from "../plan";

jest.mock("@/lib/billing/instance-entitlement", () => ({ resolveEffectiveSubscription: jest.fn() }));

const sub = (over: Record<string, unknown>) => ({
  plan: "x",
  status: "active",
  instance_limit: 1,
  total_cpu_budget: 1,
  total_ram_budget: 1,
  source: "stripe",
  ...over,
});

describe("sandboxTierFor", () => {
  it("reads with throwOnQueryError, and a failed read is unknown (refuse), never free", async () => {
    const resolve = jest.fn().mockRejectedValue(new Error("db down"));
    await expect(sandboxTierFor("u1", resolve)).resolves.toEqual({ tier: "unknown" });
    expect(resolve).toHaveBeenCalledWith("u1", { throwOnQueryError: true });
  });

  it("treats no row and the Free account as the free tier", async () => {
    await expect(sandboxTierFor("u1", jest.fn().mockResolvedValue(null))).resolves.toEqual({ tier: "free" });
    await expect(sandboxTierFor("u1", jest.fn().mockResolvedValue(sub({ plan: "free", source: "free" })))).resolves.toEqual({
      tier: "free",
    });
  });

  it("names the paid plan for an owner who pays for hosted compute, and a trial is not paid", async () => {
    await expect(sandboxTierFor("u1", jest.fn().mockResolvedValue(sub({ status: "trialing" })))).resolves.toEqual({ tier: "free" });
    await expect(sandboxTierFor("u1", jest.fn().mockResolvedValue(sub({ plan: "somePaidPlan" })))).resolves.toEqual({
      tier: "paid",
      plan: "somePaidPlan",
    });
  });
});
