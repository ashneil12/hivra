"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import styles from "./AgentModelSettings.module.css";

export interface AgentSpendLimitView {
  dailyLimitUsd: number | null;
  defaultDailyLimitUsd: number | null;
  effectiveDailyLimitUsd: number | null;
  spentTodayUsd: number;
  reachedToday: boolean;
  lastReachedAt: string | null;
  resetsAt: string;
  days: Array<{ day: string; spentUsd: number }>;
}

const money = (n: number) => `$${n.toFixed(2)}`;

async function call(agentId: string, init?: RequestInit): Promise<AgentSpendLimitView | null> {
  const response = await fetch(`/api/hivra/agents/${encodeURIComponent(agentId)}/spend-cap`, {
    cache: "no-store", credentials: "same-origin", redirect: "error", ...init,
  });
  const json = await response.json().catch(() => null);
  // 404 (feature off) and 409 (not on the managed gateway): show nothing.
  if (!init?.method && (response.status === 404 || response.status === 409)) return null;
  if (!response.ok || json?.success !== true) {
    throw new Error(typeof json?.error === "string" ? json.error : "The daily limit couldn't be loaded.");
  }
  return json.data as AgentSpendLimitView;
}

/** Daily limit on an agent's managed inference spend. Renders nothing unless the
 * server offers it for this agent (flag on and the agent is on the managed gateway). */
export function AgentSpendLimit({ agentId, refreshKey }: { agentId: string; refreshKey?: unknown }) {
  const [view, setView] = useState<AgentSpendLimitView | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await call(agentId, { signal });
      if (signal?.aborted) return;
      setView(next);
      setDraft(next?.dailyLimitUsd != null ? String(next.dailyLimitUsd) : "");
      setError(null);
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

  const save = async (dailyLimitUsd: number | null) => {
    setSaving(true); setError(null); setNotice(null);
    try {
      const next = await call(agentId, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dailyLimitUsd }),
      });
      setView(next);
      setDraft(next?.dailyLimitUsd != null ? String(next.dailyLimitUsd) : "");
      setNotice(dailyLimitUsd === null ? "Daily limit removed." : "Daily limit saved. It applies to the next request.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const parsed = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(parsed) && parsed > 0 && parsed <= 10_000;
  const limit = view?.effectiveDailyLimitUsd ?? null;

  return <div className={styles.current} aria-label="Daily spend limit">
    <div style={{ flex: 1 }}>
      <span className={styles.label}>Daily spend limit</span>
      {view ? <p>{money(view.spentTodayUsd)} spent today{limit !== null ? ` of ${money(limit)}` : ", no limit"}</p> : null}
      {view?.reachedToday ? <p role="status" className={styles.warning}>
        Limit reached today. New requests are paused until {new Date(view.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
      </p> : null}
      <p className={styles.help}>Stops this agent&apos;s managed inference for the rest of the day (UTC) once it has spent this much.
        {view?.dailyLimitUsd == null && view?.defaultDailyLimitUsd != null ? ` Hivra's default of ${money(view.defaultDailyLimitUsd)} applies until you set your own.` : ""}</p>
      <div className={styles.actions}>
        <label className={styles.field}>Limit per day (USD)
          <input type="number" inputMode="decimal" min="0.01" max="10000" step="0.01" value={draft}
            onChange={e => setDraft(e.target.value)} placeholder="e.g. 5" disabled={saving} />
        </label>
        <button type="button" className={styles.primary} disabled={saving || !valid} onClick={() => void save(parsed)}>
          {saving ? <Loader2 size={14} className={styles.spinner} aria-hidden="true" /> : null}Save limit
        </button>
        {view?.dailyLimitUsd != null ? <button type="button" className={styles.quiet} disabled={saving} onClick={() => void save(null)}>Remove</button> : null}
      </div>
      {view && view.days.some(d => d.spentUsd > 0) ? <p className={styles.help}>
        Last 7 days: {view.days.map(d => `${d.day.slice(5)} ${money(d.spentUsd)}`).join(" · ")}
      </p> : null}
      {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
      {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
    </div>
  </div>;
}
