"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { manageButtonGhost, manageLabel, manageSpin } from "./manage-styles";

/**
 * The danger zone: permanent deletion behind an acknowledgement and the typed
 * name, for every kind of computer and agent. Cancel sits where Destroy was,
 * and the destructive button comes second. `armDelayMs` also ignores a press
 * that arrives with the reveal (a double tap on Destroy).
 */
export function ManageDangerZone({
  name,
  title,
  description,
  warning,
  confirmWarning,
  busy,
  deleting,
  progress,
  armDelayMs = 0,
  onConfirm,
  error,
}: {
  name: string;
  title: string;
  description: string;
  /** Extra consequences, shown before confirming… */
  warning?: ReactNode;
  /** …and while confirming. */
  confirmWarning?: ReactNode;
  busy: boolean;
  deleting: boolean;
  progress?: string | null;
  armDelayMs?: number;
  onConfirm: () => void;
  error?: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState("");
  const shownAt = useRef(0);
  // Focus the name field only with a fine pointer: on touch the keyboard would
  // open before the acknowledgement checkbox and cover the Destroy controls.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!confirming || typeof window.matchMedia !== "function") return;
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }, [confirming]);

  const matches = typed.trim() === name;
  const ready = ack && matches;

  return (
    <section id="danger" aria-labelledby="manage-danger-title" style={{ display: "grid", gap: 10, scrollMarginTop: 72 }}>
      <div id="manage-danger-title" className="mono" style={{ ...manageLabel, color: "#c0623f" }}>Danger zone</div>
      <div style={{ border: "1px solid rgba(192,57,43,0.4)", background: "rgba(192,57,43,0.04)", padding: 18, display: "grid", gap: 14, gridTemplateColumns: "minmax(0, 1fr)" }}>
        {!confirming ? (
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="serif" style={{ fontSize: 16, fontWeight: 400, color: "var(--ink-black)" }}>{title}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 3 }}>{description}</div>
              {warning ? <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 6 }}>{warning}</div> : null}
            </div>
            <button type="button" onClick={() => { shownAt.current = Date.now(); setConfirming(true); setAck(false); setTyped(""); }} style={{ border: "1px solid #c0392b", background: "transparent", color: "#e06c5a", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800, padding: "9px 14px", minHeight: 40, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7 }}>
              <Trash2 size={14} /> Destroy
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 9 }}>
              <AlertTriangle size={18} style={{ color: "#e06c5a", flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 13, color: "var(--ink-black)", lineHeight: 1.55 }}>
                This will <strong>permanently destroy</strong> <span className="mono" style={{ color: "#c0623f" }}>{name}</span> and wipe its disk. Anything not saved elsewhere is gone for good.
                {confirmWarning ? <p style={{ margin: "8px 0 0" }}>{confirmWarning}</p> : null}
              </div>
            </div>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, fontSize: 12.5, color: "var(--text-secondary)", cursor: "pointer", lineHeight: 1.5 }}>
              <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} style={{ marginTop: 2, accentColor: "#c0392b" }} />
              I understand this is irreversible and deletes all data on the computer.
            </label>
            <div>
              <div className="mono" style={{ ...manageLabel, marginBottom: 6 }}>Type <span style={{ color: "#c0623f" }}>{name}</span> to confirm</div>
              <input ref={inputRef} value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={name} aria-label={`Type ${name} to confirm`}
                autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" enterKeyHint="done"
                style={{ width: "100%", padding: "9px 12px", minHeight: 40, boxSizing: "border-box", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", fontSize: 13, fontFamily: "var(--font-mono), monospace", outline: "none" }} />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)} style={{ ...manageButtonGhost, cursor: busy ? "default" : "pointer" }}>Cancel</button>
              <button
                type="button"
                disabled={busy || !ready}
                onClick={() => {
                  if (!ready || Date.now() - shownAt.current < armDelayMs) return;
                  onConfirm();
                }}
                style={{ border: "1px solid #c0392b", background: ready ? "#c0392b" : "transparent", color: ready ? "#fff" : "var(--text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800, padding: "10px 16px", minHeight: 40, cursor: busy || !ready ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 7 }}
              >
                {deleting ? <Loader2 size={14} style={manageSpin} /> : <Trash2 size={14} />} Permanently destroy
              </button>
            </div>
            {deleting && progress ? <p role="status" style={{ margin: 0, color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5 }}>{progress}</p> : null}
          </>
        )}
        {error}
      </div>
    </section>
  );
}
