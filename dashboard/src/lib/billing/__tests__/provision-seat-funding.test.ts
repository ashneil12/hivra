import { decideProvisionSeatFunding } from "@/lib/billing/provision-seat-funding";

describe("decideProvisionSeatFunding", () => {
  it("marks only the admitted token-holding lane as holder-funded", () => {
    expect(decideProvisionSeatFunding({ source: "token_holding" })).toBe("holder");
  });

  it("keeps every non-holder entitlement lane on ordinary paid-seat controls", () => {
    for (const source of ["stripe", "apple_iap", "token_yearly", "workspace_cloud", "free"] as const) {
      expect(decideProvisionSeatFunding({ source })).toBe("paid");
    }
  });

  it("fails closed when the server has no entitlement decision", () => {
    expect(decideProvisionSeatFunding(null)).toBeNull();
    expect(decideProvisionSeatFunding(undefined)).toBeNull();
  });
});
