"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, Copy, KeyRound, Loader2, Trash2 } from "lucide-react";

import { MEMORY_MAX_ITEMS } from "@/lib/memory/facts";
import { MEMORY_INSTRUCTIONS, MEMORY_KEY_PLACEHOLDER, memorySetupOptions } from "@/lib/memory/setup";

/**
 * Hivra Memory for the signed-in owner: make a key, copy the setup for an
 * agent, see what is stored, revoke a key, delete everything. Owner controls
 * go through /api/memory; agents use the key against the memory service
 * directly. Shown only while NEXT_PUBLIC_HIVRA_MEMORY is on.
 */

interface MemoryKey {
  id: string;
  label: string;
  scope: "rw" | "ro";
  created_at: number;
  last_used_at: number | null;
}

interface Stats {
  active?: number;
  saves?: number;
  recalls?: number;
}

const API = "/api/memory";

const ERRORS: Record<string, string> = {
  not_configured: "Memory isn't switched on here yet.",
  worker_unreachable: "Couldn't reach your memory. Try again in a moment.",
  worker_refused: "Couldn't reach your memory. Try again in a moment.",
  rate_limited: "That was a lot of requests. Wait a minute and try again.",
};

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof data?.error === "string" ? data.error : "unknown";
    throw new Error(ERRORS[code] ?? "Something went wrong. Try again.");
  }
  return data as T;
}

const PANEL: React.CSSProperties = {
  border: "1px solid var(--etched-border)",
  background: "var(--hg-fill-1)",
  borderRadius: 16,
  padding: "clamp(16px, 3vw, 24px)",
};

const BUTTON: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  minHeight: 40,
  padding: "0 14px",
  borderRadius: 999,
  border: "1px solid var(--etched-border)",
  background: "transparent",
  color: "var(--text-primary)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  textDecoration: "none",
};

const PRIMARY: React.CSSProperties = { ...BUTTON, background: "var(--text-primary)", color: "var(--bg-primary, #fff)", border: "none" };

const INPUT: React.CSSProperties = {
  flex: "1 1 200px",
  minWidth: 0,
  boxSizing: "border-box",
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid var(--etched-border)",
  background: "var(--hg-fill-1)",
  color: "var(--text-primary)",
  fontSize: 14,
  fontFamily: "inherit",
};

const CODE: React.CSSProperties = {
  margin: 0,
  padding: 14,
  borderRadius: 12,
  border: "1px solid var(--etched-border)",
  background: "color-mix(in srgb, var(--text-primary) 5%, transparent)",
  color: "var(--text-primary)",
  font: "12.5px/1.6 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const H2: React.CSSProperties = { margin: "0 0 6px", fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em" };
const MUTED: React.CSSProperties = { margin: 0, color: "var(--text-secondary)", fontSize: 14, lineHeight: 1.6 };

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" style={BUTTON} onClick={copy} aria-label={label}>
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function when(ms: number | null): string {
  if (!ms) return "never used";
  return `last used ${new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

export function MemoryApp() {
  const [keys, setKeys] = useState<MemoryKey[] | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("claude-code");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, usage] = await Promise.all([
        api<{ keys: MemoryKey[]; endpoint: string }>("GET", "/keys"),
        api<Stats>("GET", "/stats"),
      ]);
      setKeys(list.keys ?? []);
      setEndpoint(list.endpoint ?? "");
      setStats(usage);
      setError(null);
    } catch (problem) {
      setKeys((current) => current ?? []);
      setError((problem as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const made = await api<{ key: string }>("POST", "/keys", { label: label.trim() || "My agents", scope: readOnly ? "ro" : "rw" });
      setFresh(made.key);
      setLabel("");
      setReadOnly(false);
      await load();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (keyId: string) => {
    setBusy(true);
    try {
      await api("DELETE", "/keys", { keyId });
      await load();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const wipe = async () => {
    setBusy(true);
    try {
      await api("DELETE", "/account");
      setFresh(null);
      setConfirmDelete(false);
      await load();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const options = useMemo(() => (endpoint ? memorySetupOptions(endpoint, fresh ?? MEMORY_KEY_PLACEHOLDER) : []), [endpoint, fresh]);
  const option = options.find((item) => item.id === tab) ?? options[0];
  const stored = stats?.active ?? 0;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <header style={{ padding: "8px 0 4px" }}>
        <h1 style={{ margin: "0 0 8px", fontSize: "clamp(26px, 4vw, 34px)", fontWeight: 600, letterSpacing: "-0.03em" }}>Memory</h1>
        <p style={{ ...MUTED, fontSize: 15, maxWidth: "62ch" }}>
          One memory that all your agents share. Claude Code, Codex, Cursor, Hermes, OpenClaw: what one learns, the others know. Free.
        </p>
      </header>

      {error ? (
        <p role="alert" style={{ ...PANEL, margin: 0, fontSize: 14, color: "var(--text-primary)" }}>
          {error}
        </p>
      ) : null}

      {keys === null ? (
        <p style={{ ...MUTED, display: "flex", alignItems: "center", gap: 8 }}>
          <Loader2 size={16} aria-hidden="true" className="animate-spin" /> Loading your memory
        </p>
      ) : (
        <>
          <section style={PANEL} aria-labelledby="memory-key">
            <h2 id="memory-key" style={H2}>
              1. Get a key
            </h2>
            <p style={{ ...MUTED, marginBottom: 14 }}>A key lets an agent read and write your memory. Make one for all your agents, or one each so you can switch a single agent off.</p>
            <form onSubmit={create} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              <input style={INPUT} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} placeholder="Name, for example Laptop Claude Code" aria-label="Key name" />
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-secondary)" }}>
                <input type="checkbox" checked={readOnly} onChange={(event) => setReadOnly(event.target.checked)} /> Read only
              </label>
              <button type="submit" style={PRIMARY} disabled={busy}>
                <KeyRound size={14} aria-hidden="true" /> Create key
              </button>
            </form>

            {fresh ? (
              <div style={{ marginTop: 16, display: "grid", gap: 8 }} data-testid="fresh-key">
                <p style={{ ...MUTED, color: "var(--text-primary)", fontWeight: 600 }}>Your new key. Copy it now: it is shown only this once.</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                  <code style={{ ...CODE, flex: "1 1 260px" }}>{fresh}</code>
                  <CopyButton text={fresh} label="Copy key" />
                </div>
              </div>
            ) : null}

            {keys.length ? (
              <ul style={{ listStyle: "none", margin: "18px 0 0", padding: 0, display: "grid", gap: 8 }} aria-label="Your keys">
                {keys.map((key) => (
                  <li key={key.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, justifyContent: "space-between", paddingTop: 8, borderTop: "1px solid var(--etched-border)" }}>
                    <span style={{ fontSize: 14 }}>
                      <strong style={{ fontWeight: 600 }}>{key.label}</strong>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {" "}
                        · {key.scope === "ro" ? "read only" : "read and write"} · {when(key.last_used_at)}
                      </span>
                    </span>
                    <button type="button" style={BUTTON} disabled={busy} onClick={() => revoke(key.id)} aria-label={`Revoke ${key.label}`}>
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          {option ? (
            <section style={PANEL} aria-labelledby="memory-connect">
              <h2 id="memory-connect" style={H2}>
                2. Connect an agent
              </h2>
              <p style={{ ...MUTED, marginBottom: 14 }}>
                {fresh ? "Your new key is already filled in below." : `Replace ${MEMORY_KEY_PLACEHOLDER} with your key.`}
              </p>
              <div role="tablist" aria-label="Agent" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                {options.map((item) => (
                  <button key={item.id} type="button" role="tab" aria-selected={item.id === option.id} style={item.id === option.id ? PRIMARY : BUTTON} onClick={() => setTab(item.id)}>
                    {item.label}
                  </button>
                ))}
              </div>
              <p style={{ ...MUTED, marginBottom: 8 }}>{option.where}</p>
              <pre style={CODE} data-testid="setup-code">
                {option.code}
              </pre>
              <div style={{ marginTop: 10 }}>
                <CopyButton text={option.code} label="Copy setup" />
              </div>
            </section>
          ) : null}

          {option?.instructionsFile ? (
            <section style={PANEL} aria-labelledby="memory-tell">
              <h2 id="memory-tell" style={H2}>
                3. Tell the agent to use it
              </h2>
              <p style={{ ...MUTED, marginBottom: 12 }}>
                Agents ignore a memory nobody told them about. Paste this into {option.instructionsFile} and it will read your memory at the start of every session and save to it as it works.
              </p>
              <pre style={CODE}>{MEMORY_INSTRUCTIONS}</pre>
              <div style={{ marginTop: 10 }}>
                <CopyButton text={MEMORY_INSTRUCTIONS} label="Copy instructions" />
              </div>
            </section>
          ) : null}

          <section style={PANEL} aria-labelledby="memory-stored">
            <h2 id="memory-stored" style={H2}>
              What is stored
            </h2>
            <p style={MUTED} data-testid="memory-usage">
              {stored.toLocaleString("en-US")} of {MEMORY_MAX_ITEMS.toLocaleString("en-US")} memories used
              {stats ? ` · ${(stats.saves ?? 0).toLocaleString("en-US")} saves · ${(stats.recalls ?? 0).toLocaleString("en-US")} searches` : ""}
            </p>
            <p style={{ ...MUTED, marginTop: 8 }}>To read it all, ask any connected agent to export your memory. It comes back as plain text you can keep.</p>
            <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              {confirmDelete ? (
                <>
                  <span style={{ fontSize: 13 }}>This deletes every memory and every key for good.</span>
                  <button type="button" style={PRIMARY} disabled={busy} onClick={wipe}>
                    Yes, delete everything
                  </button>
                  <button type="button" style={BUTTON} onClick={() => setConfirmDelete(false)}>
                    Keep it
                  </button>
                </>
              ) : (
                <button type="button" style={BUTTON} onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} aria-hidden="true" /> Delete everything
                </button>
              )}
            </div>
          </section>

          <section style={{ ...PANEL, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }} aria-labelledby="memory-agent">
            <div style={{ flex: "1 1 320px" }}>
              <h2 id="memory-agent" style={H2}>
                Want an agent that already knows all this?
              </h2>
              <p style={MUTED}>Launch an agent on a computer of its own. It stays on when your laptop is closed and works from the same memory.</p>
            </div>
            <Link href="/dashboard/launch?ref=memory" style={PRIMARY} data-cta="memory-launch">
              Launch an agent <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </section>
        </>
      )}
    </div>
  );
}
