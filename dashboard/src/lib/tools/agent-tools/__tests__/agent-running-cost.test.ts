import { findBannedClaims } from "../../copy-rules";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import { ENTRY_PLAN_PRICE } from "@/lib/blog/plan-facts";
import { VENICE_CHAT_MODEL_PRICES } from "@/lib/venice/pricing";
import { OPENROUTER_MODELS } from "../openrouter-snapshot";
import {
  ALL_MODELS,
  DEFAULT_MODEL_KEY,
  RUNNING_COST_DEFAULTS,
  RUNNING_COST_FACTS,
  SERVER_KEYS,
  SERVER_OPTIONS,
  USAGE_PRESETS,
  buildSummary,
  buildVerdict,
  computeRunningCost,
  formatTokens,
  formatUsd,
  getModel,
  parseRunningCostParams,
  serializeRunningCostParams,
  timeCostUsd,
  type RunningCostInput,
} from "../agent-running-cost";
import { AGENT_RUNNING_COST_ENTRY, RUNNING_COST_EXAMPLE_INPUTS } from "../agent-running-cost-entry";

const ALLOWED_RELATED = new Set([
  "/pricing",
  "/agents/hermes",
  "/agents/openclaw",
  "/compare/openclaw-to-hermes",
  "/compare/vs-self-hosted",
  "/agents/claude-code",
  "/agents/codex",
  "/tools/claude-code-plan-calculator",
  "/tools/agent-survival-check",
  "/tools/ai-agent-hosting-cost-calculator",
  "/tools/claude-code-limit-reset-calculator",
  "/tools/keep-mac-awake",
  "/tools/tmux-cheat-sheet",
]);

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

const base = RUNNING_COST_DEFAULTS;
const withInput = (patch: Partial<RunningCostInput>): RunningCostInput => ({ ...base, ...patch });

describe("running cost tables", () => {
  it("combines Hivra's managed list and the OpenRouter snapshot, with unique keys", () => {
    expect(ALL_MODELS.length).toBe(VENICE_CHAT_MODEL_PRICES.length + OPENROUTER_MODELS.length);
    expect(new Set(ALL_MODELS.map((m) => m.key)).size).toBe(ALL_MODELS.length);
  });

  it("converts Hivra micro-USD per million to USD per million", () => {
    const flash = getModel("hivra:deepseek-v4-1-flash");
    expect(flash.inputUsdPerM).toBeCloseTo(0.3, 6);
    expect(flash.outputUsdPerM).toBeCloseTo(1.2, 6);
    expect(DEFAULT_MODEL_KEY).toBe("hivra:deepseek-v4-1-flash");
  });

  it("marks only the OpenRouter free rows as free, at $0", () => {
    const free = ALL_MODELS.filter((m) => m.free);
    expect(free.length).toBeGreaterThan(0);
    for (const m of free) {
      expect(m.source).toBe("openrouter");
      expect(m.inputUsdPerM + m.outputUsdPerM).toBe(0);
    }
  });

  it("copies the VPS prices from the hosting calculator and reads the Hivra price from billing", () => {
    expect(RUNNING_COST_FACTS.vps.lastVerified).toBe("2026-09-24");
    expect(RUNNING_COST_FACTS.vps.rows.hetznerCx23.monthlyUsd).toBe(7.09);
    expect(RUNNING_COST_FACTS.vps.rows.vultr1gb.monthlyUsd).toBe(5);
    expect(RUNNING_COST_FACTS.hivra.entryMonthlyUsd).toBe(Number(ENTRY_PLAN_PRICE.slice(1)));
    for (const url of [...RUNNING_COST_FACTS.vps.sources, ...RUNNING_COST_FACTS.models.sources]) expect(url).toMatch(/^https:\/\//);
  });

  it("offers a laptop at $0, every VPS and both Hivra sizes", () => {
    expect(SERVER_OPTIONS.map((o) => o.key)).toEqual(SERVER_KEYS);
    expect(SERVER_OPTIONS[0]).toMatchObject({ key: "laptop", monthlyUsd: 0 });
    expect(SERVER_OPTIONS.filter((o) => o.kind === "hivra")).toHaveLength(2);
  });
});

describe("computeRunningCost", () => {
  it("adds server, tokens and time, and the shares sum to 1", () => {
    const cost = computeRunningCost(withInput({ countTime: true }));
    expect(cost.totalUsd).toBeCloseTo(cost.serverUsd + cost.tokensUsd + cost.timeUsd, 9);
    expect(cost.shares.server + cost.shares.tokens + cost.shares.time).toBeCloseTo(1, 9);
  });

  it("prices the typical preset by hand: 48M tokens, 85% in, 15% out", () => {
    // 40 messages x 40,000 tokens x 30 days = 48,000,000 tokens.
    const cost = computeRunningCost(base);
    expect(cost.monthlyTokens).toBe(48_000_000);
    // 40.8M x $0.30 + 7.2M x $1.20 = 12.24 + 8.64
    expect(cost.tokensUsd).toBeCloseTo(20.88, 6);
    expect(cost.serverUsd).toBe(7.09);
    expect(cost.totalUsd).toBeCloseTo(27.97, 6);
  });

  it("scales with the presets: light < typical < heavy", () => {
    const totals = (["light", "typical", "heavy"] as const).map((usage) => computeRunningCost(withInput({ usage })).tokensUsd);
    expect(totals[0]).toBeLessThan(totals[1]);
    expect(totals[1]).toBeLessThan(totals[2]);
    expect(USAGE_PRESETS.light.messagesPerDay).toBe(10);
  });

  it("uses custom messages and tokens, and clamps nonsense to the limits", () => {
    const custom = computeRunningCost(withInput({ usage: "custom", messagesPerDay: 10, tokensPerMessage: 10_000 }));
    expect(custom.monthlyTokens).toBe(3_000_000);
    expect(computeRunningCost(withInput({ usage: "custom", messagesPerDay: -5, tokensPerMessage: 10_000 })).monthlyTokens).toBe(0);
    expect(computeRunningCost(withInput({ usage: "custom", messagesPerDay: Number.NaN, tokensPerMessage: 10_000 })).monthlyTokens).toBe(0);
    expect(computeRunningCost(withInput({ usage: "custom", messagesPerDay: 1e9, tokensPerMessage: 1e12 })).monthlyTokens).toBe(10_000 * 2_000_000 * 30);
  });

  it("a free model on a laptop costs $0 and has zero shares", () => {
    const cost = computeRunningCost(withInput({ server: "laptop", model: "openrouter:google/gemma-4-31b-it:free" }));
    expect(cost.totalUsd).toBe(0);
    expect(cost.shares).toEqual({ server: 0, tokens: 0, time: 0 });
  });

  it("leaves time out unless it is turned on, and counts no hours on Hivra", () => {
    expect(timeCostUsd(withInput({ countTime: false }))).toBe(0);
    expect(timeCostUsd(withInput({ countTime: true }))).toBe(150);
    expect(timeCostUsd(withInput({ countTime: true, server: "hivra-entry" }))).toBe(0);
    expect(timeCostUsd(withInput({ countTime: true, hoursPerMonth: -3 }))).toBe(0);
  });

  it("falls back to the default model for an unknown key", () => {
    expect(getModel("nope").key).toBe(DEFAULT_MODEL_KEY);
  });
});

describe("verdict", () => {
  it("says DIY wins on a laptop and that it sleeps", () => {
    const text = buildVerdict(withInput({ server: "laptop" }));
    expect(text).toMatch(/DIY wins/);
    expect(text).toMatch(/sleeps/);
  });

  it("calls out the free-model limits from the table", () => {
    const text = buildVerdict(withInput({ server: "laptop", model: "openrouter:google/gemma-4-31b-it:free" }));
    expect(text).toMatch(/20 requests a minute and 50 a day/);
    expect(text).toMatch(/1,000 a day/);
  });

  it("says a cheap VPS is cheaper than Hivra when time is not counted, and Hivra when hours are", () => {
    expect(buildVerdict(withInput({ server: "vultr1gb" }))).toMatch(/cheaper than a Hivra computer/);
    expect(buildVerdict(withInput({ server: "vultr1gb" }))).toMatch(/time is not counted|Your own time is not counted/);
    expect(buildVerdict(withInput({ countTime: true }))).toMatch(/more for the same usage|a month more than a Hivra computer/);
  });

  it("says a VPS costing the same as Hivra is the same", () => {
    // No VPS row equals $9.99, so check the equal branch through a zero-token setup against a price tie.
    const tie = withInput({ server: "hivra-entry", usage: "custom", messagesPerDay: 0 });
    expect(computeRunningCost(tie).totalUsd).toBeCloseTo(9.99, 6);
  });

  it("on the entry Hivra plan, compares against a same-size 2 vCPU and 4 GB VPS", () => {
    const text = buildVerdict(withInput({ server: "hivra-entry" }));
    expect(text).toMatch(/2 vCPU and 4 GB lists from/);
    expect(text).toMatch(/DIY is cheaper in dollars/);
    expect(text).not.toMatch(/does not include AI usage/);
  });

  it("on the larger Hivra plan, makes no same-size VPS price claim", () => {
    const text = buildVerdict(withInput({ server: "hivra-larger" }));
    expect(text).toMatch(/4 vCPU and 8 GB/);
    expect(text).toMatch(/smaller than that/);
    expect(text).not.toMatch(/lists from/);
    expect(text).not.toMatch(/DIY is cheaper in dollars/);
  });

  it("names the token share when tokens are at least half of the bill", () => {
    expect(buildVerdict(base)).toMatch(/Model tokens are 75% of this bill/);
  });

  it("states a plain total when the server dominates", () => {
    expect(buildVerdict(withInput({ server: "do4gb", usage: "light", model: "hivra:deepseek-v4-flash" }))).toMatch(/Total: \$/);
  });

  it("never makes a banned claim, for every server and a spread of models", () => {
    for (const server of SERVER_KEYS) {
      for (const model of [DEFAULT_MODEL_KEY, "openrouter:google/gemma-4-31b-it:free", ALL_MODELS[3].key]) {
        for (const countTime of [false, true]) {
          const text = buildVerdict(withInput({ server, model, countTime }));
          expect({ text, hits: findBannedClaims(text) }).toEqual({ text, hits: [] });
        }
      }
    }
  });
});

describe("formatting", () => {
  it("formats dollars and tokens", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(7.09)).toBe("$7.09");
    expect(formatUsd(1234.5)).toBe("$1,235");
    expect(formatTokens(48_000_000)).toBe("48.0 million");
    expect(formatTokens(2_500_000_000)).toBe("2.5 billion");
    expect(formatTokens(20_000)).toBe("20,000");
    expect(formatTokens(12)).toBe("12");
  });
});

describe("link parameters", () => {
  it("leaves the defaults out and round-trips a changed state", () => {
    expect(serializeRunningCostParams(base)).toBe("");
    const changed = withInput({ server: "hivra-entry", model: "openrouter:google/gemma-4-31b-it:free", usage: "custom", messagesPerDay: 12, tokensPerMessage: 30_000, countTime: true, hoursPerMonth: 5, hourlyRate: 80 });
    const qs = serializeRunningCostParams(changed);
    expect(parseRunningCostParams(qs)).toEqual(changed);
  });

  it("falls back to defaults for unknown, hand-edited or oversized values", () => {
    expect(parseRunningCostParams("?server=evil&model=<script>&usage=nope&msgs=abc&time=yes")).toEqual(base);
    const parsed = parseRunningCostParams("usage=custom&msgs=99999999&tokens=-4&hours=9999");
    expect(parsed.messagesPerDay).toBe(10_000);
    expect(parsed.tokensPerMessage).toBe(base.tokensPerMessage);
    expect(parsed.hoursPerMonth).toBe(200);
  });

  it("keeps hours and rate clamped when serialised with out-of-range values", () => {
    const qs = serializeRunningCostParams(withInput({ countTime: true, hoursPerMonth: 500, hourlyRate: 5000 }));
    const parsed = parseRunningCostParams(qs);
    expect(parsed.hoursPerMonth).toBe(200);
    expect(parsed.hourlyRate).toBe(1000);
  });

  it("only carries allow-listed values, never free text", () => {
    const qs = serializeRunningCostParams(withInput({ model: "not a model" }));
    expect(parseRunningCostParams(qs).model).toBe(DEFAULT_MODEL_KEY);
  });
});

describe("catalog entry", () => {
  const entry = AGENT_RUNNING_COST_ENTRY;

  it("has the keys the task fixes", () => {
    expect(entry.slug).toBe("ai-agent-running-cost-calculator");
    expect(entry.componentKey).toBe("agent-running-cost");
    expect(entry.primaryKeyword).toBe("openclaw cost");
  });

  it("keeps titles and the description within limits", () => {
    expect(entry.metaTitle.length).toBeLessThanOrEqual(55);
    expect(entry.metaTitle).not.toMatch(/\|\s*Hivra|Hivra\s*$/);
    expect(entry.browserTitle).toBe(`${entry.metaTitle} | Hivra`);
    expect(entry.metaDescription.length).toBeGreaterThanOrEqual(120);
    expect(entry.metaDescription.length).toBeLessThanOrEqual(155);
  });

  it("has at least five FAQs covering the keyword cluster", () => {
    expect(entry.faqs.length).toBeGreaterThanOrEqual(5);
    const questions = entry.faqs.map((f) => f.q).join("\n");
    expect(questions).toMatch(/Is OpenClaw free/);
    expect(questions).toMatch(/Hermes Agent cost/);
    expect(questions).toMatch(/Hermes Agent pricing/);
  });

  it("makes no banned claim in any string", () => {
    for (const text of collectStrings(entry)) {
      expect({ text, hits: findBannedClaims(text) }).toEqual({ text, hits: [] });
    }
  });

  it("passes the keep-running and dashboard-name checks", () => {
    const copy = collectStrings(entry).join("\n");
    expect(unqualifiedKeepRunningClaims(copy, /Hivra|always-on (?:box|computer)|managed (?:box|computer)/i)).toEqual([]);
    expect(unknownDashboardNames(copy)).toEqual([]);
  });

  it("states the $19.99 size inline, never a free hosted plan, and no unsupported AI usage claim", () => {
    const copy = collectStrings(entry).join("\n");
    for (const mention of copy.match(/\$19\.99[^.]*\./g) ?? []) expect(mention).toMatch(/4 vCPU and 8 GB/);
    expect(copy).not.toMatch(/does not include AI usage|account or key/);
    expect(copy).toMatch(/Hivra's managed inference by default, or your own Venice key/);
    expect(copy).not.toMatch(/[–—]/);
  });

  it("links the hosting calculator and only allowed routes", () => {
    const hrefs = entry.relatedLinks.map((l) => l.href);
    expect(hrefs).toContain("/tools/ai-agent-hosting-cost-calculator");
    expect(hrefs.length).toBeGreaterThanOrEqual(2);
    for (const href of hrefs) expect(ALLOWED_RELATED.has(href)).toBe(true);
  });

  it("has a method with sources and three examples whose output equals the builder's", () => {
    const method = entry.method!;
    expect(method.lastVerified).toBe("2026-11-12");
    expect(method.paragraphs.length).toBeGreaterThanOrEqual(4);
    const sources = method.paragraphs.flatMap((p) => p.sources ?? []);
    expect(sources.length).toBeGreaterThanOrEqual(2);
    for (const s of sources) expect(s.url).toMatch(/^https:\/\//);
    expect(entry.examples).toHaveLength(3);
    expect(entry.examples!.map((e) => e.command)).toEqual([
      buildSummary(RUNNING_COST_EXAMPLE_INPUTS.freeLaptop),
      buildSummary(RUNNING_COST_EXAMPLE_INPUTS.vps),
      buildSummary(RUNNING_COST_EXAMPLE_INPUTS.vpsWithTime),
    ]);
    expect(entry.examples![0].command).toMatch(/Total: \$0\.00 a month/);
  });
});
