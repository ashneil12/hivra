"use client";

// HivraGit — git explorer for the box (Git tab): repo status, per-file diffs,
// stage-and-commit of selected files, and branch switching. Talks to the box's
// token-gated /api/git/* endpoints; all operations run as the box user via
// execFile (no shell) server-side. Command Center vocabulary.

import { useCallback, useEffect, useState } from "react";
import { GitBranch, GitCommitHorizontal, Loader2, AlertTriangle, RefreshCw, FileDiff, Plus } from "lucide-react";

import { gitStatus, gitDiff, gitCommit, gitCheckout, type GitStatus, type GitEntry } from "@/lib/hivra/agent-api";

const mono: React.CSSProperties = { fontFamily: "var(--font-mono), monospace", fontSize: 11, letterSpacing: "0.02em" };

// Two-letter porcelain code → human chip.
function statusLabel(e: GitEntry): { label: string; color: string } {
  const code = (e.x + e.y).trim();
  if (code.includes("?")) return { label: "new", color: "#22c55e" };
  if (code.includes("D")) return { label: "deleted", color: "#e06c5a" };
  if (code.includes("A")) return { label: "added", color: "#22c55e" };
  if (code.includes("R")) return { label: "renamed", color: "var(--gold-leaf)" };
  return { label: "modified", color: "var(--gold-leaf)" };
}

export function HivraGit({ boxUrl, token, dir = "." }: { boxUrl: string; token?: string | null; dir?: string }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ text: string; untracked: boolean } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [branchPick, setBranchPick] = useState("");
  const [newBranch, setNewBranch] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const r = await gitStatus(boxUrl, dir, token);
    setSt(r);
    setBranchPick(r.branch || "");
    setSel(new Set());
    setDiffFor(null);
    setDiff(null);
    setLoading(false);
    if (r.error) setErr(r.error);
  }, [boxUrl, dir, token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh() is async; its setState calls fire after an await.
    void refresh();
  }, [refresh]);

  const openDiff = useCallback(async (p: string) => {
    setDiffFor(p);
    setDiff(null);
    const r = await gitDiff(boxUrl, st?.root || dir, p, token);
    if (r.error) { setErr(r.error); return; }
    setDiff({ text: r.diff, untracked: r.untracked });
  }, [boxUrl, dir, st?.root, token]);

  const toggle = useCallback((p: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }, []);

  const commit = useCallback(async () => {
    if (!msg.trim() || sel.size === 0 || busy) return;
    setBusy("commit");
    setErr(null);
    const r = await gitCommit(boxUrl, st?.root || dir, msg.trim(), Array.from(sel), token);
    setBusy(null);
    if (!r.ok) { setErr(r.error || "Commit failed"); return; }
    setMsg("");
    void refresh();
  }, [boxUrl, dir, st?.root, msg, sel, busy, token, refresh]);

  const checkout = useCallback(async (branch: string, create: boolean) => {
    if (!branch || busy) return;
    setBusy("checkout");
    setErr(null);
    const r = await gitCheckout(boxUrl, st?.root || dir, branch, create, token);
    setBusy(null);
    if (!r.ok) { setErr(r.error || "Checkout failed"); return; }
    setNewBranch("");
    void refresh();
  }, [boxUrl, dir, st?.root, busy, token, refresh]);

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center" }}><Loader2 size={18} style={{ animation: "spin 1s linear infinite", opacity: 0.5 }} /></div>;
  }
  if (!st?.repo) {
    return (
      <div style={{ padding: 48, textAlign: "center", color: "var(--text-muted)" }}>
        <div className="serif" style={{ fontSize: 22, fontWeight: 400, color: "var(--ink-black)", marginBottom: 6 }}>No git repository.</div>
        <div style={{ fontSize: 13, maxWidth: 460, margin: "0 auto", lineHeight: 1.6 }}>
          The box home isn&apos;t a git repo yet. Ask the agent to clone or init one, then refresh.
        </div>
        <button type="button" onClick={() => void refresh()} className="mono" style={{ ...mono, marginTop: 16, border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-secondary)", padding: "7px 12px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
    );
  }

  const entries = st.entries || [];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* repo header: branch switch + last commit */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 18px", borderBottom: "1px solid var(--etched-border)", background: "var(--bg-surface)", flexWrap: "wrap" }}>
        <GitBranch size={13} style={{ color: "var(--gold-leaf)" }} />
        <select
          value={branchPick}
          disabled={busy !== null}
          onChange={(e) => { setBranchPick(e.target.value); void checkout(e.target.value, false); }}
          className="mono"
          style={{ ...mono, background: "var(--bg-surface)", color: "var(--ink-black)", border: "1px solid var(--etched-border)", padding: "5px 8px" }}
        >
          {(st.branches || []).map((b) => <option key={b} value={b}>{b}</option>)}
          {st.branch && !(st.branches || []).includes(st.branch) ? <option value={st.branch}>{st.branch}</option> : null}
        </select>
        <input
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && newBranch.trim()) void checkout(newBranch.trim(), true); }}
          placeholder="new branch…"
          className="mono"
          style={{ ...mono, width: 120, background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", border: "1px solid var(--etched-border)", padding: "5px 8px", outline: "none" }}
        />
        <button type="button" disabled={!newBranch.trim() || busy !== null} onClick={() => void checkout(newBranch.trim(), true)} aria-label="Create branch" style={{ border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-secondary)", padding: "5px 7px", cursor: "pointer", display: "inline-flex", opacity: newBranch.trim() ? 1 : 0.5 }}>
          <Plus size={12} />
        </button>
        <span className="mono" style={{ ...mono, color: "var(--text-muted)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}>
          {st.lastCommit || ""}{st.root && st.root !== "." ? ` · ~/${st.root}` : ""}
        </span>
        <button type="button" onClick={() => void refresh()} aria-label="Refresh" style={{ border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-muted)", padding: "5px 7px", cursor: "pointer", display: "inline-flex" }}>
          {busy === "checkout" ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={12} />}
        </button>
      </div>

      {err ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 18px", color: "#e06c5a", fontSize: 12, borderBottom: "1px solid var(--etched-border)" }}><AlertTriangle size={13} /> {err}</div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* change list + commit box */}
        <div style={{ width: diffFor ? 360 : "100%", flexShrink: 0, display: "flex", flexDirection: "column", borderRight: diffFor ? "1px solid var(--etched-border)" : "none", minHeight: 0 }}>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {entries.length === 0 ? (
              <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>Working tree clean. <span className="mono" style={{ ...mono, color: "var(--text-muted)" }}>{st.lastCommit || ""}</span></div>
            ) : (
              entries.map((e) => {
                const s = statusLabel(e);
                return (
                  <div key={e.path} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 14px", borderBottom: "1px solid var(--etched-border)", background: diffFor === e.path ? "rgba(255,255,255,0.05)" : "transparent" }}>
                    <input type="checkbox" checked={sel.has(e.path)} onChange={() => toggle(e.path)} aria-label={`Select ${e.path}`} style={{ accentColor: "var(--gold-leaf)", cursor: "pointer" }} />
                    <button type="button" onClick={() => void openDiff(e.path)} style={{ flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "transparent", color: "var(--ink-black)", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: 0 }}>
                      <FileDiff size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                      <span className="mono" style={{ ...mono, fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.path}</span>
                    </button>
                    <span className="mono" style={{ ...mono, fontSize: 10, color: s.color, flexShrink: 0 }}>{s.label}</span>
                  </div>
                );
              })
            )}
          </div>
          {entries.length > 0 ? (
            <div style={{ borderTop: "1px solid var(--etched-border)", padding: "10px 14px", display: "grid", gap: 8, background: "var(--bg-surface)" }}>
              <input
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void commit(); }}
                placeholder="Commit message…"
                className="mono"
                style={{ ...mono, fontSize: 12, background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", border: "1px solid var(--etched-border)", padding: "8px 10px", outline: "none" }}
              />
              <button
                type="button"
                disabled={!msg.trim() || sel.size === 0 || busy !== null}
                onClick={() => void commit()}
                className="mono"
                style={{ ...mono, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, border: "1px solid var(--ink-black)", background: "var(--ink-black)", color: "var(--bg-surface)", padding: "8px 12px", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800, cursor: msg.trim() && sel.size > 0 ? "pointer" : "default", opacity: msg.trim() && sel.size > 0 ? 1 : 0.5 }}
              >
                {busy === "commit" ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <GitCommitHorizontal size={13} />}
                Commit {sel.size > 0 ? `${sel.size} file${sel.size === 1 ? "" : "s"}` : ""}
              </button>
            </div>
          ) : null}
        </div>

        {/* diff pane */}
        {diffFor ? (
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", borderBottom: "1px solid var(--etched-border)" }}>
              <FileDiff size={12} style={{ color: "var(--text-muted)" }} />
              <span className="mono" style={{ ...mono, fontSize: 12, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink-black)" }}>{diffFor}{diff?.untracked ? " (new file)" : ""}</span>
              <button type="button" onClick={() => { setDiffFor(null); setDiff(null); }} aria-label="Close diff" className="mono" style={{ ...mono, border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-muted)", padding: "4px 8px", cursor: "pointer" }}>Close</button>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "12px 16px", background: "rgba(0,0,0,0.18)" }}>
              {!diff ? (
                <Loader2 size={15} style={{ animation: "spin 1s linear infinite", opacity: 0.5 }} />
              ) : (
                <pre className="mono" style={{ ...mono, fontSize: 11.5, lineHeight: 1.5, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {diff.text.split("\n").map((l, i) => (
                    <div key={i} style={{ color: l.startsWith("+") ? "#22c55e" : l.startsWith("-") ? "#e06c5a" : l.startsWith("@@") ? "var(--gold-leaf)" : "var(--text-secondary)" }}>{l || " "}</div>
                  ))}
                </pre>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
