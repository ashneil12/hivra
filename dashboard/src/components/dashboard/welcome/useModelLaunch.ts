"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { AgentLaunchError, createAgentModelLaunch, findAgentModelLaunch, SavedModelLaunchSchema,
  type ModelLaunchAgent, type ModelLaunchIntent, type SavedModelLaunch } from "@/lib/hivra/agent-launch-api";

export const modelLaunchStorageKey = (ownerId: string) => `hivra:codex-model-launch:v1:${ownerId}`;
type State = { ownerId: string | null; ready: boolean; busy: boolean; editing: boolean; saved: SavedModelLaunch | null; agent: ModelLaunchAgent | null; error: string | null };
const initial = (ownerId: string | null): State => ({ ownerId, ready: false, busy: false, editing: false, saved: null, agent: null, error: null });
const STORAGE_ERROR = "This browser could not retain your launch request. Enable session storage before launching with a model key. No new launch was sent.";
function read(ownerId: string): SavedModelLaunch | null {
  const raw = sessionStorage.getItem(modelLaunchStorageKey(ownerId));
  return raw === null ? null : SavedModelLaunchSchema.parse(JSON.parse(raw));
}

/** Browser persistence contains only the request ID and a whitelisted key-free
 * intent, scoped to the signed-in owner. The API key never enters this state. */
export function useModelLaunch(ownerId: string | null) {
  const [state, setState] = useState<State>(() => initial(ownerId));
  const owner = useRef(ownerId);
  const work = useRef<AbortController | null>(null);
  const live = useRef(true);
  const stateRef = useRef(state);
  const update = useCallback((value: State) => { stateRef.current = value; setState(value); }, []);
  const current = useCallback((controller: AbortController, id: string) => live.current && owner.current === id && work.current === controller && !controller.signal.aborted, []);

  useLayoutEffect(() => {
    owner.current = ownerId;
    live.current = true;
    const controller = new AbortController();
    work.current?.abort(); work.current = controller;
    if (!ownerId) { update(initial(ownerId)); return () => { live.current = false; controller.abort(); }; }
    try {
      const saved = read(ownerId);
      update({ ...initial(ownerId), ready: true, saved, busy: Boolean(saved) });
      if (saved) {
        void findAgentModelLaunch(saved.requestId, { signal: controller.signal }).then(agent => {
          if (current(controller, ownerId)) update({ ...stateRef.current, busy: false, agent,
            error: agent ? null : "The original request is not visible yet. Keep this request ID: an earlier launch may still be finishing." });
        }).catch(error => {
          if (current(controller, ownerId)) update({ ...stateRef.current, busy: false, error: error instanceof AgentLaunchError ? error.message : "The saved launch could not be checked." });
        });
      }
    } catch { update({ ...initial(ownerId), error: STORAGE_ERROR }); }
    return () => { live.current = false; work.current?.abort(); };
  }, [ownerId, current, update]);

  async function check() {
    const before = stateRef.current;
    if (!ownerId || before.ownerId !== ownerId || before.busy || !before.saved || !before.ready) return;
    const controller = new AbortController(); work.current?.abort(); work.current = controller;
    update({ ...before, busy: true, error: null });
    try {
      const agent = await findAgentModelLaunch(before.saved.requestId, { signal: controller.signal });
      if (current(controller, ownerId)) update({ ...before, busy: false, agent, editing: agent ? false : before.editing,
        error: agent ? null : "The original request is not visible yet. Retrying uses this same ID and cannot allocate a second computer for it." });
    } catch (error) {
      if (current(controller, ownerId)) update({ ...before, busy: false, error: error instanceof AgentLaunchError ? error.message : "The saved launch could not be checked." });
    }
  }

  async function submit(intent: ModelLaunchIntent, apiKey: string): Promise<ModelLaunchAgent | null> {
    const before = stateRef.current;
    if (!ownerId || before.ownerId !== ownerId || !before.ready || before.busy || !live.current) return null;
    if (before.agent) return before.agent;
    const controller = new AbortController(); work.current?.abort(); work.current = controller;
    let saved: SavedModelLaunch;
    try {
      // Re-read before writing, including after another instance in this tab
      // has reserved a request. Schema parsing rejects accidental secret fields.
      const existing = read(ownerId);
      if (before.saved && existing?.requestId !== before.saved.requestId) throw new Error("Changed request");
      saved = existing && !before.editing ? existing
        : SavedModelLaunchSchema.parse({ requestId: existing?.requestId ?? crypto.randomUUID(), intent });
      sessionStorage.setItem(modelLaunchStorageKey(ownerId), JSON.stringify(saved));
      if (JSON.stringify(read(ownerId)) !== JSON.stringify(saved)) throw new Error("Storage did not retain the request");
    } catch { update({ ...before, error: STORAGE_ERROR }); return null; }
    update({ ...before, busy: true, editing: false, saved, error: null });
    try {
      // A retry first looks for the original. A missing read does not authorize
      // a fresh ID; the server's atomic reservation also fences in-flight POSTs.
      const original = before.saved ? await findAgentModelLaunch(saved.requestId, { signal: controller.signal }) : null;
      if (!current(controller, ownerId)) return null;
      const agent = original ?? await createAgentModelLaunch(saved, apiKey, { signal: controller.signal });
      if (!current(controller, ownerId)) return null;
      update({ ...before, ready: true, saved, agent, busy: false, editing: false, error: null });
      return agent;
    } catch (error) {
      if (current(controller, ownerId)) update({ ...before, saved, busy: false, editing: false, error: error instanceof AgentLaunchError ? error.message : "The saved launch could not be confirmed." });
      return null;
    }
  }

  function startAnother() {
    const before = stateRef.current;
    // Only a positively identified original allows an explicit new launch.
    // Neither a failed POST, a 404 lookup nor a deleted local draft does.
    if (!ownerId || before.ownerId !== ownerId || before.busy || !before.agent || !before.saved) return;
    try {
      if (read(ownerId)?.requestId !== before.saved.requestId) throw new Error("Changed request");
      sessionStorage.removeItem(modelLaunchStorageKey(ownerId));
      if (read(ownerId)) throw new Error("Request not removed");
      update({ ...initial(ownerId), ready: true });
    } catch { update({ ...before, error: STORAGE_ERROR }); }
  }

  function reviewChoices() {
    const before = stateRef.current;
    if (before.ownerId === ownerId && before.ready && before.saved && !before.agent && !before.busy) update({ ...before, editing: true });
  }

  return { ...(state.ownerId === ownerId ? state : initial(ownerId)), submit, check, startAnother, reviewChoices };
}
