export const PROVIDER_ID_MAP: Record<string, string> = {
  alibaba: "alibaba",
  moonshot: "kimi-coding",
  zhipu: "zai",
  openai: "custom",
  bankr: "custom",
  venice: "custom",
  gemini: "custom",
  groq: "custom",
  xai: "custom",
  "xai-oauth": "xai-oauth",
  cometapi: "custom",
  nous: "custom",
  "nous-portal": "custom",
  codex: "openai-codex",
  crof: "custom",
  opengateway: "custom",
  surplus: "custom",
};

const PROVIDER_FALLBACK_MODELS: Record<string, string> = {
  custom_llm: "llama3.2",
  crof: "deepseek-v3.2",
  alibaba: "qwen3-max-2026-01-23",
  codex: "gpt-5.5",
  moonshot: "kimi-k2.6",
  zhipu: "glm-5",
  openai: "gpt-5.4",
  venice: "deepseek-v4-pro",
  cometapi: "gpt-5.5-all",
  gemini: "gemini-3.5-flash",
  groq: "llama-3.3-70b-versatile",
  xai: "grok-3-latest",
  "xai-oauth": "grok-4.3",
  anthropic: "claude-opus-4-8",
  nous: "nousresearch/hermes-3-llama-3.1-70b",
  "nous-portal": "nousresearch/hermes-3-llama-3.1-70b",
  bankr: "claude-opus-4.7",
  opengateway: "mimo-v2.5-pro",
  surplus: "claude-opus-4.6",
};

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  bankr: "https://llm.bankr.bot/v1",
  codex: "https://chatgpt.com/backend-api/codex",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  "xai-oauth": "https://api.x.ai/v1",
  venice: "https://api.venice.ai/api/v1",
  cometapi: "https://api.cometapi.com/v1",
  nous: "https://inference-api.nousresearch.com/v1",
  "nous-portal": "https://inference-api.nousresearch.com/v1",
  crof: "https://crof.ai/v1",
  opengateway: "https://opengateway.gitlawb.com/v1",
  surplus: "https://www.surplusintelligence.ai/api/inference/v1",
};

export function resolveProviderBaseUrl(
  provider?: string,
  customLlmBaseUrl?: string,
  apiKey?: string,
): string | null {
  if (!provider) {
    return null;
  }

  const customBaseUrl = customLlmBaseUrl?.trim();
  if (provider === "venice") {
    // Managed-Venice points at OUR proxy (`/api/managed-venice/v1` on the
    // dashboard), not a user-owned endpoint — so its host must always track the
    // CURRENT dashboard domain, never the one frozen into the row at deploy
    // time. Returning the stored value verbatim is what broke chat in the
    // hivra.cloud rebrand: agents provisioned pre-cutover kept re-baking
    // `hermesos.cloud/api/managed-venice/...`, which now 301-redirects, and the
    // agent's OpenAI client won't follow a cross-origin POST redirect. Re-derive
    // managed-Venice URLs from the live app URL on every (re)deploy so they
    // self-heal; pass a genuine BYO Venice URL (api.venice.ai, etc.) through
    // unchanged.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getManagedVeniceProxyBaseUrl } =
      require("@/lib/venice/managed-endpoints") as typeof import("@/lib/venice/managed-endpoints");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isManagedVeniceProxyKey } =
      require("@/lib/venice/byok-classification") as typeof import("@/lib/venice/byok-classification");

    // The KEY is the source of truth for managed-Venice, not the stored URL. An
    // `hven_live_` proxy key is only valid against our gateway, never
    // api.venice.ai — so pin it to the live proxy no matter what customLlmBaseUrl
    // says (or doesn't). Without this, a managed box whose customLlmBaseUrl is
    // missing/stripped falls through to the direct Venice API and 401s, and a
    // box still carrying a legacy-domain URL keeps POSTing into a 301 that its
    // OpenAI client won't follow. Both silently kill inference (the Jun-2026
    // managed-Venice cliff). A real BYO Venice key takes the URL paths below.
    if (isManagedVeniceProxyKey(apiKey)) {
      return getManagedVeniceProxyBaseUrl();
    }
    if (customBaseUrl) {
      if (customBaseUrl.includes("/api/managed-venice/")) {
        return getManagedVeniceProxyBaseUrl();
      }
      return customBaseUrl;
    }
  }

  if (provider === "custom_llm") {
    return customBaseUrl || "http://localhost:11434/v1";
  }

  // For known providers, a user-provided customBaseUrl always wins over the
  // hardcoded default. This lets users point "surplus" at a different endpoint
  // (e.g. https://api.surplusintelligence.ai/min30/v1 instead of the default
  // https://www.surplusintelligence.ai/api/inference/v1), or use any provider
  // with a proxy/mirror URL.
  if (customBaseUrl) {
    return customBaseUrl;
  }

  return PROVIDER_BASE_URLS[provider] ?? null;
}

export function resolveProviderFallbackModel(provider?: string): string {
  if (!provider) {
    return "hermes-agent";
  }

  return PROVIDER_FALLBACK_MODELS[provider] ?? "hermes-agent";
}

// Returns true when the model is plausibly valid for the provider. Catches the
// "switch provider but forget to update model" case — e.g. user picks
// `claude-opus-4.7` (only on Bankr) then switches the provider to Crof. Crof's
// upstream returns 404 "Model Not Known" and the chat goes blank with no
// surface-level explanation.
//
// Returns true (skip validation) when:
//  - provider is custom_llm (user-defined endpoint, no static catalog)
//  - provider is unknown to PROVIDERS (let it through; static catalog may be stale)
//  - model is empty (caller should fill in fallback themselves)
//  - model already appears in this provider's static catalog
//
// Returns false only when we're confident the model belongs to a *different*
// provider in the static catalog — i.e. the model exists somewhere but not
// here. That's the actual mismatch worth correcting.
export function isModelValidForProvider(provider: string, model: string): boolean {
  const trimmedModel = model.trim();
  if (!trimmedModel) return true;
  if (provider === "custom_llm") return true;

  // Lazy-require to avoid pulling the full PROVIDERS catalog into modules that
  // only need PROVIDER_ID_MAP / base URLs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PROVIDERS } = require("@/lib/models") as typeof import("@/lib/models");

  const target = PROVIDERS.find((p) => p.id === provider);
  if (!target) return true;
  if (target.models.some((m) => m.value === trimmedModel)) return true;

  const ownedByOther = PROVIDERS.some(
    (p) => p.id !== provider && p.models.some((m) => m.value === trimmedModel),
  );
  return !ownedByOther;
}

// When the new provider rejects the current model, snap to the first model
// in the provider's static catalog — same model the dropdown auto-selects
// when the user picks the provider without re-picking a model. Mirrors the
// frontend's handleProviderSelect behavior so the user's mental model
// ("whatever the dropdown showed first") matches what actually gets saved.
// Falls through to the provider's hardcoded fallback for providers without
// a static catalog (custom_llm, unknown).
//
// IMPORTANT 2026-05-02: only the instance *creation* path still calls this.
// Edit/save/load paths used to call this too, which silently rewrote the
// user's selection any time the static catalog hadn't caught up to the
// provider's real catalog (CometAPI + Claude Opus 4.7, OpenRouter + any new
// model, etc — every aggregator and every user-typed id was clobbered).
// New code should call validateProviderModelPair instead and surface a
// warning to the user; never overwrite their selection silently.
export function reconcileModelForProvider(
  provider: string,
  model: string | undefined | null,
): { model: string; corrected: boolean } {
  const incoming = (model || "").trim();
  if (incoming && isModelValidForProvider(provider, incoming)) {
    return { model: incoming, corrected: false };
  }
  return { model: getFirstAvailableModelForProvider(provider), corrected: true };
}

// Advisory validator. Returns whether the (provider, model) pair is
// recognized by the static catalog and, if not, why — so the UI can warn
// the user without rewriting their selection. The static catalog is just a
// best-known seed: aggregator providers (CometAPI, OpenRouter, Crof) serve
// far more models than we ever enumerate, providers add models faster than
// we track, and users sometimes type model ids by hand. Silently snapping
// any unfamiliar pair to a fallback was the root of every "I picked X and
// it saved as Y" bug across this surface.
//
// `kind` semantics:
//   - "ok"       — model is in this provider's static catalog
//   - "unknown"  — model isn't in any provider's static catalog (could be a
//                  new live-only model id, a typo, or just out of date).
//                  Allow it; the runtime will validate.
//   - "mismatch" — model is statically owned by a *different* provider.
//                  Most likely a real misconfiguration, but aggregators
//                  legitimately re-host other providers' models, so still
//                  allow it — just flag it.
//   - "empty"    — no model selected at all
export type ProviderModelPairWarning =
  | { kind: "ok" }
  | { kind: "empty" }
  | { kind: "unknown"; model: string; provider: string }
  | { kind: "mismatch"; model: string; provider: string; ownedBy: string };

export function validateProviderModelPair(
  provider: string,
  model: string | undefined | null,
): ProviderModelPairWarning {
  const trimmedModel = (model || "").trim();
  if (!trimmedModel) return { kind: "empty" };
  if (!provider || provider === "custom_llm") return { kind: "ok" };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PROVIDERS } = require("@/lib/models") as typeof import("@/lib/models");
  const target = PROVIDERS.find((p) => p.id === provider);
  if (!target) return { kind: "ok" };
  if (target.models.some((m) => m.value === trimmedModel)) {
    return { kind: "ok" };
  }
  const ownedBy = PROVIDERS.find(
    (p) => p.id !== provider && p.models.some((m) => m.value === trimmedModel),
  );
  if (ownedBy) {
    return { kind: "mismatch", model: trimmedModel, provider, ownedBy: ownedBy.id };
  }
  return { kind: "unknown", model: trimmedModel, provider };
}

function getFirstAvailableModelForProvider(provider: string): string {
  // custom_llm's catalog entry is a placeholder ("Custom Model") — no real
  // upstream understands the literal string "custom". Use the hardcoded
  // fallback (llama3.2) so users get a sensible starter to edit.
  if (provider === "custom_llm") {
    return resolveProviderFallbackModel(provider);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PROVIDERS } = require("@/lib/models") as typeof import("@/lib/models");
  const target = PROVIDERS.find((p) => p.id === provider);
  if (target && target.models.length > 0) {
    return target.models[0].value;
  }
  return resolveProviderFallbackModel(provider);
}
