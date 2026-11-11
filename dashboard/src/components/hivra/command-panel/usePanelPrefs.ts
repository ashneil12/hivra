"use client";

// What one owner chose to show in an agent's command panel, remembered per
// agent in this browser. Nothing is ever deleted: a hidden action, a dismissed
// suggestion and a hidden section are all just a "false" that Customize turns
// back on. Storage can be missing or throw (private windows, blocked site
// data); the choices then last until the page closes and the panel still works.

import { useCallback, useState } from "react";

const KEY_PREFIX = "hivra.commandPanel.v1:";

export interface PanelPrefs {
  /** The panel is open. null: never chosen, so the default for the screen applies. */
  open: boolean | null;
  /** Quick actions the owner turned on or off. Absent: the action's own default. */
  actions: Record<string, boolean>;
  /** Suggestions the owner turned on or off ("Not interested" is false). Absent: shown. */
  suggestions: Record<string, boolean>;
  /** The Recent activity section is shown. */
  activity: boolean;
  /** The Recent activity list is expanded. */
  activityOpen: boolean;
}

export const DEFAULT_PANEL_PREFS: PanelPrefs = {
  open: null,
  actions: {},
  suggestions: {},
  activity: true,
  activityOpen: true,
};

function booleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "boolean") out[key] = entry;
  }
  return out;
}

export function readPanelPrefs(agentId: string): PanelPrefs {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + agentId);
    if (!raw) return DEFAULT_PANEL_PREFS;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_PANEL_PREFS;
    return {
      open: typeof parsed.open === "boolean" ? parsed.open : null,
      actions: booleanRecord(parsed.actions),
      suggestions: booleanRecord(parsed.suggestions),
      activity: typeof parsed.activity === "boolean" ? parsed.activity : true,
      activityOpen: typeof parsed.activityOpen === "boolean" ? parsed.activityOpen : true,
    };
  } catch {
    return DEFAULT_PANEL_PREFS;
  }
}

function writePanelPrefs(agentId: string, prefs: PanelPrefs): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + agentId, JSON.stringify(prefs));
  } catch {
    /* Storage is unavailable: the choice holds for this page only. */
  }
}

export interface UsePanelPrefs {
  prefs: PanelPrefs;
  isActionShown: (id: string, defaultShown: boolean) => boolean;
  setActionShown: (id: string, shown: boolean) => void;
  isSuggestionShown: (id: string) => boolean;
  setSuggestionShown: (id: string, shown: boolean) => void;
  setActivityShown: (shown: boolean) => void;
  setActivityOpen: (open: boolean) => void;
  setOpen: (open: boolean) => void;
}

/**
 * The saved choices for this agent. Key the component that calls it by the
 * agent id: another agent starts from its own choices.
 */
export function usePanelPrefs(agentId: string): UsePanelPrefs {
  const [prefs, setPrefs] = useState<PanelPrefs>(() => readPanelPrefs(agentId));

  const update = useCallback((change: (current: PanelPrefs) => PanelPrefs) => {
    setPrefs((current) => {
      const next = change(current);
      writePanelPrefs(agentId, next);
      return next;
    });
  }, [agentId]);

  return {
    prefs,
    isActionShown: (id, defaultShown) => prefs.actions[id] ?? defaultShown,
    setActionShown: (id, shown) => update((c) => ({ ...c, actions: { ...c.actions, [id]: shown } })),
    isSuggestionShown: (id) => prefs.suggestions[id] ?? true,
    setSuggestionShown: (id, shown) => update((c) => ({ ...c, suggestions: { ...c.suggestions, [id]: shown } })),
    setActivityShown: (shown) => update((c) => ({ ...c, activity: shown })),
    setActivityOpen: (open) => update((c) => ({ ...c, activityOpen: open })),
    setOpen: (open) => update((c) => ({ ...c, open })),
  };
}
