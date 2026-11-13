// Logic and facts for the "free and cheap models for AI agents" finder
// (/tools/best-free-models-for-ai-agents). Pure: no React, no browser APIs.
//
// Two dated tables feed it. Hivra's managed inference list (lib/venice/pricing.ts, micro-USD per million
// tokens) carries price, context and a privacy label but no capability flags, so the capability table
// below was read from the model provider's own public models list on 2026-11-12. A Hivra model is shown
// only when that list says it supports function calling: an agent needs tool calls. The OpenRouter
// snapshot (openrouter-snapshot.ts) already holds only tool-capable models at list price.
//
// Nothing here ranks quality. Every sort is by a stated number: a price, the context window or an
// estimated cost per agent-day from a stated token assumption.

import { VENICE_CHAT_MODEL_PRICES, VENICE_CHAT_PRICING_CATALOG_UPDATED_AT } from "@/lib/venice/pricing";
import { OPENROUTER_MODELS, OPENROUTER_SNAPSHOT_DATE } from "./openrouter-snapshot";
import { DAYS_PER_MONTH, INPUT_SHARE, USAGE_PRESETS } from "./agent-running-cost";

export const MODEL_FINDER_FACTS = {
  lastVerified: "2026-11-12",
  hivraCatalogUpdatedAt: VENICE_CHAT_PRICING_CATALOG_UPDATED_AT,
  openRouterSnapshotDate: OPENROUTER_SNAPSHOT_DATE,
  /** OpenRouter's own free-models page, read 2026-11-12. The numbers below are quoted from its FAQ. */
  freeModels: {
    source: "https://openrouter.ai/collections/free-models",
    limitsSource: "https://openrouter.ai/docs/api-reference/limits",
    requestsPerMinute: 20,
    requestsPerDayBase: 50,
    requestsPerDayAfterCredits: 1000,
    creditsUsd: 10,
    failedAttemptsCount: true,
    routerId: "openrouter/free",
  },
  /** The model provider's public models list, read 2026-11-12, for tool-call, reasoning and image flags. */
  capabilitySource: "https://api.venice.ai/api/v1/models?type=text",
  sources: [
    "https://openrouter.ai/models",
    "https://openrouter.ai/collections/free-models",
    "https://openrouter.ai/docs/api-reference/limits",
    "https://api.venice.ai/api/v1/models?type=text",
    "https://github.com/NousResearch/hermes-agent",
    "https://github.com/openclaw/openclaw",
  ],
} as const;

/**
 * Capability flags for Hivra's managed models, from the provider's public models list read on
 * 2026-11-12 (supportsFunctionCalling, supportsReasoning, supportsVision). Models in the Hivra
 * catalog that the live list did not return are absent here and are left out of the table.
 */
export const HIVRA_MODEL_CAPABILITIES: Readonly<Record<string, { tools: boolean; reasoning: boolean; vision: boolean }>> = {
    "venice-uncensored-1-2": { tools: true, reasoning: false, vision: true },
    "venice-uncensored-role-play": { tools: true, reasoning: false, vision: true },
    "deepseek-v3.2": { tools: true, reasoning: true, vision: false },
    "deepseek-v4-1-flash": { tools: true, reasoning: true, vision: true },
    "deepseek-v4-flash": { tools: true, reasoning: true, vision: false },
    "deepseek-v4-pro": { tools: true, reasoning: true, vision: false },
    "kimi-k2-5": { tools: true, reasoning: true, vision: true },
    "kimi-k2-6": { tools: true, reasoning: true, vision: true },
    "zai-org-glm-4.6": { tools: true, reasoning: true, vision: false },
    "zai-org-glm-4.7": { tools: true, reasoning: true, vision: false },
    "olafangensan-glm-4.7-flash-heretic": { tools: true, reasoning: true, vision: false },
    "zai-org-glm-5": { tools: true, reasoning: true, vision: false },
    "z-ai-glm-5-turbo": { tools: true, reasoning: true, vision: false },
    "zai-org-glm-5-1": { tools: true, reasoning: true, vision: false },
    "z-ai-glm-5v-turbo": { tools: true, reasoning: true, vision: true },
    "qwen3-235b-a22b-instruct-2507": { tools: true, reasoning: false, vision: false },
    "qwen3-235b-a22b-thinking-2507": { tools: true, reasoning: true, vision: false },
    "qwen3-coder-480b-a35b-instruct-turbo": { tools: true, reasoning: false, vision: false },
    "qwen3-next-80b": { tools: true, reasoning: false, vision: false },
    "qwen3-5-35b-a3b": { tools: true, reasoning: true, vision: true },
    "qwen3-5-397b-a17b": { tools: true, reasoning: true, vision: true },
    "qwen3-6-27b": { tools: true, reasoning: true, vision: true },
    "qwen-3-6-plus": { tools: true, reasoning: true, vision: true },
    "qwen3-vl-235b-a22b": { tools: true, reasoning: false, vision: true },
    "e2ee-qwen3-vl-30b-a3b-p": { tools: true, reasoning: false, vision: true },
    "e2ee-qwen-2-5-7b-p": { tools: false, reasoning: false, vision: false },
    "llama-3.2-3b": { tools: true, reasoning: false, vision: false },
    "llama-3.3-70b": { tools: true, reasoning: false, vision: false },
    "mistral-small-3-2-24b-instruct": { tools: true, reasoning: false, vision: true },
    "google-gemma-3-27b-it": { tools: true, reasoning: false, vision: true },
    "google-gemma-4-26b-a4b-it": { tools: true, reasoning: true, vision: true },
    "google-gemma-4-31b-it": { tools: true, reasoning: true, vision: true },
    "gemma-4-uncensored": { tools: true, reasoning: false, vision: true },
    "openai-gpt-4o-2024-11-20": { tools: true, reasoning: false, vision: true },
    "openai-gpt-4o-mini-2024-07-18": { tools: true, reasoning: false, vision: true },
    "openai-gpt-52": { tools: true, reasoning: true, vision: false },
    "openai-gpt-53-codex": { tools: true, reasoning: true, vision: true },
    "openai-gpt-54": { tools: true, reasoning: true, vision: true },
    "openai-gpt-54-mini": { tools: true, reasoning: true, vision: true },
    "openai-gpt-54-pro": { tools: true, reasoning: true, vision: true },
    "openai-gpt-55": { tools: true, reasoning: true, vision: true },
    "openai-gpt-55-pro": { tools: true, reasoning: true, vision: true },
    "openai-gpt-oss-120b": { tools: true, reasoning: true, vision: false },
    "e2ee-gpt-oss-120b-p": { tools: false, reasoning: true, vision: false },
    "claude-opus-4-5": { tools: true, reasoning: true, vision: true },
    "claude-opus-4-6": { tools: true, reasoning: true, vision: true },
    "claude-opus-4-7": { tools: true, reasoning: true, vision: true },
    "claude-opus-4-8": { tools: true, reasoning: true, vision: true },
    "claude-opus-4-8-fast": { tools: true, reasoning: true, vision: true },
    "claude-fable-5": { tools: true, reasoning: true, vision: true },
    "claude-sonnet-4-6": { tools: true, reasoning: true, vision: true },
    "gemini-3-flash-preview": { tools: true, reasoning: true, vision: true },
    "gemini-3-1-pro-preview": { tools: true, reasoning: true, vision: true },
    "grok-4-3": { tools: true, reasoning: true, vision: true },
    "grok-4-20": { tools: true, reasoning: true, vision: true },
    "grok-4-20-multi-agent": { tools: false, reasoning: true, vision: true },
    "minimax-m25": { tools: true, reasoning: true, vision: false },
    "minimax-m27": { tools: true, reasoning: true, vision: false },
    "nvidia-nemotron-3-nano-30b-a3b": { tools: true, reasoning: false, vision: false },
};

export type Where = "hivra" | "openrouter";

export interface FinderRow {
  /** "hivra:<id>" or "openrouter:<id>". */
  key: string;
  name: string;
  where: Where;
  inputUsdPerM: number;
  outputUsdPerM: number;
  contextTokens: number;
  free: boolean;
  /** Hivra catalog privacy label is "private" or "e2ee_private". Always false for OpenRouter rows (not recorded). */
  isPrivate: boolean;
  reasoning: boolean;
  imageInput: boolean;
}

const hivraRows: FinderRow[] = [];
let hivraLeftOut = 0;
for (const price of VENICE_CHAT_MODEL_PRICES) {
  const caps = HIVRA_MODEL_CAPABILITIES[price.model];
  if (!caps || !caps.tools) {
    hivraLeftOut += 1;
    continue;
  }
  hivraRows.push({
    key: `hivra:${price.model}`,
    name: price.displayName,
    where: "hivra",
    inputUsdPerM: price.inputMicroUsdPerMillion / 1_000_000,
    outputUsdPerM: price.outputMicroUsdPerMillion / 1_000_000,
    contextTokens: price.contextWindow,
    free: false,
    isPrivate: price.privacy === "private" || price.privacy === "e2ee_private",
    reasoning: caps.reasoning,
    imageInput: caps.vision,
  });
}

const openRouterRows: FinderRow[] = OPENROUTER_MODELS.map((row) => ({
  key: `openrouter:${row.id}`,
  name: row.name,
  where: "openrouter",
  inputUsdPerM: row.inputUsdPerM,
  outputUsdPerM: row.outputUsdPerM,
  contextTokens: row.contextTokens,
  free: row.free,
  isPrivate: false,
  reasoning: row.reasoning,
  imageInput: row.imageInput,
}));

export const FINDER_ROWS: readonly FinderRow[] = [...hivraRows, ...openRouterRows];
/** Models in Hivra's catalog that are not shown: the provider list did not confirm tool calls for them. */
export const HIVRA_LEFT_OUT_COUNT = hivraLeftOut;
export const HIVRA_CATALOG_COUNT = VENICE_CHAT_MODEL_PRICES.length;

export const WHERE_LABEL: Record<Where, string> = { hivra: "Hivra managed inference", openrouter: "OpenRouter" };

// ---- Usage assumption ------------------------------------------------------

export type UsageKey = "light" | "typical" | "heavy";
export const USAGE_KEYS: readonly UsageKey[] = ["light", "typical", "heavy"];
export const DEFAULT_USAGE: UsageKey = "typical";

export function tokensPerDay(usage: UsageKey): number {
  const preset = USAGE_PRESETS[usage];
  return preset.messagesPerDay * preset.tokensPerMessage;
}

/** Estimated list-price cost of one agent-day: tokens a day, 85% input and 15% output. No caching. */
export function costPerDayUsd(row: Pick<FinderRow, "inputUsdPerM" | "outputUsdPerM">, usage: UsageKey): number {
  const tokens = tokensPerDay(usage);
  const input = tokens * INPUT_SHARE;
  return (input / 1_000_000) * row.inputUsdPerM + ((tokens - input) / 1_000_000) * row.outputUsdPerM;
}

export { DAYS_PER_MONTH };

// ---- Filters, sort ---------------------------------------------------------

export const MIN_CONTEXT_KEYS = ["any", "32k", "128k", "200k", "1m"] as const;
export type MinContextKey = (typeof MIN_CONTEXT_KEYS)[number];
export const MIN_CONTEXT_TOKENS: Record<MinContextKey, number> = { any: 0, "32k": 32_000, "128k": 128_000, "200k": 200_000, "1m": 1_000_000 };
export const MIN_CONTEXT_LABEL: Record<MinContextKey, string> = { any: "Any", "32k": "32K or more", "128k": "128K or more", "200k": "200K or more", "1m": "1M or more" };

export const WHERE_FILTER_KEYS = ["all", "hivra", "openrouter"] as const;
export type WhereFilter = (typeof WHERE_FILTER_KEYS)[number];

export const SORT_KEYS = ["name", "input", "output", "context", "cost"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

export const PRICE_FILTER_KEYS = ["all", "free", "paid"] as const;
export type PriceFilter = (typeof PRICE_FILTER_KEYS)[number];

export interface FinderState {
  price: PriceFilter;
  privateOnly: boolean;
  reasoningOnly: boolean;
  imageOnly: boolean;
  minContext: MinContextKey;
  where: WhereFilter;
  usage: UsageKey;
  sort: SortKey;
  dir: SortDir;
}

export const FINDER_DEFAULTS: FinderState = {
  price: "all",
  privateOnly: false,
  reasoningOnly: false,
  imageOnly: false,
  minContext: "any",
  where: "all",
  usage: DEFAULT_USAGE,
  sort: "cost",
  dir: "asc",
};

/** The direction a column starts in when first chosen: names and prices read best low to high, context high to low. */
export function defaultDir(sort: SortKey): SortDir {
  return sort === "context" ? "desc" : "asc";
}

export function filterRows(rows: readonly FinderRow[], state: FinderState, query = ""): FinderRow[] {
  const needle = query.trim().toLowerCase();
  const minTokens = MIN_CONTEXT_TOKENS[state.minContext];
  return rows.filter((row) => {
    if (state.price === "free" && !row.free) return false;
    if (state.price === "paid" && row.free) return false;
    if (state.privateOnly && !row.isPrivate) return false;
    if (state.reasoningOnly && !row.reasoning) return false;
    if (state.imageOnly && !row.imageInput) return false;
    if (row.contextTokens < minTokens) return false;
    if (state.where !== "all" && row.where !== state.where) return false;
    if (needle && !row.name.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function sortValue(row: FinderRow, sort: SortKey, usage: UsageKey): number | string {
  switch (sort) {
    case "name":
      return row.name.toLowerCase();
    case "input":
      return row.inputUsdPerM;
    case "output":
      return row.outputUsdPerM;
    case "context":
      return row.contextTokens;
    case "cost":
      return costPerDayUsd(row, usage);
  }
}

/** Sorted copy. Ties fall back to the larger context, then the name, so the order never jumps. */
export function sortRows(rows: readonly FinderRow[], state: FinderState): FinderRow[] {
  const factor = state.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, state.sort, state.usage);
    const vb = sortValue(b, state.sort, state.usage);
    if (va !== vb) {
      if (typeof va === "string" && typeof vb === "string") return va.localeCompare(vb) * factor;
      return ((va as number) - (vb as number)) * factor;
    }
    if (a.contextTokens !== b.contextTokens) return b.contextTokens - a.contextTokens;
    return a.name.localeCompare(b.name);
  });
}

export function findRows(state: FinderState, query = ""): FinderRow[] {
  return sortRows(filterRows(FINDER_ROWS, state, query), state);
}

// ---- Formatting ------------------------------------------------------------

/** "Free", or dollars with at least 2 and at most 3 decimals ("$0.075", "$1.20", "$15.00"). */
export function formatPrice(value: number): string {
  if (value === 0) return "Free";
  if (value >= 1) return `$${value.toFixed(2)}`;
  const three = value.toFixed(3);
  if (three === "0.000") return "<$0.001";
  return `$${three.endsWith("0") ? value.toFixed(2) : three}`;
}

/** "128K", "1M", "1.05M". Context windows are marketed in round numbers, so 131,072 reads 131K. */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number(millions.toFixed(2))}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))} million`;
  return `${Math.round(tokens / 1000).toLocaleString("en-US")},000`;
}

export const SORT_LABEL: Record<SortKey, string> = {
  name: "Model name",
  input: "Input price",
  output: "Output price",
  context: "Context window",
  cost: "Estimated cost per agent-day",
};

// ---- Summary ---------------------------------------------------------------

export interface FinderSummary {
  matching: number;
  total: number;
  freeCount: number;
  cheapestPaid: FinderRow | null;
  cheapestFree: FinderRow | null;
}

/** Counts and the cheapest rows at the stated usage. "Cheapest" always means lowest estimated list-price cost. */
export function summarize(rows: readonly FinderRow[], usage: UsageKey): FinderSummary {
  const byCost = (a: FinderRow, b: FinderRow) => costPerDayUsd(a, usage) - costPerDayUsd(b, usage) || b.contextTokens - a.contextTokens || a.name.localeCompare(b.name);
  const free = rows.filter((row) => row.free).sort(byCost);
  const paid = rows.filter((row) => !row.free).sort(byCost);
  return { matching: rows.length, total: FINDER_ROWS.length, freeCount: free.length, cheapestPaid: paid[0] ?? null, cheapestFree: free[0] ?? null };
}

export function buildSummary(state: FinderState, query = ""): string {
  const rows = findRows(state, query);
  const label = USAGE_PRESETS[state.usage].plain;
  if (rows.length === 0) return `No model matches these filters. Estimates assume ${label}.`;
  const order =
    state.sort === "cost" && state.dir === "asc"
      ? "Lowest estimated cost first"
      : `Sorted by ${SORT_LABEL[state.sort].toLowerCase()}, ${state.dir === "asc" ? "low to high" : "high to low"}`;
  const top = rows
    .slice(0, 3)
    .map((row, index) => {
      const cost = costPerDayUsd(row, state.usage);
      return `${index + 1}. ${row.name} (${WHERE_LABEL[row.where]}): ${row.free ? "free" : `${formatPrice(cost)} a day`}, ${formatContext(row.contextTokens)} context`;
    })
    .join(" ");
  return `${rows.length} of ${FINDER_ROWS.length} models match. ${order} at ${label}: ${top}`;
}

// ---- Shareable link --------------------------------------------------------
// Structured answers only, allow-listed, defaults omitted. The name search is free text and never goes in a link.

export const FINDER_PARAM_KEYS = ["price", "private", "reasoning", "image", "minctx", "where", "usage", "sort", "dir"] as const;

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function parseFinderParams(search: string): FinderState {
  const params = new URLSearchParams(search);
  const sort = pick(params.get("sort"), SORT_KEYS, FINDER_DEFAULTS.sort);
  const dirFallback = sort === FINDER_DEFAULTS.sort ? FINDER_DEFAULTS.dir : defaultDir(sort);
  return {
    price: pick(params.get("price"), PRICE_FILTER_KEYS, FINDER_DEFAULTS.price),
    privateOnly: params.get("private") === "1",
    reasoningOnly: params.get("reasoning") === "1",
    imageOnly: params.get("image") === "1",
    minContext: pick(params.get("minctx"), MIN_CONTEXT_KEYS, FINDER_DEFAULTS.minContext),
    where: pick(params.get("where"), WHERE_FILTER_KEYS, FINDER_DEFAULTS.where),
    usage: pick(params.get("usage"), USAGE_KEYS, FINDER_DEFAULTS.usage),
    sort,
    dir: pick(params.get("dir"), ["asc", "desc"] as const, dirFallback),
  };
}

/** Query string without the leading "?", defaults omitted. Empty string when everything is default. */
export function serializeFinderParams(state: FinderState): string {
  const params = new URLSearchParams();
  if (state.price !== FINDER_DEFAULTS.price) params.set("price", state.price);
  if (state.privateOnly) params.set("private", "1");
  if (state.reasoningOnly) params.set("reasoning", "1");
  if (state.imageOnly) params.set("image", "1");
  if (state.minContext !== FINDER_DEFAULTS.minContext) params.set("minctx", state.minContext);
  if (state.where !== FINDER_DEFAULTS.where) params.set("where", state.where);
  if (state.usage !== FINDER_DEFAULTS.usage) params.set("usage", state.usage);
  if (state.sort !== FINDER_DEFAULTS.sort) params.set("sort", state.sort);
  const dirDefault = state.sort === FINDER_DEFAULTS.sort ? FINDER_DEFAULTS.dir : defaultDir(state.sort);
  if (state.dir !== dirDefault) params.set("dir", state.dir);
  return params.toString();
}
