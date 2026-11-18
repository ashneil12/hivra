"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import styles from "./AgentModelSettings.module.css";

export interface AgentPrivateModelsOnlyView {
  enabled: boolean;
  updatedAt: string | null;
  savedModel: string;
  savedModelIsPrivate: boolean;
}

async function call(agentId: string, init?: RequestInit): Promise<AgentPrivateModelsOnlyView | null> {
  const response = await fetch(`/api/hivra/agents/${encodeURIComponent(agentId)}/private-models`, {
    cache: "no-store", credentials: "same-origin", redirect: "error", ...init,
  });
  const json = await response.json().catch(() => null);
  // 404 (feature off) and 409 (not on the managed gateway): show nothing.
  if (!init?.method && (response.status === 404 || response.status === 409)) return null;
  if (!response.ok || json?.success !== true) {
    throw new Error(typeof json?.error === "string" ? json.error : "The private models setting couldn't be loaded.");
  }
  return json.data as AgentPrivateModelsOnlyView;
}

/** "Private models only" for an agent on the managed gateway. Renders nothing unless
 * the server offers it for this agent (flag on and the agent is on the managed gateway).
 * `onChange` reports the saved state so the model list beside it can hide other models. */
export function AgentPrivateModelsOnly({ agentId, refreshKey, onChange }: {
  agentId: string; refreshKey?: unknown; onChange?: (enabled: boolean) => void;
}) {
  const [view, setView] = useState<AgentPrivateModelsOnlyView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Kept in a ref so a parent that passes a new function each render does not restart the load.
  const report = useRef(onChange);
  useEffect(() => { report.current = onChange; }, [onChange]);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await call(agentId, { signal });
      if (signal?.aborted) return;
      setView(next);
      setError(null);
      report.current?.(next?.enabled === true);
    } catch (cause) {
      if (!signal?.aborted) setError((cause as Error).message);
    }
  }, [agentId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  if (!view && !error) return null;

  const save = async (enabled: boolean) => {
    setSaving(true); setError(null); setNotice(null);
    try {
      const next = await call(agentId, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
      });
      setView(next);
      report.current?.(next?.enabled === true);
      setNotice(enabled ? "Private models only is on. It applies to the next request." : "Private models only is off.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const on = view?.enabled === true;
  return <div className={styles.current} aria-label="Private models only">
    <div style={{ flex: 1 }}>
      <span className={styles.label}>Private models only</span>
      {view ? <p>{on ? "On. This agent can only use models Venice marks private." : "Off. This agent can use any model in the Venice list."}</p> : null}
      {view && !view.savedModelIsPrivate ? <p role="status" className={styles.warning}>
        {on
          ? `The saved model, ${view.savedModel}, is not marked private, so requests to it are refused. Choose a private model below.`
          : `The saved model, ${view.savedModel}, is not marked private. If you turn this on, choose a private model below.`}
      </p> : null}
      <p className={styles.help}>Venice marks each model private or anonymized. A request to an anonymized model passes through another
        provider. With this on, Hivra&apos;s gateway refuses any model Venice does not mark private, for chat, images, audio and video.
        Web search and page fetching are not models, so they stay available. It covers the managed gateway only, not your own API key
        or the agent&apos;s native sign-in.</p>
      {view ? <div className={styles.actions}>
        <button type="button" role="switch" aria-checked={on} className={on ? styles.quiet : styles.primary} disabled={saving}
          onClick={() => void save(!on)}>
          {saving ? <Loader2 size={14} className={styles.spinner} aria-hidden="true" /> : null}{on ? "Turn off" : "Turn on"}
        </button>
      </div> : null}
      {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
      {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
    </div>
  </div>;
}
