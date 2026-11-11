"use client";

// What the composer's pickers read and change on the computer: its model
// (GET/POST /api/model, the same calls Settings makes), the effort levels it
// offers (`chatEffort` in GET /api/meta, remembered per agent once picked) and
// its permission preset (GET/POST /api/restrict, also Settings'). Every one of
// them is only offered when the computer answers for it, so an older computer
// shows the composer without that picker.

import { useCallback, useEffect, useRef, useState } from "react";
import { getBoxChatMeta, getBoxModel, getBoxRestrict, setBoxModel, setBoxRestrict, type BoxRestrict } from "@/lib/hivra/agent-api";
import { BOX_MODEL_OPTIONS, isEffortLevel, modelLabelFor, parseChatEffort, type BoxModelOption, type EffortLevel } from "@/lib/hivra/agent-models";

function storageKey(skey: string): string {
  return "hivra_effort_" + skey.replace(/[^a-z0-9]/gi, "").slice(-32);
}
function loadEffort(skey: string): EffortLevel | null {
  try {
    const value = window.localStorage.getItem(storageKey(skey));
    return isEffortLevel(value) ? value : null;
  } catch {
    return null;
  }
}
function saveEffort(skey: string, level: EffortLevel | null) {
  try {
    if (level) window.localStorage.setItem(storageKey(skey), level);
    else window.localStorage.removeItem(storageKey(skey));
  } catch {
    // The choice just is not remembered.
  }
}

export interface BoxChatControls {
  /** The agent's CLI, which words the access hints. */
  agentKind: string;
  /** The models the agent's CLI can switch between; empty when the model cannot be changed from the chat. */
  models: readonly BoxModelOption[];
  /** The current model id ("" for the CLI's default). */
  model: string;
  /** What the pill says: the model's name, or "Default". */
  modelName: string;
  changeModel: (value: string) => void;
  /** The effort levels the computer takes (`chatEffort`); empty when it takes none. */
  effortLevels: readonly EffortLevel[];
  /** The level picked for this agent, or null for the agent's own default. Only a level the computer offers. */
  effort: EffortLevel | null;
  changeEffort: (level: EffortLevel | null) => void;
  /** The permission preset, or null when the computer has no such setting. */
  restrict: BoxRestrict | null;
  changeRestrict: (value: BoxRestrict) => void;
  /** A model or access change is being applied. */
  pending: boolean;
  error: string | null;
}

export function useBoxChatControls({ boxUrl, token, agentKind, storageKey: skey, modelLocked, lockedModelName }: {
  boxUrl: string;
  token?: string | null;
  agentKind: string;
  storageKey: string;
  /** The model comes from the agent's own provider connection, not the CLI's model setting. */
  modelLocked: boolean;
  /** What the pill says for a locked model: the provider connection's own. */
  lockedModelName?: string;
}): BoxChatControls {
  const isChatCli = agentKind === "claude" || agentKind === "codex";
  const [model, setModel] = useState<string | null | undefined>(undefined);
  const [levels, setLevels] = useState<readonly EffortLevel[]>([]);
  const [effort, setEffort] = useState<EffortLevel | null>(null);
  const [restrict, setRestrict] = useState<BoxRestrict | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // The effort choice belongs to the agent; read it when the agent changes.
  useEffect(() => {
    setEffort(loadEffort(skey));
  }, [skey]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLevels([]);
    void getBoxChatMeta(boxUrl, token, controller.signal).then((meta) => {
      if (!controller.signal.aborted && meta) setLevels(parseChatEffort(meta.chatEffort));
    });
    return () => controller.abort();
  }, [boxUrl, token]);

  useEffect(() => {
    setModel(undefined);
    setRestrict(null);
    if (!token || !isChatCli) return;
    let cancelled = false;
    // An older computer has no /api/model or /api/restrict: the error hides that picker, as it does in Settings.
    void getBoxModel(boxUrl, token).then((r) => {
      if (!cancelled && !r.error) setModel(r.model);
    });
    void getBoxRestrict(boxUrl, token).then((r) => {
      if (!cancelled && !r.error) setRestrict(r.restrict);
    });
    return () => { cancelled = true; };
  }, [boxUrl, token, isChatCli]);

  const changeModel = useCallback((value: string) => {
    if (!token || pending) return;
    const previous = model;
    setPending(true);
    setError(null);
    setModel(value || null);
    void setBoxModel(boxUrl, value || null, token).then((r) => {
      if (!alive.current) return;
      setPending(false);
      if (!r.ok) {
        setModel(previous);
        setError(r.error || "Couldn't change the model");
      }
    });
  }, [boxUrl, model, pending, token]);

  const changeRestrict = useCallback((value: BoxRestrict) => {
    if (!token || pending) return;
    const previous = restrict;
    setPending(true);
    setError(null);
    setRestrict(value);
    void setBoxRestrict(boxUrl, value, token).then((r) => {
      if (!alive.current) return;
      setPending(false);
      if (!r.ok) {
        setRestrict(previous);
        setError(r.error || "Couldn't change access");
      }
    });
  }, [boxUrl, pending, restrict, token]);

  const changeEffort = useCallback((level: EffortLevel | null) => {
    setEffort(level);
    saveEffort(skey, level);
  }, [skey]);

  const models = isChatCli && !modelLocked && model !== undefined ? BOX_MODEL_OPTIONS[agentKind] || [] : [];
  return {
    agentKind,
    models,
    model: model || "",
    modelName: modelLocked && lockedModelName ? lockedModelName : model === undefined || !model ? "Default" : modelLabelFor(agentKind, model),
    changeModel,
    effortLevels: levels,
    effort: effort && levels.includes(effort) ? effort : null,
    changeEffort,
    restrict,
    changeRestrict,
    pending,
    error,
  };
}
