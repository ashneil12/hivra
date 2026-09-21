export interface VeniceChatModelPrice {
  model: string;
  displayName: string;
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  cacheReadMicroUsdPerMillion?: number | null;
  cacheWriteMicroUsdPerMillion?: number | null;
  contextWindow: number;
  maxOutputTokens: number;
  privacy: "private" | "anonymized" | "e2ee_private";
}

export const VENICE_CHAT_PRICING_CATALOG_UPDATED_AT = "2026-06-09";

// Venice ships pricing changes on its own cadence and we don't yet have
// automated scraping. The drift cron flags the catalog stale after this
// window so an operator re-checks before users overpay (or we eat the
// margin).
//
// TODO(2026-05-17): the static catalog is a reliability hazard — Venice's
// /v1/models endpoint exposes live pricing per model (input.usd, output.usd,
// cache_input.usd) and we're already proxying that endpoint. Move the
// cost-estimator to read from a 5-minute in-memory cache of the live
// endpoint with this static catalog as fallback. Until then, every
// chat/completions request runs checkVeniceChatPricingCatalogStaleness()
// and logs a warning when the window expires (see chat/completions/route.ts).
export const VENICE_CHAT_PRICING_CATALOG_MAX_AGE_DAYS = 30;

export interface VeniceChatPricingCatalogStaleness {
  updatedAt: string;
  ageDays: number;
  maxAgeDays: number;
  stale: boolean;
}

export function checkVeniceChatPricingCatalogStaleness(
  now: Date = new Date(),
  maxAgeDays: number = VENICE_CHAT_PRICING_CATALOG_MAX_AGE_DAYS
): VeniceChatPricingCatalogStaleness {
  const updatedAtMs = Date.parse(`${VENICE_CHAT_PRICING_CATALOG_UPDATED_AT}T00:00:00Z`);
  if (Number.isNaN(updatedAtMs)) {
    throw new Error("VENICE_CHAT_PRICING_CATALOG_UPDATED_AT is not a valid ISO date");
  }
  const ageMs = now.getTime() - updatedAtMs;
  const ageDays = Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1_000)));
  return {
    updatedAt: VENICE_CHAT_PRICING_CATALOG_UPDATED_AT,
    ageDays,
    maxAgeDays,
    stale: ageDays > maxAgeDays,
  };
}

export class UnsupportedVeniceModelError extends Error {
  constructor(model: string) {
    super(`Unsupported Venice chat model: ${model}`);
    this.name = "UnsupportedVeniceModelError";
  }
}

function usdPerMillionToMicroUsd(value: number) {
  return Math.round(value * 1_000_000);
}

function model(params: {
  model: string;
  displayName: string;
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd?: number | null;
  cacheWriteUsd?: number | null;
  contextWindow: number;
  maxOutputTokens?: number;
  privacy: VeniceChatModelPrice["privacy"];
}): VeniceChatModelPrice {
  return {
    model: params.model,
    displayName: params.displayName,
    inputMicroUsdPerMillion: usdPerMillionToMicroUsd(params.inputUsd),
    outputMicroUsdPerMillion: usdPerMillionToMicroUsd(params.outputUsd),
    cacheReadMicroUsdPerMillion:
      params.cacheReadUsd == null ? null : usdPerMillionToMicroUsd(params.cacheReadUsd),
    cacheWriteMicroUsdPerMillion:
      params.cacheWriteUsd == null ? null : usdPerMillionToMicroUsd(params.cacheWriteUsd),
    contextWindow: params.contextWindow,
    maxOutputTokens: params.maxOutputTokens ?? Math.min(8_192, params.contextWindow),
    privacy: params.privacy,
  };
}

// Source: Venice's live `GET /api/v1/models?type=text` endpoint, snapshot
// 2026-05-17. Prices are per 1M tokens converted to microdollars. Privacy
// classification, context window, and max output tokens are also taken from
// the live API (`model_spec.availableContextTokens`,
// `model_spec.maxCompletionTokens`, `model_spec.privacy`).
//
// cacheReadUsd reflects `model_spec.pricing.cache_input.usd`. When omitted,
// Venice doesn't offer a cache rate for that model and the cost-estimator
// falls back to the input rate — same money for the user, conservative for
// our P&L. cacheWriteUsd stays null because Venice's pricing object doesn't
// expose a separate cache-write rate (only Anthropic-style providers do).
//
// IMPORTANT: keep this list in lockstep with the live endpoint. The previous
// catalog was sourced from the human-facing pricing page (docs.venice.ai),
// which omitted cache_input rates entirely and used rounded numbers — that
// caused a ~6× overbill on deepseek-v4-flash (which is heavily cache-served)
// during Hassan's first session. Re-pull whenever Venice ships a new model
// or quietly re-prices an existing one.
export const VENICE_CHAT_MODEL_PRICES: readonly VeniceChatModelPrice[] = [
  // Venice-native uncensored
  model({
    model: "venice-uncensored-1-2",
    displayName: "Venice Uncensored 1.2",
    inputUsd: 0.2,
    outputUsd: 0.9,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    privacy: "private",
  }),
  model({
    model: "venice-uncensored-role-play",
    displayName: "Venice Role Play Uncensored",
    inputUsd: 0.5,
    outputUsd: 2,
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    privacy: "private",
  }),
  model({
    model: "e2ee-venice-uncensored-24b-p",
    displayName: "Venice Uncensored 1.1 (Beta E2EE)",
    inputUsd: 0.25,
    outputUsd: 1.15,
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    privacy: "e2ee_private",
  }),

  // DeepSeek family
  model({
    model: "deepseek-v3.2",
    displayName: "DeepSeek V3.2",
    inputUsd: 0.33,
    outputUsd: 0.48,
    cacheReadUsd: 0.16,
    contextWindow: 160_000,
    maxOutputTokens: 32_768,
    privacy: "private",
  }),
  model({
    model: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    inputUsd: 0.17,
    outputUsd: 0.35,
    cacheReadUsd: 0.028,
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    privacy: "anonymized",
  }),
  model({
    model: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    inputUsd: 1.73,
    outputUsd: 3.796,
    cacheReadUsd: 0.33,
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    privacy: "anonymized",
  }),

  // Kimi family
  model({
    model: "kimi-k2-5",
    displayName: "Kimi K2.5",
    inputUsd: 0.56,
    outputUsd: 3.5,
    cacheReadUsd: 0.22,
    contextWindow: 256_000,
    maxOutputTokens: 65_536,
    privacy: "private",
  }),
  model({
    model: "kimi-k2-6",
    displayName: "Kimi K2.6",
    inputUsd: 0.85,
    outputUsd: 4.655,
    cacheReadUsd: 0.22,
    contextWindow: 256_000,
    maxOutputTokens: 65_536,
    privacy: "private",
  }),

  // GLM family (Z.AI)
  model({
    model: "zai-org-glm-4.6",
    displayName: "GLM 4.6",
    inputUsd: 0.85,
    outputUsd: 2.75,
    cacheReadUsd: 0.3,
    contextWindow: 198_000,
    maxOutputTokens: 16_384,
    privacy: "private",
  }),
  model({
    model: "zai-org-glm-4.7",
    displayName: "GLM 4.7",
    inputUsd: 0.55,
    outputUsd: 2.65,
    cacheReadUsd: 0.11,
    contextWindow: 198_000,
    maxOutputTokens: 16_384,
    privacy: "private",
  }),
  model({
    model: "e2ee-glm-4-7-p",
    displayName: "GLM 4.7 (Beta E2EE)",
    inputUsd: 1.1,
    outputUsd: 4.15,
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    privacy: "private",
  }),
  model({
    model: "zai-org-glm-4.7-flash",
    displayName: "GLM 4.7 Flash",
    inputUsd: 0.125,
    outputUsd: 0.5,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    privacy: "private",
  }),
  model({
    model: "e2ee-glm-4-7-flash-p",
    displayName: "GLM 4.7 Flash (Beta E2EE)",
    inputUsd: 0.13,
    outputUsd: 0.55,
    contextWindow: 198_000,
    maxOutputTokens: 4_096,
    privacy: "private",
  }),
  model({
    model: "olafangensan-glm-4.7-flash-heretic",
    displayName: "GLM 4.7 Flash Heretic (Uncensored)",
    inputUsd: 0.14,
    outputUsd: 0.8,
    contextWindow: 200_000,
    maxOutputTokens: 24_000,
    privacy: "private",
  }),
  model({
    model: "zai-org-glm-5",
    displayName: "GLM 5",
    inputUsd: 1,
    outputUsd: 3.2,
    cacheReadUsd: 0.2,
    contextWindow: 198_000,
    maxOutputTokens: 32_000,
    privacy: "private",
  }),
  model({
    model: "z-ai-glm-5-turbo",
    displayName: "GLM 5 Turbo",
    inputUsd: 1.2,
    outputUsd: 4,
    cacheReadUsd: 0.24,
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
    privacy: "anonymized",
  }),
  model({
    model: "zai-org-glm-5-1",
    displayName: "GLM 5.1 (Beta)",
    inputUsd: 1.75,
    outputUsd: 5.5,
    cacheReadUsd: 0.325,
    contextWindow: 200_000,
    maxOutputTokens: 24_000,
    privacy: "private",
  }),
  model({
    model: "e2ee-glm-5-1",
    displayName: "GLM 5.1 (Beta E2EE)",
    inputUsd: 1.1,
    outputUsd: 4.15,
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
    privacy: "private",
  }),
  model({
    model: "z-ai-glm-5v-turbo",
    displayName: "GLM 5V Turbo (Multimodal Beta)",
    inputUsd: 1.5,
    outputUsd: 5,
    cacheReadUsd: 0.3,
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
    privacy: "anonymized",
  }),

  // Qwen family
  model({
    model: "qwen3-235b-a22b-instruct-2507",
    displayName: "Qwen 3 235B A22B Instruct 2507",
    inputUsd: 0.15,
    outputUsd: 0.75,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    privacy: "private",
  }),
  model({
    model: "qwen3-235b-a22b-thinking-2507",
    displayName: "Qwen 3 235B A22B Thinking 2507",
    inputUsd: 0.45,
    outputUsd: 3.5,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    privacy: "private",
  }),
  model({
    model: "qwen3-coder-480b-a35b-instruct-turbo",
    displayName: "Qwen 3 Coder 480B Turbo",
    inputUsd: 0.35,
    outputUsd: 1.5,
    cacheReadUsd: 0.04,
    contextWindow: 256_000,
    maxOutputTokens: 65_536,
    privacy: "private",
  }),
  model({
    model: "qwen3-next-80b",
    displayName: "Qwen 3 Next 80B",
    inputUsd: 0.35,
    outputUsd: 1.9,
    contextWindow: 256_000,
    maxOutputTokens: 16_384,
    privacy: "private",
  }),
  model({
    model: "qwen3-5-35b-a3b",
    displayName: "Qwen 3.5 35B A3B (Beta)",
    inputUsd: 0.3125,
    outputUsd: 1.25,
    cacheReadUsd: 0.15625,
    contextWindow: 256_000,
    maxOutputTokens: 65_536,
    privacy: "private",
  }),
  model({
    model: "qwen3-5-397b-a17b",
    displayName: "Qwen 3.5 397B",
    inputUsd: 0.75,
    outputUsd: 4.5,
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    privacy: "anonymized",
  }),
  model({
    model: "qwen3-5-9b",
    displayName: "Qwen 3.5 9B",
    inputUsd: 0.1,
    outputUsd: 0.15,
    contextWindow: 256_000,
    maxOutputTokens: 32_768,
    privacy: "private",
  }),
  model({
    model: "qwen3-6-27b",
    displayName: "Qwen 3.6 27B",
    inputUsd: 0.325,
    outputUsd: 3.25,
    contextWindow: 256_000,
    maxOutputTokens: 65_536,
    privacy: "private",
  }),
  model({
    model: "qwen-3-6-plus",
    displayName: "Qwen 3.6 Plus Uncensored (Beta)",
    inputUsd: 0.625,
    outputUsd: 3.75,
    cacheReadUsd: 0.0625,
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    privacy: "anonymized",
  }),
  model({
    model: "qwen3-vl-235b-a22b",
    displayName: "Qwen 3 VL 235B (Vision)",
    inputUsd: 0.25,
    outputUsd: 1.5,
    contextWindow: 256_000,
    maxOutputTokens: 16_384,
    privacy: "private",
  }),
  model({
    model: "e2ee-qwen3-vl-30b-a3b-p",
    displayName: "Qwen 3 VL 30B A3B (Beta E2EE)",
    inputUsd: 0.25,
    outputUsd: 0.9,
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    privacy: "private",
  }),
  model({
    model: "e2ee-qwen3-30b-a3b-p",
    displayName: "Qwen 3 30B A3B (Beta E2EE)",
    inputUsd: 0.19,
    outputUsd: 0.69,
    contextWindow: 256_000,
    maxOutputTokens: 32_768,
    privacy: "private",
  }),
  model({
    model: "e2ee-qwen3-5-122b-a10b",
    displayName: "Qwen 3.5 122B A10B (Beta E2EE)",
    inputUsd: 0.5,
    outputUsd: 4,
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    privacy: "private",
  }),
  model({
    model: "e2ee-qwen-2-5-7b-p",
    displayName: "Qwen 2.5 7B (Beta E2EE)",
    inputUsd: 0.05,
    outputUsd: 0.13,
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    privacy: "private",
  }),

  // Llama family
  model({
    model: "llama-3.2-3b",
    displayName: "Llama 3.2 3B",
    inputUsd: 0.15,
    outputUsd: 0.6,
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    privacy: "private",
  }),
  model({
    model: "llama-3.3-70b",
    displayName: "Llama 3.3 70B",
    inputUsd: 0.7,
    outputUsd: 2.8,
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    privacy: "private",
  }),
  model({
    model: "hermes-3-llama-3.1-405b",
    displayName: "Hermes 3 Llama 3.1 405B",
    inputUsd: 1.1,
    outputUsd: 3,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    privacy: "private",
  }),

  // Mistral
  model({
    model: "mistral-small-3-2-24b-instruct",
    displayName: "Mistral Small 3.2 24B Instruct",
    inputUsd: 0.09375,
    outputUsd: 0.25,
    contextWindow: 256_000,
    maxOutputTokens: 16_384,
    privacy: "private",
  }),
  model({
    model: "mistral-small-2603",
    displayName: "Mistral Small 4 (Beta)",
    inputUsd: 0.1875,
    outputUsd: 0.75,
    contextWindow: 256_000,
    maxOutputTokens: 65_536,
    privacy: "private",
  }),

  // Google Gemma (open-source, hosted on Venice)
  model({
    model: "google-gemma-3-27b-it",
    displayName: "Google Gemma 3 27B Instruct",
    inputUsd: 0.12,
    outputUsd: 0.2,
    contextWindow: 198_000,
    maxOutputTokens: 16_384,
    privacy: "private",
  }),
  model({
    model: "google-gemma-4-26b-a4b-it",
    displayName: "Google Gemma 4 26B A4B Instruct",
    inputUsd: 0.1625,
    outputUsd: 0.5,
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    privacy: "private",
  }),
  model({
    model: "google-gemma-4-31b-it",
    displayName: "Google Gemma 4 31B Instruct",
    inputUsd: 0.175,
    outputUsd: 0.5,
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    privacy: "private",
  }),
  model({
    model: "gemma-4-uncensored",
    displayName: "Gemma 4 Uncensored",
    inputUsd: 0.1625,
    outputUsd: 0.5,
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    privacy: "private",
  }),
  model({
    model: "e2ee-gemma-3-27b-p",
    displayName: "Gemma 3 27B (Beta E2EE)",
    inputUsd: 0.14,
    outputUsd: 0.5,
    contextWindow: 40_000,
    maxOutputTokens: 4_096,
    privacy: "private",
  }),

  // OpenAI proxied (anonymized — Venice forwards to OpenAI)
  model({
    model: "openai-gpt-4o-2024-11-20",
    displayName: "GPT-4o",
    inputUsd: 3.125,
    outputUsd: 12.5,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    privacy: "anonymized",
  }),
  model({
    model: "openai-gpt-4o-mini-2024-07-18",
    displayName: "GPT-4o Mini",
    inputUsd: 0.1875,
    outputUsd: 0.75,
    cacheReadUsd: 0.09375,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    privacy: "anonymized",
  }),
  model({
    model: "openai-gpt-52",
    displayName: "GPT-5.2",
    inputUsd: 2.19,
    outputUsd: 17.5,
    cacheReadUsd: 0.219,
    contextWindow: 256_000,
    maxOutputTokens: 65_536,
    privacy: "anonymized",
  }),
  model({
    model: "openai-gpt-52-codex",
    displayName: "GPT-5.2 Codex",
    inputUsd: 2.19,
    outputUsd: 17.5,
    cacheReadUsd: 0.219,
    contextWindow: 256_000,
    maxOutputTokens: 65_536,
    privacy: "anonymized",
  }),
  model({
    model: "openai-gpt-53-codex",
    displayName: "GPT-5.3 Codex (Beta)",
    inputUsd: 2.19,
    outputUsd: 17.5,
    cacheReadUsd: 0.219,
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    privacy: "anonymized",
  }),
  model({
    model: "openai-gpt-54",
    displayName: "GPT-5.4",
    inputUsd: 3.13,
    outputUsd: 18.8,
    cacheReadUsd: 0.313,
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    privacy: "anonymized",
  }),
  model({
    model: "openai-gpt-54-mini",
    displayName: "GPT-5.4 Mini (Beta)",
    inputUsd: 0.9375,
    outputUsd: 5.625,
    cacheReadUsd: 0.09375,
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    privacy: "anonymized",
  }),
  model({
    model: "openai-gpt-54-pro",
    displayName: "GPT-5.4 Pro (Beta)",
    inputUsd: 37.5,
    outputUsd: 225,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    privacy: "anonymized",
  }),
  model({
    model: "openai-gpt-55",
    displayName: "GPT-5.5 (Beta)",
    inputUsd: 6.25,
    outputUsd: 37.5,
    cacheReadUsd: 0.625,
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    privacy: "anonymized",
  }),
  model({
    model: "openai-gpt-55-pro",
    displayName: "GPT-5.5 Pro (Beta)",
    inputUsd: 37.5,
    outputUsd: 225,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    privacy: "anonymized",
  }),

  // OpenAI GPT OSS (open-source weights, hosted on Venice)
  model({
    model: "openai-gpt-oss-120b",
    displayName: "OpenAI GPT OSS 120B",
    inputUsd: 0.07,
    outputUsd: 0.3,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    privacy: "private",
  }),
  model({
    model: "e2ee-gpt-oss-120b-p",
    displayName: "GPT OSS 120B (Beta E2EE)",
    inputUsd: 0.13,
    outputUsd: 0.65,
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    privacy: "private",
  }),
  model({
    model: "e2ee-gpt-oss-20b-p",
    displayName: "GPT OSS 20B (Beta E2EE)",
    inputUsd: 0.05,
    outputUsd: 0.19,
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    privacy: "private",
  }),

  // Anthropic proxied (anonymized — Venice forwards to Anthropic)
  model({
    model: "claude-opus-4-5",
    displayName: "Claude Opus 4.5",
    inputUsd: 6,
    outputUsd: 30,
    cacheReadUsd: 0.6,
    contextWindow: 198_000,
    maxOutputTokens: 32_768,
    privacy: "anonymized",
  }),
  model({
    model: "claude-opus-4-6",
    displayName: "Claude Opus 4.6 (Beta)",
    inputUsd: 6,
    outputUsd: 30,
    cacheReadUsd: 0.6,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    privacy: "anonymized",
  }),
  model({
    model: "claude-opus-4-6-fast",
    displayName: "Claude Opus 4.6 Fast (Beta)",
    inputUsd: 36,
    outputUsd: 180,
    cacheReadUsd: 3.6,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    privacy: "anonymized",
  }),
  model({
    model: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    inputUsd: 6,
    outputUsd: 30,
    cacheReadUsd: 0.6,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    privacy: "anonymized",
  }),
  model({
    model: "claude-opus-4-7-fast",
    displayName: "Claude Opus 4.7 Fast (Beta)",
    inputUsd: 36,
    outputUsd: 180,
    cacheReadUsd: 3.6,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    privacy: "anonymized",
  }),
  model({
    model: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    inputUsd: 6,
    outputUsd: 30,
    cacheReadUsd: 0.6,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    privacy: "anonymized",
  }),
  model({
    model: "claude-opus-4-8-fast",
    displayName: "Claude Opus 4.8 Fast (Beta)",
    inputUsd: 12,
    outputUsd: 60,
    cacheReadUsd: 1.2,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    privacy: "anonymized",
  }),
  model({
    model: "claude-fable-5",
    displayName: "Claude Fable 5",
    inputUsd: 12,
    outputUsd: 60,
    cacheReadUsd: 1.2,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    privacy: "anonymized",
  }),
  model({
    model: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    inputUsd: 3.75,
    outputUsd: 18.75,
    cacheReadUsd: 0.375,
    contextWindow: 198_000,
    maxOutputTokens: 64_000,
    privacy: "anonymized",
  }),
  model({
    model: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6 (Beta)",
    inputUsd: 3.6,
    outputUsd: 18,
    cacheReadUsd: 0.36,
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    privacy: "anonymized",
  }),

  // Google Gemini proxied (anonymized — Venice forwards to Google)
  model({
    model: "gemini-3-flash-preview",
    displayName: "Gemini 3 Flash Preview",
    inputUsd: 0.7,
    outputUsd: 3.75,
    cacheReadUsd: 0.07,
    contextWindow: 256_000,
    maxOutputTokens: 65_536,
    privacy: "anonymized",
  }),
  model({
    model: "gemini-3-1-pro-preview",
    displayName: "Gemini 3.1 Pro Preview",
    inputUsd: 2.5,
    outputUsd: 15,
    cacheReadUsd: 0.5,
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    privacy: "anonymized",
  }),

  // xAI Grok
  model({
    model: "grok-4-3",
    displayName: "Grok 4.3",
    inputUsd: 1.42,
    outputUsd: 2.83,
    cacheReadUsd: 0.23,
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    privacy: "private",
  }),
  model({
    model: "grok-4-20",
    displayName: "Grok 4.20",
    inputUsd: 1.42,
    outputUsd: 2.83,
    cacheReadUsd: 0.23,
    contextWindow: 2_000_000,
    maxOutputTokens: 128_000,
    privacy: "private",
  }),
  model({
    model: "grok-4-20-multi-agent",
    displayName: "Grok 4.20 Multi-Agent",
    inputUsd: 1.42,
    outputUsd: 2.83,
    cacheReadUsd: 0.23,
    contextWindow: 2_000_000,
    maxOutputTokens: 128_000,
    privacy: "private",
  }),

  // Misc
  model({
    model: "aion-labs-aion-2-0",
    displayName: "Aion 2.0",
    inputUsd: 1,
    outputUsd: 2,
    cacheReadUsd: 0.25,
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    privacy: "anonymized",
  }),
  model({
    model: "arcee-trinity-large-thinking",
    displayName: "Trinity Large Thinking",
    inputUsd: 0.3125,
    outputUsd: 1.125,
    cacheReadUsd: 0.075,
    contextWindow: 256_000,
    maxOutputTokens: 65_536,
    privacy: "private",
  }),
  model({
    model: "mercury-2",
    displayName: "Mercury 2 (Beta)",
    inputUsd: 0.3125,
    outputUsd: 0.9375,
    cacheReadUsd: 0.03125,
    contextWindow: 128_000,
    maxOutputTokens: 50_000,
    privacy: "anonymized",
  }),
  model({
    model: "minimax-m25",
    displayName: "MiniMax M2.5",
    inputUsd: 0.34,
    outputUsd: 1.19,
    cacheReadUsd: 0.04,
    contextWindow: 198_000,
    maxOutputTokens: 32_768,
    privacy: "private",
  }),
  model({
    model: "minimax-m27",
    displayName: "MiniMax M2.7",
    inputUsd: 0.375,
    outputUsd: 1.5,
    cacheReadUsd: 0.075,
    contextWindow: 198_000,
    maxOutputTokens: 32_768,
    privacy: "anonymized",
  }),
  model({
    model: "nvidia-nemotron-cascade-2-30b-a3b",
    displayName: "Nemotron Cascade 2 30B A3B (Beta)",
    inputUsd: 0.14,
    outputUsd: 0.8,
    contextWindow: 256_000,
    maxOutputTokens: 32_768,
    privacy: "private",
  }),
  model({
    model: "nvidia-nemotron-3-nano-30b-a3b",
    displayName: "NVIDIA Nemotron 3 Nano 30B (Beta)",
    inputUsd: 0.075,
    outputUsd: 0.3,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    privacy: "private",
  }),
];

const PRICE_BY_MODEL = new Map(
  VENICE_CHAT_MODEL_PRICES.map((price) => [price.model, price])
);

export function getVeniceChatModelPrice(modelId: string): VeniceChatModelPrice {
  const price = PRICE_BY_MODEL.get(modelId);
  if (!price) throw new UnsupportedVeniceModelError(modelId);
  return price;
}

export function calculateVeniceTokenCostMicroUsd(
  tokens: number,
  microUsdPerMillionTokens: number
) {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new Error("tokens must be a non-negative integer");
  }
  if (
    !Number.isInteger(microUsdPerMillionTokens) ||
    microUsdPerMillionTokens < 0
  ) {
    throw new Error("microUsdPerMillionTokens must be a non-negative integer");
  }
  return Math.ceil((tokens * microUsdPerMillionTokens) / 1_000_000);
}
