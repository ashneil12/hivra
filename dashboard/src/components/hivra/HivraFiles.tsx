"use client";

// HivraFiles — a file browser (with in-place text editing) for the box's home
// tree, in the Command Center vocabulary. Talks to the box's token-gated
// /api/files + /api/file (GET read / POST save). Credential files are blocked
// server-side. Provider desktops use an explicit, surface-scoped access adapter
// rooted in their shared folder; legacy token-less boxes stay read-only.

import { useCallback, useEffect, useState } from "react";
import { Folder, FileText, CornerLeftUp, Loader2, AlertTriangle, X, RefreshCw, Pencil, Check } from "lucide-react";

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

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    setFile(null);
    setEditing(false);
    setSaveErr(null);
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
    setFile({ path: child, name: e.name, size: e.size, content: res.content, error: res.error });
  }, [boxUrl, token, access, path, load]);

  const save = useCallback(async () => {
    if (!file || saving) return;
    setSaving(true);
    setSaveErr(null);
    const r = await (access ? access.write(file.path, draft) : writeBoxFile(boxUrl, file.path, draft, token));
    setSaving(false);
    if (!r.ok) { setSaveErr(r.error || "Save failed"); return; }
    setFile({ ...file, content: draft, size: new Blob([draft]).size });
    setEditing(false);
  }, [boxUrl, token, access, file, draft, saving]);

  const up = useCallback(() => {
    if (path === "." || path === "") return;
    void load(path.split("/").slice(0, -1).join("/") || ".");
  }, [path, load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 18px", borderBottom: "1px solid var(--etched-border)", background: "var(--bg-surface)" }}>
        <button type="button" onClick={up} disabled={path === "." || path === ""} className="mono" style={{ ...mono, display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--etched-border)", background: "transparent", color: path === "." ? "var(--text-muted)" : "var(--text-secondary)", padding: "5px 9px", cursor: path === "." ? "default" : "pointer", opacity: path === "." ? 0.5 : 1 }}>
          <CornerLeftUp size={12} /> Up
        </button>
        <span className="mono" style={{ ...mono, color: "var(--text-secondary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{access || workspaceRoot ? "Hivra/" : "~/"}{path === "." ? "" : path}</span>
        <button type="button" onClick={() => void load(path)} aria-label="Refresh" style={{ border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-muted)", padding: "5px 7px", cursor: "pointer", display: "inline-flex" }}>
          <RefreshCw size={12} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ width: file ? 340 : "100%", flexShrink: 0, overflowY: "auto", borderRight: file ? "1px solid var(--etched-border)" : "none" }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: "center" }}><Loader2 size={18} style={{ animation: "spin 1s linear infinite", opacity: 0.5 }} /></div>
          ) : error ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px", color: "#e06c5a", fontSize: 13 }}><AlertTriangle size={16} /> {error}</div>
          ) : entries.length === 0 ? (
            <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>Empty.</div>
          ) : (
            entries.map((e) => (
              <button key={e.name} type="button" onClick={() => void openEntry(e)} style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 10, padding: "9px 18px", border: "none", borderBottom: "1px solid var(--etched-border)", background: file?.name === e.name ? "rgba(255,255,255,0.05)" : "transparent", color: "var(--ink-black)", cursor: "pointer" }}>
                {e.type === "dir" ? <Folder size={14} style={{ color: "var(--gold-leaf)", flexShrink: 0 }} /> : <FileText size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />}
                <span className="mono" style={{ ...mono, fontSize: 12, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink-black)" }}>{e.name}</span>
                {e.type === "file" ? <span className="mono" style={{ ...mono, color: "var(--text-muted)", flexShrink: 0 }}>{fmtSize(e.size)}</span> : null}
              </button>
            ))
          )}
        </div>

        {file ? (
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", borderBottom: "1px solid var(--etched-border)" }}>
              <FileText size={13} style={{ color: "var(--text-muted)" }} />
              <span className="mono" style={{ ...mono, fontSize: 12, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink-black)" }}>{file.name}</span>
              {editing ? (
                <>
                  <button type="button" onClick={() => void save()} disabled={saving || draft === file.content} className="mono" style={{ ...mono, display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--ink-black)", background: "var(--ink-black)", color: "var(--bg-surface)", padding: "4px 9px", cursor: saving || draft === file.content ? "default" : "pointer", opacity: saving || draft === file.content ? 0.5 : 1 }}>
                    {saving ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={11} />} Save
                  </button>
                  <button type="button" onClick={() => { setEditing(false); setSaveErr(null); }} disabled={saving} className="mono" style={{ ...mono, border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-secondary)", padding: "4px 9px", cursor: "pointer" }}>
                    Cancel
                  </button>
                </>
              ) : !file.error && (token || access) && file.size <= EDIT_MAX ? (
                <button type="button" onClick={() => { setDraft(file.content); setEditing(true); setSaveErr(null); }} aria-label="Edit" className="mono" style={{ ...mono, display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-secondary)", padding: "4px 9px", cursor: "pointer" }}>
                  <Pencil size={11} /> Edit
                </button>
              ) : null}
              <button type="button" onClick={() => { setFile(null); setEditing(false); }} aria-label="Close" style={{ border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-muted)", padding: "4px 6px", cursor: "pointer", display: "inline-flex" }}><X size={12} /></button>
            </div>
            {saveErr ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", color: "#e06c5a", fontSize: 12, borderBottom: "1px solid var(--etched-border)" }}><AlertTriangle size={13} /> {saveErr}</div>
            ) : null}
            {editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
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
