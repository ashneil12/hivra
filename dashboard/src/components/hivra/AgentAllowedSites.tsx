"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import styles from "./AgentModelSettings.module.css";

export interface AllowedSitesView {
  enabled: boolean;
  sites: string[];
  applyState: "pending" | "applied" | "saved" | "failed" | null;
  applyError: string | null;
  appliedAt: string | null;
  updatedAt: string | null;
  alwaysAllowed: string[];
  maxSites: number;
}

async function call(agentId: string, init?: RequestInit): Promise<AllowedSitesView | null> {
  const response = await fetch(`/api/hivra/agents/${encodeURIComponent(agentId)}/allowed-sites`, {
    cache: "no-store", credentials: "same-origin", redirect: "error", ...init,
  });
  const json = await response.json().catch(() => null);
  // 404 (feature off or not this owner's agent): show nothing.
  if (!init?.method && response.status === 404) return null;
  if (!response.ok || json?.success !== true) {
    throw new Error(typeof json?.error === "string" ? json.error : "Allowed sites couldn't be loaded.");
  }
  return json.data as AllowedSitesView;
}

const toLines = (sites: string[]) => sites.join("\n");
const fromLines = (text: string) => text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);

/** Which sites this computer may reach, enforced on its server. Renders nothing
 * unless the server offers it (NEXT_PUBLIC_HIVRA_ALLOWED_SITES on). */
export function AgentAllowedSites({ agentId }: { agentId: string }) {
  const [view, setView] = useState<AllowedSitesView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await call(agentId, { signal });
      if (signal?.aborted) return;
      setView(next);
      setEnabled(next?.enabled ?? false);
      setDraft(toLines(next?.sites ?? []));
      setError(null);
    } catch (cause) {
      if (!signal?.aborted) setError((cause as Error).message);
    }
  }, [agentId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (!view && !error) return null;

  const save = async (nextEnabled: boolean) => {
    setSaving(true); setError(null); setNotice(null);
    try {
      const next = await call(agentId, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled, sites: fromLines(draft) }),
      });
      setView(next);
      setEnabled(next?.enabled ?? nextEnabled);
      setDraft(toLines(next?.sites ?? []));
      if (next?.applyState === "applied") {
        setNotice(nextEnabled ? "Saved. This computer can now reach only the sites below." : "Limit off. This computer can reach any site again.");
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const count = fromLines(draft).length;
  const tooMany = view ? count > view.maxSites : false;

  return <div className={styles.current} aria-label="Allowed sites">
    <div style={{ flex: 1 }}>
      <span className={styles.label}>Allowed sites</span>
      <p>{view?.enabled ? `Limited to ${view.sites.length} site${view.sites.length === 1 ? "" : "s"}.` : "Not limited: this computer can reach any site."}</p>
      <p className={styles.help}>
        Turn this on to let this computer reach only the sites you list, plus what Hivra needs to keep it connected.
        The limit is set on the server the computer runs on, so nothing inside the computer can switch it off.
        List one address per line, like github.com or api.openai.com. Each address needs its own line: listing example.com does not cover www.example.com.
      </p>
      <label className={styles.field} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={saving} />
        Only allow the sites below
      </label>
      <label className={styles.field}>Sites
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={6} disabled={saving}
          placeholder={"github.com\napi.openai.com"} spellCheck={false} autoCapitalize="off" autoCorrect="off"
          style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 13, width: "100%", resize: "vertical" }} />
      </label>
      {view?.alwaysAllowed?.length ? <p className={styles.help}>Always allowed so this computer stays connected: {view.alwaysAllowed.join(", ")}. Name lookups (DNS) and clock sync also stay open.</p> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={saving || tooMany} onClick={() => void save(enabled)}>
          {saving ? <Loader2 size={14} className={styles.spinner} aria-hidden="true" /> : null}Save
        </button>
      </div>
      {tooMany ? <p role="alert" className={styles.warning}>List at most {view?.maxSites} sites.</p> : null}
      {view?.applyError ? <p role="status" className={styles.warning}>{view.applyError}</p> : null}
      {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
      {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
    </div>
  </div>;
}
