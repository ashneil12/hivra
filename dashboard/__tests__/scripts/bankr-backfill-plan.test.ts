import { planInstanceBankrBackfill } from "../../scripts/bankr-backfill-plan";

describe("planInstanceBankrBackfill", () => {
  // Hivra no longer creates agent wallets; a backfill must never make one a
  // user didn't ask for (new agents connect their own Bankr account).
  it("never provisions a wallet for an instance without one", () => {
    expect(planInstanceBankrBackfill({ instance: { status: "running" }, wallet: null })).toBe("skip");
  });

  it("never retries a pending row, which may date from unrequested eager provisioning", () => {
    expect(
      planInstanceBankrBackfill({
        instance: { status: "running" },
        wallet: { status: "pending", metadata: {} },
      })
    ).toBe("skip");
  });

  it("seeds the Bankr suite for running agents with active unseeded wallets", () => {
    expect(
      planInstanceBankrBackfill({
        instance: { status: "running" },
        wallet: { status: "active", metadata: { bankrSuiteSeeded: false } },
      })
    ).toBe("seed_skills");
  });

  it("skips active wallets that already have the Bankr suite", () => {
    expect(
      planInstanceBankrBackfill({
        instance: { status: "running" },
        wallet: { status: "active", metadata: { bankrSuiteSeeded: true } },
      })
    ).toBe("skip");
  });

  it("does not try to seed stopped agents", () => {
    expect(
      planInstanceBankrBackfill({
        instance: { status: "stopped" },
        wallet: { status: "active", metadata: {} },
      })
    ).toBe("skip");
  });
});
