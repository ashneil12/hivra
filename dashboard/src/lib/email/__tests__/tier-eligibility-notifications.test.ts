jest.mock("resend", () => ({ Resend: jest.fn() }));
jest.mock("@clerk/nextjs/server", () => ({ clerkClient: jest.fn() }));
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf",
    decimals: 18,
    poolId: `0x${"cd".repeat(32)}`,
    activatesAt: "2026-01-01T00:00:00Z",
  },
}));

import { buildEmailContent } from "@/lib/email/tier-eligibility-notifications";
import { REQUALIFICATION_GRACE_HOURS } from "@/lib/billing/tier-thresholds";

const ONE = 10n ** 18n;

function evaluation(tokenKey: "hermesos" | "hivra", transition: string) {
  const tier = {
    tier: "pro" as const,
    tokenKey,
    threshold: 1_200n * ONE,
    thresholdCode: "PRO_STANDARD" as const,
    balance: 5n * ONE,
    qualifyingQuantity: 1_000n * ONE,
    qualifyingThresholdTier: "PRO_STANDARD" as const,
    currentlyEligible: false,
    inGrace: false,
    cooldownEndsAt: new Date("2026-10-10T00:00:00Z"),
    transition,
  };
  return { configured: true, warnings: [], pro: tier, power: null } as unknown as Parameters<typeof buildEmailContent>[0]["evaluation"];
}

describe("tier eligibility emails", () => {
  it("name the token the tier is held in", () => {
    const hivra = buildEmailContent({
      userId: "u",
      tier: "pro",
      transition: "breached",
      currentBalance: 5n * ONE,
      evaluation: evaluation("hivra", "breached"),
    })!;
    expect(hivra.subject).toBe("Your $HIVRA balance dropped below your qualifying quantity");
    expect(hivra.text).toContain("5 $HIVRA");
    expect(hivra.text).not.toMatch(/HermesOS|\bHivra\b/);
    // A breach opens the grace; it does not end the tier.
    expect(hivra.text).toContain("24-hour grace period");
    expect(hivra.text).not.toContain("has ended");

    const hermesos = buildEmailContent({
      userId: "u",
      tier: "pro",
      transition: "qualified",
      currentBalance: 5n * ONE,
      evaluation: evaluation("hermesos", "qualified"),
    })!;
    expect(hermesos.text).toContain("5 $HermesOS");
    expect(hermesos.subject).not.toContain("$$");
  });

  it("state the grace period the code enforces", () => {
    const suspended = buildEmailContent({
      userId: "u",
      tier: "pro",
      transition: "suspended",
      currentBalance: 0n,
      evaluation: evaluation("hermesos", "suspended"),
    })!;
    expect(REQUALIFICATION_GRACE_HOURS).toBe(24);
    expect(suspended.text).toContain("the 24-hour grace period has elapsed");
    expect(suspended.text).not.toContain("48-hour");
  });
});
