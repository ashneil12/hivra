import { findBannedClaims } from "../../copy-rules";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import { VENICE_CHAT_MODEL_PRICES } from "@/lib/venice/pricing";
import { OPENROUTER_MODELS } from "../openrouter-snapshot";
import {
  FINDER_DEFAULTS,
  FINDER_ROWS,
  HIVRA_CATALOG_COUNT,
  HIVRA_LEFT_OUT_COUNT,
  HIVRA_MODEL_CAPABILITIES,
  MODEL_FINDER_FACTS,
  buildSummary,
  costPerDayUsd,
  filterRows,
  findRows,
  formatContext,
  formatPrice,
  parseFinderParams,
  serializeFinderParams,
  sortRows,
  summarize,
  tokensPerDay,
  type FinderState,
} from "../agent-model-finder";
import { AGENT_MODEL_FINDER_ENTRY, MODEL_FINDER_EXAMPLE_STATES } from "../agent-model-finder-entry";

const ALLOWED_RELATED = new Set([
  "/pricing",
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

const withState = (patch: Partial<FinderState>): FinderState => ({ ...FINDER_DEFAULTS, ...patch });

describe("finder tables", () => {
  it("combines Hivra's tool-capable models and the OpenRouter snapshot, with unique keys", () => {
    const hivra = FINDER_ROWS.filter((row) => row.where === "hivra");
    expect(hivra.length + HIVRA_LEFT_OUT_COUNT).toBe(HIVRA_CATALOG_COUNT);
    expect(HIVRA_CATALOG_COUNT).toBe(VENICE_CHAT_MODEL_PRICES.length);
    expect(FINDER_ROWS.length - hivra.length).toBe(OPENROUTER_MODELS.length);
    expect(new Set(FINDER_ROWS.map((row) => row.key)).size).toBe(FINDER_ROWS.length);
  });

  it("converts Hivra micro-USD per million to USD per million", () => {
    const flash = FINDER_ROWS.find((row) => row.key === "hivra:deepseek-v4-1-flash");
    expect(flash?.inputUsdPerM).toBeCloseTo(0.3, 6);
    expect(flash?.outputUsdPerM).toBeCloseTo(1.2, 6);
    expect(flash?.contextTokens).toBe(1_000_000);
  });

  it("shows a Hivra model only when the provider list confirms tool calls", () => {
    for (const row of FINDER_ROWS.filter((r) => r.where === "hivra")) {
      expect(HIVRA_MODEL_CAPABILITIES[row.key.replace("hivra:", "")]?.tools).toBe(true);
    }
    expect(FINDER_ROWS.find((row) => row.key === "hivra:e2ee-qwen-2-5-7b-p")).toBeUndefined();
    expect(FINDER_ROWS.find((row) => row.key === "hivra:grok-4-20-multi-agent")).toBeUndefined();
  });

  it("marks only Hivra rows with a private or e2ee privacy label as private", () => {
    const privateKeys = FINDER_ROWS.filter((row) => row.isPrivate).map((row) => row.key);
    expect(privateKeys.length).toBeGreaterThan(0);
    for (const key of privateKeys) {
      expect(key.startsWith("hivra:")).toBe(true);
      const price = VENICE_CHAT_MODEL_PRICES.find((p) => `hivra:${p.model}` === key);
      expect(["private", "e2ee_private"]).toContain(price?.privacy);
    }
    expect(FINDER_ROWS.filter((row) => row.where === "openrouter").some((row) => row.isPrivate)).toBe(false);
  });

  it("carries a date for each dataset and real https sources", () => {
    expect(MODEL_FINDER_FACTS.lastVerified).toBe("2026-11-12");
    expect(MODEL_FINDER_FACTS.hivraCatalogUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(MODEL_FINDER_FACTS.openRouterSnapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const url of MODEL_FINDER_FACTS.sources) expect(url).toMatch(/^https:\/\//);
  });
});

describe("cost per agent-day", () => {
  it("prices 85% of the tokens as input and 15% as output", () => {
    const tokens = tokensPerDay("typical");
    expect(tokens).toBe(1_600_000);
    expect(costPerDayUsd({ inputUsdPerM: 1, outputUsdPerM: 2 }, "typical")).toBeCloseTo(1.6 * (0.85 * 1 + 0.15 * 2), 6);
  });
  it("is zero for a free model and grows with usage", () => {
    expect(costPerDayUsd({ inputUsdPerM: 0, outputUsdPerM: 0 }, "heavy")).toBe(0);
    const row = { inputUsdPerM: 0.3, outputUsdPerM: 1.2 };
    expect(costPerDayUsd(row, "light")).toBeLessThan(costPerDayUsd(row, "typical"));
    expect(costPerDayUsd(row, "typical")).toBeLessThan(costPerDayUsd(row, "heavy"));
  });
  it("every free row costs nothing", () => {
    for (const row of FINDER_ROWS.filter((r) => r.free)) expect(costPerDayUsd(row, "heavy")).toBe(0);
  });
});

describe("filters", () => {
  it("free only keeps only free rows, paid only keeps none of them", () => {
    const free = filterRows(FINDER_ROWS, withState({ price: "free" }));
    expect(free.length).toBeGreaterThan(0);
    expect(free.every((row) => row.free)).toBe(true);
    expect(filterRows(FINDER_ROWS, withState({ price: "paid" })).some((row) => row.free)).toBe(false);
    expect(free.length + filterRows(FINDER_ROWS, withState({ price: "paid" })).length).toBe(FINDER_ROWS.length);
  });
  it("private only keeps the private rows", () => {
    const rows = filterRows(FINDER_ROWS, withState({ privateOnly: true }));
    expect(rows.length).toBe(FINDER_ROWS.filter((r) => r.isPrivate).length);
    expect(rows.every((row) => row.where === "hivra")).toBe(true);
  });
  it("reasoning and image filters", () => {
    expect(filterRows(FINDER_ROWS, withState({ reasoningOnly: true })).every((row) => row.reasoning)).toBe(true);
    expect(filterRows(FINDER_ROWS, withState({ imageOnly: true })).every((row) => row.imageInput)).toBe(true);
  });
  it("minimum context", () => {
    expect(filterRows(FINDER_ROWS, withState({ minContext: "200k" })).every((row) => row.contextTokens >= 200_000)).toBe(true);
    expect(filterRows(FINDER_ROWS, withState({ minContext: "1m" })).every((row) => row.contextTokens >= 1_000_000)).toBe(true);
  });
  it("where, and a name search that ignores case and spaces at the edges", () => {
    expect(filterRows(FINDER_ROWS, withState({ where: "openrouter" })).every((row) => row.where === "openrouter")).toBe(true);
    const hits = filterRows(FINDER_ROWS, FINDER_DEFAULTS, "  DEEPSEEK ");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((row) => row.name.toLowerCase().includes("deepseek"))).toBe(true);
    expect(filterRows(FINDER_ROWS, FINDER_DEFAULTS, "no such model zzz")).toEqual([]);
  });
  it("combines filters", () => {
    const rows = filterRows(FINDER_ROWS, withState({ price: "free", reasoningOnly: true, minContext: "200k", where: "openrouter" }));
    for (const row of rows) expect(row.free && row.reasoning && row.contextTokens >= 200_000 && row.where === "openrouter").toBe(true);
  });
});

describe("sorting", () => {
  const ordered = (sort: FinderState["sort"], dir: FinderState["dir"]) => sortRows(FINDER_ROWS, withState({ sort, dir }));
  it("sorts by each column in both directions", () => {
    const input = ordered("input", "asc").map((r) => r.inputUsdPerM);
    expect(input).toEqual([...input].sort((a, b) => a - b));
    const output = ordered("output", "desc").map((r) => r.outputUsdPerM);
    expect(output).toEqual([...output].sort((a, b) => b - a));
    const context = ordered("context", "desc").map((r) => r.contextTokens);
    expect(context).toEqual([...context].sort((a, b) => b - a));
    const cost = ordered("cost", "asc").map((r) => costPerDayUsd(r, "typical"));
    expect(cost).toEqual([...cost].sort((a, b) => a - b));
    const names = ordered("name", "asc").map((r) => r.name.toLowerCase());
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
  it("does not mutate its input and is stable on ties", () => {
    const copy = [...FINDER_ROWS];
    const once = sortRows(FINDER_ROWS, withState({ sort: "output" }));
    expect(FINDER_ROWS).toEqual(copy);
    expect(sortRows(FINDER_ROWS, withState({ sort: "output" })).map((r) => r.key)).toEqual(once.map((r) => r.key));
  });
  it("the cost order depends on the usage assumption only by scale", () => {
    expect(findRows(withState({ usage: "light" })).map((r) => r.key)).toEqual(findRows(withState({ usage: "heavy" })).map((r) => r.key));
  });
});

describe("summaries and formatting", () => {
  it("summarize finds the cheapest paid and free rows", () => {
    const s = summarize(FINDER_ROWS, "typical");
    expect(s.total).toBe(FINDER_ROWS.length);
    expect(s.freeCount).toBe(FINDER_ROWS.filter((r) => r.free).length);
    expect(s.cheapestPaid?.free).toBe(false);
    expect(s.cheapestFree?.free).toBe(true);
    expect(summarize([], "light")).toMatchObject({ matching: 0, cheapestPaid: null, cheapestFree: null });
  });
  it("buildSummary names the assumption and handles no match", () => {
    expect(buildSummary(withState({ price: "free", where: "hivra" }))).toMatch(/No model matches/);
    expect(buildSummary(FINDER_DEFAULTS)).toMatch(/models match\. Lowest estimated cost first at 40 messages a day/);
  });
  it("buildSummary words the order from the sort, not always by cost", () => {
    expect(buildSummary(withState({ sort: "context", dir: "desc" }))).toMatch(/Sorted by context.*, high to low at 40 messages a day/);
    expect(buildSummary(withState({ sort: "cost", dir: "desc" }))).not.toMatch(/Lowest estimated cost first/);
  });
  it("formats prices and context", () => {
    expect(formatPrice(0)).toBe("Free");
    expect(formatPrice(0.0076)).toBe("$0.008");
    expect(formatPrice(0.3)).toBe("$0.30");
    expect(formatPrice(0.075)).toBe("$0.075");
    expect(formatPrice(1.2)).toBe("$1.20");
    expect(formatPrice(0.0001)).toBe("<$0.001");
    expect(formatContext(128_000)).toBe("128K");
    expect(formatContext(131_072)).toBe("131K");
    expect(formatContext(1_000_000)).toBe("1M");
    expect(formatContext(1_050_000)).toBe("1.05M");
  });
});

describe("shareable link", () => {
  it("omits defaults and round-trips", () => {
    expect(serializeFinderParams(FINDER_DEFAULTS)).toBe("");
    const state = withState({ price: "free", privateOnly: true, reasoningOnly: true, imageOnly: true, minContext: "128k", where: "hivra", usage: "heavy", sort: "context", dir: "asc" });
    expect(parseFinderParams(`?${serializeFinderParams(state)}`)).toEqual(state);
  });
  it("uses the column's natural direction when none is given", () => {
    expect(parseFinderParams("?sort=context").dir).toBe("desc");
    expect(parseFinderParams("?sort=input").dir).toBe("asc");
    expect(serializeFinderParams(withState({ sort: "context", dir: "desc" }))).toBe("sort=context");
  });
  it("ignores values that are not on the allow list", () => {
    expect(parseFinderParams("?price=x&minctx=9&where=y&usage=z&sort=q&dir=up&private=yes")).toEqual(FINDER_DEFAULTS);
    expect(serializeFinderParams(FINDER_DEFAULTS)).not.toMatch(/q=/);
  });
});

describe("catalog entry", () => {
  const entry = AGENT_MODEL_FINDER_ENTRY;
  const copy = collectStrings(entry);

  it("has the identifying fields", () => {
    expect(entry.slug).toBe("best-free-models-for-ai-agents");
    expect(entry.componentKey).toBe("agent-model-finder");
    expect(entry.primaryKeyword).toBe("free llm api");
    expect(entry.faqs.length).toBeGreaterThanOrEqual(5);
    expect(entry.examples?.length).toBeGreaterThanOrEqual(1);
    expect(entry.metaTitle.length).toBeLessThanOrEqual(55);
    expect(entry.browserTitle).toBe(`${entry.metaTitle} | Hivra`);
    expect(entry.metaDescription.length).toBeGreaterThanOrEqual(120);
    expect(entry.metaDescription.length).toBeLessThanOrEqual(155);
    expect(entry.method?.lastVerified).toBe("2026-11-12");
  });
  it("makes none of the banned claims in any copy string", () => {
    for (const text of copy) expect({ text, hits: findBannedClaims(text) }).toEqual({ text, hits: [] });
  });
  it("passes the keep-running and dashboard-name checks", () => {
    const all = copy.join("\n");
    expect(unqualifiedKeepRunningClaims(all, /Hivra|always-on (?:box|computer)|managed (?:box|computer)/i)).toEqual([]);
    expect(unknownDashboardNames(all)).toEqual([]);
  });
  it("keeps related links on allowed routes", () => {
    expect(entry.relatedLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of entry.relatedLinks) expect(ALLOWED_RELATED.has(link.href)).toBe(true);
  });
  it("cites https sources, and every faqCode phrase occurs in an answer", () => {
    for (const paragraph of entry.method?.paragraphs ?? []) for (const source of paragraph.sources ?? []) expect(source.url).toMatch(/^https:\/\//);
    const answers = entry.faqs.map((faq) => faq.a).join("\n");
    for (const phrase of entry.faqCode ?? []) expect(answers).toContain(phrase);
  });
  it("never calls a model the best one without a stated measure", () => {
    const answers = [entry.intro.lede, ...entry.intro.body, ...entry.faqs.map((f) => f.a), ...(entry.method?.paragraphs.map((p) => p.text) ?? [])].join("\n");
    expect(answers).not.toMatch(/\bthe best (?:free )?model (?:is|for)\b/i);
    expect(answers).toMatch(/do not call any model the best/);
    expect(answers).toMatch(/retries/);
  });
  it("examples print what the tool prints", () => {
    const states = Object.values(MODEL_FINDER_EXAMPLE_STATES);
    expect(entry.examples?.map((e) => e.command)).toEqual(states.map((state) => buildSummary(state)));
  });
});
