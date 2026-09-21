import { planInstanceBankrBackfill } from "../../scripts/bankr-backfill-plan";

describe("planInstanceBankrBackfill", () => {
  it("provisions instances with no wallet row", () => {
    expect(planInstanceBankrBackfill({ instance: { status: "running" }, wallet: null })).toBe("provision");
  });

  it("retries incomplete wallet rows", () => {
    expect(
      planInstanceBankrBackfill({
        instance: { status: "running" },
        wallet: { status: "pending", metadata: {} },
      })
    ).toBe("retry_provision");
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
