"use client";

// HivraFiles — a file browser (with in-place text editing) for the box's home
// tree, in the Command Center vocabulary. Talks to the box's token-gated
// /api/files + /api/file (GET read / POST save). Credential files are blocked
// server-side. Provider desktops use an explicit, surface-scoped access adapter
// rooted in their shared folder; legacy token-less boxes stay read-only.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoadingState } from "@/components/ui/LoadingState";
import { Folder, FileText, CornerLeftUp, Loader2, AlertTriangle, X, RefreshCw, Pencil, Check } from "lucide-react";

import styles from "./HivraFiles.module.css";

import { listBoxFiles, readBoxFile, writeBoxFile, type BoxFileEntry } from "@/lib/hivra/agent-api";
import type { WorkspaceFilesAccess } from "@/lib/hivra/workspace-browser-bridge";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const mono: React.CSSProperties = { fontFamily: "var(--font-mono), monospace", fontSize: 11, letterSpacing: "0.02em" };

// Editing is offered up to the box write cap; bigger files stay view-only.
const EDIT_MAX = 512 * 1024;

function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body;
}

export function HivraFiles({ boxUrl, token, access, workspaceRoot }: { boxUrl: string; token?: string | null; access?: WorkspaceFilesAccess; workspaceRoot?: boolean }) {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<BoxFileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState<{ path: string; name: string; size: number; content: string; error: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // An action that would drop an edited draft waits here for Discard or Keep.
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // The control that asked for the pending action, so focus can go back to it.
  const discardOriginRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // Where focus goes after the next commit. A thunk, because the target (a
  // row, the Back button) may only exist once that commit lands.
  const focusNextRef = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const dirty = editing && file !== null && draft !== file.content;

  useLayoutEffect(() => {
    const pick = focusNextRef.current;
    if (!pick) return;
    focusNextRef.current = null;
    pick()?.focus();
  });

  // Narrow panes hide the list while a file is open (the module's container
  // query), taking the focused row with it.
  const listHidden = useCallback(() => {
    const list = listRef.current;
    return list !== null && window.getComputedStyle(list).display === "none";
  }, []);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    setFile(null);
    setEditing(false);
    setSaveErr(null);
    setPendingDiscard(null);
    const res = await (access ? access.list(p) : listBoxFiles(boxUrl, p, token));
    setPath(res.path || ".");
    setEntries(res.entries);
    setError(res.error);
    setLoading(false);
  }, [boxUrl, token, access]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() is async; its setState calls fire after an await, not synchronously in the effect body.
    void load(".");
  }, [load]);

  const openEntry = useCallback(async (e: BoxFileEntry) => {
    const child = path === "." || path === "" ? e.name : `${path}/${e.name}`;
    if (e.type === "dir") { void load(child); return; }
    const res = await (access ? access.read(child) : readBoxFile(boxUrl, child, token));
    setEditing(false);
    setSaveErr(null);
    focusNextRef.current = () => (listHidden() ? backRef.current : focusLost() ? rowRefs.current.get(e.name) : null);
    setFile({ path: child, name: e.name, size: e.size, content: res.content, error: res.error });
  }, [boxUrl, token, access, path, load, listHidden]);

  const save = useCallback(async () => {
    if (!file || saving) return;
    setSaving(true);
    setSaveErr(null);
    const r = await (access ? access.write(file.path, draft) : writeBoxFile(boxUrl, file.path, draft, token));
    setSaving(false);
    if (!r.ok) { setSaveErr(r.error || "Save failed"); return; }
    setFile({ ...file, content: draft, size: new Blob([draft]).size });
    setEditing(false);
    setPendingDiscard(null);
  }, [boxUrl, token, access, file, draft, saving]);

  const up = useCallback(() => {
    if (path === "." || path === "") return;
    void load(path.split("/").slice(0, -1).join("/") || ".");
  }, [path, load]);

  // Back (or Close) returns focus to the row that opened the file.
  const closeFile = useCallback(() => {
    const opened = file?.name;
    focusNextRef.current = () => (opened && focusLost() ? rowRefs.current.get(opened) : null);
    setFile(null);
    setEditing(false);
  }, [file?.name]);

  // Anything that replaces the open file asks first while the draft differs.
  const guard = useCallback((action: () => void, origin?: HTMLElement | null) => {
    if (dirty) { discardOriginRef.current = origin ?? null; setPendingDiscard(() => action); return; }
    action();
  }, [dirty]);

  const discard = useCallback(() => {
    const action = pendingDiscard;
    const origin = discardOriginRef.current;
    discardOriginRef.current = null;
    setPendingDiscard(null);
    setEditing(false);
    // Back to the control that asked; an action that moves focus itself
    // (closing the file) overrides this.
    focusNextRef.current = () => (origin?.isConnected && focusLost() ? origin : null);
    action?.();
  }, [pendingDiscard]);

  const keep = useCallback(() => {
    discardOriginRef.current = null;
    setPendingDiscard(null);
    focusNextRef.current = () => editorRef.current;
  }, []);

  useEffect(() => {
    if (pendingDiscard) keepRef.current?.focus();
  }, [pendingDiscard]);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <button type="button" onClick={(event) => guard(up, event.currentTarget)} disabled={path === "." || path === ""} className={`mono ${styles.toolButton}`} style={mono}>
          <CornerLeftUp size={12} /> Up
        </button>
        <span className={`mono ${styles.path}`} style={mono}>{access || workspaceRoot ? "Hivra/" : "~/"}{path === "." ? "" : path}</span>
        <button type="button" onClick={(event) => guard(() => void load(path), event.currentTarget)} aria-label="Refresh" className={styles.iconButton}>
          <RefreshCw size={12} />
        </button>
      </div>

      <div className={styles.split} data-open={file ? "true" : "false"}>
        <div ref={listRef} className={styles.list}>
          {loading ? (
            <LoadingState compact label="Loading files…" />
          ) : error ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px", color: "#e06c5a", fontSize: 13 }}><AlertTriangle size={16} /> {error}</div>
          ) : entries.length === 0 ? (
            <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>Empty.</div>
          ) : (
            entries.map((e) => (
              <button key={e.name} type="button"
                ref={(node) => { if (node) rowRefs.current.set(e.name, node); else rowRefs.current.delete(e.name); }}
                onClick={(event) => guard(() => void openEntry(e), event.currentTarget)} data-selected={file?.name === e.name ? "true" : undefined} className={styles.row}>
                {e.type === "dir" ? <Folder size={14} style={{ color: "var(--gold-leaf)", flexShrink: 0 }} /> : <FileText size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />}
                <span className={`mono ${styles.rowName}`} style={{ ...mono, fontSize: 12 }}>{e.name}</span>
                {e.type === "file" ? <span className="mono" style={{ ...mono, color: "var(--text-muted)", flexShrink: 0 }}>{fmtSize(e.size)}</span> : null}
              </button>
            ))
          )}
        </div>

        {file ? (
          <div className={styles.viewer}>
            <div className={styles.viewerHeader}>
              <button ref={backRef} type="button" onClick={(event) => guard(closeFile, event.currentTarget)} aria-label="Back to files" className={`mono ${styles.backButton}`} style={mono}>
                <span aria-hidden="true">‹</span> Files
              </button>
              <FileText size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
              <span className={`mono ${styles.fileName}`} style={{ ...mono, fontSize: 12 }}>{file.name}</span>
              {editing ? (
                <>
                  <button type="button" onClick={() => void save()} disabled={saving || draft === file.content} className={`mono ${styles.headerButton} ${styles.primaryButton}`} style={mono}>
                    {saving ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={11} />} Save
                  </button>
                  <button type="button" onClick={() => { setEditing(false); setSaveErr(null); setPendingDiscard(null); }} disabled={saving} className={`mono ${styles.headerButton}`} style={mono}>
                    Cancel
                  </button>
                </>
              ) : !file.error && (token || access) && file.size <= EDIT_MAX ? (
                <button type="button" onClick={() => { setDraft(file.content); setEditing(true); setSaveErr(null); }} aria-label="Edit" className={`mono ${styles.headerButton}`} style={mono}>
                  <Pencil size={11} /> Edit
                </button>
              ) : null}
              {/* Hidden while editing: Save or Cancel ends an edit, so a stray
                  tap beside them cannot drop the draft. */}
              {editing ? null : (
                <button type="button" onClick={closeFile} aria-label="Close" className={`${styles.headerButton} ${styles.closeButton}`}><X size={12} /></button>
              )}
            </div>
            {pendingDiscard ? (
              <div role="group" aria-label="Unsaved changes" className={`mono ${styles.discard}`} style={mono}>
                <span>Discard changes?</span>
                <button type="button" className={`mono ${styles.confirmButton} ${styles.confirmDanger}`} style={mono} onClick={discard}>
                  Discard
                </button>
                <button ref={keepRef} type="button" className={`mono ${styles.confirmButton}`} style={mono} onClick={keep}>
                  Keep
                </button>
              </div>
            ) : null}
            {saveErr ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", color: "#e06c5a", fontSize: 12, borderBottom: "1px solid var(--etched-border)" }}><AlertTriangle size={13} /> {saveErr}</div>
            ) : null}
            {editing ? (
              <textarea
                ref={editorRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={`Edit ${file.name}`}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                style={{ flex: 1, width: "100%", boxSizing: "border-box", resize: "none", border: "none", outline: "none", background: "rgba(255,255,255,0.02)", color: "var(--ink-black)", padding: "14px 16px", fontFamily: "var(--font-mono), monospace", fontSize: 12, lineHeight: 1.55 }}
              />
            ) : (
              <div style={{ flex: 1, overflow: "auto", padding: "14px 16px" }}>
                {file.error ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#e06c5a", fontSize: 13 }}><AlertTriangle size={16} /> {file.error}</div>
                ) : (
                  <pre className="mono" style={{ ...mono, fontSize: 12, lineHeight: 1.55, color: "var(--ink-black)", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>{file.content}</pre>
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
