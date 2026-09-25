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

/** The price row (rates, context window, max output) the estimator uses for a model. */
export function resolveVeniceChatPrice(
  modelId: string,
  pricingMap?: VenicePricingMap
): VeniceChatModelPrice {
  return resolvePrice(modelId, pricingMap);
}

// What a chat hold covers (security review 2026-09, Medium "Managed-Venice
// overage"): everything the request, AS FORWARDED, can make Venice bill.
//
// Output: Venice's contract is that a missing (or non-positive) `max_tokens`
// means "the model's default maximum", and `max_completion_tokens` bounds
// visible plus reasoning tokens. So a request with no cap can run to the
// model's published maximum (`maxCompletionTokens`, e.g. 128,000 on the
// Claude Opus models). The previous 4,096-token default held about 1/31 of
// that, and the overage debit at capture fails on a small wallet, so Hivra
// paid the rest. The hold is now the model maximum, or the request's own cap
// when that is smaller. When both cap fields are sent, the larger one counts,
// because nothing in the contract says which one Venice honours. Callers that
// cannot afford the worst case get a lower cap written into the forwarded
// request instead (see chat-output-budget.ts), so the hold still covers it.
//
// Input: text is counted at 3 ASCII characters per token (typical English,
// code and JSON run at 3.5 to 4) plus one token per non-ASCII UTF-16 unit
// (CJK text runs close to one token per character, so counting it at a third
// under-held CJK prompts about threefold). Every image part counts at least
// IMAGE_INPUT_TOKEN_FLOOR, since a short URL can stand for a large image. The
// total is capped at the model's context window: a request cannot bill more
// prompt than the model accepts. Adversarial token-dense ASCII (long digit or
// symbol runs) can still reach about one token per character, three times
// this estimate; that residual is bounded by the context window and is
// debited as overage at capture.

/** Visual-token allowance per image part. 16,384 is Qwen-VL's default
 * per-image maximum, the largest default we know of among the vision families
 * Venice serves (Claude, GPT and Gemini spend a few thousand at most). It is
 * an allowance, not a measured Venice bill. */
export const IMAGE_INPUT_TOKEN_FLOOR = 16_384;

/** The chat hold buffer on top of the estimate (10%). */
const RESERVATION_BUFFER_NUMERATOR = 110;
const RESERVATION_BUFFER_DENOMINATOR = 100;

type ChatMessage = {
  role?: string;
  content?: unknown;
  name?: string;
  tool_calls?: unknown;
  function_call?: unknown;
  reasoning_content?: unknown;
};

export class MissingVeniceUsageError extends Error {
  constructor(message = "Venice usage is missing required token counts") {
    super(message);
    this.name = "MissingVeniceUsageError";
  }
}

/** A chat request the managed proxy will not price or forward (maps to a 400). */
export class InvalidVeniceChatRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVeniceChatRequestError";
  }
}

/**
 * Read an output-cap or `n` field: absent/null means "not sent"; anything else
 * must be a positive safe integer. Venice treats a non-positive `max_tokens`
 * as "use the model maximum", so it is refused rather than priced low.
 */
export function readVeniceChatPositiveInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new InvalidVeniceChatRequestError(`${label} must be a positive integer`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new MissingVeniceUsageError(`${label} must be a non-negative integer`);
  }
  return value as number;
}

interface InputTally {
  characters: number;
  asciiUnits: number;
  otherUnits: number;
  imageTokens: number;
}

function tallyString(text: string, tally: InputTally) {
  tally.characters += text.length;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 0x80) tally.asciiUnits += 1;
    else tally.otherUnits += 1;
  }
}

function textTokens(tally: Pick<InputTally, "asciiUnits" | "otherUnits">) {
  return Math.ceil(tally.asciiUnits / 3) + tally.otherUnits;
}

const IMAGE_PART_TYPES = new Set(["image_url", "input_image", "image"]);

function tallyValue(value: unknown, tally: InputTally) {
  if (typeof value === "string") {
    tallyString(value, tally);
    return;
  }
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    for (const item of value) tallyValue(item, tally);
    return;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.type === "string" && IMAGE_PART_TYPES.has(record.type)) {
      const part: InputTally = { characters: 0, asciiUnits: 0, otherUnits: 0, imageTokens: 0 };
      tallyString(JSON.stringify(value), part);
      tally.characters += part.characters;
      tally.imageTokens += Math.max(textTokens(part), IMAGE_INPUT_TOKEN_FLOOR);
      return;
    }
    if (typeof record.text === "string") {
      tallyString(record.text, tally);
      return;
    }
    if (typeof record.content === "string") {
      tallyString(record.content, tally);
      return;
    }
    tallyString(JSON.stringify(value), tally);
    return;
  }

  tallyString(String(value), tally);
}

function tallyJson(value: unknown, tally: InputTally) {
  if (value === undefined) return;
  tallyString(JSON.stringify(value), tally);
}

function estimateInput(request: {
  messages?: ChatMessage[];
  tools?: unknown;
  functions?: unknown;
  response_format?: unknown;
}): InputTally {
  const tally: InputTally = { characters: 0, asciiUnits: 0, otherUnits: 0, imageTokens: 0 };
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      if (!message || typeof message !== "object") continue;
      tallyValue(message.content, tally);
      tallyValue(message.tool_calls, tally);
      tallyValue(message.function_call, tally);
      tallyValue(message.reasoning_content, tally);
    }
  }
  tallyJson(request.tools, tally);
  tallyJson(request.functions, tally);
  tallyJson(request.response_format, tally);
  return tally;
}

export interface VeniceChatEstimateRequest {
  model: string;
  messages?: ChatMessage[];
  max_completion_tokens?: unknown;
  max_tokens?: unknown;
  n?: unknown;
  tools?: unknown;
  functions?: unknown;
  response_format?: unknown;
  [key: string]: unknown;
}

/**
 * The per-choice output cap Venice can run a request to, as forwarded:
 * the larger of the sent cap fields, else the model maximum, never above the
 * model maximum. Throws InvalidVeniceChatRequestError for a malformed cap.
 */
export function worstCaseVeniceChatOutputCap(
  request: Pick<VeniceChatEstimateRequest, "max_completion_tokens" | "max_tokens">,
  price: Pick<VeniceChatModelPrice, "maxOutputTokens">
): number {
  const caps = [
    readVeniceChatPositiveInteger(request.max_completion_tokens, "max_completion_tokens"),
    readVeniceChatPositiveInteger(request.max_tokens, "max_tokens"),
  ].filter((cap): cap is number => cap !== null);
  const requested = caps.length ? Math.max(...caps) : price.maxOutputTokens;
  return Math.min(requested, price.maxOutputTokens);
}

export function estimateChatCompletionCost(
  request: VeniceChatEstimateRequest,
  pricingMap?: VenicePricingMap,
) {
  const price = resolvePrice(request.model, pricingMap);
  const input = estimateInput(request);
  const inputTokens = Math.min(textTokens(input) + input.imageTokens, price.contextWindow);
  const outputCap = worstCaseVeniceChatOutputCap(request, price);
  const outputChoices = readVeniceChatPositiveInteger(request.n, "n") ?? 1;
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
    RESERVATION_BUFFER_NUMERATOR,
    RESERVATION_BUFFER_DENOMINATOR
  );

  return {
    model: price.model,
    inputCharacters: input.characters,
    inputTokens,
    outputCap,
    outputTokens,
    outputChoices,
    modelMaxOutputTokens: price.maxOutputTokens,
    outputCapExplicit:
      request.max_completion_tokens != null || request.max_tokens != null,
    inputCostMicroUsd,
    outputCostMicroUsd,
    estimatedCostMicroUsd,
    reservedCostMicroUsd,
    safetyBufferBps: 1000,
  };
}

/**
 * The largest per-choice output cap whose hold (input + cap x n, plus the
 * buffer, exactly as estimateChatCompletionCost computes it) fits in
 * `availableMicroUsd`, never above the model maximum. 0 when even the input
 * alone does not fit. Pure: the caller decides whether that cap is useful.
 */
export function maxAffordableVeniceChatOutputCap(
  request: VeniceChatEstimateRequest,
  availableMicroUsd: number,
  pricingMap?: VenicePricingMap
): number {
  const base = estimateChatCompletionCost(
    { ...request, max_completion_tokens: 1, max_tokens: undefined },
    pricingMap
  );
  const available = BigInt(Math.max(0, Math.floor(availableMicroUsd)));
  // ceil(estimate * 110 / 100) <= available  <=>  estimate <= floor(available * 100 / 110)
  const estimateBudget =
    (available * BigInt(RESERVATION_BUFFER_DENOMINATOR)) / BigInt(RESERVATION_BUFFER_NUMERATOR);
  const outputBudget = estimateBudget - BigInt(base.inputCostMicroUsd);
  if (outputBudget < BigInt(0)) return 0;
  const price = resolvePrice(request.model, pricingMap);
  if (price.outputMicroUsdPerMillion === 0) return price.maxOutputTokens;
  // ceil(tokens * rate / 1e6) <= budget  <=>  tokens <= floor(budget * 1e6 / rate)
  const affordableTokens =
    (outputBudget * BigInt(1_000_000)) / BigInt(price.outputMicroUsdPerMillion);
  const perChoice = affordableTokens / BigInt(base.outputChoices);
  return Number(perChoice < BigInt(price.maxOutputTokens) ? perChoice : BigInt(price.maxOutputTokens));
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
