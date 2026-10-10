/**
 * One set of rules for how every launched agent reaches a model: sign in
 * inside the agent after it opens, send the owner's own API key to its
 * computer, or pay with Hivra credits. The Launch journey's Model access row,
 * its Review row and each runtime's launch request all read from here, so
 * what the owner is shown is what the launch sends.
 *
 * Nothing here holds a secret. A pasted key is passed in by the caller for the
 * launch it was typed into and is never part of the draft.
 */

import { PROVIDERS, type Provider } from "@/lib/models";
import { VENICE_DEFAULT_MODEL } from "@/lib/hivra/model-key-selection";
import { supportsHermesAuthProvider } from "@/lib/provider-auth";
import { validateProviderKeyShape } from "@/lib/provider-key-shape";

import {
  DEFAULT_MODEL_ACCESS,
  PROFILE_DETAILS,
  type LaunchDraft,
  type LaunchModelAccess,
  type LaunchModelAccessMode,
  type LaunchProfileId,
} from "./contracts";

/** A saved key as the Vault lists it: never the key itself. */
export type SavedModelKey = {
  id: string;
  provider: string;
  name: string;
  key_preview: string | null;
};

/** What Hivra knows about the owner's credit balance. "unknown" means the
 * balance could not be read, which is not the same as $0. */
export type CreditsBalance =
  | { state: "loading" }
  | { state: "unknown" }
  | { state: "known"; cardMicroUsd: number; hermesosMicroUsd: number };

const VENICE = "venice";
/** Codex, OpenClaw and Agent Zero reach models through Venice's API. */
const CODEX_MODEL = /^[A-Za-z0-9._:/[\]-]{1,64}$/;
const HERMES_MODEL = /^[\x21-\x7e]{1,128}$/;
const CODEX_KEY = /^[\x21-\x7e]{8,256}$/;

/** Every agent is shown the same three choices, in this order. */
const ALL_MODES: readonly LaunchModelAccessMode[] = ["native", "api-key", "credits"];

/** The model access choices a profile can use, in the order they are shown.
 * They are exactly the choices its own setup form offered. */
export function modelAccessModes(profileId: LaunchProfileId): LaunchModelAccessMode[] {
  switch (profileId) {
    case "codex":
    case "hermes":
      return ["native", "api-key", "credits"];
    case "openclaw":
    case "agent-zero":
    case "aeon":
      return ["native", "credits"];
    case "claude-code":
      return ["native"];
    default:
      return [];
  }
}

export function hasModelAccess(profileId: LaunchProfileId | null): profileId is LaunchProfileId {
  return profileId !== null && modelAccessModes(profileId).length > 0;
}

export type ModelAccessContext = {
  selfHosted: boolean;
  /** The launch goes to a whole computer in the owner's own cloud. */
  providerComputer: boolean;
  /** The launch goes to a server the owner connected. */
  selfManaged: boolean;
  /** For Codex on the owner's server: it said it can take a model key. */
  modelSettingsSupported: boolean;
  balance: CreditsBalance;
};

export type ModelAccessOption = {
  mode: LaunchModelAccessMode;
  title: string;
  detail: string;
  /** Why it can't be chosen right now, or null when it can. */
  unavailable: string | null;
  /** The credits option at $0 offers a way to add some. */
  offerAddCredit: boolean;
};

function totalMicroUsd(balance: CreditsBalance): number | null {
  return balance.state === "known" ? balance.cardMicroUsd + balance.hermesosMicroUsd : null;
}

/** "$4.20", rounded down so a balance is never overstated. */
export function formatCredits(microUsd: number): string {
  const cents = Math.floor(Math.max(0, microUsd) / 10_000);
  return `$${(cents / 100).toFixed(2)}`;
}

/** The wallet a credits launch bills: the chosen one while it has credit,
 * otherwise the other one when only that has credit (the welcome forms'
 * card-first rule). */
export function creditsWallet(access: LaunchModelAccess, balance: CreditsBalance): "card" | "hermesos" {
  if (balance.state !== "known") return access.walletType;
  const available = (wallet: "card" | "hermesos") => wallet === "card" ? balance.cardMicroUsd : balance.hermesosMicroUsd;
  const other = access.walletType === "card" ? "hermesos" : "card";
  return available(access.walletType) <= 0 && available(other) > 0 ? other : access.walletType;
}

export function creditsAvailableMicroUsd(access: LaunchModelAccess, balance: CreditsBalance): number | null {
  if (balance.state !== "known") return null;
  return creditsWallet(access, balance) === "card" ? balance.cardMicroUsd : balance.hermesosMicroUsd;
}

/** Both wallets hold credit, so the owner may pick which one pays. */
export function bothWalletsFunded(balance: CreditsBalance): boolean {
  return balance.state === "known" && balance.cardMicroUsd > 0 && balance.hermesosMicroUsd > 0;
}

function nativeCopy(profileId: LaunchProfileId): { title: string; detail: string; summary: string } {
  const name = PROFILE_DETAILS[profileId].name;
  switch (profileId) {
    case "codex":
      return {
        title: "Sign in inside Codex after it opens",
        detail: "Use ChatGPT, or your own OpenAI API key, in its terminal.",
        summary: "Sign in to ChatGPT inside Codex after it opens.",
      };
    case "claude-code":
      return {
        title: "Sign in inside Claude Code after it opens",
        detail: "Use your Claude or Anthropic Console account in its terminal.",
        summary: "Sign in with your Anthropic account inside Claude Code after it opens.",
      };
    case "hermes":
      return {
        title: "Set up inside Hermes after it opens",
        detail: "Hermes asks which model provider to use before your first chat.",
        summary: "Choose a model provider inside Hermes after it opens.",
      };
    case "openclaw":
      return {
        title: "Set up inside OpenClaw after it opens",
        detail: "Choose a model provider in its Control UI.",
        summary: "Choose a model provider in OpenClaw's Control UI after it opens.",
      };
    case "agent-zero":
      return {
        title: "Set up inside Agent Zero after it opens",
        detail: "Choose a model provider in its Settings.",
        summary: "Choose a model provider in Agent Zero's Settings after it opens.",
      };
    case "aeon":
      return {
        title: "Use the key on your GitHub fork",
        detail: "Aeon runs on your GitHub Actions with the AI provider key you set on your fork.",
        summary: "Aeon uses the AI provider key on your GitHub fork after you connect GitHub.",
      };
    default:
      return { title: `Set up inside ${name}`, detail: "", summary: "" };
  }
}

/** Why a runtime can't use a choice through Hivra, and what to do instead. */
function unsupportedReason(profileId: LaunchProfileId, mode: LaunchModelAccessMode): string {
  const name = PROFILE_DETAILS[profileId].name;
  if (mode === "api-key") {
    if (profileId === "claude-code") return "Not available for Claude Code yet. Its own sign-in takes an Anthropic Console account instead.";
    if (profileId === "aeon") return "Not available for Aeon here. Set your key on your GitHub fork instead.";
    return `Not available for ${name} yet. Add your key inside ${name} after it opens instead.`;
  }
  return `Not available for ${name} yet.`;
}

/** Each of the three choices, with the reason when it can't be chosen here.
 * A choice a runtime or its destination can't use is explained, never pressed
 * and disabled. A self-hosted installation has no Hivra credits to offer. */
export function modelAccessOptions(profileId: LaunchProfileId, context: ModelAccessContext): ModelAccessOption[] {
  if (!hasModelAccess(profileId)) return [];
  const supported = modelAccessModes(profileId);
  return ALL_MODES
    .filter(mode => mode !== "credits" || !context.selfHosted)
    .map(mode => {
      if (!supported.includes(mode)) {
        const copy = mode === "api-key"
          ? { title: "Use my API key", detail: "" }
          : { title: "Hivra credits", detail: "" };
        return { mode, ...copy, unavailable: unsupportedReason(profileId, mode), offerAddCredit: false };
      }
      if (mode === "native") {
        const copy = nativeCopy(profileId);
        return { mode, title: copy.title, detail: copy.detail, unavailable: null, offerAddCredit: false };
      }
      const codexKeyGap = profileId === "codex" && context.selfManaged && !context.modelSettingsSupported
        ? "This server hasn't said it can take a model key safely yet. Update it in Capacity, or choose another option."
        : null;
      if (mode === "api-key") {
        return {
          mode,
          title: "Use my API key",
          detail: profileId === "codex"
            ? "A Venice API key. Venice bills your model usage."
            : "A key from the model provider you use. They bill your model usage.",
          unavailable: codexKeyGap,
          offerAddCredit: false,
        };
      }
      const total = totalMicroUsd(context.balance);
      const detail = context.balance.state === "loading"
        ? "Checking your Hivra credits…"
        : context.balance.state === "unknown"
          ? "Couldn't check your balance. Model usage is paid from your credits."
          : `${formatCredits(total ?? 0)} available. Model usage is paid from your credits at provider rates.`;
      const providerGap = context.providerComputer && profileId !== "codex"
        ? `Hivra credits can't be set up for ${PROFILE_DETAILS[profileId].name} on a computer in your own cloud yet.`
        : null;
      const empty = context.balance.state === "known" && (total ?? 0) <= 0;
      return {
        mode,
        title: "Hivra credits",
        detail,
        unavailable: codexKeyGap ?? providerGap ?? (empty ? "You have $0 in Hivra credits." : null),
        offerAddCredit: !codexKeyGap && !providerGap && empty,
      };
    });
}

/** Hivra's default: the runtime's own sign-in, except Hermes, which runs on
 * Hivra credits when the owner has some. Null while that depends on a
 * balance still loading. */
export function recommendedModelAccessMode(profileId: LaunchProfileId, balance: CreditsBalance, selfHosted: boolean): LaunchModelAccessMode | null {
  if (profileId !== "hermes" || selfHosted) return "native";
  if (balance.state === "loading") return null;
  const total = totalMicroUsd(balance);
  return total !== null && total > 0 ? "credits" : "native";
}

/** The draft with Hivra's model access default applied. A pure function: it
 * returns the same draft when nothing changes, and never moves a choice the
 * owner made or a launch already sent. */
export function withModelAccessDefault(
  draft: LaunchDraft,
  context: { balance: CreditsBalance; selfHosted: boolean },
): LaunchDraft {
  if (!draft.profileId || !hasModelAccess(draft.profileId)) return draft;
  if (draft.modelAccess.source !== "recommended" || draft.submittedDeployment || draft.stage === "launch") return draft;
  const mode = recommendedModelAccessMode(draft.profileId, context.balance, context.selfHosted);
  if (mode === null || mode === draft.modelAccess.mode) return draft;
  return { ...draft, modelAccess: { ...draft.modelAccess, mode } };
}

/** Model access for a newly chosen profile. */
export function freshModelAccess(): LaunchModelAccess {
  return { ...DEFAULT_MODEL_ACCESS };
}

// ── Providers and models ────────────────────────────────────────────────────

function providerById(id: string): Provider | null {
  return PROVIDERS.find(provider => provider.id === id) ?? null;
}

/** Hermes can use any listed provider it takes a key for. Providers that sign
 * in with a saved session are listed only when that session is in the Vault. */
export function apiKeyProviders(profileId: LaunchProfileId, savedKeys: readonly SavedModelKey[]): Provider[] {
  if (profileId !== "hermes") return [providerById(VENICE)!].filter(Boolean);
  return PROVIDERS.filter(provider => !provider.hidden
    && (!supportsHermesAuthProvider(provider.id) || savedKeys.some(key => key.provider === provider.id)));
}

/** The models the dropdown lists for this choice. */
export function modelChoices(profileId: LaunchProfileId, access: LaunchModelAccess): { value: string; label: string }[] {
  const provider = access.mode === "credits" ? providerById(VENICE) : providerById(access.provider);
  const models = provider?.models ?? [];
  // Codex's model setting only takes plain model IDs.
  return profileId === "codex" ? models.filter(model => CODEX_MODEL.test(model.value)) : models;
}

/** Whether this choice sends a model at launch. OpenClaw, Agent Zero and Aeon
 * pick their own model; native sign-in picks inside the agent. */
export function choosesModel(profileId: LaunchProfileId, mode: LaunchModelAccessMode): boolean {
  if (mode === "native") return false;
  return profileId === "codex" || profileId === "hermes";
}

/** The model this launch sends: the owner's pick, else the default. */
export function effectiveModel(profileId: LaunchProfileId, access: LaunchModelAccess): string {
  if (access.model.trim()) return access.model.trim();
  if (profileId === "codex") return VENICE_DEFAULT_MODEL;
  // A custom endpoint's model is whatever the owner types; there's no default.
  if (usesCustomEndpoint(profileId, access)) return "";
  return modelChoices(profileId, access)[0]?.value ?? "";
}

function usesCustomEndpoint(profileId: LaunchProfileId, access: LaunchModelAccess): boolean {
  return profileId === "hermes" && access.mode === "api-key" && access.provider === "custom_llm";
}

export function modelLabel(profileId: LaunchProfileId, access: LaunchModelAccess): string {
  const model = effectiveModel(profileId, access);
  return modelChoices(profileId, access).find(choice => choice.value === model)?.label ?? model;
}

/** The provider this launch uses: Venice for credits and outside Hermes. */
export function effectiveProvider(profileId: LaunchProfileId, access: LaunchModelAccess): string {
  if (access.mode === "credits" || profileId !== "hermes") return VENICE;
  return access.provider || VENICE;
}

export function providerName(providerId: string): string {
  return providerById(providerId)?.name ?? providerId;
}

/** The saved Vault keys that belong to this choice's provider. */
export function savedKeysFor(profileId: LaunchProfileId, access: LaunchModelAccess, savedKeys: readonly SavedModelKey[]): SavedModelKey[] {
  const provider = effectiveProvider(profileId, access);
  return savedKeys.filter(key => key.provider === provider);
}

/** "••3f2a" from a Vault preview like "sk-abc...3f2a". */
export function savedKeyHint(key: SavedModelKey): string {
  const preview = key.key_preview ?? "";
  const tail = preview.includes("...") ? preview.slice(preview.lastIndexOf("...") + 3) : preview.slice(-4);
  return tail ? `••${tail}` : "saved key";
}

/** A provider that signs in with a saved session takes no pasted key. */
export function requiresSavedKey(profileId: LaunchProfileId, access: LaunchModelAccess): boolean {
  return profileId === "hermes" && supportsHermesAuthProvider(effectiveProvider(profileId, access));
}

function validBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Why this model access can't launch yet, or null when it can. The pasted
 * key is checked against the same shape rules the server runs. */
export function modelAccessProblem(
  profileId: LaunchProfileId,
  access: LaunchModelAccess,
  {
    name,
    pastedKey,
    savedKeys,
    options,
  }: {
    name: string;
    pastedKey: string;
    savedKeys: readonly SavedModelKey[];
    options: readonly ModelAccessOption[];
  },
): string | null {
  const option = options.find(candidate => candidate.mode === access.mode);
  if (!option) return "Choose how this agent reaches a model.";
  if (option.unavailable) return option.unavailable;
  if (access.mode === "native") return null;
  if (access.mode === "credits") {
    return choosesModel(profileId, "credits") && !modelIsValid(profileId, effectiveModel(profileId, access))
      ? "Choose a model from the list, or enter a valid model ID."
      : null;
  }
  const provider = effectiveProvider(profileId, access);
  const saved = savedKeysFor(profileId, access, savedKeys);
  if (access.keySource === "saved" || requiresSavedKey(profileId, access)) {
    const key = saved.find(candidate => candidate.id === access.vaultKeyId);
    if (!key) {
      return requiresSavedKey(profileId, access)
        ? `${providerName(provider)} signs in with a saved session. Connect it from Settings, or choose another provider.`
        : "Choose your saved key, or paste a new one.";
    }
    if (!access.sendSavedKey) return `Confirm that your saved key can be sent to ${name.trim() || "this agent"}'s computer.`;
  } else {
    const key = pastedKey.trim();
    if (!key) return `Paste your ${providerName(provider)} API key.`;
    if (profileId === "codex" && !CODEX_KEY.test(key)) return "Check the key: it should be one line of 8 to 256 characters.";
    const shape = profileId === "hermes" ? validateProviderKeyShape(provider, key) : null;
    if (shape) return shape.message;
  }
  if (usesCustomEndpoint(profileId, access) && !validBaseUrl(access.baseUrl)) {
    return "Enter the base URL of your OpenAI-compatible endpoint.";
  }
  if (usesCustomEndpoint(profileId, access) && !effectiveModel(profileId, access)) {
    return "Enter the model ID your endpoint serves.";
  }
  if (!modelIsValid(profileId, effectiveModel(profileId, access))) {
    return "Choose a model from the list, or enter a valid model ID.";
  }
  return null;
}

function modelIsValid(profileId: LaunchProfileId, model: string): boolean {
  return profileId === "codex" ? CODEX_MODEL.test(model) : HERMES_MODEL.test(model);
}

/** The Review row, in plain words. */
export function modelAccessSummary(
  profileId: LaunchProfileId,
  access: LaunchModelAccess,
  {
    name,
    balance,
    savedKeys,
  }: { name: string; balance: CreditsBalance; savedKeys: readonly SavedModelKey[] },
): string | null {
  if (!hasModelAccess(profileId)) return null;
  const agentName = name.trim() || PROFILE_DETAILS[profileId].name;
  const model = choosesModel(profileId, access.mode) ? ` · ${modelLabel(profileId, access)}` : "";
  if (access.mode === "native") return nativeCopy(profileId).summary;
  if (access.mode === "credits") {
    const available = creditsAvailableMicroUsd(access, balance);
    const funds = available === null ? "" : ` (${formatCredits(available)} available)`;
    if (profileId === "aeon") return `Hivra credits${funds}. Aeon sets them up when you connect GitHub.`;
    return `Hivra credits${funds}${model}`;
  }
  const provider = providerName(effectiveProvider(profileId, access));
  if (access.keySource === "saved" || requiresSavedKey(profileId, access)) {
    const key = savedKeysFor(profileId, access, savedKeys).find(candidate => candidate.id === access.vaultKeyId);
    return `Your saved ${provider} key${key ? ` ${savedKeyHint(key)}` : ""}, sent to ${agentName}'s computer${model}`;
  }
  const replaced = access.saveKey ? savedKeysFor(profileId, access, savedKeys)[0] ?? null : null;
  const saving = !access.saveKey ? ""
    : replaced ? ` and saved in your Vault, replacing ${savedKeyHint(replaced)}` : " and saved in your Vault";
  return `The ${provider} key you pasted, sent to ${agentName}'s computer${saving}${model}`;
}

/** The Cost row's model line, or null when the model isn't paid through Hivra. */
export function modelCostNote(profileId: LaunchProfileId, access: LaunchModelAccess): string | null {
  if (!hasModelAccess(profileId)) return null;
  if (access.mode === "credits") return "Model usage is paid from your Hivra credits at provider rates.";
  if (access.mode === "api-key") return `${providerName(effectiveProvider(profileId, access))} bills your model usage.`;
  return null;
}
