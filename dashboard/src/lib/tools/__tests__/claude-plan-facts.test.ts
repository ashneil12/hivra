import {
  CLAUDE_PLAN_CHANGELOG,
  CLAUDE_PLAN_FACTS,
  OFFICIAL_SOURCE_HOSTS,
  breakEvenDays,
  formatDays,
  usd,
} from "../claude-plan-facts";

// The Claude plan facts are read by the plan calculator, its catalog copy, the
// limit-reset tool and /blog/claude-max-vs-pro-for-claude-code. Every value is
// pinned to a literal here, so changing one in claude-plan-facts.ts fails this
// test until the pin moves with it. Move a pin only after re-reading the
// Anthropic page in `sources` and updating lastVerified.

const F = CLAUDE_PLAN_FACTS;
const TODAY = "2026-09-30";

describe("Claude plan facts, pinned to what Anthropic's pages said on 2026-09-30", () => {
  it("carries the verification date", () => {
    expect(F.lastVerified).toBe("2026-09-30");
    expect(F.windowHours).toBe(5);
  });

  it("pins the individual plan prices and the per-session multiples", () => {
    expect(F.plans).toEqual({
      pro: { label: "Pro", priceUsd: 20, annualMonthlyUsd: 17, annualUpfrontUsd: 200, multiplier: 1 },
      max5x: { label: "Max 5x", priceUsd: 100, multiplier: 5 },
      max20x: { label: "Max 20x", priceUsd: 200, multiplier: 20 },
    });
  });

  it("pins the Team and Enterprise seat prices and multiples", () => {
    expect(F.team).toEqual({
      standardMonthlyUsd: 25,
      standardAnnualUsd: 20,
      premiumMonthlyUsd: 125,
      premiumAnnualUsd: 100,
      standardMultiplier: 1.25,
      premiumMultiplier: 6.25,
      minSeats: 2,
      maxSeats: 150,
    });
    expect(F.enterpriseSeatUsd).toBe(20);
  });

  it("pins the API list prices per million tokens and the default model", () => {
    expect(F.api).toEqual({
      fable: { label: "Fable 5.1", input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5 },
      opus: { label: "Opus 5.5", input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5 },
      sonnet: { label: "Sonnet 5.5", input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5 },
      haiku: { label: "Haiku 4.5", input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25 },
    });
    expect(F.defaultModel).toEqual({ label: "Opus 5.5", since: "2026-09-22" });
    // Anthropic's cache-read multiples: 0.05x on Opus 5.5, 0.1x on Sonnet 5.5 is
    // not what the table shows, so the prices are the authority, not a multiple.
    expect(F.api.opus.cacheWrite5m / F.api.opus.input).toBe(1.25);
    expect(F.api.sonnet.cacheWrite5m / F.api.sonnet.input).toBe(1.25);
  });

  it("pins Anthropic's own cost figures and the dates of its limit changes", () => {
    expect(F.anthropicCost).toEqual({
      perActiveDayUsd: 13,
      p90PerActiveDayUsd: 30,
      perMonthLowUsd: 150,
      perMonthHighUsd: 250,
      inputToOutputRatio: 324,
      inputToOutputRatioBefore: 189,
    });
    expect(F.limitChanges).toEqual({
      fiveHourDoubled: "2026-05-06",
      weeklyPromotionStart: "2026-05-13",
      weeklyPromotionEnd: "2026-09-13",
      weeklyChanged: "2026-09-14",
      fiveHourRaised: "2026-09-22",
    });
  });

  it("keeps Hivra's own estimate apart from Anthropic's figures, and pinned", () => {
    expect(F.estimate).toEqual({
      outputMPerHour: { normal: 0.05, heavy: 0.1 },
      cacheReadShare: 0.98,
      weeksPerMonth: 4.33,
    });
  });

  it("formats prices and break-even days the way the pages print them", () => {
    expect(usd(20)).toBe("$20");
    expect(usd(0.2)).toBe("$0.20");
    expect(usd(12.5)).toBe("$12.50");
    expect(formatDays(breakEvenDays(F.plans.pro.priceUsd, F.anthropicCost.perActiveDayUsd))).toBe("1.5");
    expect(formatDays(breakEvenDays(F.plans.max5x.priceUsd, F.anthropicCost.perActiveDayUsd))).toBe("7.7");
    expect(formatDays(breakEvenDays(F.plans.max20x.priceUsd, F.anthropicCost.perActiveDayUsd))).toBe("15.4");
    expect(formatDays(breakEvenDays(F.plans.max5x.priceUsd, F.anthropicCost.p90PerActiveDayUsd))).toBe("3.3");
  });
});

describe("every source", () => {
  const sources = Object.values(F.sources);

  it("is an https page on an official Anthropic host with a label", () => {
    for (const source of sources) {
      const url = new URL(source.url);
      expect({ url: source.url, https: url.protocol }).toEqual({ url: source.url, https: "https:" });
      expect({ url: source.url, official: (OFFICIAL_SOURCE_HOSTS as readonly string[]).includes(url.hostname) }).toEqual({
        url: source.url,
        official: true,
      });
      expect(source.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("is unique and never a post on X", () => {
    const urls = sources.map((source) => source.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.join("\n")).not.toMatch(/x\.com|twitter\.com/);
  });
});

describe("the plan changelog", () => {
  it("has a real ISO date, a source Anthropic owns and plain text on every row", () => {
    const knownSources = new Set(Object.values(F.sources).map((source) => source.url));
    expect(CLAUDE_PLAN_CHANGELOG.length).toBeGreaterThanOrEqual(10);
    for (const row of CLAUDE_PLAN_CHANGELOG) {
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(row.date))).toBe(false);
      expect(row.date <= TODAY).toBe(true);
      expect(row.date <= F.lastVerified).toBe(true);
      expect(row.text.trim().length).toBeGreaterThan(10);
      expect(row.text).not.toMatch(/[–—]/);
      expect(row.source.url).toMatch(/^https:\/\//);
      expect(knownSources.has(row.source.url)).toBe(true);
      expect((OFFICIAL_SOURCE_HOSTS as readonly string[]).includes(new URL(row.source.url).hostname)).toBe(true);
      expect(row.source.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("is newest first", () => {
    const dates = CLAUDE_PLAN_CHANGELOG.map((row) => row.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("holds no row that rests on news, a forum or a post on X", () => {
    for (const row of CLAUDE_PLAN_CHANGELOG) {
      expect(row.text).not.toMatch(/\b(?:reported|reportedly|rumou?r|community|estimated)\b/i);
      expect(row.source.url).not.toMatch(/x\.com|twitter\.com|reddit|bleepingcomputer|techcrunch/i);
    }
  });

  it("carries every limit change date the calculator states, on the page that states it", () => {
    const row = (date: string, sourceUrl: string) =>
      CLAUDE_PLAN_CHANGELOG.some((entry) => entry.date === date && entry.source.url === sourceUrl);
    expect(row(F.limitChanges.fiveHourDoubled, F.sources.spacex.url)).toBe(true);
    expect(row(F.limitChanges.weeklyPromotionStart, F.sources.weeklyPromotion.url)).toBe(true);
    expect(row(F.limitChanges.weeklyChanged, F.sources.weeklyPromotion.url)).toBe(true);
    expect(row(F.limitChanges.fiveHourRaised, F.sources.opus55.url)).toBe(true);
    expect(row(F.defaultModel.since, F.sources.changelog.url)).toBe(true);
  });

  it("states the prices that are also pinned above", () => {
    const text = CLAUDE_PLAN_CHANGELOG.map((row) => row.text).join("\n");
    expect(text).toContain(`Max launched at ${usd(F.plans.max5x.priceUsd)} a month`);
    expect(text).toContain(`${usd(F.plans.max20x.priceUsd)} a month for 20x`);
    expect(text).toContain(`Opus 5.5 launched at ${usd(F.api.opus.input)} and ${usd(F.api.opus.output)} per million tokens`);
    expect(text).toContain(`Sonnet 5.5 launched at ${usd(F.api.sonnet.input)} and ${usd(F.api.sonnet.output)} per million tokens`);
    expect(text).toContain(`${usd(F.team.standardAnnualUsd)} a month on the annual plan or ${usd(F.team.standardMonthlyUsd)} a month on the monthly plan for a Standard seat`);
    expect(text).toContain(`${usd(F.team.premiumAnnualUsd)} a month on the annual plan or ${usd(F.team.premiumMonthlyUsd)} a month on the monthly plan for a Premium seat`);
  });
});
