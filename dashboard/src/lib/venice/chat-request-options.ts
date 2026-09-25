// Chat options Venice bills on top of tokens.
//
// The chat hold and settlement (proxy-settlement.ts) price tokens only, and
// the chat route and the Cloudflare Worker forward the caller's body to
// Venice as sent, with Hivra's upstream key. Venice charges extra for
// (https://docs.venice.ai/overview/pricing):
//   * venice_parameters.enable_web_search: $10 per 1K requests. "auto" lets
//     the model decide, so the charge can't be known up front;
//   * venice_parameters.enable_web_scraping: $10 per 1K successfully scraped
//     URLs, up to 5 per request;
//   * venice_parameters.enable_x_search: $10 per 1K results returned;
//   * provider-side `web_search` / `x_search` tools.
// None of these is reported in the usage block the settlement reads, so they
// can't be charged exactly. Until they are priced, a managed request that
// switches one on is refused with a 400 before any hold or upstream call. It
// is checked in authorizeManagedVeniceChat, because the Worker forwards its
// own copy of the body: refusing is the only control that covers both paths.
//
// venice_parameters is an allowlist. An option Venice adds later is refused
// until it is reviewed here, so a new paid option can't add to the bill.

const BILLED_OPTIONS = ["enable_web_search", "enable_web_scraping", "enable_x_search"] as const;

// Documented options that change the response but not the price.
const FREE_OPTIONS = new Set([
  // The Hermes agent sends this for a profile's base character
  // (agent/chat_completion_helpers.py, _maybe_add_venice_character).
  "character_slug",
  "strip_thinking_response",
  "disable_thinking",
  "enable_e2ee",
  "include_venice_system_prompt",
  // Only shape search output; they cost nothing without a search.
  "enable_web_citations",
  "include_search_results_in_stream",
  "return_search_results_as_documents",
]);

// Chat tools Venice doesn't run itself: the caller executes them.
const CLIENT_TOOL_TYPES = new Set(["function", "custom"]);

/** Off = absent, null, false, 0, and "", "false", "off", "0" (any case). */
function switchedOn(value: unknown) {
  if (value === undefined || value === null || value === false || value === 0) return false;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    return !(text === "" || text === "false" || text === "off" || text === "0");
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Why this chat request can't run on managed Venice, or null when every option
 * it switches on is covered by the token hold.
 */
export function managedChatBilledOptionError(body: Record<string, unknown>): string | null {
  const params = body.venice_parameters;
  if (params !== undefined && params !== null) {
    if (!isRecord(params)) return "venice_parameters must be an object.";
    for (const name of BILLED_OPTIONS) {
      if (switchedOn(params[name])) {
        return `venice_parameters.${name} is billed by Venice on top of tokens and is not available on managed Venice.`;
      }
    }
    const unknown = Object.keys(params).find(
      (name) => !FREE_OPTIONS.has(name) && !(BILLED_OPTIONS as readonly string[]).includes(name)
    );
    if (unknown !== undefined) {
      return `venice_parameters.${unknown.slice(0, 64)} is not supported on managed Venice.`;
    }
  }

  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) return "tools must be an array.";
    const providerTool = body.tools.find((tool) => !isRecord(tool) || !CLIENT_TOOL_TYPES.has(String(tool.type)));
    if (providerTool !== undefined) {
      return "Managed Venice chat supports function tools only; provider-side tools such as web_search are billed separately.";
    }
  }
  if (isRecord(body.tool_choice) && !CLIENT_TOOL_TYPES.has(String(body.tool_choice.type))) {
    return "Managed Venice chat supports function tool_choice only.";
  }
  return null;
}
