import { multiplyMicrodollarsByRatio } from "@/lib/billing/microdollars";
import {
  UnsupportedVeniceModelError,
  calculateVeniceTokenCostMicroUsd,
  getVeniceChatModelPrice,
  type VeniceChatModelPrice,
} from "./pricing";

export type VenicePricingMap = ReadonlyMap<string, VeniceChatModelPrice>;

function resolvePrice(modelId: string, pricingMap?: VenicePricingMap): VeniceChatModelPrice {
  if (pricingMap) {
    const fromMap = pricingMap.get(modelId);
    if (fromMap) return fromMap;
    // Fall through to static so a model that exists in our catalog but
    // didn't come back from /v1/models (Venice quietly delisted it, network
    // hiccup, etc.) still settles.
    try {
      return getVeniceChatModelPrice(modelId);
    } catch {
      throw new UnsupportedVeniceModelError(modelId);
    }
  }
  return getVeniceChatModelPrice(modelId);
}

// When the caller does not declare an output ceiling we still have to
// reserve *something* up-front. Using the model's full maxOutputTokens
// (up to 16,384 on GPT-5.4) holds ~$0.34 per request even if the
// response is 50 tokens, which causes false 402s for users with
// realistic top-ups. 4,096 is enough headroom for the vast majority of
// chat completions while keeping reservations proportionate to a small
// wallet balance. Over-runs are reconciled at capture time.
export const RESERVATION_OUTPUT_TOKEN_DEFAULT = 4_096;

type ChatMessage = {
  role?: string;
  content?: unknown;
  name?: string;
  tool_calls?: unknown;
  function_call?: unknown;
};

export class MissingVeniceUsageError extends Error {
  constructor(message = "Venice usage is missing required token counts") {
    super(message);
    this.name = "MissingVeniceUsageError";
  }
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new MissingVeniceUsageError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function countTextCharacters(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === null || value === undefined) return 0;

  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countTextCharacters(item), 0);
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text.length;
    }
    if (typeof record.content === "string") {
      return record.content.length;
    }
    return JSON.stringify(value).length;
  }

  return String(value).length;
}

function estimateInputCharacters(request: {
  messages?: ChatMessage[];
  tools?: unknown;
  functions?: unknown;
  response_format?: unknown;
}) {
  const messageCharacters = Array.isArray(request.messages)
      ? request.messages.reduce((sum, message) => {
        return (
          sum +
          countTextCharacters(message.content) +
          countTextCharacters(message.tool_calls) +
          countTextCharacters(message.function_call)
        );
      }, 0)
    : 0;

  const toolCharacters =
    request.tools === undefined ? 0 : JSON.stringify(request.tools).length;
  const functionCharacters =
    request.functions === undefined ? 0 : JSON.stringify(request.functions).length;
  const responseFormatCharacters =
    request.response_format === undefined
      ? 0
      : JSON.stringify(request.response_format).length;

  return messageCharacters + toolCharacters + functionCharacters + responseFormatCharacters;
}

export function estimateChatCompletionCost(
  request: {
    model: string;
    messages?: ChatMessage[];
    max_completion_tokens?: number;
    max_tokens?: number;
    n?: number;
    tools?: unknown;
    functions?: unknown;
    response_format?: unknown;
  },
  pricingMap?: VenicePricingMap,
) {
  const price = resolvePrice(request.model, pricingMap);
  const inputCharacters = estimateInputCharacters(request);
  const inputTokens = Math.ceil(inputCharacters / 3);
  const explicitOutputCap =
    request.max_completion_tokens !== undefined
      ? requirePositiveInteger(request.max_completion_tokens, "max_completion_tokens")
      : request.max_tokens !== undefined
        ? requirePositiveInteger(request.max_tokens, "max_tokens")
        : null;
  // When the caller is explicit, trust them — they accepted the cost of
  // that ceiling. When they aren't, reserve against a defensive default
  // rather than the model's native max; Venice still streams the full
  // response and any overage is captured against the wallet at settle
  // time (or flagged for reconciliation if it can't be covered).
  const outputCap =
    explicitOutputCap ?? Math.min(price.maxOutputTokens, RESERVATION_OUTPUT_TOKEN_DEFAULT);
  const outputChoices =
    request.n === undefined ? 1 : requirePositiveInteger(request.n, "n");
  const outputTokens = outputCap * outputChoices;

  const inputCostMicroUsd = calculateVeniceTokenCostMicroUsd(
    inputTokens,
    price.inputMicroUsdPerMillion
  );
  const outputCostMicroUsd = calculateVeniceTokenCostMicroUsd(
    outputTokens,
    price.outputMicroUsdPerMillion
  );
  const estimatedCostMicroUsd = inputCostMicroUsd + outputCostMicroUsd;
  const reservedCostMicroUsd = multiplyMicrodollarsByRatio(
    estimatedCostMicroUsd,
    110,
    100
  );

  return {
    model: price.model,
    inputCharacters,
    inputTokens,
    outputTokens,
    outputChoices,
    outputCapExplicit: explicitOutputCap !== null,
    inputCostMicroUsd,
    outputCostMicroUsd,
    estimatedCostMicroUsd,
    reservedCostMicroUsd,
    safetyBufferBps: 1000,
  };
}

export function calculateActualChatCost(
  params: {
    model: string;
    promptTokens: number | null | undefined;
    completionTokens: number | null | undefined;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
  },
  pricingMap?: VenicePricingMap,
) {
  const price = resolvePrice(params.model, pricingMap);
  const promptTokens = requireNonNegativeInteger(params.promptTokens, "promptTokens");
  const completionTokens = requireNonNegativeInteger(
    params.completionTokens,
    "completionTokens"
  );
  const cacheReadTokens = params.cacheReadTokens ?? 0;
  const cacheWriteTokens = params.cacheWriteTokens ?? 0;
  requireNonNegativeInteger(cacheReadTokens, "cacheReadTokens");
  requireNonNegativeInteger(cacheWriteTokens, "cacheWriteTokens");

  const promptCostMicroUsd = calculateVeniceTokenCostMicroUsd(
    promptTokens,
    price.inputMicroUsdPerMillion
  );
  const completionCostMicroUsd = calculateVeniceTokenCostMicroUsd(
    completionTokens,
    price.outputMicroUsdPerMillion
  );
  const cacheReadCostMicroUsd = calculateVeniceTokenCostMicroUsd(
    cacheReadTokens,
    price.cacheReadMicroUsdPerMillion ?? price.inputMicroUsdPerMillion
  );
  const cacheWriteCostMicroUsd = calculateVeniceTokenCostMicroUsd(
    cacheWriteTokens,
    price.cacheWriteMicroUsdPerMillion ?? price.inputMicroUsdPerMillion
  );
  const actualCostMicroUsd =
    promptCostMicroUsd +
    completionCostMicroUsd +
    cacheReadCostMicroUsd +
    cacheWriteCostMicroUsd;

  return {
    model: price.model,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    promptCostMicroUsd,
    completionCostMicroUsd,
    cacheReadCostMicroUsd,
    cacheWriteCostMicroUsd,
    actualCostMicroUsd,
  };
}
