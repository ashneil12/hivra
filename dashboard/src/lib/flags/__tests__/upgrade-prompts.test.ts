/** @jest-environment jsdom */
import {
  isSleepUpgradePromptEnabled,
  isUsageUpgradeCtaEnabled,
} from "../upgrade-prompts";
import { isFreePlanInfo, type PlanInfo } from "@/lib/hivra/agent-api";

const FREE_PLAN: PlanInfo = {
  subscribed: false,
  name: "Free",
  key: "free",
  maxAgents: 1,
  maxCpuPerAgent: 0.5,
  maxRamPerAgent: 1,
  poolCpu: 0.5,
  poolRam: 1,
};
const PRO_PLAN: PlanInfo = { ...FREE_PLAN, subscribed: true, name: "Pro", key: "operator" };

// Snapshot + restore the env vars this suite mutates so it can't bleed into
// other tests under --runInBand.
const ENV_KEYS = [
  "NEXT_PUBLIC_HERMES_SLEEP_UPGRADE_PROMPT_ENABLED",
  "NEXT_PUBLIC_HERMES_USAGE_UPGRADE_CTA_ENABLED",
  "NEXT_PUBLIC_HERMES_UPSELL_PREVIEW",
] as const;
const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) original[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  window.history.replaceState({}, "", "/dashboard");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe("upgrade-prompt flags", () => {
  it("both default OFF when the env vars are unset", () => {
    expect(isSleepUpgradePromptEnabled()).toBe(false);
    expect(isUsageUpgradeCtaEnabled()).toBe(false);
  });

  it("turns ON when the build-env flag is '1', 'true', or 'on'", () => {
    for (const truthy of ["1", "true", "on", "TRUE", " On "]) {
      process.env.NEXT_PUBLIC_HERMES_SLEEP_UPGRADE_PROMPT_ENABLED = truthy;
      process.env.NEXT_PUBLIC_HERMES_USAGE_UPGRADE_CTA_ENABLED = truthy;
      expect(isSleepUpgradePromptEnabled()).toBe(true);
      expect(isUsageUpgradeCtaEnabled()).toBe(true);
    }
  });

  it("stays OFF for a non-truthy env value", () => {
    process.env.NEXT_PUBLIC_HERMES_SLEEP_UPGRADE_PROMPT_ENABLED = "0";
    process.env.NEXT_PUBLIC_HERMES_USAGE_UPGRADE_CTA_ENABLED = "no";
    expect(isSleepUpgradePromptEnabled()).toBe(false);
    expect(isUsageUpgradeCtaEnabled()).toBe(false);
  });

  it("IGNORES ?upsellPreview=1 when the hatch var is unset (fail-closed: prod leaves it unset)", () => {
    window.history.replaceState({}, "", "/dashboard/usage?upsellPreview=1");
    expect(isSleepUpgradePromptEnabled()).toBe(false);
    expect(isUsageUpgradeCtaEnabled()).toBe(false);
  });

  it("honors ?upsellPreview=1 only when NEXT_PUBLIC_HERMES_UPSELL_PREVIEW opts the build in", () => {
    process.env.NEXT_PUBLIC_HERMES_UPSELL_PREVIEW = "1";
    window.history.replaceState({}, "", "/dashboard/usage?upsellPreview=1");
    expect(isSleepUpgradePromptEnabled()).toBe(true);
    expect(isUsageUpgradeCtaEnabled()).toBe(true);
  });

  it("hatch var alone does nothing without the URL param", () => {
    process.env.NEXT_PUBLIC_HERMES_UPSELL_PREVIEW = "1";
    window.history.replaceState({}, "", "/dashboard/usage");
    expect(isSleepUpgradePromptEnabled()).toBe(false);
    expect(isUsageUpgradeCtaEnabled()).toBe(false);
  });

  it("IGNORES ?upsellPreview=1 for a non-truthy hatch value", () => {
    process.env.NEXT_PUBLIC_HERMES_UPSELL_PREVIEW = "0";
    window.history.replaceState({}, "", "/dashboard/usage?upsellPreview=1");
    expect(isSleepUpgradePromptEnabled()).toBe(false);
    expect(isUsageUpgradeCtaEnabled()).toBe(false);
  });
});

// The exact boolean each surface gates its render on. Proves the truth table the
// task requires: renders for free, ABSENT for paid, and no prompt when the flag
// is off — for both Moment #1 (sleep banner) and Moment #2 (usage footer).
describe("upgrade-prompt gating truth table", () => {
  it("shows ONLY when the flag is on AND the plan is confirmed free", () => {
    process.env.NEXT_PUBLIC_HERMES_SLEEP_UPGRADE_PROMPT_ENABLED = "1";
    process.env.NEXT_PUBLIC_HERMES_USAGE_UPGRADE_CTA_ENABLED = "1";

    // free + flag on → show
    expect(isSleepUpgradePromptEnabled() && isFreePlanInfo(FREE_PLAN)).toBe(true);
    expect(isUsageUpgradeCtaEnabled() && isFreePlanInfo(FREE_PLAN)).toBe(true);

    // paid + flag on → NEVER
    expect(isSleepUpgradePromptEnabled() && isFreePlanInfo(PRO_PLAN)).toBe(false);
    expect(isUsageUpgradeCtaEnabled() && isFreePlanInfo(PRO_PLAN)).toBe(false);

    // plan still loading (null) → don't flash
    expect(isSleepUpgradePromptEnabled() && isFreePlanInfo(null)).toBe(false);
  });

  it("shows nothing when the flag is off, even for a free user", () => {
    delete process.env.NEXT_PUBLIC_HERMES_SLEEP_UPGRADE_PROMPT_ENABLED;
    delete process.env.NEXT_PUBLIC_HERMES_USAGE_UPGRADE_CTA_ENABLED;
    expect(isSleepUpgradePromptEnabled() && isFreePlanInfo(FREE_PLAN)).toBe(false);
    expect(isUsageUpgradeCtaEnabled() && isFreePlanInfo(FREE_PLAN)).toBe(false);
  });
});

describe("isFreePlanInfo", () => {
  it("treats the free row (subscribed:true, key:'free') as free", () => {
    expect(isFreePlanInfo({ ...FREE_PLAN, subscribed: true, key: "free" })).toBe(true);
  });
  it("treats a paid plan as NOT free", () => {
    expect(isFreePlanInfo(PRO_PLAN)).toBe(false);
  });
  it("treats null/undefined (loading) as NOT free", () => {
    expect(isFreePlanInfo(null)).toBe(false);
    expect(isFreePlanInfo(undefined)).toBe(false);
  });
});
