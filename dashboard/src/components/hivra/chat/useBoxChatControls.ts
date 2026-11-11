"use client";

// What the composer's pickers read and change on the computer: its model
// (GET/POST /api/model, the same calls Settings makes), the effort levels it
// offers (`chatEffort` in GET /api/meta, remembered per agent once picked) and
// its permission preset (GET/POST /api/restrict, also Settings'). The model and
// access pickers are only offered when the computer answers for them, so an
// older computer shows the composer without them.
//
// Effort is always listed for Claude Code and Codex. A computer whose chat
// service predates `chatEffort` does not take it yet: a level picked there is
// held back (and never sent) until the owner updates the connection service
// from the picker, the same update Manage's "Update connection service" runs,
// after which the held level is applied once /api/meta advertises effort.

import { useCallback, useEffect, useRef, useState } from "react";
import { AgentActionError, getBoxChatMeta, getBoxModel, getBoxRestrict, setBoxModel, setBoxRestrict, updateAgentRuntime, type BoxRestrict } from "@/lib/hivra/agent-api";
import { BOX_MODEL_OPTIONS, defaultEffortLevels, isEffortLevel, modelLabelFor, parseChatEffort, type BoxModelOption, type EffortLevel } from "@/lib/hivra/agent-models";
import { agentSoftwareUpdateError } from "../AgentSoftwarePanel";

/** How often a computer that is updating is asked whether it advertises effort yet, and for how long. */
export const EFFORT_POLL_MS = 3_000;
export const EFFORT_POLL_LIMIT_MS = 3 * 60_000;

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

/**
 * Where the effort levels stand on this computer. `checking`: its answer is
 * not in yet. `idle`: it does not advertise effort (its connection service is
 * older) and nothing has been done about it. `updating`: the connection
 * service is being updated and the computer is being watched for the answer.
 * `failed`: the update did not finish. `ready`: it advertises effort now.
 */
export type EffortUpdateState = "checking" | "idle" | "updating" | "failed" | "ready";

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
  /** The levels the chat lists: the ones the computer advertises, or the agent's own full set until it does. Empty for an agent with no effort. */
  effortLevels: readonly EffortLevel[];
  /** The computer advertises `chatEffort`, so a level picked is sent with each turn. */
  effortReady: boolean;
  /** The level picked for this agent, or null for the agent's own default. Only a level the computer offers. */
  effort: EffortLevel | null;
  /** On a computer that does not advertise effort the level is held, not applied, until it does. */
  changeEffort: (level: EffortLevel | null) => void;
  effortUpdate: { state: EffortUpdateState; message: string | null; /** An update can be started from here. */ available: boolean };
  /** Start the connection-service update that gives the computer effort levels. */
  startEffortUpdate: () => void;
  /** The permission preset, or null when the computer has no such setting. */
  restrict: BoxRestrict | null;
  changeRestrict: (value: BoxRestrict) => void;
  /** A model or access change is being applied. */
  pending: boolean;
  error: string | null;
}

export function useBoxChatControls({ boxUrl, token, agentKind, storageKey: skey, modelLocked, lockedModelName, computerId, onConnectionServiceRestarted }: {
  boxUrl: string;
  token?: string | null;
  agentKind: string;
  storageKey: string;
  /** The model comes from the agent's own provider connection, not the CLI's model setting. */
  modelLocked: boolean;
  /** What the pill says for a locked model: the provider connection's own. */
  lockedModelName?: string;
  /** The computer whose connection service the owner can update from the picker. Without it the picker points to Manage. */
  computerId?: string;
  /** The update restarted the connection service, which drops embedded surfaces' sign-ins. */
  onConnectionServiceRestarted?: () => void;
}): BoxChatControls {
  const isChatCli = agentKind === "claude" || agentKind === "codex";
  const [model, setModel] = useState<string | null | undefined>(undefined);
  const [levels, setLevels] = useState<readonly EffortLevel[]>([]);
  const [metaAnswered, setMetaAnswered] = useState(false);
  const [update, setUpdate] = useState<{ state: "idle" | "updating" | "failed" | "ready"; message: string | null }>({ state: "idle", message: null });
  const wanted = useRef<EffortLevel | null | undefined>(undefined);
  const restarted = useRef(onConnectionServiceRestarted);
  useEffect(() => { restarted.current = onConnectionServiceRestarted; });
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
    setLevels([]);
    setMetaAnswered(false);
    setUpdate({ state: "idle", message: null });
    wanted.current = undefined;
    if (!token) return;
    const controller = new AbortController();
    void getBoxChatMeta(boxUrl, token, controller.signal).then((meta) => {
      if (controller.signal.aborted) return;
      if (meta) setLevels(parseChatEffort(meta.chatEffort));
      setMetaAnswered(true);
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

  const ready = levels.length > 0;
  const changeEffort = useCallback((level: EffortLevel | null) => {
    if (!ready) {
      // Not taken yet: held, and applied once the computer advertises effort.
      wanted.current = level;
      return;
    }
    setEffort(level);
    saveEffort(skey, level);
    setUpdate((u) => (u.state === "ready" ? { state: "idle", message: null } : u));
  }, [ready, skey]);

  // A level the owner picked before the computer advertised effort, applied as soon as it does.
  useEffect(() => {
    if (!ready || wanted.current === undefined) return;
    const level = wanted.current;
    wanted.current = undefined;
    if (level === null || levels.includes(level)) {
      setEffort(level);
      saveEffort(skey, level);
    }
  }, [ready, levels, skey]);

  const startEffortUpdate = useCallback(() => {
    if (!computerId || !token || update.state === "updating") return;
    setUpdate({ state: "updating", message: null });
    void (async () => {
      let watch = true;
      try {
        await updateAgentRuntime(computerId);
        restarted.current?.();
      } catch (error) {
        // 502: the update could not be confirmed and may have finished, so the computer is still watched.
        const unverified = error instanceof AgentActionError && error.status === 502;
        if (unverified) restarted.current?.();
        else {
          watch = false;
          if (alive.current) {
            const message = error instanceof AgentActionError && error.code
              ? agentSoftwareUpdateError(error.code, error.message, false, "computer")
              : error instanceof Error ? error.message : "The update didn't start.";
            setUpdate({ state: "failed", message });
          }
        }
      }
      if (!watch) return;
      const until = Date.now() + EFFORT_POLL_LIMIT_MS;
      while (alive.current && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, EFFORT_POLL_MS));
        if (!alive.current) return;
        const meta = await getBoxChatMeta(boxUrl, token);
        if (!alive.current) return;
        const offered = meta ? parseChatEffort(meta.chatEffort) : [];
        if (offered.length > 0) {
          setUpdate({ state: "ready", message: null });
          setLevels(offered);
          return;
        }
      }
      if (alive.current) setUpdate({ state: "failed", message: "The computer hasn't finished updating yet. Try again in a minute." });
    })();
  }, [boxUrl, computerId, token, update.state]);

  const models = isChatCli && !modelLocked && model !== undefined ? BOX_MODEL_OPTIONS[agentKind] || [] : [];
  return {
    agentKind,
    models,
    model: model || "",
    modelName: modelLocked && lockedModelName ? lockedModelName : model === undefined || !model ? "Default" : modelLabelFor(agentKind, model),
    changeModel,
    effortLevels: levels.length > 0 ? levels : defaultEffortLevels(agentKind),
    effortReady: ready,
    effort: effort && levels.includes(effort) ? effort : null,
    changeEffort,
    effortUpdate: {
      state: ready ? (update.state === "ready" ? "ready" : "idle") : !metaAnswered && token ? "checking" : update.state,
      message: update.message,
      available: Boolean(computerId && token),
    },
    startEffortUpdate,
    restrict,
    changeRestrict,
    pending,
    error,
  };
}
