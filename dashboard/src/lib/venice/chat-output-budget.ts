// Managed-Venice chat: hold what the forwarded request can spend.
//
// Security review 2026-09 (Medium, "Managed-Venice overage"): a chat request
// without `max_tokens` used to hold 4,096 output tokens while Venice could run
// it to the model's maximum, about 31x more on the Claude Opus models. The
// overage debit at capture then failed on a small wallet and Hivra paid.
//
// The rule here is "reserve what you forward":
//   1. The hold covers the worst case of the request exactly as it will be
//      forwarded (cost-estimator.ts: the model maximum when no cap is sent).
//   2. When the wallet cannot cover that worst case, the proxy does not refuse
//      outright. It writes a lower output cap into the forwarded request, the
//      largest one the available balance covers, and holds for that. Venice then
//      stops generating where the wallet runs out, so the hold still covers the
//      whole bill, and a small wallet keeps working for normal-length answers.
//      Refusing instead would 402 every request on a premium model for anyone
//      holding less than its worst case (about $4.22 on claude-opus-4-8), even
//      though a typical answer costs cents.
//   3. Below MIN_CLAMPED_OUTPUT_TOKENS the request is refused with 402: an
//      answer truncated that short is not worth sending, and every request that
//      the old 4,096-token hold admitted still clears this floor.
//   4. The model maximum is only trusted when Venice published it (the live
//      /v1/models refresh). While that refresh is down the proxy prices from
//      the static catalog, whose maximum can lag Venice's (it listed
//      zai-org-glm-5-1 at 24,000 while Venice allowed 80,000). So when the
//      maximum came from the catalog, the cap the hold covers is always written
//      into the forwarded request, even when it equals that maximum.
//
// A caller that cannot rewrite the forwarded body (an older Cloudflare Worker
// that forwards its own copy) gets rule 1 only: the full worst-case hold, or a
// 402. It never gets a lower cap it would not apply. With a catalog maximum
// nothing enforces that maximum, so its worst case is bounded by the model's
// context window instead.

import {
  ManagedVeniceInsufficientBalanceError,
  getManagedVeniceWalletSummary,
  type ManagedVeniceWalletType,
} from "@/lib/billing/managed-venice-wallets";
import { log } from "@/lib/logger";
import { reserveManagedVeniceChatRequest } from "@/lib/venice/proxy-settlement";
import {
  maxAffordableVeniceChatOutputCap,
  readVeniceChatPositiveInteger,
  resolveVeniceChatPrice,
  worstCaseVeniceChatOutputCap,
  type VeniceChatEstimateRequest,
  type VenicePricingMap,
} from "./cost-estimator";
import type { VeniceChatModelPrice } from "./pricing";
import { VENICE_RESPONSES_ENDPOINT, responsesEstimateRequest } from "./responses-protocol";

export type ManagedVeniceChatProtocol = "chat" | "responses";

/** Smallest output cap the proxy will lower a request to before it 402s instead. */
export const MIN_CLAMPED_OUTPUT_TOKENS = 4_096;

export type ManagedVeniceOutputCapField =
  | "max_completion_tokens"
  | "max_tokens"
  | "max_output_tokens";

/** Top-level fields to overwrite in the forwarded body. Empty = forward as sent. */
export type ManagedVeniceOutputCapPatch = Partial<Record<ManagedVeniceOutputCapField, number>>;

// Chat: max_completion_tokens first, then the deprecated max_tokens, the
// precedence Venice documents. Responses has one field.
const CAP_FIELDS: Record<ManagedVeniceChatProtocol, readonly ManagedVeniceOutputCapField[]> = {
  chat: ["max_completion_tokens", "max_tokens"],
  responses: ["max_output_tokens"],
};

// Injected when the caller sent no cap: the current, non-deprecated field.
const INJECTED_FIELD: Record<ManagedVeniceChatProtocol, ManagedVeniceOutputCapField> = {
  chat: "max_completion_tokens",
  responses: "max_output_tokens",
};

export const MANAGED_VENICE_OUTPUT_CAP_FIELDS: readonly ManagedVeniceOutputCapField[] = [
  "max_completion_tokens",
  "max_tokens",
  "max_output_tokens",
];

/** The chat-shaped request the estimator prices, for a body with `patch` applied. */
export function managedVeniceChatEstimateBody(
  protocol: ManagedVeniceChatProtocol,
  body: Record<string, unknown>,
  patch: ManagedVeniceOutputCapPatch = {}
): VeniceChatEstimateRequest {
  if (protocol === "responses") {
    const estimate = responsesEstimateRequest(body) as VeniceChatEstimateRequest;
    return patch.max_output_tokens === undefined
      ? estimate
      : { ...estimate, max_completion_tokens: patch.max_output_tokens };
  }
  return { ...(body as VeniceChatEstimateRequest), ...patch };
}

/** The cap the caller asked for, by precedence. Validates every cap field. */
function requestedOutputCap(protocol: ManagedVeniceChatProtocol, body: Record<string, unknown>) {
  const values = CAP_FIELDS[protocol].map((field) => readVeniceChatPositiveInteger(body[field], field));
  return values.find((value): value is number => value !== null) ?? null;
}

/** True when Venice itself published the model's output maximum. */
function outputMaximumConfirmed(price: Pick<VeniceChatModelPrice, "maxOutputTokensSource">) {
  return price.maxOutputTokensSource === "venice_live";
}

/**
 * The fields to overwrite so the forwarded body runs with output cap `cap`:
 * every cap field the caller sent becomes `cap`. When none was sent, one is
 * added unless `cap` is Venice's own published maximum (its default): below
 * it, or whenever the maximum is only the catalog's guess.
 */
export function managedVeniceOutputCapPatch(
  protocol: ManagedVeniceChatProtocol,
  body: Record<string, unknown>,
  cap: number,
  price: Pick<VeniceChatModelPrice, "maxOutputTokens" | "maxOutputTokensSource">
): ManagedVeniceOutputCapPatch {
  const patch: ManagedVeniceOutputCapPatch = {};
  let sent = false;
  for (const field of CAP_FIELDS[protocol]) {
    if (body[field] === undefined || body[field] === null) continue;
    sent = true;
    if (body[field] !== cap) patch[field] = cap;
  }
  if (!sent && (cap < price.maxOutputTokens || !outputMaximumConfirmed(price))) {
    patch[INJECTED_FIELD[protocol]] = cap;
  }
  return patch;
}

/**
 * The price row, and a pricing map carrying it, to hold a request whose body
 * cannot be changed. With a catalog maximum nothing enforces that maximum, so
 * output is bounded by the model's context window instead.
 */
function unpatchedRequestPricing(
  modelId: string,
  price: VeniceChatModelPrice,
  pricingMap: VenicePricingMap
): { price: VeniceChatModelPrice; pricingMap: VenicePricingMap } {
  if (outputMaximumConfirmed(price)) return { price, pricingMap };
  const bounded: VeniceChatModelPrice = {
    ...price,
    maxOutputTokens: Math.max(price.maxOutputTokens, price.contextWindow),
  };
  const map = new Map(pricingMap);
  map.set(modelId, bounded);
  return { price: bounded, pricingMap: map };
}

/**
 * Venice bills these chat options per search / URL / result, outside token
 * usage, so a token hold cannot cover them (pricing: $10 per 1K each). Model
 * `fallbacks` can run a different model than the one priced. Returns the
 * offending field, or null when the request only uses token-billed features.
 */
export function unbilledVeniceChatOption(body: Record<string, unknown>): string | null {
  if (body.fallbacks !== undefined && body.fallbacks !== null) {
    if (!Array.isArray(body.fallbacks) || body.fallbacks.length > 0) return "fallbacks";
  }
  const params = body.venice_parameters;
  if (params === undefined || params === null) return null;
  if (typeof params !== "object" || Array.isArray(params)) return "venice_parameters";
  const record = params as Record<string, unknown>;
  const off = (value: unknown, ...offValues: unknown[]) =>
    value === undefined || value === null || offValues.includes(value);
  if (!off(record.enable_web_search, "off", false)) return "venice_parameters.enable_web_search";
  if (!off(record.enable_web_scraping, false)) return "venice_parameters.enable_web_scraping";
  if (!off(record.enable_x_search, false)) return "venice_parameters.enable_x_search";
  return null;
}

export interface ManagedVeniceChatBudgetedReservation {
  reservation: Awaited<ReturnType<typeof reserveManagedVeniceChatRequest>>;
  /** Apply to the caller's body before forwarding. Empty when nothing changes. */
  bodyPatch: ManagedVeniceOutputCapPatch;
  /** Per-choice output cap the forwarded request runs with. */
  outputCap: number;
  modelMaxOutputTokens: number;
  /** True when the cap was lowered because the wallet could not cover more. */
  clampedToBalance: boolean;
}

/**
 * Reserve wallet funds for a chat request so the hold covers everything the
 * forwarded request can spend. Throws ManagedVeniceInsufficientBalanceError
 * (402) when not even MIN_CLAMPED_OUTPUT_TOKENS fit, ManagedVeniceSpendCapError
 * from the spend cap, and InvalidVeniceChatRequestError for a malformed cap.
 */
export async function reserveManagedVeniceChatWithinBalance(params: {
  userId: string;
  proxyKeyId: string;
  walletType: ManagedVeniceWalletType;
  referenceId: string;
  protocol: ManagedVeniceChatProtocol;
  body: Record<string, unknown>;
  pricingMap: VenicePricingMap;
  /** False when the forwarded body cannot be changed (older Worker). */
  allowBodyRewrite: boolean;
  /** The proxy route, for logs. */
  route: string;
}): Promise<ManagedVeniceChatBudgetedReservation> {
  const { protocol, body, pricingMap } = params;
  const modelId = String(body.model);
  const price = resolveVeniceChatPrice(modelId, pricingMap);
  const modelMaxOutputTokens = price.maxOutputTokens;

  const reserve = (patch: ManagedVeniceOutputCapPatch, holdPricing: VenicePricingMap = pricingMap) =>
    reserveManagedVeniceChatRequest({
      userId: params.userId,
      proxyKeyId: params.proxyKeyId,
      walletType: params.walletType,
      referenceId: params.referenceId,
      requestBody: managedVeniceChatEstimateBody(protocol, body, patch),
      ...(protocol === "responses" ? { endpoint: VENICE_RESPONSES_ENDPOINT } : {}),
      pricingMap: holdPricing,
    });

  if (!params.allowBodyRewrite) {
    // Forwarded exactly as sent: hold its worst case (the larger cap field,
    // or the model maximum, or with a catalog maximum the context window), or
    // refuse.
    const unpatched = unpatchedRequestPricing(modelId, price, pricingMap);
    const reservation = await reserve({}, unpatched.pricingMap);
    return {
      reservation,
      bodyPatch: {},
      outputCap: worstCaseVeniceChatOutputCap(managedVeniceChatEstimateBody(protocol, body), unpatched.price),
      modelMaxOutputTokens: unpatched.price.maxOutputTokens,
      clampedToBalance: false,
    };
  }

  const requested = requestedOutputCap(protocol, body);
  const fullCap = Math.min(requested ?? modelMaxOutputTokens, modelMaxOutputTokens);
  const fullPatch = managedVeniceOutputCapPatch(protocol, body, fullCap, price);
  try {
    const reservation = await reserve(fullPatch);
    return {
      reservation,
      bodyPatch: fullPatch,
      outputCap: fullCap,
      modelMaxOutputTokens,
      clampedToBalance: false,
    };
  } catch (error) {
    if (!(error instanceof ManagedVeniceInsufficientBalanceError)) throw error;
  }

  // The worst case does not fit. Lower the cap to what the wallet covers now.
  const summary = await getManagedVeniceWalletSummary(params.userId);
  const available =
    params.walletType === "card"
      ? summary.card.availableMicroUsd
      : summary.hermesos.availableMicroUsd;
  const affordable = maxAffordableVeniceChatOutputCap(
    managedVeniceChatEstimateBody(protocol, body, fullPatch),
    available,
    pricingMap
  );
  if (affordable < Math.min(MIN_CLAMPED_OUTPUT_TOKENS, fullCap)) {
    throw new ManagedVeniceInsufficientBalanceError();
  }
  const outputCap = Math.min(affordable, fullCap);
  const bodyPatch = managedVeniceOutputCapPatch(protocol, body, outputCap, price);
  // A concurrent request can still take the balance first; the reservation
  // then throws ManagedVeniceInsufficientBalanceError and the caller 402s.
  const reservation = await reserve(bodyPatch);
  if (outputCap < fullCap) {
    log.info("Managed Venice chat output cap lowered to what the wallet covers", {
      source: "managed-venice-chat",
      route: params.route,
      failureType: "managed_venice_output_cap_lowered_to_balance",
      userId: params.userId,
      proxyKeyId: params.proxyKeyId,
      walletType: params.walletType,
      referenceId: params.referenceId,
      model: body.model,
      outputCap,
      requestedOutputCap: fullCap,
      modelMaxOutputTokens,
      modelMaxOutputTokensSource: price.maxOutputTokensSource,
      reservedMicroUsd: reservation.reservedMicroUsd,
    });
  }
  return {
    reservation,
    bodyPatch,
    outputCap,
    modelMaxOutputTokens,
    clampedToBalance: outputCap < fullCap,
  };
}
