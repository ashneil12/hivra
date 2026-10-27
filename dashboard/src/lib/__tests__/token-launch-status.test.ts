import { TOKEN_LAUNCH_STATUS, claimLinkAvailable, feeSumPercent } from "@/lib/token-launch-status";

describe("token launch status (prelaunch)", () => {
  it("has no verified launch facts yet", () => {
    expect(TOKEN_LAUNCH_STATUS.launch).toBe("preparing");
    expect(TOKEN_LAUNCH_STATUS.claim).toBe("not_open");
    for (const value of Object.values(TOKEN_LAUNCH_STATUS.verified)) expect(value).toBeNull();
    expect(claimLinkAvailable()).toBe(false);
  });

  it("splits the intended fee into 1.20 + 0.30 + 0.08 = 1.58", () => {
    expect(feeSumPercent()).toBe(1.58);
    expect(TOKEN_LAUNCH_STATUS.fees.totalPercent).toBe(1.58);
    expect(TOKEN_LAUNCH_STATUS.feesVerifiedOnChain).toBe(false);
  });

  it("never shows a claim link unless the claim is open and the URL is verified", () => {
    const base = TOKEN_LAUNCH_STATUS;
    expect(claimLinkAvailable({ ...base, claim: "open" })).toBe(false);
    expect(
      claimLinkAvailable({ ...base, claim: "open", verified: { ...base.verified, sablierClaimUrl: "https://app.sablier.com/x" } }),
    ).toBe(true);
  });

  it("plans no founder allocation and a 90 day claim window with no burn required", () => {
    expect(TOKEN_LAUNCH_STATUS.founderTokenAllocation).toBe(false);
    expect(TOKEN_LAUNCH_STATUS.migration.claimWindowDays).toBe(90);
    expect(TOKEN_LAUNCH_STATUS.migration.burnOrSurrenderRequired).toBe(false);
  });
});
