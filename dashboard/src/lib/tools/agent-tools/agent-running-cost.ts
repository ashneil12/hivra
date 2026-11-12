// Logic and facts for the AI agent running cost calculator
// (/tools/ai-agent-running-cost-calculator). Pure: no React, no browser APIs.
//
// One always-on agent costs three things: the machine it runs on, the model
// tokens it burns, and (if you choose to count it) your own time. Every price
// shown comes from a table in this file or from the two shared price tables:
// Hivra's managed inference catalog (lib/venice/pricing.ts) and the OpenRouter
// list-price snapshot (agent-tools/openrouter-snapshot.ts). The only invented
// numbers are the usage presets, and the page labels them as our assumptions.

import {
  ENTRY_PLAN_PRICE,
  LARGER_PLAN_PRICE,
  formatPlanSize,
} from "@/lib/blog/plan-facts";
import {
  VENICE_CHAT_MODEL_PRICES,
  VENICE_CHAT_PRICING_CATALOG_UPDATED_AT,
} from "@/lib/venice/pricing";
import {
  OPENROUTER_MODELS,
  OPENROUTER_SNAPSHOT_DATE,
} from "./openrouter-snapshot";

export const RUNNING_COST_FACTS = {
  lastVerified: "2026-11-12",
  /**
   * VPS list prices in USD, copied from HostingCostCalculatorTool.tsx (RATES) with its original
   * check date. Hetzner's own page (cost-optimized range) was re-read on 2026-11-12: it now lists
   * the CX23 in euros as "currently unavailable", so the dollar figure below is still the
   * September one and the page says that plainly.
   */
  vps: {
    lastVerified: "2026-09-24",
    rows: {
      hetznerCx23: {
        label: "Hetzner CX23 (2 vCPU, 4 GB, 40 GB)",
        monthlyUsd: 7.09,
        limitedAvailability: true,
      },
      vultr1gb: {
        label: "Vultr Cloud Compute (1 vCPU, 1 GB, 25 GB)",
        monthlyUsd: 5,
        limitedAvailability: false,
      },
      vultr4gb: {
        label: "Vultr Cloud Compute (2 vCPU, 4 GB, 80 GB)",
        monthlyUsd: 20,
        limitedAvailability: false,
      },
      do1gb: {
        label: "DigitalOcean Basic (1 vCPU, 1 GB, 25 GB)",
        monthlyUsd: 6,
        limitedAvailability: false,
      },
      do4gb: {
        label: "DigitalOcean Basic (2 vCPU, 4 GB, 80 GB)",
        monthlyUsd: 24,
        limitedAvailability: false,
      },
      lightsail1gb: {
        label: "AWS Lightsail (2 vCPU, 1 GB, 40 GB)",
        monthlyUsd: 7,
        limitedAvailability: false,
      },
      lightsail4gb: {
        label: "AWS Lightsail (2 vCPU, 4 GB, 80 GB)",
        monthlyUsd: 24,
        limitedAvailability: false,
      },
    },
    sources: [
      "https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/",
      "https://www.hetzner.com/cloud/cost-optimized",
      "https://www.digitalocean.com/pricing/droplets",
      "https://api.vultr.com/v2/plans",
      "https://aws.amazon.com/lightsail/pricing/",
    ],
  },
  /** Hivra's hosted sizes. Price and size are read from the billing constants. */
  hivra: {
    entryMonthlyUsd: Number(ENTRY_PLAN_PRICE.replace("$", "")),
    largerMonthlyUsd: Number(LARGER_PLAN_PRICE.replace("$", "")),
  },
  models: {
    hivraCatalogUpdatedAt: VENICE_CHAT_PRICING_CATALOG_UPDATED_AT,
    openRouterSnapshotDate: OPENROUTER_SNAPSHOT_DATE,
    sources: [
      "https://openrouter.ai/models",
      "https://openrouter.ai/docs/api-reference/limits",
    ],
  },
  /** OpenRouter's published limits for its free models, read 2026-11-12. */
  freeModelLimits: {
    requestsPerMinute: 20,
    requestsPerDayUnder10Credits: 50,
    requestsPerDayWith10Credits: 1000,
    source: "https://openrouter.ai/docs/api-reference/limits",
  },
  agents: {
    openclaw: {
      license: "MIT",
      noPaidTier: true,
      source: "https://github.com/openclaw/openclaw",
    },
    hermes: {
      license: "MIT",
      source: "https://github.com/NousResearch/hermes-agent",
    },
  },
} as const;

// ---- Servers ----------------------------------------------------------------

export type VpsKey = keyof typeof RUNNING_COST_FACTS.vps.rows;
export const VPS_KEYS = Object.keys(RUNNING_COST_FACTS.vps.rows) as VpsKey[];

export type ServerKey = "laptop" | VpsKey | "hivra-entry" | "hivra-larger";
export const SERVER_KEYS: readonly ServerKey[] = [
  "laptop",
  ...VPS_KEYS,
  "hivra-entry",
  "hivra-larger",
];

export interface ServerOption {
  key: ServerKey;
  label: string;
  monthlyUsd: number;
  kind: "laptop" | "vps" | "hivra";
  note: string;
}

export const SERVER_OPTIONS: readonly ServerOption[] = [
  {
    key: "laptop",
    label: "A laptop or desktop you already own",
    monthlyUsd: 0,
    kind: "laptop",
    note: "No server bill, and electricity is not counted. It sleeps when the lid closes or the machine idles, so the agent only works while it is awake.",
  },
  ...VPS_KEYS.map(
    (key): ServerOption => ({
      key,
      label: RUNNING_COST_FACTS.vps.rows[key].label,
      monthlyUsd: RUNNING_COST_FACTS.vps.rows[key].monthlyUsd,
      kind: "vps",
      note: RUNNING_COST_FACTS.vps.rows[key].limitedAvailability
        ? "Hetzner's own page for this range says the number of servers is limited, and showed this size as unavailable when we looked in November 2026."
        : "List price before tax, with a public IPv4 address.",
    }),
  ),
  {
    key: "hivra-entry",
    label: `Hivra computer (${formatPlanSize("entry")})`,
    monthlyUsd: RUNNING_COST_FACTS.hivra.entryMonthlyUsd,
    kind: "hivra",
    note: "Hivra installs and runs the official agent for you. The model is priced separately here.",
  },
  {
    key: "hivra-larger",
    label: `Hivra computer (${formatPlanSize("larger")})`,
    monthlyUsd: RUNNING_COST_FACTS.hivra.largerMonthlyUsd,
    kind: "hivra",
    note: "More room for heavier agents or a browser. The model is priced separately here.",
  },
];

export function getServer(key: ServerKey): ServerOption {
  return (
    SERVER_OPTIONS.find((option) => option.key === key) ?? SERVER_OPTIONS[0]
  );
}

// ---- Models -----------------------------------------------------------------

export type ModelSource = "hivra" | "openrouter";

export interface ModelOption {
  /** "hivra:<venice model id>" or "openrouter:<openrouter id>". Safe in a link. */
  key: string;
  label: string;
  source: ModelSource;
  inputUsdPerM: number;
  outputUsdPerM: number;
  free: boolean;
}

export const HIVRA_MODELS: readonly ModelOption[] =
  VENICE_CHAT_MODEL_PRICES.map(
    (price): ModelOption => ({
      key: `hivra:${price.model}`,
      label: price.displayName,
      source: "hivra",
      inputUsdPerM: price.inputMicroUsdPerMillion / 1_000_000,
      outputUsdPerM: price.outputMicroUsdPerMillion / 1_000_000,
      free: false,
    }),
  ).sort((a, b) => a.label.localeCompare(b.label));

export const OPENROUTER_OPTIONS: readonly ModelOption[] = OPENROUTER_MODELS.map(
  (row): ModelOption => ({
    key: `openrouter:${row.id}`,
    label: row.name,
    source: "openrouter",
    inputUsdPerM: row.inputUsdPerM,
    outputUsdPerM: row.outputUsdPerM,
    free: row.free,
  }),
).sort((a, b) => a.label.localeCompare(b.label));

export const ALL_MODELS: readonly ModelOption[] = [
  ...HIVRA_MODELS,
  ...OPENROUTER_OPTIONS,
];

/** Hermes on a Hivra computer defaults to this model (docs/STATUS.md). */
export const DEFAULT_MODEL_KEY = "hivra:deepseek-v4-1-flash";

export function getModel(key: string): ModelOption {
  return (
    ALL_MODELS.find((model) => model.key === key) ??
    ALL_MODELS.find((model) => model.key === DEFAULT_MODEL_KEY) ??
    ALL_MODELS[0]
  );
}

// ---- Usage ------------------------------------------------------------------

/**
 * Our assumptions, not measurements. A chat message to an agent is not one model call: the agent
 * re-reads its instructions and the conversation, calls tools and reads the results, so one message
 * can move tens of thousands of tokens. Prompt caching, which makes repeat input cheaper on many
 * models, is not modelled, so these numbers lean high for models that cache.
 */
export const USAGE_PRESETS = {
  light: {
    label: "Light",
    messagesPerDay: 10,
    tokensPerMessage: 20_000,
    plain: "10 messages a day, about 20,000 tokens each",
  },
  typical: {
    label: "Typical",
    messagesPerDay: 40,
    tokensPerMessage: 40_000,
    plain: "40 messages a day, about 40,000 tokens each",
  },
  heavy: {
    label: "Heavy",
    messagesPerDay: 150,
    tokensPerMessage: 80_000,
    plain: "150 messages a day, about 80,000 tokens each",
  },
} as const;

export type UsageKey = keyof typeof USAGE_PRESETS | "custom";
export const USAGE_KEYS: readonly UsageKey[] = [
  "light",
  "typical",
  "heavy",
  "custom",
];

/** Days in the month the cost is stated for. */
export const DAYS_PER_MONTH = 30;
/** Our assumption: how much of the tokens moved are input (the context re-read) and how much are output. */
export const INPUT_SHARE = 0.85;

export const LIMITS = {
  maxMessagesPerDay: 10_000,
  maxTokensPerMessage: 2_000_000,
  maxHours: 200,
  maxRate: 1_000,
} as const;

// ---- Input, defaults and costs ---------------------------------------------

export interface RunningCostInput {
  server: ServerKey;
  model: string;
  usage: UsageKey;
  messagesPerDay: number;
  tokensPerMessage: number;
  countTime: boolean;
  hoursPerMonth: number;
  hourlyRate: number;
}

export const RUNNING_COST_DEFAULTS: RunningCostInput = {
  server: "hetznerCx23",
  model: DEFAULT_MODEL_KEY,
  usage: "typical",
  messagesPerDay: USAGE_PRESETS.typical.messagesPerDay,
  tokensPerMessage: USAGE_PRESETS.typical.tokensPerMessage,
  countTime: false,
  // The hosting cost calculator's starting guesses: 2 hours maintenance plus 1 hour recovery a month.
  hoursPerMonth: 3,
  hourlyRate: 50,
};

export function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), max);
}

export function effectiveUsage(input: RunningCostInput): {
  messagesPerDay: number;
  tokensPerMessage: number;
} {
  if (input.usage === "custom") {
    return {
      messagesPerDay: clamp(input.messagesPerDay, LIMITS.maxMessagesPerDay),
      tokensPerMessage: clamp(
        input.tokensPerMessage,
        LIMITS.maxTokensPerMessage,
      ),
    };
  }
  const preset = USAGE_PRESETS[input.usage];
  return {
    messagesPerDay: preset.messagesPerDay,
    tokensPerMessage: preset.tokensPerMessage,
  };
}

export interface RunningCost {
  serverUsd: number;
  tokensUsd: number;
  timeUsd: number;
  totalUsd: number;
  monthlyTokens: number;
  /** Share of the total, 0 to 1, each. Zero when the total is zero. */
  shares: { server: number; tokens: number; time: number };
}

export function tokenCostUsd(
  model: ModelOption,
  monthlyTokens: number,
): number {
  const inputTokens = monthlyTokens * INPUT_SHARE;
  const outputTokens = monthlyTokens - inputTokens;
  return (
    (inputTokens / 1_000_000) * model.inputUsdPerM +
    (outputTokens / 1_000_000) * model.outputUsdPerM
  );
}

/** Hours only apply to a machine you look after yourself; a Hivra computer counts as 0 hours here. */
export function timeCostUsd(input: RunningCostInput): number {
  if (!input.countTime || getServer(input.server).kind === "hivra") return 0;
  return (
    clamp(input.hoursPerMonth, LIMITS.maxHours) *
    clamp(input.hourlyRate, LIMITS.maxRate)
  );
}

export function computeRunningCost(input: RunningCostInput): RunningCost {
  const { messagesPerDay, tokensPerMessage } = effectiveUsage(input);
  const monthlyTokens = messagesPerDay * tokensPerMessage * DAYS_PER_MONTH;
  const serverUsd = getServer(input.server).monthlyUsd;
  const tokensUsd = tokenCostUsd(getModel(input.model), monthlyTokens);
  const timeUsd = timeCostUsd(input);
  const totalUsd = serverUsd + tokensUsd + timeUsd;
  const share = (part: number) => (totalUsd > 0 ? part / totalUsd : 0);
  return {
    serverUsd,
    tokensUsd,
    timeUsd,
    totalUsd,
    monthlyTokens,
    shares: {
      server: share(serverUsd),
      tokens: share(tokensUsd),
      time: share(timeUsd),
    },
  };
}

// ---- Words ------------------------------------------------------------------

export function formatUsd(value: number): string {
  if (value >= 100) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${value.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000)
    return `${(tokens / 1_000_000_000).toFixed(1)} billion`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)} million`;
  if (tokens >= 1_000)
    return `${Math.round(tokens / 1_000).toLocaleString("en-US")},000`;
  return String(Math.round(tokens));
}

/** The same usage and model on Hivra's entry computer, for the "DIY or Hivra" comparison. */
export function costOnHivraEntry(input: RunningCostInput): RunningCost {
  return computeRunningCost({ ...input, server: "hivra-entry" });
}

/** The one-line summary of a result, held equal to the worked examples on the page. */
export function buildSummary(input: RunningCostInput): string {
  const cost = computeRunningCost(input);
  const model = getModel(input.model);
  const server = getServer(input.server);
  return `${server.label}: ${formatUsd(cost.serverUsd)}. ${model.label}: ${formatUsd(cost.tokensUsd)}. Your time: ${formatUsd(cost.timeUsd)}. Total: ${formatUsd(cost.totalUsd)} a month.`;
}

/**
 * The plain verdict: where the money goes, and when DIY or a free model wins. Never pushes a
 * product; when the other option is the cheaper one it says so.
 */
export function buildVerdict(input: RunningCostInput): string {
  const cost = computeRunningCost(input);
  const model = getModel(input.model);
  const server = getServer(input.server);
  const parts: string[] = [];

  if (model.free) {
    const limits = RUNNING_COST_FACTS.freeModelLimits;
    parts.push(
      `A free model takes the token bill to $0, so the machine is the whole cost${server.kind === "hivra" ? "" : `: ${formatUsd(cost.totalUsd)} a month`}. The catch is the limits. OpenRouter caps its free models at ${limits.requestsPerMinute} requests a minute and ${limits.requestsPerDayUnder10Credits} a day, or ${limits.requestsPerDayWith10Credits.toLocaleString("en-US")} a day once you have bought 10 credits. One agent message can use several requests, and free models can change or disappear. Fine for light use or learning, a poor fit for an agent you rely on.`,
    );
  } else if (cost.totalUsd > 0 && cost.shares.tokens >= 0.5) {
    parts.push(
      `Model tokens are ${Math.round(cost.shares.tokens * 100)}% of this bill (${formatUsd(cost.tokensUsd)} of ${formatUsd(cost.totalUsd)}). The machine matters less than the model you pick and how much the agent does.`,
    );
  } else {
    parts.push(
      `Total: ${formatUsd(cost.totalUsd)} a month, of which the machine is ${formatUsd(cost.serverUsd)} and tokens ${formatUsd(cost.tokensUsd)}.`,
    );
  }

  if (server.kind === "laptop") {
    parts.push(
      "A laptop you already own is the cheapest machine there is, and DIY wins on dollars. The price is that it sleeps: the agent stops answering when the lid closes, so it suits agents you use while you are at the desk.",
    );
  } else if (server.kind === "vps") {
    const hivra = costOnHivraEntry(input);
    const diff = Math.abs(cost.totalUsd - hivra.totalUsd);
    if (cost.totalUsd < hivra.totalUsd) {
      parts.push(
        `With your time ${input.countTime ? "counted" : "not counted"}, this VPS comes out ${formatUsd(diff)} a month cheaper than a Hivra computer (${formatUsd(hivra.totalUsd)}). If you are happy to run it yourself, DIY wins.`,
      );
    } else if (cost.totalUsd > hivra.totalUsd) {
      parts.push(
        `This VPS costs ${formatUsd(diff)} a month more than a Hivra computer for the same usage (${formatUsd(hivra.totalUsd)}), so there is no price reason to prefer it.`,
      );
    } else {
      parts.push(
        `This VPS costs the same as a Hivra computer for the same usage (${formatUsd(hivra.totalUsd)}).`,
      );
    }
    if (!input.countTime) {
      parts.push(
        "Your own time is not counted. Turn it on to see where a hands-off machine starts to win.",
      );
    }
  } else {
    if (server.key === "hivra-entry") {
      const cheapestSameSize = Math.min(
        RUNNING_COST_FACTS.vps.rows.vultr4gb.monthlyUsd,
        RUNNING_COST_FACTS.vps.rows.do4gb.monthlyUsd,
        RUNNING_COST_FACTS.vps.rows.lightsail4gb.monthlyUsd,
      );
      parts.push(
        `A Hivra computer is ${formatPlanSize("entry")}. A VPS with 2 vCPU and 4 GB lists from ${formatUsd(cheapestSameSize)}, so if you will install and maintain it yourself, DIY is cheaper in dollars. You pay Hivra for the setup and upkeep you skip. The model line is priced separately in this tool.`,
      );
    } else {
      parts.push(
        `A Hivra computer is ${formatPlanSize("larger")}. The VPS options in this tool are smaller than that, so they are not a like-for-like price comparison. Price a VPS of the same size yourself if you want to compare. You pay Hivra for the setup and upkeep you skip. The model line is priced separately in this tool.`,
      );
    }
  }
  return parts.join(" ");
}

// ---- Links ------------------------------------------------------------------

/** The query keys this tool owns. Every other key in the address is left alone. */
export const RUNNING_COST_PARAM_KEYS = [
  "server",
  "model",
  "usage",
  "msgs",
  "tokens",
  "time",
  "hours",
  "rate",
] as const;

function pick<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

function whole(raw: string | null, max: number, fallback: number): number {
  if (raw === null || !/^\d{1,9}$/.test(raw)) return fallback;
  return clamp(Number.parseInt(raw, 10), max);
}

/** Parse a query string into the inputs. Unknown or out-of-range values fall back to the default. */
export function parseRunningCostParams(search: string): RunningCostInput {
  const params = new URLSearchParams(search);
  const d = RUNNING_COST_DEFAULTS;
  const model = params.get("model");
  const usage = pick(params.get("usage"), USAGE_KEYS, d.usage);
  return {
    server: pick(params.get("server"), SERVER_KEYS, d.server),
    model: ALL_MODELS.some((option) => option.key === model)
      ? (model as string)
      : d.model,
    usage,
    messagesPerDay:
      usage === "custom"
        ? whole(params.get("msgs"), LIMITS.maxMessagesPerDay, d.messagesPerDay)
        : d.messagesPerDay,
    tokensPerMessage:
      usage === "custom"
        ? whole(
            params.get("tokens"),
            LIMITS.maxTokensPerMessage,
            d.tokensPerMessage,
          )
        : d.tokensPerMessage,
    countTime: params.get("time") === "1",
    hoursPerMonth: whole(params.get("hours"), LIMITS.maxHours, d.hoursPerMonth),
    hourlyRate: whole(params.get("rate"), LIMITS.maxRate, d.hourlyRate),
  };
}

/** The query string (no "?") for the inputs: only non-default, link-safe values. */
export function serializeRunningCostParams(input: RunningCostInput): string {
  const d = RUNNING_COST_DEFAULTS;
  const params = new URLSearchParams();
  if (input.server !== d.server) params.set("server", input.server);
  if (input.model !== d.model) params.set("model", input.model);
  if (input.usage !== d.usage) params.set("usage", input.usage);
  if (input.usage === "custom") {
    params.set(
      "msgs",
      String(Math.round(clamp(input.messagesPerDay, LIMITS.maxMessagesPerDay))),
    );
    params.set(
      "tokens",
      String(
        Math.round(clamp(input.tokensPerMessage, LIMITS.maxTokensPerMessage)),
      ),
    );
  }
  if (input.countTime) {
    params.set("time", "1");
    if (input.hoursPerMonth !== d.hoursPerMonth)
      params.set(
        "hours",
        String(Math.round(clamp(input.hoursPerMonth, LIMITS.maxHours))),
      );
    if (input.hourlyRate !== d.hourlyRate)
      params.set(
        "rate",
        String(Math.round(clamp(input.hourlyRate, LIMITS.maxRate))),
      );
  }
  return params.toString();
}
