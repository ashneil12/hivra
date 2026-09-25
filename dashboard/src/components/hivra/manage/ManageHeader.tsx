"use client";

import { useState, type ReactNode } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { manageButtonGhost, manageLabel, manageSpin } from "./manage-styles";

const STATUS_COLOR: Record<string, string> = {
  running: "#22c55e", ready: "#22c55e", provisioning: "var(--yellow)", stopped: "var(--text-muted)", paused: "var(--text-muted)",
  error: "#e06c5a", deleted: "#e06c5a",
};

export const MANAGE_NAME_MAX = 60;

/**
 * Manage's header: what this is, its name (renamed in place: Enter saves,
 * Escape cancels, 1–60 characters), its status and where it runs. Every kind
 * of computer and agent renames here.
 */
export function ManageHeader({
  eyebrow,
  name,
  status,
  statusLabel,
  subtitle,
  chips,
  renaming,
  disabled,
  onRename,
  error,
}: {
  eyebrow: string;
  name: string;
  /** Status key for the dot's colour. */
  status: string;
  statusLabel: string;
  /** "<OS or agent> · <where it runs>". */
  subtitle: string;
  chips?: ReactNode;
  renaming: boolean;
  disabled: boolean;
  onRename: (name: string) => void;
  error?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const trimmed = draft.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= MANAGE_NAME_MAX;
  const save = () => {
    if (!valid || disabled) return;
    setEditing(false);
    if (trimmed !== name) onRename(trimmed);
  };
  const cancel = () => { setEditing(false); setDraft(name); };

  return (
    <>
      <div className="mono" style={manageLabel}>{eyebrow}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" }}>
        {editing ? (
          <>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={MANAGE_NAME_MAX}
              autoFocus
              aria-label="Name"
              autoComplete="off"
              enterKeyHint="done"
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); save(); }
                if (event.key === "Escape") cancel();
              }}
              style={{ flex: "1 1 200px", minWidth: 0, padding: "7px 10px", minHeight: 40, boxSizing: "border-box", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", fontSize: 18, fontFamily: "var(--font-serif), serif", outline: "none" }}
            />
            <span style={{ display: "inline-flex", gap: 6 }}>
              <button type="button" disabled={!valid || disabled} onClick={save} title="Save" aria-label="Save name" style={{ ...manageButtonGhost, padding: "7px 11px", color: "#22a06b" }}><Check size={14} /></button>
              <button type="button" onClick={cancel} title="Cancel" aria-label="Cancel renaming" style={{ ...manageButtonGhost, padding: "7px 11px" }}><X size={14} /></button>
            </span>
          </>
        ) : (
          <>
            <h1 className="serif" style={{ margin: 0, fontSize: 26, fontWeight: 400, lineHeight: 1.2, color: "var(--ink-black)", flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</h1>
            {renaming ? <Loader2 size={14} aria-label="Renaming" style={{ ...manageSpin, color: "var(--text-muted)" }} /> : null}
            <button type="button" onClick={() => { setDraft(name); setEditing(true); }} title="Rename" className="mono" style={{ ...manageLabel, border: "1px solid var(--etched-border)", background: "transparent", padding: "6px 10px", minHeight: 40, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-secondary)", flexShrink: 0 }}>
              <Pencil size={12} /> Rename
            </button>
          </>
        )}
      </div>
      {error}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5, color: "var(--text-secondary)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, border: "1px solid var(--etched-border)", padding: "4px 9px" }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: STATUS_COLOR[status] || "var(--text-muted)", display: "inline-block" }} />
          <span style={{ textTransform: "capitalize" }}>{statusLabel}</span>
        </span>
        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{subtitle}</span>
        {chips}
      </div>
    </>
  );
}
