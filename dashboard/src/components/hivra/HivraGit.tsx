"use client";

// HivraGit — git explorer for the box (Git tab): repo status, per-file diffs,
// stage-and-commit of selected files, and branch switching. Talks to the box's
// token-gated /api/git/* endpoints; all operations run as the box user via
// execFile (no shell) server-side. Command Center vocabulary.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GitBranch, GitCommitHorizontal, Loader2, AlertTriangle, RefreshCw, FileDiff, Plus } from "lucide-react";

import { gitStatus, gitDiff, gitCommit, gitCheckout, type GitStatus, type GitEntry } from "@/lib/hivra/agent-api";

import styles from "./HivraGit.module.css";

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
  // A picked branch is only staged; checkout waits for Switch, and for an
  // explicit confirm while uncommitted changes are listed.
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const changesRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const entryRefs = useRef(new Map<string, HTMLButtonElement>());
  // Where focus goes after the next commit; the target may only exist then.
  const focusNextRef = useRef<(() => HTMLElement | null | undefined) | null>(null);

  useLayoutEffect(() => {
    const pick = focusNextRef.current;
    if (!pick) return;
    focusNextRef.current = null;
    pick()?.focus();
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const r = await gitStatus(boxUrl, dir, token);
    setSt(r);
    setBranchPick(r.branch || "");
    setConfirmSwitch(false);
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
    // Narrow panes hide the change list behind the diff (the module's
    // container query), taking the focused row with it.
    focusNextRef.current = () => {
      const changes = changesRef.current;
      return changes && window.getComputedStyle(changes).display === "none" ? backRef.current : null;
    };
    setDiffFor(p);
    setDiff(null);
    const r = await gitDiff(boxUrl, st?.root || dir, p, token);
    if (r.error) { setErr(r.error); return; }
    setDiff({ text: r.diff, untracked: r.untracked });
  }, [boxUrl, dir, st?.root, token]);

  // Back (or Close) returns focus to the row that opened the diff.
  const closeDiff = useCallback(() => {
    const opened = diffFor;
    focusNextRef.current = () => {
      const active = document.activeElement;
      return opened && (!active || active === document.body) ? entryRefs.current.get(opened) : null;
    };
    setDiffFor(null);
    setDiff(null);
  }, [diffFor]);

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
    setConfirmSwitch(false);
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
  const pickedOther = Boolean(branchPick) && branchPick !== (st.branch || "");
  const changeCount = `${entries.length} uncommitted change${entries.length === 1 ? "" : "s"}`;
  return (
    <div className={styles.root}>
      {/* repo header: branch switch + last commit */}
      <div className={styles.repoHeader}>
        <GitBranch size={13} style={{ color: "var(--gold-leaf)", flexShrink: 0 }} />
        <select
          ref={selectRef}
          value={branchPick}
          disabled={busy !== null}
          onChange={(e) => { setBranchPick(e.target.value); setConfirmSwitch(false); }}
          aria-label="Branch"
          className={`mono ${styles.select}`}
          style={mono}
        >
          {(st.branches || []).map((b) => <option key={b} value={b}>{b}</option>)}
          {st.branch && !(st.branches || []).includes(st.branch) ? <option value={st.branch}>{st.branch}</option> : null}
        </select>
        {pickedOther ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              if (entries.length === 0) { void checkout(branchPick, false); return; }
              // The key that opened the confirm must not also run the checkout.
              focusNextRef.current = () => cancelRef.current;
              setConfirmSwitch(true);
            }}
            className={`mono ${styles.textButton}`}
            style={mono}
          >
            Switch
          </button>
        ) : null}
        <input
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && newBranch.trim()) void checkout(newBranch.trim(), true); }}
          placeholder="new branch…"
          aria-label="New branch name"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          className={`mono ${styles.branchInput}`}
          style={mono}
        />
        <button type="button" disabled={!newBranch.trim() || busy !== null} onClick={() => void checkout(newBranch.trim(), true)} aria-label="Create branch" className={styles.iconButton}>
          <Plus size={12} />
        </button>
        <span className={`mono ${styles.lastCommit}`} style={mono}>
          {st.lastCommit || ""}{st.root && st.root !== "." ? ` · ~/${st.root}` : ""}
        </span>
        <button type="button" onClick={() => void refresh()} aria-label="Refresh" className={styles.iconButton} style={{ color: "var(--text-muted)" }}>
          {busy === "checkout" ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={12} />}
        </button>
      </div>

      {confirmSwitch && pickedOther ? (
        <div role="group" aria-label="Confirm branch switch" className={`mono ${styles.confirm}`} style={mono}>
          <span>Switch to {branchPick} with {changeCount}? Git carries them over, or refuses if they conflict.</span>
          <button type="button" disabled={busy !== null} onClick={() => void checkout(branchPick, false)} className={`mono ${styles.confirmButton} ${styles.confirmDanger}`} style={mono}>
            Switch
          </button>
          <button ref={cancelRef} type="button" onClick={() => { focusNextRef.current = () => selectRef.current; setConfirmSwitch(false); setBranchPick(st.branch || ""); }} className={`mono ${styles.confirmButton}`} style={mono}>
            Cancel
          </button>
        </div>
      ) : null}

      {err ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 18px", color: "#e06c5a", fontSize: 12, borderBottom: "1px solid var(--etched-border)" }}><AlertTriangle size={13} /> {err}</div>
      ) : null}

      <div className={styles.split} data-open={diffFor ? "true" : "false"}>
        {/* change list + commit box */}
        <div ref={changesRef} className={styles.changes}>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {entries.length === 0 ? (
              <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>Working tree clean. <span className="mono" style={{ ...mono, color: "var(--text-muted)" }}>{st.lastCommit || ""}</span></div>
            ) : (
              entries.map((e) => {
                const s = statusLabel(e);
                return (
                  <div key={e.path} className={styles.entry} data-selected={diffFor === e.path ? "true" : undefined}>
                    <label className={styles.stage}>
                      <input type="checkbox" checked={sel.has(e.path)} onChange={() => toggle(e.path)} aria-label={`Select ${e.path}`} />
                    </label>
                    <button type="button" onClick={() => void openDiff(e.path)} className={styles.entryButton}
                      ref={(node) => { if (node) entryRefs.current.set(e.path, node); else entryRefs.current.delete(e.path); }}>
                      <FileDiff size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                      <span className="mono" style={{ ...mono, fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.path}</span>
                    </button>
                    <span className={`mono ${styles.chip}`} style={{ color: s.color }}>{s.label}</span>
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
                aria-label="Commit message"
                enterKeyHint="done"
                className={`mono ${styles.commitInput}`}
                style={{ ...mono, fontSize: 12, background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", border: "1px solid var(--etched-border)", padding: "8px 10px", outline: "none" }}
              />
              <button
                type="button"
                disabled={!msg.trim() || sel.size === 0 || busy !== null}
                onClick={() => void commit()}
                className={`mono ${styles.commitButton}`}
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
          <div className={styles.diff}>
            <div className={styles.diffHeader}>
              <button ref={backRef} type="button" onClick={closeDiff} aria-label="Back to changes" className={`mono ${styles.backButton}`} style={mono}>
                <span aria-hidden="true">‹</span> Changes
              </button>
              <FileDiff size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
              <span className="mono" style={{ ...mono, fontSize: 12, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink-black)" }}>{diffFor}{diff?.untracked ? " (new file)" : ""}</span>
              <button type="button" onClick={closeDiff} aria-label="Close diff" className={`mono ${styles.closeButton}`} style={mono}>Close</button>
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
