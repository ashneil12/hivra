import { PROVIDERS } from "@/lib/models";
import {
  PROVIDER_ID_MAP,
  isModelValidForProvider,
  reconcileModelForProvider,
  resolveProviderBaseUrl,
  resolveProviderFallbackModel,
  validateProviderModelPair,
} from "../provider-config";

describe("provider-config Bankr wiring", () => {
  it("keeps Codex/ChatGPT OAuth defaulting to GPT-5.5", () => {
    const codex = PROVIDERS.find((provider) => provider.id === "codex");

    expect(codex).toBeDefined();
    expect(resolveProviderFallbackModel("codex")).toBe("gpt-5.5");
    expect(resolveProviderFallbackModel("codex")).toBe(codex!.models[0]?.value);
  });

  it("keeps direct OpenAI API fallback on GPT-5.4 until GPT-5.5 API access is live", () => {
    const openai = PROVIDERS.find((provider) => provider.id === "openai");

    expect(openai).toBeDefined();
    expect(openai!.models.map((model) => model.value)).toContain("gpt-5.5");
    expect(resolveProviderFallbackModel("openai")).toBe("gpt-5.4");
  });

  it("maps Bankr to the custom Hermes provider and its gateway base URL", () => {
    expect(PROVIDER_ID_MAP.bankr).toBe("custom");
    expect(resolveProviderBaseUrl("bankr")).toBe("https://llm.bankr.bot/v1");
  });

  it("keeps the Bankr fallback model aligned with the first picker model", () => {
    const bankr = PROVIDERS.find((provider) => provider.id === "bankr");

    expect(bankr).toBeDefined();
    expect(resolveProviderFallbackModel("bankr")).toBe(bankr!.models[0]?.value);
  });

  it("maps CometAPI to the custom Hermes provider and its gateway base URL", () => {
    expect(PROVIDER_ID_MAP.cometapi).toBe("custom");
    expect(resolveProviderBaseUrl("cometapi")).toBe("https://api.cometapi.com/v1");
  });

  it("keeps the CometAPI fallback model aligned with the first picker model", () => {
    const cometapi = PROVIDERS.find((provider) => provider.id === "cometapi");

    expect(cometapi).toBeDefined();
    expect(resolveProviderFallbackModel("cometapi")).toBe(cometapi!.models[0]?.value);
  });

  it("maps Surplus Intelligence to the custom Hermes provider and its marketplace base URL", () => {
    expect(PROVIDER_ID_MAP.surplus).toBe("custom");
    expect(resolveProviderBaseUrl("surplus")).toBe(
      "https://www.surplusintelligence.ai/api/inference/v1",
    );
  });

  it("keeps the Surplus fallback model aligned with the first picker model", () => {
    const surplus = PROVIDERS.find((provider) => provider.id === "surplus");

    expect(surplus).toBeDefined();
    expect(resolveProviderFallbackModel("surplus")).toBe(surplus!.models[0]?.value);
  });

  it("keeps the direct Gemini fallback model aligned with the first live-compatible picker model", () => {
    const gemini = PROVIDERS.find((provider) => provider.id === "gemini");

    expect(gemini).toBeDefined();
    expect(gemini!.models[0]?.value).toBe("gemini-3.5-flash");
    expect(resolveProviderFallbackModel("gemini")).toBe(gemini!.models[0]?.value);
  });

  it("keeps Venice fallback model on the latest DeepSeek V4 Pro release", () => {
    expect(resolveProviderFallbackModel("venice")).toBe("deepseek-v4-pro");
  });

  it("re-derives a managed-Venice base URL from the CURRENT app domain, never the frozen one", () => {
    // Regression: pre-cutover agents froze `hermesos.cloud/api/managed-venice/...`
    // into their config; after the hivra.cloud rebrand that host 301-redirects
    // and the agent's OpenAI client (no cross-origin POST redirect follow) died
    // with "HTTP 301". A managed-Venice URL is OUR proxy, so it must always
    // track the live dashboard domain — even when a stale host is passed in.
    const prev = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://hivra.cloud";
    try {
      expect(
        resolveProviderBaseUrl("venice", "https://hermesos.cloud/api/managed-venice/v1")
      ).toBe("https://hivra.cloud/api/managed-venice/v1");
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = prev;
    }
  });

  it("passes a genuine BYO Venice endpoint through unchanged (only managed-Venice self-heals)", () => {
    expect(resolveProviderBaseUrl("venice", "https://api.venice.ai/api/v1")).toBe(
      "https://api.venice.ai/api/v1"
    );
  });

  it("pins an hven_ managed key to the live proxy even when the stored base URL is MISSING", () => {
    // Regression for the Jun-2026 cliff: a managed box whose customLlmBaseUrl was
    // dropped used to fall through to the direct Venice API, where the hven_ proxy
    // key 401s. The KEY is the source of truth — force the proxy regardless.
    const prev = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://hivra.cloud";
    try {
      expect(
        resolveProviderBaseUrl("venice", undefined, "hven_live_abc123")
      ).toBe("https://hivra.cloud/api/managed-venice/v1");
      // ...and even when the stored URL is a stale legacy domain.
      expect(
        resolveProviderBaseUrl("venice", "https://hermesos.cloud/api/managed-venice/v1", "hven_live_abc123")
      ).toBe("https://hivra.cloud/api/managed-venice/v1");
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = prev;
    }
  });

  it("still sends a real BYO Venice key with no custom URL to the direct API (no managed override)", () => {
    expect(resolveProviderBaseUrl("venice", undefined, "sk-venice-real-byok")).toBe(
      "https://api.venice.ai/api/v1"
    );
  });
});

describe("provider/model reconciliation", () => {
  it("accepts a model that lives in the provider's catalog", () => {
    expect(isModelValidForProvider("anthropic", "claude-opus-4-7")).toBe(true);
    expect(isModelValidForProvider("crof", "kimi-k2.6")).toBe(true);
  });

  it("rejects a Bankr-only model when the active provider is Crof (the bug behind silent blank chats)", () => {
    expect(isModelValidForProvider("crof", "claude-opus-4.7")).toBe(false);
  });

  it("treats unknown providers as valid (don't lock out new/staging providers)", () => {
    expect(isModelValidForProvider("never-heard-of-it", "claude-opus-4.7")).toBe(true);
  });

  it("treats custom_llm as always valid (user-defined endpoint, no static catalog)", () => {
    expect(isModelValidForProvider("custom_llm", "anything-the-user-typed")).toBe(true);
  });

  it("treats empty model as valid so callers can fall back themselves", () => {
    expect(isModelValidForProvider("crof", "")).toBe(true);
  });

  it("snaps to the first model in the provider's catalog when the incoming model belongs to a different provider", () => {
    const crofFirstModel = PROVIDERS.find((p) => p.id === "crof")!.models[0]!.value;
    const result = reconcileModelForProvider("crof", "claude-opus-4.7");
    expect(result.corrected).toBe(true);
    // Mirrors the dropdown UX: when user picks Crof and doesn't re-pick a
    // model, the dropdown auto-selects models[0] — so the saved value should
    // match what the user *would have seen* selected.
    expect(result.model).toBe(crofFirstModel);
  });

  it("leaves a valid (provider, model) pair untouched", () => {
    const result = reconcileModelForProvider("anthropic", "claude-opus-4-7");
    expect(result.corrected).toBe(false);
    expect(result.model).toBe("claude-opus-4-7");
  });

  it("falls back to first catalog model when the model is empty", () => {
    const crofFirstModel = PROVIDERS.find((p) => p.id === "crof")!.models[0]!.value;
    const result = reconcileModelForProvider("crof", "");
    expect(result.corrected).toBe(true);
    expect(result.model).toBe(crofFirstModel);
  });

  it("falls back to PROVIDER_FALLBACK_MODELS when the provider has no static catalog (custom_llm)", () => {
    const result = reconcileModelForProvider("custom_llm", "");
    expect(result.corrected).toBe(true);
    expect(result.model).toBe(resolveProviderFallbackModel("custom_llm"));
  });
});

describe("validateProviderModelPair (advisory, never mutates)", () => {
  it("returns ok when model is in the provider's static catalog", () => {
    expect(validateProviderModelPair("anthropic", "claude-opus-4-7")).toEqual({
      kind: "ok",
    });
  });

  it("returns empty when no model is selected", () => {
    expect(validateProviderModelPair("anthropic", "")).toEqual({ kind: "empty" });
    expect(validateProviderModelPair("anthropic", null)).toEqual({ kind: "empty" });
    expect(validateProviderModelPair("anthropic", undefined)).toEqual({
      kind: "empty",
    });
  });

  it("treats custom_llm as ok for any model (user-defined endpoint)", () => {
    expect(validateProviderModelPair("custom_llm", "anything")).toEqual({
      kind: "ok",
    });
  });

  it("treats unknown providers as ok (don't lock out new/staging providers)", () => {
    expect(
      validateProviderModelPair("never-heard-of-it", "claude-opus-4-7"),
    ).toEqual({ kind: "ok" });
  });

  it("flags a Bankr-only model selected under Crof as a mismatch (still allows it — aggregators may serve it)", () => {
    // Same scenario the old reconcile-and-snap path used to silently rewrite.
    // Now we surface it to the user without mutating their selection.
    const result = validateProviderModelPair("crof", "claude-opus-4.7");
    expect(result).toEqual({
      kind: "mismatch",
      model: "claude-opus-4.7",
      provider: "crof",
      ownedBy: "bankr",
    });
  });

  it("returns unknown for a model that's not in any static catalog (newer than our seed)", () => {
    // Live API surfaces models we never enumerate (CometAPI, OpenRouter add
    // models faster than we track). Don't refuse them — let runtime validate.
    const result = validateProviderModelPair("cometapi", "gpt-9-future-model");
    expect(result).toEqual({
      kind: "unknown",
      model: "gpt-9-future-model",
      provider: "cometapi",
    });
  });

  it("recognises the live CometAPI + Claude 4.7 combination as a mismatch (NOT silently auto-snapped)", () => {
    // The exact scenario behind the user-facing bug: CometAPI does serve
    // claude-opus-4-7 via its aggregator, but our static catalog only lists
    // claude-opus-4-6 for it. The old reconcile path snapped to gpt-5.5-all
    // on save, then again on load, silently overwriting the user's selection.
    // The new validator flags it (so the UI can warn) but does NOT mutate.
    const result = validateProviderModelPair("cometapi", "claude-opus-4-7");
    expect(result).toEqual({
      kind: "mismatch",
      model: "claude-opus-4-7",
      provider: "cometapi",
      ownedBy: "anthropic",
    });
  });
});
