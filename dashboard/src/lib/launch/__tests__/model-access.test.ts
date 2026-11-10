import { DEFAULT_MODEL_ACCESS, type LaunchModelAccess, type LaunchProfileId } from "../contracts";
import { createLaunchDraft } from "../draft-store";
import {
  apiKeyProviders,
  choicesFromVeniceKeyCheck,
  creditsWallet,
  effectiveModel,
  formatCredits,
  modelAccessOptions,
  modelAccessProblem,
  modelAccessSummary,
  modelChoices,
  modelCostNote,
  recommendedModelAccessMode,
  
  withModelAccessDefault,
  type CreditsBalance,
  type ModelAccessContext,
  type SavedModelKey,
} from "../model-access";
import { VENICE_DEFAULT_MODEL } from "@/lib/hivra/model-key-selection";
import { isPrivateVeniceModel, isPrivateVenicePrivacy, parseVenicePrivacy } from "@/lib/venice/model-privacy";

const EMPTY: CreditsBalance = { state: "known", cardMicroUsd: 0, hermesosMicroUsd: 0 };
const FUNDED: CreditsBalance = { state: "known", cardMicroUsd: 4_250_000, hermesosMicroUsd: 0 };
const CONTEXT: ModelAccessContext = {
  selfHosted: false,
  providerComputer: false,
  selfManaged: false,
  modelSettingsSupported: true,
  balance: FUNDED,
};
const VENICE_KEY: SavedModelKey = { id: "44444444-4444-4444-8444-444444444444", provider: "venice", name: "Venice AI", key_preview: "venice...3f2a" };

const access = (change: Partial<LaunchModelAccess> = {}): LaunchModelAccess => ({ ...DEFAULT_MODEL_ACCESS, source: "custom", ...change });
const byMode = (profileId: LaunchProfileId, context: ModelAccessContext = CONTEXT) =>
  Object.fromEntries(modelAccessOptions(profileId, context).map(option => [option.mode, option]));

describe("the model access choices", () => {
  it("shows every agent the same three choices, and says why one can't be used", () => {
    for (const profileId of ["claude-code", "codex", "hermes", "openclaw", "agent-zero", "aeon"] as const) {
      expect(modelAccessOptions(profileId, CONTEXT).map(option => option.mode)).toEqual(["native", "api-key", "credits"]);
    }
    expect(byMode("claude-code")["api-key"].unavailable).toMatch(/Not available for Claude Code\. Use Hivra credits/);
    expect(byMode("claude-code").credits.unavailable).toBeNull();
    expect(byMode("openclaw")["api-key"].unavailable).toBe("Not available for OpenClaw yet. Add your key inside OpenClaw after it opens instead.");
    expect(byMode("aeon")["api-key"].unavailable).toBe("Not available for Aeon here. Set your key on your GitHub fork instead.");
    // What each runtime's own form offered stays available.
    expect(byMode("codex")["api-key"].unavailable).toBeNull();
    expect(byMode("hermes")["api-key"].unavailable).toBeNull();
    expect(byMode("openclaw").credits.unavailable).toBeNull();
    expect(byMode("aeon").credits.unavailable).toBeNull();
  });

  it("runs Claude Code on credits with Venice's Claude models only, Sonnet 4.6 by default", () => {
    const credits = access({ mode: "credits" });
    const choices = modelChoices("claude-code", credits).map(choice => choice.value);
    expect(choices[0]).toBe("claude-sonnet-4-6");
    expect(choices.length).toBeGreaterThan(1);
    expect(choices.every(value => /^claude-(fable|opus|sonnet|haiku)-/.test(value))).toBe(true);
    expect(effectiveModel("claude-code", credits)).toBe("claude-sonnet-4-6");
    const options = modelAccessOptions("claude-code", CONTEXT);
    expect(modelAccessProblem("claude-code", credits, { name: "Claude Code 1", pastedKey: "", savedKeys: [], options })).toBeNull();
    expect(modelAccessProblem("claude-code", access({ mode: "credits", model: "deepseek-v4-pro" }), { name: "Claude Code 1", pastedKey: "", savedKeys: [], options }))
      .toBe("Choose a model from the list, or enter a valid model ID.");
    expect(modelAccessSummary("claude-code", credits, { name: "Claude Code 1", balance: FUNDED, savedKeys: [] }))
      .toBe("Hivra credits ($4.25 available) · Claude Sonnet 4.6 (via Venice)");
  });

  it("offers no model choice for computers", () => {
    expect(modelAccessOptions("ubuntu-desktop", CONTEXT)).toEqual([]);
    expect(modelAccessOptions("windows", CONTEXT)).toEqual([]);
  });

  it("shows the credit balance, and at $0 asks for credit and offers to add some", () => {
    expect(byMode("hermes").credits).toMatchObject({ detail: "$4.25 available. Model usage is paid from your credits at provider rates.", unavailable: null, offerAddCredit: false });
    expect(byMode("hermes", { ...CONTEXT, balance: EMPTY }).credits).toMatchObject({ unavailable: "Add credit to start chatting.", offerAddCredit: true });
    // A balance that couldn't be read is not $0.
    expect(byMode("hermes", { ...CONTEXT, balance: { state: "unknown" } }).credits).toMatchObject({ unavailable: null, offerAddCredit: false });
    expect(byMode("hermes", { ...CONTEXT, balance: { state: "loading" } }).credits.detail).toBe("Checking your Hivra credits…");
  });

  it("has no Hivra credits to offer on a self-hosted installation", () => {
    expect(modelAccessOptions("hermes", { ...CONTEXT, selfHosted: true }).map(option => option.mode)).toEqual(["native", "api-key"]);
  });

  it("explains why Codex can't take a key on a server that hasn't said it can hold one", () => {
    const options = byMode("codex", { ...CONTEXT, selfManaged: true, modelSettingsSupported: false });
    expect(options["api-key"].unavailable).toMatch(/hasn't said it can take a model key safely/);
    expect(options.credits.unavailable).toMatch(/hasn't said it can take a model key safely/);
    expect(options.credits.offerAddCredit).toBe(false);
  });

  it("explains that dashboard agents can't set up credits on a computer in the owner's own cloud", () => {
    expect(byMode("openclaw", { ...CONTEXT, selfManaged: true, providerComputer: true }).credits.unavailable)
      .toBe("Hivra credits can't be set up for OpenClaw on a computer in your own cloud yet.");
  });
});

describe("Hivra's model access default", () => {
  const HERE = { selfHosted: false };

  it("starts every agent that can use credits on credits, even at $0", () => {
    for (const profileId of ["codex", "claude-code", "hermes", "openclaw", "agent-zero", "aeon"] as const) {
      expect(recommendedModelAccessMode(profileId, HERE)).toBe("credits");
    }
  });

  it("starts on the agent's own sign-in where credits aren't offered", () => {
    expect(recommendedModelAccessMode("hermes", { selfHosted: true })).toBe("native");
    expect(recommendedModelAccessMode("openclaw", { selfHosted: false, providerComputer: true })).toBe("native");
    expect(recommendedModelAccessMode("codex", { selfHosted: false, providerComputer: true })).toBe("credits");
    expect(recommendedModelAccessMode("codex", { selfHosted: false, selfManaged: true, modelSettingsSupported: false })).toBe("native");
    expect(recommendedModelAccessMode("ubuntu-desktop", HERE)).toBe("native");
  });

  it("applies the default until the owner chooses, and never moves a choice or a sent launch", () => {
    const hermes = { ...createLaunchDraft(), profileId: "hermes" as const, resourceKind: "agent" as const, stage: "plan" as const };
    expect(withModelAccessDefault(hermes, HERE).modelAccess.mode).toBe("credits");
    expect(withModelAccessDefault({ ...hermes, profileId: "codex" }, HERE).modelAccess.mode).toBe("credits");
    expect(withModelAccessDefault(hermes, { selfHosted: true })).toBe(hermes);
    const chosen = { ...hermes, modelAccess: access({ mode: "native" }) };
    expect(withModelAccessDefault(chosen, HERE)).toBe(chosen);
    const sent = { ...hermes, stage: "launch" as const };
    expect(withModelAccessDefault(sent, HERE)).toBe(sent);
  });

  it("asks for credit at $0 instead of failing silently, and lets the owner switch", () => {
    const options = modelAccessOptions("hermes", { ...CONTEXT, balance: EMPTY });
    expect(options.find(option => option.mode === "credits")).toMatchObject({ unavailable: "Add credit to start chatting.", offerAddCredit: true });
    expect(modelAccessProblem("hermes", access({ mode: "credits" }), { name: "Hermes 1", pastedKey: "", savedKeys: [], options }))
      .toBe("Add credit to start chatting, or choose another option.");
    expect(modelAccessProblem("hermes", access({ mode: "native" }), { name: "Hermes 1", pastedKey: "", savedKeys: [], options })).toBeNull();
  });

  it("recommends a private model on credits", () => {
    expect(VENICE_DEFAULT_MODEL).toBe("kimi-k2-6");
    expect(isPrivateVeniceModel(VENICE_DEFAULT_MODEL)).toBe(true);
    expect(effectiveModel("codex", access({ mode: "credits" }))).toBe("kimi-k2-6");
    expect(effectiveModel("hermes", access({ mode: "credits" }))).toBe("kimi-k2-6");
  });
});

describe("the Private badge", () => {
  it("marks private and end-to-end private Venice models, and not anonymized ones", () => {
    expect(isPrivateVenicePrivacy("private")).toBe(true);
    expect(isPrivateVenicePrivacy("e2ee_private")).toBe(true);
    expect(isPrivateVenicePrivacy("anonymized")).toBe(false);
    expect(isPrivateVenicePrivacy(null)).toBe(false);
    expect(parseVenicePrivacy("weird")).toBe("anonymized");
    expect(parseVenicePrivacy(undefined, "e2ee-glm-5-1")).toBe("e2ee_private");
    expect(isPrivateVeniceModel("kimi-k2-6")).toBe(true);
    expect(isPrivateVeniceModel("claude-sonnet-4-6")).toBe(false);
    expect(isPrivateVeniceModel("deepseek-v4-pro")).toBe(true); // Venice lists it as private (catalog refresh 2026-11-10)
    expect(isPrivateVeniceModel("not-a-model")).toBe(false);
  });

  it("flags the credits and Venice key lists the same way", () => {
    const credits = modelChoices("hermes", access({ mode: "credits" }));
    expect(credits[0]).toMatchObject({ value: "kimi-k2-6", private: true });
    expect(credits.find(choice => choice.value === "claude-opus-4-8")?.private).toBe(false);
    expect(modelChoices("codex", access({ mode: "api-key" })).find(choice => choice.value === "kimi-k2-6")?.private).toBe(true);
    expect(modelChoices("hermes", access({ mode: "api-key", provider: "openai" })).every(choice => !choice.private)).toBe(true);
    expect(choicesFromVeniceKeyCheck([
      { id: "a", name: "A", privacy: "private" },
      { id: "b", name: "B", privacy: "anonymized" },
      { id: "c", name: "C", privacy: "e2ee_private" },
    ]).map(choice => choice.private)).toEqual([true, false, true]);
  });
});

describe("what a model access choice needs before launch", () => {
  const options = (profileId: LaunchProfileId, context: ModelAccessContext = CONTEXT) => modelAccessOptions(profileId, context);
  const problem = (profileId: LaunchProfileId, choice: LaunchModelAccess, extra: { pastedKey?: string; savedKeys?: SavedModelKey[]; context?: ModelAccessContext } = {}) =>
    modelAccessProblem(profileId, choice, {
      name: "Codex 1",
      pastedKey: extra.pastedKey ?? "",
      savedKeys: extra.savedKeys ?? [],
      options: options(profileId, extra.context),
    });

  it("needs nothing to sign in inside the agent", () => {
    expect(problem("claude-code", access({ mode: "native" }))).toBeNull();
  });

  it("asks for per-launch consent before a saved key is sent", () => {
    const saved = access({ mode: "api-key", keySource: "saved", vaultKeyId: VENICE_KEY.id, sendSavedKey: false });
    expect(problem("codex", saved, { savedKeys: [VENICE_KEY] })).toBe("Confirm that your saved key can be sent to Codex 1's computer.");
    expect(problem("codex", { ...saved, sendSavedKey: true }, { savedKeys: [VENICE_KEY] })).toBeNull();
    expect(problem("codex", { ...saved, sendSavedKey: true }, { savedKeys: [] })).toBe("Choose your saved key, or paste a new one.");
  });

  it("checks a pasted key the way the server does", () => {
    const pasted = access({ mode: "api-key", keySource: "paste" });
    expect(problem("codex", pasted)).toBe("Paste your Venice AI API key.");
    expect(problem("codex", pasted, { pastedKey: "short" })).toMatch(/8 to 256 characters/);
    expect(problem("codex", pasted, { pastedKey: "synthetic-venice-key" })).toBeNull();
    expect(problem("hermes", access({ mode: "api-key", provider: "openrouter" }), { pastedKey: "not-an-openrouter-key" }))
      .toMatch(/sk-or-/);
  });

  it("needs a base URL and a typed model for a custom endpoint", () => {
    const custom = access({ mode: "api-key", provider: "custom_llm" });
    expect(problem("hermes", custom, { pastedKey: "local-key-1" })).toBe("Enter the base URL of your OpenAI-compatible endpoint.");
    expect(problem("hermes", { ...custom, baseUrl: "https://llm.example.test/v1" }, { pastedKey: "local-key-1" })).toBe("Enter the model ID your endpoint serves.");
    expect(problem("hermes", { ...custom, baseUrl: "https://llm.example.test/v1", model: "llama3.2" }, { pastedKey: "local-key-1" })).toBeNull();
  });

  it("won't launch on credits at $0", () => {
    expect(problem("hermes", access({ mode: "credits" }), { context: { ...CONTEXT, balance: EMPTY } })).toBe("Add credit to start chatting, or choose another option.");
  });

  it("asks for a saved session for a provider that signs in instead of taking a key", () => {
    expect(problem("hermes", access({ mode: "api-key", provider: "nous" }))).toMatch(/signs in with a saved session/);
    expect(apiKeyProviders("hermes", []).some(provider => provider.id === "nous")).toBe(false);
    expect(apiKeyProviders("hermes", [{ ...VENICE_KEY, provider: "nous" }]).some(provider => provider.id === "nous")).toBe(true);
    expect(apiKeyProviders("codex", []).map(provider => provider.id)).toEqual(["venice"]);
  });
});

describe("models, wallets and plain-words summaries", () => {
  it("lists models from a dropdown, with Codex's default and Hermes' first listed model", () => {
    expect(effectiveModel("codex", access({ mode: "credits" }))).toBe("kimi-k2-6");
    expect(effectiveModel("hermes", access({ mode: "credits" }))).toBe(modelChoices("hermes", access({ mode: "credits" }))[0].value);
    expect(effectiveModel("hermes", access({ mode: "credits", model: " kimi-k2-6 " }))).toBe("kimi-k2-6");
    expect(modelChoices("codex", access({ mode: "credits" })).every(choice => /^[A-Za-z0-9._:/[\]-]{1,64}$/.test(choice.value))).toBe(true);
  });

  it("bills the chosen wallet while it has credit, else the one that does", () => {
    expect(creditsWallet(access({ walletType: "card" }), { state: "known", cardMicroUsd: 0, hermesosMicroUsd: 5 })).toBe("hermesos");
    expect(creditsWallet(access({ walletType: "card" }), { state: "known", cardMicroUsd: 5, hermesosMicroUsd: 5 })).toBe("card");
    expect(creditsWallet(access({ walletType: "hermesos" }), { state: "unknown" })).toBe("hermesos");
  });

  it("never overstates a balance", () => {
    expect(formatCredits(4_259_999)).toBe("$4.25");
    expect(formatCredits(-1)).toBe("$0.00");
  });

  it("says in plain words what the launch will do", () => {
    const summary = (profileId: LaunchProfileId, choice: LaunchModelAccess, savedKeys: SavedModelKey[] = []) =>
      modelAccessSummary(profileId, choice, { name: "Codex 1", balance: FUNDED, savedKeys });
    expect(summary("codex", access({ mode: "native" }))).toBe("Sign in to ChatGPT inside Codex after it opens.");
    expect(summary("codex", access({ mode: "api-key", keySource: "saved", vaultKeyId: VENICE_KEY.id }), [VENICE_KEY]))
      .toBe("Your saved Venice AI key ••3f2a, sent to Codex 1's computer · Kimi K2.6 (via Venice · recommended)");
    expect(summary("codex", access({ mode: "api-key", keySource: "paste", saveKey: true })))
      .toBe("The Venice AI key you pasted, sent to Codex 1's computer and saved in your Vault · Kimi K2.6 (via Venice · recommended)");
    // The Vault keeps one key per provider, so Review says which saved key a save replaces.
    expect(summary("codex", access({ mode: "api-key", keySource: "paste", saveKey: true }), [VENICE_KEY]))
      .toBe("The Venice AI key you pasted, sent to Codex 1's computer and saved in your Vault, replacing ••3f2a · Kimi K2.6 (via Venice · recommended)");
    expect(summary("codex", access({ mode: "api-key", keySource: "paste", saveKey: false }), [VENICE_KEY]))
      .toBe("The Venice AI key you pasted, sent to Codex 1's computer · Kimi K2.6 (via Venice · recommended)");
    expect(summary("hermes", access({ mode: "credits" }))).toMatch(/^Hivra credits \(\$4\.25 available\) · /);
    expect(summary("aeon", access({ mode: "credits" }))).toBe("Hivra credits ($4.25 available). Aeon sets them up when you connect GitHub.");
    expect(summary("ubuntu-desktop", access())).toBeNull();
    expect(modelCostNote("codex", access({ mode: "api-key" }))).toBe("Venice AI bills your model usage.");
    expect(modelCostNote("hermes", access({ mode: "credits" }))).toBe("Model usage is paid from your Hivra credits at provider rates.");
    expect(modelCostNote("claude-code", access({ mode: "native" }))).toBeNull();
  });
});
