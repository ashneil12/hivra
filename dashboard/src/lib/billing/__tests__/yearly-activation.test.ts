import { applyYearlyPaymentToInstances } from "@/lib/billing/yearly-activation";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { applyTierChange } from "@/lib/services/tier-change-service";
import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";
import { PLANS } from "@/lib/subscription/plans";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: jest.fn(),
}));
jest.mock("@/lib/services/tier-change-service", () => ({
  applyTierChange: jest.fn(),
}));
jest.mock("@/lib/services/stripe-webhook-service", () => ({
  StripeWebhookService: {
    restoreScheduledDeletions: jest.fn(),
    resumeBillingSuspendedInstances: jest.fn(),
  },
}));

const YEARLY_POWER = {
  plan: "fleet",
  status: "active",
  instance_limit: PLANS.fleet.maxAgents,
  total_cpu_budget: PLANS.fleet.totalCpu,
  total_ram_budget: PLANS.fleet.totalRam,
  source: "token_yearly",
  tokenTier: "power",
  currentPeriodEnd: "2027-09-23T00:00:00.000Z",
  canChangePlanInPlace: false,
};

describe("applyYearlyPaymentToInstances", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (applyTierChange as jest.Mock).mockResolvedValue({});
    (StripeWebhookService.restoreScheduledDeletions as jest.Mock).mockResolvedValue(undefined);
    (StripeWebhookService.resumeBillingSuspendedInstances as jest.Mock).mockResolvedValue(undefined);
  });

  it("moves the instances onto the paid tier and resumes billing-suspended ones", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(YEARLY_POWER);

    await applyYearlyPaymentToInstances("user_1", "activated");

    expect(applyTierChange).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1", newTier: "fleet", source: "token_yearly" })
    );
    expect(StripeWebhookService.restoreScheduledDeletions).toHaveBeenCalledWith("user_1");
    expect(StripeWebhookService.resumeBillingSuspendedInstances).toHaveBeenCalledWith("user_1");
  });

  it("changes nothing when no paid entitlement resolves", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(null);

    await applyYearlyPaymentToInstances("user_1", "renewed");

    expect(applyTierChange).not.toHaveBeenCalled();
    expect(StripeWebhookService.resumeBillingSuspendedInstances).not.toHaveBeenCalled();
  });

  it("still resumes suspended instances when the tier change fails", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockResolvedValue(YEARLY_POWER);
    (applyTierChange as jest.Mock).mockRejectedValue(new Error("ssh timeout"));

    await expect(applyYearlyPaymentToInstances("user_1", "activated")).resolves.toBeUndefined();

    expect(StripeWebhookService.resumeBillingSuspendedInstances).toHaveBeenCalledWith("user_1");
  });

  it("never throws into the settlement path", async () => {
    (resolveEffectiveSubscription as jest.Mock).mockRejectedValue(new Error("db down"));

    await expect(applyYearlyPaymentToInstances("user_1", "already_settled")).resolves.toBeUndefined();

    expect(applyTierChange).not.toHaveBeenCalled();
    expect(StripeWebhookService.resumeBillingSuspendedInstances).not.toHaveBeenCalled();
  });
});
