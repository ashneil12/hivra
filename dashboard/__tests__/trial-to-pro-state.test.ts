import { accountState, trialLengthOk } from "../e2e/trial-to-pro/state";
import { assertTestKey } from "../e2e/trial-to-pro/stripe";

const base = { plan: "operator", status: "active", stripe_subscription_id: "sub_1" };

describe("trial-to-Pro journey states", () => {
  it("reads the trial, Pro and anything else from the subscription row", () => {
    expect(accountState(null)).toBe("none");
    expect(accountState({ ...base, instance_limit: 1, total_cpu_budget: 1, total_ram_budget: 2048, trial_ends_at: "2026-11-26T00:00:00Z" })).toBe("trial");
    expect(accountState({ ...base, instance_limit: 3, total_cpu_budget: 2, total_ram_budget: 4096, trial_ends_at: null })).toBe("pro");
    // Full pool still carrying a trial end, or a trial pool without one, is neither.
    expect(accountState({ ...base, instance_limit: 3, total_cpu_budget: 2, total_ram_budget: 4096, trial_ends_at: "2026-11-26T00:00:00Z" })).toBe("other");
    expect(accountState({ ...base, instance_limit: 1, total_cpu_budget: 1, total_ram_budget: 2048, trial_ends_at: null })).toBe("other");
    // A plan granted without Stripe (the launch sweep's shortcut) is not a paid trial or Pro.
    expect(accountState({ ...base, stripe_subscription_id: null, instance_limit: 3, total_cpu_budget: 2, total_ram_budget: 4096 })).toBe("other");
  });

  it("checks the trial is 7 days long", () => {
    const start = new Date("2026-11-19T12:00:00Z");
    expect(trialLengthOk("2026-11-26T12:00:00Z", start)).toBe(true);
    expect(trialLengthOk("2026-11-20T12:00:00Z", start)).toBe(false);
  });

  it("refuses a live Stripe key", () => {
    expect(() => assertTestKey("sk_live_abc")).toThrow(/live key is refused/);
    expect(() => assertTestKey("sk_test_abc")).not.toThrow();
  });
});
