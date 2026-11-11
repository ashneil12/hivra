// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// MonoCode's model source, for one computer. MonoCode reads every provider's
// catalog from its app; the chat here talks to one computer whose agent CLI is
// fixed, so the source is that CLI's model list (what Settings offers) with the
// settings each model carries (the effort levels). It also keeps what MonoCode
// remembers for the picker: favourite models and the recently used ones.

import { effortHint, effortLabel, type BoxModelOption, type EffortLevel } from "@/lib/hivra/agent-models";

export type ModelSettingChoice = {
  value: string;
  label: string;
  /** One line on what the choice trades, shown as the row's tooltip. */
  description?: string;
};

export type ModelSetting = {
  id: string;
  label: string;
  kind: "select";
  value: string;
  options: ModelSettingChoice[];
  description?: string;
};

export type ChatModel = {
  /** The model id Settings stores ("" is the CLI's own default). */
  id: string;
  name: string;
  settings: ModelSetting[];
};

export const EFFORT_SETTING_ID = "effort";

/** The select setting that sets the effort level, when the model has one. */
export function effortSettingOf(model: ChatModel): ModelSetting | undefined {
  return model.settings.find((setting) => setting.id === EFFORT_SETTING_ID);
}

/**
 * The effort setting: "Default" (the agent's own) first, then each level.
 * `value` is the level picked, "" for the default.
 */
export function effortSetting(levels: readonly EffortLevel[], effort: EffortLevel | null): ModelSetting | null {
  if (levels.length === 0) return null;
  return {
    id: EFFORT_SETTING_ID,
    label: "Effort",
    kind: "select",
    value: effort ?? "",
    description: "How much the agent thinks before it answers",
    options: [
      { value: "", label: "Default", description: "The agent's own choice" },
      ...levels.map((level) => ({ value: level, label: effortLabel(level), description: effortHint(level) })),
    ],
  };
}

export interface ModelSource {
  /** Every model the computer's CLI can be switched between. */
  models: readonly ChatModel[];
  /** The model for an id; an id the list does not hold (a custom one) is named by itself. */
  resolve(id: string): ChatModel;
  find(id: string): ChatModel | undefined;
}

export function buildModelSource(options: readonly BoxModelOption[], setting: ModelSetting | null, currentModelName: string): ModelSource {
  const settings = setting ? [setting] : [];
  const models: ChatModel[] = options.map((option) => ({ id: option.value, name: option.label, settings }));
  const find = (id: string) => models.find((model) => model.id === id);
  return {
    models,
    find,
    resolve: (id) => find(id) ?? { id, name: currentModelName || id || "Default", settings },
  };
}

// ---- what the picker remembers on this device ---------------------------------

const FAVORITES_KEY = "hivra_model_favorites";
const RECENTS_KEY = "hivra_model_recents";
const RECENT_LIMIT = 6;

function readList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Private mode or no room: the choice just is not remembered.
  }
}

/** A model's key in the lists, scoped to its CLI so Claude Code's "opus" is not Codex's. */
export function modelKey(cliKind: string, id: string): string {
  return `${cliKind}:${id}`;
}

export const loadFavoriteModels = (): string[] => readList(FAVORITES_KEY);
export const saveFavoriteModels = (keys: string[]) => writeList(FAVORITES_KEY, keys);
export const loadRecentModels = (): string[] => readList(RECENTS_KEY).slice(0, RECENT_LIMIT);

export function saveRecentModel(key: string) {
  writeList(RECENTS_KEY, [key, ...readList(RECENTS_KEY).filter((item) => item !== key)].slice(0, RECENT_LIMIT));
}
