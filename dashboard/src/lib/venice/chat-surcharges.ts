// Chat options Venice bills on top of tokens, held and charged like tokens.
//
// Venice's published rates (https://docs.venice.ai/overview/pricing):
//   * venice_parameters.enable_web_search: $10 per 1K requests. "on" always
//     searches; "auto" (and a `web_search` tool) lets the model decide;
//   * venice_parameters.enable_web_scraping: $10 per 1K successfully scraped
//     URLs, detected in the latest user message, up to 5 per request;
//   * venice_parameters.enable_x_search (and an `x_search` tool): $10 per 1K
//     results returned by xAI search. Venice doesn't publish a cap.
// Managed chat is charged at Venice's rate with no markup
// ("provider_rate_credits_no_usage_discount"), and so are these.
//
// Hold: the token hold plus the most these options can cost, except X search,
// which has no published cap and is held at VENICE_X_SEARCH_HELD_RESULTS
// results; capture debits any overage from the wallet, as it does for tokens.
// The plan is stored on the reservation, so a settle that only carries usage
// (the Cloudflare Worker's) still charges the surcharge.
//
// Charge, in order of evidence:
//   1. Venice's own per-request `cost` (usd + diem, USD-equivalent) when the
//      response carries it: surcharge = cost - token cost, clamped to what the
//      requested options can cost at the published rates. A clamp files a
//      reconciliation item: either Venice's rates moved or the catalog did.
//   2. Otherwise the published rates for what the request switched on. Web
//      search "auto" is charged only when citations show a search ran (or
//      when there's no way to tell). X search results can't be counted, so it
//      is charged at the held results and a reconciliation item is filed for
//      ops to true up against Venice's billing.
//
// Anything else Venice may add to venice_parameters is refused until it is
// reviewed here, so a new paid option can't reach Venice unpriced.
//
// Behind MANAGED_VENICE_CHAT_SURCHARGES_ENABLED (default OFF). OFF, managed
// chat refuses these options with a 400 before any hold (chat-output-budget.ts,
// unbilledVeniceChatOption), exactly as before this module existed. A hold made
// while the flag was ON is still charged its surcharge after it is turned OFF:
// settlement reads the plan off the reservation, never the flag.
//
// The surcharge sits on top of the output-cap-aware token hold
// (chat-output-budget.ts): the half-balance rule applies to the two together,
// and the output cap is lowered first, so a small wallet gets a shorter answer
// rather than an uncovered surcharge.

/** Default OFF: only the exact value "true" turns managed chat surcharges on. */
export function isManagedVeniceChatSurchargesEnabled(): boolean {
  return process.env.MANAGED_VENICE_CHAT_SURCHARGES_ENABLED === "true";
}

export const VENICE_WEB_SEARCH_MICRO_USD = 10_000;
export const VENICE_WEB_SCRAPE_PER_URL_MICRO_USD = 10_000;
export const VENICE_WEB_SCRAPE_MAX_URLS = 5;
export const VENICE_X_SEARCH_PER_RESULT_MICRO_USD = 10_000;
/** X search results held (and charged when Venice reports no cost). */
export const VENICE_X_SEARCH_HELD_RESULTS = 20;
/** The most X search results a Venice-reported cost is accepted for. */
export const VENICE_X_SEARCH_MAX_RESULTS = 100;

export const SURCHARGE_ABOVE_CEILING_REASON = "managed_venice_surcharge_above_ceiling";
export const X_SEARCH_COST_UNREPORTED_REASON = "managed_venice_x_search_cost_unreported";

export interface ManagedChatSurchargePlan {
  webSearch: "on" | "auto" | null;
  /** http(s)/www URLs in the latest user message (0-5), or null when scraping is off. */
  scrapeUrls: number | null;
  xSearch: boolean;
}

export interface ManagedChatSurchargeEvidence {
  /** Venice's `cost.usd + cost.diem` for the request, in µUSD. */
  veniceCostMicroUsd: number | null;
  /** Length of `venice_parameters.web_search_citations` in the response. */
  webSearchCitations: number | null;
}

export const NO_SURCHARGE_EVIDENCE: ManagedChatSurchargeEvidence = {
  veniceCostMicroUsd: null,
  webSearchCitations: null,
};

const BILLED_OPTIONS = new Set(["enable_web_search", "enable_web_scraping", "enable_x_search"]);

// Documented options that change the response but not the price.
const FREE_OPTIONS = new Set([
  // The Hermes agent sends this for a profile's base character
  // (agent/chat_completion_helpers.py, _maybe_add_venice_character).
  "character_slug",
  // strip_thinking_response is not here: authorizeManagedVeniceChat refuses it
  // first (a stream could then end without a usage frame to charge).
  "disable_thinking",
  "enable_e2ee",
  "include_venice_system_prompt",
  // Only shape search output; the search itself is what's billed.
  "enable_web_citations",
  "include_search_results_in_stream",
  "return_search_results_as_documents",
]);

// Client-executed tools cost nothing extra. Venice runs `web_search` and
// `x_search` itself; they are priced below. Any other type is refused.
const CLIENT_TOOL_TYPES = new Set(["function", "custom"]);

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'`]*/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Off = absent, null or false: exactly what the flag-OFF refusal
 * (chat-output-budget.ts) lets through. Anything else is ON and held, so a
 * spelling Venice might read as true ("false", "0", "") can never be forwarded
 * unpriced.
 */
function switchedOn(value: unknown) {
  return !(value === undefined || value === null || value === false);
}

function webSearchMode(value: unknown): "on" | "auto" | null {
  // Venice's documented off switch for web search is the string "off".
  if (!switchedOn(value) || value === "off") return null;
  return typeof value === "string" && value.trim().toLowerCase() === "auto" ? "auto" : "on";
}

function strongerWebSearch(a: "on" | "auto" | null, b: "on" | "auto" | null) {
  return a === "on" || b === "on" ? "on" : a ?? b;
}

function latestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("\n");
  }
  return "";
}

function scrapeableUrlCount(messages: unknown) {
  const urls = new Set((latestUserText(messages).match(URL_PATTERN) ?? []).map((url) => url.toLowerCase()));
  return Math.min(urls.size, VENICE_WEB_SCRAPE_MAX_URLS);
}

/**
 * The surcharge plan for a chat request: null when nothing billed is switched
 * on, or an error for a request that can't be priced (a malformed
 * venice_parameters, an option not reviewed here, an unknown tool type).
 */
export function planManagedChatSurcharges(
  body: Record<string, unknown>
): { ok: true; plan: ManagedChatSurchargePlan | null } | { ok: false; error: string } {
  let webSearch: "on" | "auto" | null = null;
  let scrapeUrls: number | null = null;
  let xSearch = false;

  const params = body.venice_parameters;
  if (params !== undefined && params !== null) {
    if (!isRecord(params)) return { ok: false, error: "venice_parameters must be an object." };
    const unknown = Object.keys(params).find((name) => !FREE_OPTIONS.has(name) && !BILLED_OPTIONS.has(name));
    if (unknown !== undefined) {
      return { ok: false, error: `venice_parameters.${unknown.slice(0, 64)} is not supported on managed Venice.` };
    }
    webSearch = webSearchMode(params.enable_web_search);
    if (switchedOn(params.enable_web_scraping)) scrapeUrls = scrapeableUrlCount(body.messages);
    xSearch = switchedOn(params.enable_x_search);
  }

  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) return { ok: false, error: "tools must be an array." };
    for (const tool of body.tools) {
      const type = isRecord(tool) ? String(tool.type) : "";
      if (type === "web_search") webSearch = strongerWebSearch(webSearch, "auto");
      else if (type === "x_search") xSearch = true;
      else if (!CLIENT_TOOL_TYPES.has(type)) {
        return { ok: false, error: `Tool type "${type.slice(0, 32)}" is not supported on managed Venice.` };
      }
    }
  }
  if (isRecord(body.tool_choice)) {
    const type = String(body.tool_choice.type);
    if (type === "web_search") webSearch = "on";
    else if (type === "x_search") xSearch = true;
    else if (!CLIENT_TOOL_TYPES.has(type)) {
      return { ok: false, error: `tool_choice type "${type.slice(0, 32)}" is not supported on managed Venice.` };
    }
  }

  const plan = { webSearch, scrapeUrls, xSearch };
  return { ok: true, plan: webSearch || scrapeUrls !== null || xSearch ? plan : null };
}

/** What the hold adds for these options: their most, X search at the held results. */
export function surchargeHoldMicroUsd(plan: ManagedChatSurchargePlan | null) {
  if (!plan) return 0;
  return (
    (plan.webSearch ? VENICE_WEB_SEARCH_MICRO_USD : 0) +
    (plan.scrapeUrls !== null ? VENICE_WEB_SCRAPE_MAX_URLS * VENICE_WEB_SCRAPE_PER_URL_MICRO_USD : 0) +
    (plan.xSearch ? VENICE_X_SEARCH_HELD_RESULTS * VENICE_X_SEARCH_PER_RESULT_MICRO_USD : 0)
  );
}

function surchargeCeilingMicroUsd(plan: ManagedChatSurchargePlan) {
  return (
    (plan.webSearch ? VENICE_WEB_SEARCH_MICRO_USD : 0) +
    (plan.scrapeUrls !== null ? VENICE_WEB_SCRAPE_MAX_URLS * VENICE_WEB_SCRAPE_PER_URL_MICRO_USD : 0) +
    (plan.xSearch ? VENICE_X_SEARCH_MAX_RESULTS * VENICE_X_SEARCH_PER_RESULT_MICRO_USD : 0)
  );
}

/** The plan a reservation was held for (reservation.metadata.surcharge.plan). */
export function readSurchargePlan(metadata: unknown): ManagedChatSurchargePlan | null {
  const surcharge = isRecord(metadata) ? metadata.surcharge : null;
  const plan = isRecord(surcharge) ? surcharge.plan : null;
  if (!isRecord(plan)) return null;
  const webSearch = plan.webSearch === "on" || plan.webSearch === "auto" ? plan.webSearch : null;
  const scrapeUrls =
    Number.isSafeInteger(plan.scrapeUrls) && Number(plan.scrapeUrls) >= 0
      ? Math.min(Number(plan.scrapeUrls), VENICE_WEB_SCRAPE_MAX_URLS)
      : null;
  const xSearch = plan.xSearch === true;
  return webSearch || scrapeUrls !== null || xSearch ? { webSearch, scrapeUrls, xSearch } : null;
}

function readCostMicroUsd(cost: unknown): number | null {
  if (!isRecord(cost)) return null;
  const usd = cost.usd ?? 0;
  const diem = cost.diem ?? 0;
  if (typeof usd !== "number" || typeof diem !== "number") return null;
  if (!Number.isFinite(usd) || !Number.isFinite(diem) || usd < 0 || diem < 0) return null;
  if (cost.usd === undefined && cost.diem === undefined) return null;
  return Math.round((usd + diem) * 1_000_000);
}

/** Evidence in one Venice chat response body or stream chunk. */
export function readSurchargeEvidence(payload: unknown): ManagedChatSurchargeEvidence {
  if (!isRecord(payload)) return NO_SURCHARGE_EVIDENCE;
  const citations = isRecord(payload.venice_parameters) ? payload.venice_parameters.web_search_citations : undefined;
  return {
    veniceCostMicroUsd: readCostMicroUsd(payload.cost),
    webSearchCitations: Array.isArray(citations) ? citations.length : null,
  };
}

/** Later evidence wins field by field; missing fields keep what was seen. */
export function mergeSurchargeEvidence(
  seen: ManagedChatSurchargeEvidence,
  next: ManagedChatSurchargeEvidence
): ManagedChatSurchargeEvidence {
  return {
    veniceCostMicroUsd: next.veniceCostMicroUsd ?? seen.veniceCostMicroUsd,
    webSearchCitations:
      seen.webSearchCitations === null && next.webSearchCitations === null
        ? null
        : Math.max(seen.webSearchCitations ?? 0, next.webSearchCitations ?? 0),
  };
}

/** Evidence across the JSON `data:` lines of one SSE frame. */
export function readSurchargeEvidenceFromSseFrame(frame: string): ManagedChatSurchargeEvidence {
  // Most frames carry neither; skip parsing them.
  if (!frame.includes('"cost"') && !frame.includes("web_search_citations")) return NO_SURCHARGE_EVIDENCE;
  let evidence = NO_SURCHARGE_EVIDENCE;
  for (const line of frame.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      evidence = mergeSurchargeEvidence(evidence, readSurchargeEvidence(JSON.parse(data)));
    } catch {
      // non-JSON keep-alive / comment frame
    }
  }
  return evidence;
}

/** Evidence the Worker forwards to internal/settle, validated. */
export function parseSurchargeEvidence(value: unknown): ManagedChatSurchargeEvidence {
  if (!isRecord(value)) return NO_SURCHARGE_EVIDENCE;
  const count = (field: unknown) => (Number.isSafeInteger(field) && Number(field) >= 0 ? Number(field) : null);
  return {
    veniceCostMicroUsd: count(value.veniceCostMicroUsd),
    webSearchCitations: count(value.webSearchCitations),
  };
}

export interface ManagedChatSurchargeCharge {
  surchargeMicroUsd: number;
  source: "venice_cost" | "published_rates";
  ceilingMicroUsd: number;
  /** Set when ops should compare this charge with Venice's billing. */
  reconciliationReason: string | null;
}

export function settleManagedChatSurcharge(params: {
  plan: ManagedChatSurchargePlan;
  evidence: ManagedChatSurchargeEvidence;
  tokenCostMicroUsd: number;
}): ManagedChatSurchargeCharge {
  const { plan, evidence } = params;
  const ceilingMicroUsd = surchargeCeilingMicroUsd(plan);

  if (evidence.veniceCostMicroUsd !== null) {
    // A search that was forced ("on") certainly ran and is billed at least its
    // published rate, whatever the reported cost says: the shape of `cost` is
    // not confirmed against Venice's invoice, so it never lowers that floor.
    const floor = plan.webSearch === "on" ? VENICE_WEB_SEARCH_MICRO_USD : 0;
    const reported = Math.max(floor, evidence.veniceCostMicroUsd - params.tokenCostMicroUsd);
    return reported > ceilingMicroUsd
      ? { surchargeMicroUsd: ceilingMicroUsd, source: "venice_cost", ceilingMicroUsd, reconciliationReason: SURCHARGE_ABOVE_CEILING_REASON }
      : { surchargeMicroUsd: reported, source: "venice_cost", ceilingMicroUsd, reconciliationReason: null };
  }

  const searched =
    plan.webSearch === "on" ||
    (plan.webSearch === "auto" && (evidence.webSearchCitations === null || evidence.webSearchCitations > 0));
  const surchargeMicroUsd =
    (searched ? VENICE_WEB_SEARCH_MICRO_USD : 0) +
    (plan.scrapeUrls ?? 0) * VENICE_WEB_SCRAPE_PER_URL_MICRO_USD +
    (plan.xSearch ? VENICE_X_SEARCH_HELD_RESULTS * VENICE_X_SEARCH_PER_RESULT_MICRO_USD : 0);
  return {
    surchargeMicroUsd,
    source: "published_rates",
    ceilingMicroUsd,
    reconciliationReason: plan.xSearch ? X_SEARCH_COST_UNREPORTED_REASON : null,
  };
}

/**
 * What a request is charged for its options when Venice delivered a response
 * but nothing about its cost arrived (a stream whose usage frame never came,
 * or the stale-hold sweep): the published rates for what was switched on, no
 * evidence either way. Recorded on the hold so those paths charge it without
 * the plan.
 */
export function surchargeFallbackChargeMicroUsd(plan: ManagedChatSurchargePlan | null): number {
  if (!plan) return 0;
  return settleManagedChatSurcharge({ plan, evidence: NO_SURCHARGE_EVIDENCE, tokenCostMicroUsd: 0 }).surchargeMicroUsd;
}
