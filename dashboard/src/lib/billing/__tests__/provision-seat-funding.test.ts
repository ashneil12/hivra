import { decideProvisionSeatFunding, provisionSeatCanReceiveBoost } from "@/lib/billing/provision-seat-funding";

describe("decideProvisionSeatFunding", () => {
  it("marks only the admitted token-holding lane as holder-funded", () => {
    expect(decideProvisionSeatFunding({ source: "token_holding" })).toBe("holder");
  });

  it("keeps every non-holder entitlement lane on ordinary paid-seat controls", () => {
    for (const source of ["stripe", "apple_iap", "token_yearly", "workspace_cloud", "free"] as const) {
      expect(decideProvisionSeatFunding({ source })).toBe("paid");
    }
  });

  it.each(["operator", "fleet"])("uses funding as well as the %s plan label for Venice", (plan) => {
    expect(provisionSeatCanReceiveBoost({ source: "token_holding", plan })).toBe(false);
    for (const source of ["stripe", "apple_iap", "token_yearly"] as const) {
      expect(provisionSeatCanReceiveBoost({ source, plan })).toBe(true);
    }
    expect(provisionSeatCanReceiveBoost({ source: "free", plan: "free" })).toBe(false);
  });

  it("fails closed when the server has no entitlement decision", () => {
    expect(decideProvisionSeatFunding(null)).toBeNull();
    expect(decideProvisionSeatFunding(undefined)).toBeNull();
  });
});
