import { LARGER_PLAN_SIZE, PLAN_DISPLAY } from "@/lib/blog/plan-facts";
import { PLANS } from "@/lib/subscription";
import { findBannedClaims } from "@/lib/tools/copy-rules";

import { PLAN_FEATURES, planLabel, planSizeLine } from "../plan-card-copy";

const DASH = /[\u2013\u2014]/;

describe("plan card copy", () => {
  it("names the two hosted plans by what they are, never by their billing names", () => {
    expect(planLabel("operator", PLANS.operator.name)).toBe(PLAN_DISPLAY.entry);
    expect(planLabel("fleet", PLANS.fleet.name)).toBe(PLAN_DISPLAY.larger);
    // Free has no hosted size, so it keeps its own name.
    expect(planLabel("free", PLANS.free.name)).toBe("Free");
    expect(planSizeLine("free")).toBeNull();
    expect(planSizeLine("fleet")).toBe(LARGER_PLAN_SIZE);
  });

  it("drops the perks that are not shipped from the larger card", () => {
    const larger = PLAN_FEATURES.fleet ?? [];
    expect(larger.length).toBeGreaterThan(0);
    for (const bullet of larger) {
      expect(bullet).not.toMatch(/marketplace|email support|48 hr/i);
    }
    expect(larger).toEqual([
      `Everything in ${PLAN_DISPLAY.entry}`,
      `Twice the CPU and memory: ${LARGER_PLAN_SIZE}`,
      "Burst CPU when capacity allows",
      "Priority scheduling",
    ]);
  });

  it("says twice only while the larger size really is twice the entry size", () => {
    expect(PLANS.fleet.totalCpu).toBe(PLANS.operator.totalCpu * 2);
    expect(PLANS.fleet.totalRam).toBe(PLANS.operator.totalRam * 2);
  });

  it("keeps the approved stays-on sentence on the entry card and promises nothing about AI usage", () => {
    const entry = PLAN_FEATURES.operator ?? [];
    expect(entry).toContain("A paid Hivra Cloud computer stays on and is not paused for inactivity.");
    expect(entry.join(" ")).not.toMatch(/always-on|never paused|includes? (?:AI|model) usage/i);
  });

  it.each(Object.entries(PLAN_FEATURES))("%s: writes every bullet without dashes, plan names or banned claims", (_key, bullets) => {
    for (const bullet of bullets ?? []) {
      expect(bullet).not.toMatch(DASH);
      expect(bullet).not.toMatch(/\b(?:Pro|Power|Command|Starter)\b/);
      expect(findBannedClaims(bullet)).toEqual([]);
    }
  });
});
