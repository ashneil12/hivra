import { CLAUDE_PLAN_FACTS } from "../claude-plan-facts";
import {
  FIT_LABELS,
  PLAN_DEFAULTS,
  PRO_HIT_OPTIONS,
  apiCostPerActiveHour,
  computePlanResult,
  formatUsd,
  type PlanInput,
  type ProHit,
} from "../claude-plan-calc";
import { getToolEntry } from "../tool-catalog";
import { findBannedClaims } from "../copy-rules";

const F = CLAUDE_PLAN_FACTS;

describe("the estimate is held to Anthropic's own cost figures", () => {
  it("puts a normal three-hour Sonnet day within 5% of Anthropic's $13 average", () => {
    const day = apiCostPerActiveHour("sonnet", false) * 3;
    expect(Math.abs(day - F.anthropicCost.perActiveDayUsd) / F.anthropicCost.perActiveDayUsd).toBeLessThan(0.05);
  });

  it("puts a heavy Opus day above Anthropic's $30 line and a heavy Sonnet day below it", () => {
    expect(apiCostPerActiveHour("opus", true) * 3).toBeGreaterThan(F.anthropicCost.p90PerActiveDayUsd);
    expect(apiCostPerActiveHour("sonnet", true) * 3).toBeLessThan(F.anthropicCost.p90PerActiveDayUsd);
  });

  it("prices Opus above Sonnet for the same hour, and heavy above normal", () => {
    expect(apiCostPerActiveHour("opus", false)).toBeGreaterThan(apiCostPerActiveHour("sonnet", false));
    expect(apiCostPerActiveHour("sonnet", true)).toBeCloseTo(apiCostPerActiveHour("sonnet", false) * 2, 6);
  });

  it("builds the hour from the published rates: output, cache reads and cache writes", () => {
    const outputM = F.estimate.outputMPerHour.normal;
    const inputM = outputM * F.anthropicCost.inputToOutputRatio;
    const expected =
      outputM * F.api.opus.output +
      inputM * F.estimate.cacheReadShare * F.api.opus.cacheRead +
      inputM * (1 - F.estimate.cacheReadShare) * F.api.opus.cacheWrite5m;
    expect(apiCostPerActiveHour("opus", false)).toBeCloseTo(expected, 10);
  });
});

describe("computePlanResult", () => {
  it("starts at 100% Opus, Claude Code's default model", () => {
    expect(PLAN_DEFAULTS.opusPct).toBe(100);
  });

  it("starts without a Pro reading, so the default rates nothing and still prices the schedule", () => {
    // Anthropic publishes no figure for where Pro stops anyone. The default render
    // is what crawlers and answer engines quote, so it must not rest a verdict on
    // an invented reading.
    expect(PLAN_DEFAULTS.proHit).toBe("unknown");
    const result = computePlanResult(PLAN_DEFAULTS);
    expect(result.planFits.every((plan) => plan.fit === null)).toBe(true);
    expect(result.verdict).toBe(
      "Anthropic does not publish Pro's cap, so tell the calculator where Pro stops you to rate each plan. At API list price this schedule is an estimated $376/month.",
    );
    expect(result.verdict).not.toMatch(/cheapest plan that fits/);
    expect(result.tableLines).toEqual([
      "Pro      $20/mo   Not rated",
      "Max 5x   $100/mo  Not rated",
      "Max 20x  $200/mo  Not rated",
      "API list price, estimated: $376/mo",
    ]);
  });

  it("gives the typical week, Pro stopping about 2 hours in, Max 5x and an estimated $376 a month at API list price", () => {
    const result = computePlanResult({ ...PLAN_DEFAULTS, proHit: "2" });
    expect(result.weeklyHours).toBe(15);
    expect(result.monthlyHours).toBeCloseTo(64.95, 6);
    expect(formatUsd(result.apiCostPerMonth)).toBe("$376");
    expect(formatUsd(result.anthropicAveragePerMonth)).toBe("$281");
    expect(result.verdict).toBe("Max 5x at $100/month is the cheapest plan that fits. The same usage at API list price is an estimated $376/month.");
    expect(result.planFits.map((plan) => plan.fit)).toEqual(["over", "headroom", "headroom"]);
  });

  it("scales the Pro reading by the published per-session multiples only", () => {
    // Pro stops at 1 hour, a 5 hour window: Pro 1h, Max 5x 5h (tight), Max 20x 20h.
    const fits = computePlanResult({ ...PLAN_DEFAULTS, hoursPerDay: 6, proHit: "1" }).planFits;
    expect(fits.map((plan) => plan.fit)).toEqual(["over", "tight", "headroom"]);
    expect(fits[1].detail).toBe("5h of work per window vs the full 5h window estimated");
    expect(fits[0].detail).toBe("5h of work per window vs ~1h estimated");
  });

  it("never prints a cap for Pro when the visitor has not used it", () => {
    const result = computePlanResult({ ...PLAN_DEFAULTS, proHit: "unknown" });
    expect(result.planFits.every((plan) => plan.fit === null)).toBe(true);
    expect(result.verdict).toMatch(/^Anthropic does not publish Pro's cap/);
    expect(result.planFits.map((plan) => plan.detail)).toEqual(["1x Pro's usage per session", "5x Pro's usage per session", "20x Pro's usage per session"]);
  });

  it("says the API is cheaper only when the estimate is below the cheapest plan that fits", () => {
    const light = computePlanResult({ ...PLAN_DEFAULTS, daysPerWeek: 1, hoursPerDay: 1, opusPct: 0, proHit: "never" });
    expect(light.verdict).toBe("Pro at $20/month is the cheapest plan that fits, but at this volume API billing is estimated cheaper: about $19.42/month.");
    const lightOpus = computePlanResult({ ...PLAN_DEFAULTS, daysPerWeek: 1, hoursPerDay: 1, opusPct: 100, proHit: "never" });
    expect(lightOpus.verdict).toMatch(/^Pro at \$20\/month is the cheapest plan that fits\. The same usage at API list price is an estimated \$25\.09\/month\.$/);
  });

  it("adds the weekly note when Pro's weekly limit has stopped the visitor, and only then", () => {
    const base = computePlanResult(PLAN_DEFAULTS).verdict;
    const weekly = computePlanResult({ ...PLAN_DEFAULTS, proWeekly: "yes" }).verdict;
    expect(weekly.startsWith(base)).toBe(true);
    expect(weekly).toMatch(/publishes no weekly multiple/);
    expect(weekly).not.toMatch(/\b2x\b/);
    expect(base).not.toMatch(/weekly/);
  });

  it("names Anthropic's documented ways past a limit when no plan covers the sessions", () => {
    // No Pro reading on the page can trigger this (Max 20x always covers a whole
    // five-hour window), so it is reached with a reading shorter than any option.
    const result = computePlanResult({ ...PLAN_DEFAULTS, proHit: "0.1" as ProHit });
    expect(result.verdict).toMatch(/usage credits billed at API rates, a Claude Console account for API-billed work, or waiting for the reset/);
    expect(findBannedClaims(result.verdict)).toEqual([]);
  });

  it("keeps out-of-range inputs inside the tool's ranges", () => {
    const wild = computePlanResult({ ...PLAN_DEFAULTS, daysPerWeek: 99, hoursPerDay: -4, opusPct: 500 });
    expect(wild.weeklyHours).toBe(7);
    // The page's hours slider stops at 12, and days at 7.
    expect(computePlanResult({ ...PLAN_DEFAULTS, hoursPerDay: 99 }).weeklyHours).toBe(PLAN_DEFAULTS.daysPerWeek * 12);
    expect(computePlanResult({ ...PLAN_DEFAULTS, daysPerWeek: 99, hoursPerDay: 99 }).weeklyHours).toBe(7 * 12);
  });

  describe("fit thresholds, as the method text states them", () => {
    // "Headroom at 60% of that capacity or less, tight up to 100%, over beyond it."
    // capacity = the hours into a window where Pro stops you, times the plan's multiple;
    // the busiest window is the day's hours, at most the five-hour window.
    const fit = (input: Partial<PlanInput>, plan: "pro" | "max5x" | "max20x") =>
      computePlanResult({ ...PLAN_DEFAULTS, ...input }).planFits.find((entry) => entry.key === plan)!.fit;

    it("rates 67% of capacity tight, not headroom", () => {
      // Pro capacity 3h, busiest window 2h: ratio 0.67.
      expect(fit({ hoursPerDay: 2, proHit: "3" }, "pro")).toBe("tight");
    });

    it("rates exactly 60% of capacity headroom and exactly 100% tight", () => {
      // Max 5x capacity 5h, busiest window 3h: ratio 0.6.
      expect(fit({ hoursPerDay: 3, proHit: "1" }, "max5x")).toBe("headroom");
      // Max 5x capacity 5h, busiest window 5h: ratio 1.
      expect(fit({ hoursPerDay: 5, proHit: "1" }, "max5x")).toBe("tight");
    });

    it("rates 120% of capacity over, not tight", () => {
      // Max 5x capacity 2.5h, busiest window 3h: ratio 1.2.
      expect(fit({ hoursPerDay: 3, proHit: "0.5" }, "max5x")).toBe("over");
    });

    it("never counts more than one five-hour window of work, however long the day", () => {
      // A 12 hour day is still a 5 hour busiest window: Max 5x capacity 10h, ratio 0.5.
      expect(fit({ hoursPerDay: 12, proHit: "2" }, "max5x")).toBe("headroom");
    });
  });

  it("prints dollar amounts of $1,000 or more with a thousands comma", () => {
    expect(formatUsd(1506.4)).toBe("$1,506");
    expect(formatUsd(999.4)).toBe("$999");
    expect(formatUsd(100)).toBe("$100");
    expect(formatUsd(7.789)).toBe("$7.79");
    const heaviest = computePlanResult({ ...PLAN_DEFAULTS, daysPerWeek: 7, hoursPerDay: 12, opusPct: 100, heavyUse: true, proHit: "never" });
    expect(heaviest.apiCostPerMonth).toBeGreaterThan(1000);
    expect(heaviest.verdict).toMatch(/\$\d,\d{3}\/month/);
  });

  it("offers the Pro readings the page shows, with 'unknown' first because it is the default", () => {
    expect(PRO_HIT_OPTIONS.map((option) => option.value)).toEqual(["unknown", "0.5", "1", "2", "3", "4", "never"]);
    expect(PRO_HIT_OPTIONS[0].value).toBe(PLAN_DEFAULTS.proHit);
  });
});

// The worked examples on the page are printed text. Each must equal what the
// calculator prints for the same inputs, so a change to a rate, a multiple or a
// rule fails here instead of leaving a stale example live.
describe("the worked examples on /tools/claude-code-plan-calculator", () => {
  // "100% Sonnet 5.5" when no work is on Opus, otherwise the Opus share.
  const mix = (opusPct: number): string =>
    opusPct === 0 ? `100% ${F.api.sonnet.label}` : `${opusPct}% ${F.api.opus.label}`;
  const describeInput = (input: PlanInput): string => {
    const days = `${input.daysPerWeek} ${input.daysPerWeek === 1 ? "day" : "days"} a week`;
    const hours = `${input.hoursPerDay} ${input.hoursPerDay === 1 ? "hour" : "hours"} a day`;
    const hit: Record<string, string> = {
      "0.5": "Pro stops you about 30 minutes in",
      "1": "Pro stops you about 1 hour in",
      "2": "Pro stops you about 2 hours in",
      "never": "Pro never stops you",
    };
    const weekly = input.proWeekly === "yes" ? "Pro's weekly limit stops you" : "weekly limit not hit";
    return `${days}, ${hours}, ${mix(input.opusPct)}, ${input.heavyUse ? "heavy use" : "normal use"}, ${hit[input.proHit]}, ${weekly}`;
  };

  const EXPECTED: Array<{ input: PlanInput; verdictPlan: string; mentionsApi: boolean }> = [
    { input: { ...PLAN_DEFAULTS, proHit: "2" }, verdictPlan: "Max 5x", mentionsApi: true },
    { input: { ...PLAN_DEFAULTS, daysPerWeek: 1, hoursPerDay: 1, opusPct: 0, proHit: "never" }, verdictPlan: "Pro", mentionsApi: true },
    { input: { ...PLAN_DEFAULTS, daysPerWeek: 4, hoursPerDay: 6, opusPct: 50, proHit: "1", proWeekly: "yes" }, verdictPlan: "Max 5x", mentionsApi: false },
    { input: { ...PLAN_DEFAULTS, daysPerWeek: 5, hoursPerDay: 5, opusPct: 100, proHit: "0.5" }, verdictPlan: "Max 20x", mentionsApi: true },
  ];

  const examples = getToolEntry("claude-code-plan-calculator")!.examples!;

  it("has one example per case below", () => {
    expect(examples).toHaveLength(EXPECTED.length);
  });

  it.each(EXPECTED.map((expected, index) => [index, expected] as const))("example %i prints exactly what the calculator prints", (index, expected) => {
    const example = examples[index];
    const result = computePlanResult(expected.input);
    expect(example.command).toBe(result.tableLines.join("\n"));
    expect(example.inputs).toBe(describeInput(expected.input));
    expect(result.verdict.startsWith(`${expected.verdictPlan} at `)).toBe(true);
    expect(example.result).toContain(expected.verdictPlan === "Pro" ? "Pro covers you" : expected.verdictPlan);
    if (expected.mentionsApi) expect(example.result).toContain(`${formatUsd(result.apiCostPerMonth)} a month`);
    for (const fit of Object.values(FIT_LABELS)) expect(typeof fit).toBe("string");
  });

  it("says the third example is tight and the weekly limit is not rated", () => {
    expect(examples[2].result).toMatch(/rated tight/);
    expect(examples[2].result).toMatch(/publishes no weekly multiple/);
  });
});
