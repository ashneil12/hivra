"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { getBoxRestorePoints, setBoxRestorePoints } from "@/lib/hivra/agent-api";
import styles from "./AgentModelSettings.module.css";

/**
 * Restore points are Hermes's own checkpoints: before Hermes changes files in a
 * turn it snapshots the project, and the owner rolls back with /rollback (or
 * /undo) in any Hermes chat. Hivra only turns Hermes's setting on or off.
 * Unreleased: shown only when NEXT_PUBLIC_HIVRA_RESTORE_POINTS_ENABLED is "true".
 */
export function restorePointsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_HIVRA_RESTORE_POINTS_ENABLED === "true";
}

type Load = { state: "loading" } | { state: "stopped" } | { state: "unreachable" } | { state: "old" } | { state: "ready" };

export function HermesRestorePoints({ chatUrl, apiToken, agentName, running, disabled }: {
  chatUrl: string; apiToken?: string | null; agentName: string; running: boolean; disabled: boolean;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [on, setOn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let alive = true;
    if (!running) { setLoad({ state: "stopped" }); return () => { alive = false; }; }
    setLoad({ state: "loading" });
    void getBoxRestorePoints(chatUrl, apiToken).then(r => {
      if (!alive) return;
      if (r.error) setLoad({ state: "unreachable" });
      else if (!r.supported) setLoad({ state: "old" });
      else { setOn(r.enabled); setLoad({ state: "ready" }); }
    });
    return () => { alive = false; };
  }, [chatUrl, apiToken, running]);

  const heading = <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--ink-black)" }}>Restore points</h4>;
  if (load.state !== "ready") {
    const text = load.state === "loading" ? `Checking ${agentName}'s restore points…`
      : load.state === "stopped" ? `Start this computer to change ${agentName}'s restore points.`
      : load.state === "unreachable" ? `Hivra couldn't reach ${agentName}. Refresh the page to try again.`
      : `Update ${agentName}'s connection service to turn restore points on here.`;
    return <div style={{ display: "grid", gap: 10 }}>{heading}<p className={load.state === "loading" || load.state === "stopped" ? styles.help : styles.notice}>{text}</p></div>;
  }

  const toggle = async () => {
    if (inFlight.current || disabled || saving) return;
    inFlight.current = true; setSaving(true); setNotice(null); setError(null);
    const next = !on;
    try {
      const r = await setBoxRestorePoints(chatUrl, next, apiToken);
      if (r.ok) {
        setOn(next);
        setNotice(next
          ? `On. ${agentName} saves a restore point before it changes files. Type /rollback in a chat to see them and go back.`
          : `Off. ${agentName} keeps the restore points it already saved for a few days, then clears them.`);
      } else setError(r.error || "Could not change restore points.");
    } finally { inFlight.current = false; setSaving(false); }
  };

  return <div style={{ display: "grid", gap: 10 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
        {heading}
        <p className={styles.help}>
          Before {agentName} changes files in a project, it saves a restore point. If a turn goes wrong, type <code>/rollback</code> in
          the chat to pick one and go back, or <code>/undo</code> to take back the last turn. Files sitting directly in the home folder aren&apos;t covered.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Restore points"
        disabled={disabled || saving}
        onClick={() => void toggle()}
        style={{ minWidth: 56, minHeight: 44, border: 0, background: "transparent", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: disabled || saving ? "default" : "pointer", flexShrink: 0, padding: 0, opacity: disabled ? 0.5 : 1 }}
      >
        <span aria-hidden="true" style={{ width: 48, height: 27, borderRadius: 14, border: "1px solid var(--etched-border)", background: on ? "var(--gold-leaf)" : "var(--hg-fill-2)", position: "relative", display: "inline-block", boxSizing: "border-box" }}>
          {saving ? (
            <Loader2 size={13} style={{ animation: "spin 1s linear infinite", color: on ? "var(--hg-on-accent)" : "var(--ink-black)", position: "absolute", top: 6, left: on ? 24 : 6 }} />
          ) : (
            <span style={{ position: "absolute", top: 3, left: on ? 24 : 3, width: 19, height: 19, borderRadius: "50%", background: on ? "var(--hg-on-accent)" : "var(--text-muted)", transition: "left var(--hg-medium) var(--hg-ease)" }} />
          )}
        </span>
      </button>
    </div>
    {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
    {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
  </div>;
}
