/** Tier-spec resolution regression tests.
 *
 * Catches drift between subscription/plans.ts (Stripe-facing) and
 * tier-specs.ts (warden + provisioning-facing). The two MUST agree on
 * CPU/RAM caps for paid plans — a mismatch would cause warden to gate at
 * one limit while the dashboard sells another.
 */

import {
  resolveTierSpec,
  tierFromPlanKey,
  isPaidTier,
  applyComputeBoost,
  resolveEffectiveTierSpec,
  VENICE_BOOST_CPU,
  VENICE_BOOST_RAM_MB,
} from "../tier-specs";
import { PLANS } from "@/lib/subscription";

describe("tier-specs", () => {
  describe("resolveTierSpec", () => {
    it("free / sandbox is half a vCPU + 1GB", () => {
      const spec = resolveTierSpec("credit_base");
      expect(spec.cpuLimit).toBe(0.5);
      expect(spec.ramLimitMb).toBe(1024);
    });

    it("$HERMES holder (token_base) matches the base free shape — 0.5 vCPU + 1GB", () => {
      const spec = resolveTierSpec("token_base");
      expect(spec.cpuLimit).toBe(0.5);
      expect(spec.ramLimitMb).toBe(1024);
    });

    it("operator/fleet/command tiers mirror the PLANS object — no drift", () => {
      // Regression: a price/spec change in subscription/plans.ts must
      // propagate to tier-specs without any manual sync. If this drifts,
      // a Stripe-paying user sees one cap on the pricing page and another
      // when warden gates them.
      expect(resolveTierSpec("operator").cpuLimit).toBe(PLANS.operator.maxCpuPerAgent);
      expect(resolveTierSpec("operator").ramLimitMb).toBe(PLANS.operator.maxRamPerAgent);
      expect(resolveTierSpec("fleet").cpuLimit).toBe(PLANS.fleet.maxCpuPerAgent);
      expect(resolveTierSpec("fleet").ramLimitMb).toBe(PLANS.fleet.maxRamPerAgent);
      expect(resolveTierSpec("command").cpuLimit).toBe(PLANS.command.maxCpuPerAgent);
      expect(resolveTierSpec("command").ramLimitMb).toBe(PLANS.command.maxRamPerAgent);
    });

    it("keeps the production Command tier at the upstream-safe capacity", () => {
      expect(PLANS.command.maxCpuPerAgent).toBe(8);
      expect(PLANS.command.maxRamPerAgent).toBe(16384);
      expect(PLANS.command.totalCpu).toBe(8);
      expect(PLANS.command.totalRam).toBe(16384);
    });

    it("unknown tier silently falls back to credit_base instead of crashing", () => {
      // Important: a typo in a webhook payload or a new tier name we
      // haven't added shouldn't cause a 500 on the upgrade flow — it
      // should land the user in the safest (free) tier and log loudly.
      const spec = resolveTierSpec("never_heard_of_this_tier");
      expect(spec.cpuLimit).toBe(0.5);
      expect(spec.ramLimitMb).toBe(1024);
    });
  });

  describe("tierFromPlanKey", () => {
    it("each Stripe plan key maps to its same-name tier key", () => {
      // Regression: if PLANS gains "enterprise" but tierFromPlanKey
      // doesn't know about it, every enterprise upgrade silently falls
      // back to credit_base — a paying user gets free-tier compute.
      // The map must stay in sync.
      expect(tierFromPlanKey("operator")).toBe("operator");
      expect(tierFromPlanKey("fleet")).toBe("fleet");
      expect(tierFromPlanKey("command")).toBe("command");
    });

    it("unknown plan key falls back to credit_base instead of crashing", () => {
      expect(tierFromPlanKey("legacy_plan_we_killed")).toBe("credit_base");
    });
  });

  describe("Venice compute boost", () => {
    it("only paid tiers (operator/fleet/command) are boost-eligible", () => {
      expect(isPaidTier("operator")).toBe(true);
      expect(isPaidTier("fleet")).toBe(true);
      expect(isPaidTier("command")).toBe(true);
      expect(isPaidTier("token_base")).toBe(false);
      expect(isPaidTier("credit_base")).toBe(false);
      expect(isPaidTier("nonsense")).toBe(false);
    });

    it("applyComputeBoost adds +1 vCPU / +2GB only when active", () => {
      const base = resolveTierSpec("operator");
      const boosted = applyComputeBoost(base, true);
      expect(boosted.cpuLimit).toBe(base.cpuLimit + VENICE_BOOST_CPU);
      expect(boosted.ramLimitMb).toBe(base.ramLimitMb + VENICE_BOOST_RAM_MB);
      // Inactive returns the base spec untouched.
      expect(applyComputeBoost(base, false)).toEqual(base);
    });

    it("applyComputeBoost is pure (does not mutate the input spec)", () => {
      const base = resolveTierSpec("fleet");
      const cpuBefore = base.cpuLimit;
      applyComputeBoost(base, true);
      expect(base.cpuLimit).toBe(cpuBefore);
    });

    it("resolveEffectiveTierSpec stacks the boost on a paid tier", () => {
      const eff = resolveEffectiveTierSpec("fleet", true);
      expect(eff.cpuLimit).toBe(PLANS.fleet.maxCpuPerAgent + VENICE_BOOST_CPU);
      expect(eff.ramLimitMb).toBe(PLANS.fleet.maxRamPerAgent + VENICE_BOOST_RAM_MB);
    });

    it("resolveEffectiveTierSpec refuses the boost on a non-paid tier even when eligible", () => {
      // A free/token-base holder who holds VVV still gets no extra compute
      // until they upgrade — the paid gate lives here.
      expect(resolveEffectiveTierSpec("token_base", true)).toEqual(resolveTierSpec("token_base"));
      expect(resolveEffectiveTierSpec("credit_base", true)).toEqual(resolveTierSpec("credit_base"));
    });

    it("resolveEffectiveTierSpec without the boost equals the plain tier spec", () => {
      expect(resolveEffectiveTierSpec("operator", false)).toEqual(resolveTierSpec("operator"));
    });
  });
});
