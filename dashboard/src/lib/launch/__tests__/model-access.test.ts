import { DEFAULT_MODEL_ACCESS, type LaunchModelAccess, type LaunchProfileId } from "../contracts";
import { createLaunchDraft } from "../draft-store";
import {
  apiKeyProviders,
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
    expect(byMode("claude-code")["api-key"].unavailable).toMatch(/Not available for Claude Code yet/);
    expect(byMode("claude-code").credits.unavailable).toBe("Not available for Claude Code yet.");
    expect(byMode("openclaw")["api-key"].unavailable).toBe("Not available for OpenClaw yet. Add your key inside OpenClaw after it opens instead.");
    expect(byMode("aeon")["api-key"].unavailable).toBe("Not available for Aeon here. Set your key on your GitHub fork instead.");
    // What each runtime's own form offered stays available.
    expect(byMode("codex")["api-key"].unavailable).toBeNull();
    expect(byMode("hermes")["api-key"].unavailable).toBeNull();
    expect(byMode("openclaw").credits.unavailable).toBeNull();
    expect(byMode("aeon").credits.unavailable).toBeNull();
  });

  it("offers no model choice for computers", () => {
    expect(modelAccessOptions("ubuntu-desktop", CONTEXT)).toEqual([]);
    expect(modelAccessOptions("windows", CONTEXT)).toEqual([]);
  });

  it("shows the credit balance, and at $0 disables credits and offers to add some", () => {
    expect(byMode("hermes").credits).toMatchObject({ detail: "$4.25 available. Model usage is paid from your credits at provider rates.", unavailable: null, offerAddCredit: false });
    expect(byMode("hermes", { ...CONTEXT, balance: EMPTY }).credits).toMatchObject({ unavailable: "You have $0 in Hivra credits.", offerAddCredit: true });
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
  it("signs Codex and Claude Code in inside the agent", () => {
    expect(recommendedModelAccessMode("codex", FUNDED, false)).toBe("native");
    expect(recommendedModelAccessMode("claude-code", FUNDED, false)).toBe("native");
    expect(recommendedModelAccessMode("openclaw", FUNDED, false)).toBe("native");
  });

  it("starts Hermes on credits only when the balance is positive", () => {
    expect(recommendedModelAccessMode("hermes", FUNDED, false)).toBe("credits");
    expect(recommendedModelAccessMode("hermes", { state: "known", cardMicroUsd: 0, hermesosMicroUsd: 1 }, false)).toBe("credits");
    expect(recommendedModelAccessMode("hermes", EMPTY, false)).toBe("native");
    expect(recommendedModelAccessMode("hermes", { state: "unknown" }, false)).toBe("native");
    expect(recommendedModelAccessMode("hermes", { state: "loading" }, false)).toBeNull();
    expect(recommendedModelAccessMode("hermes", FUNDED, true)).toBe("native");
  });

  it("follows the balance until the owner chooses, and never moves a choice or a sent launch", () => {
    const hermes = { ...createLaunchDraft(), profileId: "hermes" as const, resourceKind: "agent" as const, stage: "plan" as const };
    expect(withModelAccessDefault(hermes, { balance: FUNDED, selfHosted: false }).modelAccess.mode).toBe("credits");
    expect(withModelAccessDefault(hermes, { balance: { state: "loading" }, selfHosted: false })).toBe(hermes);
    const chosen = { ...hermes, modelAccess: access({ mode: "native" }) };
    expect(withModelAccessDefault(chosen, { balance: FUNDED, selfHosted: false })).toBe(chosen);
    const sent = { ...hermes, stage: "launch" as const };
    expect(withModelAccessDefault(sent, { balance: FUNDED, selfHosted: false })).toBe(sent);
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
    expect(problem("hermes", access({ mode: "credits" }), { context: { ...CONTEXT, balance: EMPTY } })).toBe("You have $0 in Hivra credits.");
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
    expect(effectiveModel("codex", access({ mode: "credits" }))).toBe("deepseek-v4-pro");
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
      .toBe("Your saved Venice AI key ••3f2a, sent to Codex 1's computer · DeepSeek V4 Pro (via Venice)");
    expect(summary("codex", access({ mode: "api-key", keySource: "paste", saveKey: true })))
      .toBe("The Venice AI key you pasted, sent to Codex 1's computer and saved in your Vault · DeepSeek V4 Pro (via Venice)");
    // The Vault keeps one key per provider, so Review says which saved key a save replaces.
    expect(summary("codex", access({ mode: "api-key", keySource: "paste", saveKey: true }), [VENICE_KEY]))
      .toBe("The Venice AI key you pasted, sent to Codex 1's computer and saved in your Vault, replacing ••3f2a · DeepSeek V4 Pro (via Venice)");
    expect(summary("codex", access({ mode: "api-key", keySource: "paste", saveKey: false }), [VENICE_KEY]))
      .toBe("The Venice AI key you pasted, sent to Codex 1's computer · DeepSeek V4 Pro (via Venice)");
    expect(summary("hermes", access({ mode: "credits" }))).toMatch(/^Hivra credits \(\$4\.25 available\) · /);
    expect(summary("aeon", access({ mode: "credits" }))).toBe("Hivra credits ($4.25 available). Aeon sets them up when you connect GitHub.");
    expect(summary("ubuntu-desktop", access())).toBeNull();
    expect(modelCostNote("codex", access({ mode: "api-key" }))).toBe("Venice AI bills your model usage.");
    expect(modelCostNote("hermes", access({ mode: "credits" }))).toBe("Model usage is paid from your Hivra credits at provider rates.");
    expect(modelCostNote("claude-code", access({ mode: "native" }))).toBeNull();
  });
});
