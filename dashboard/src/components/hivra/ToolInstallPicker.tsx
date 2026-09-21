"use client";

// ToolInstallPicker — a modal that lets the user browse the curated TOOL catalog
// and one-click attach a tool to this box. A tool is an MCP server (+ optional
// credentials + teaching skills); installed-vs-available is diffed against the
// live box MCP list (a tool is installed iff its mcpName is a connected server).
// Install POSTs to the in-app tools route (which SSHes the MCP config + skills
// onto the box); remove DELETEs it. Each card is self-contained — its own env
// inputs, its own action — so a keyless tool installs in one click and a keyed
// tool blocks until its required fields are filled.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Check, Plus, X, Wrench, Trash2 } from "lucide-react";

import { listBoxMcp } from "@/lib/hivra/agent-api";

const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  opacity: 0.62,
};

interface ToolEnvFieldMeta {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
}
interface ToolMeta {
  id: string;
  name: string;
  description: string;
  category: string;
  trust: "builtin" | "trusted" | "community";
  mcpName: string;
  env: ToolEnvFieldMeta[];
  skillCount: number;
}

async function readJson(r: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function ToolInstallPicker({
  agentId,
  boxUrl,
  token,
  onClose,
  onChanged,
}: {
  agentId: string;
  boxUrl: string;
  token?: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [catalog, setCatalog] = useState<ToolMeta[] | null>(null);
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  // Per-tool env input values, keyed `${toolId}:${envKey}`.
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  // Which tool is mid-action, and the last per-tool error.
  const [acting, setActing] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoadError(null);
    setCatalog(null);
    try {
      const [catRes, boxMcp] = await Promise.all([
        fetch(`/api/hivra/agents/${agentId}/tools`, { cache: "no-store" }),
        listBoxMcp(boxUrl, token),
      ]);
      const j = await readJson(catRes);
      if (!catRes.ok || !j || j.success !== true) {
        setLoadError((j?.error as string) || `Couldn't load the tool catalog (${catRes.status})`);
        setCatalog([]);
        return;
      }
      const d = j.data as { supported?: boolean; tools?: ToolMeta[] };
      setCatalog(d.tools || []);
      setInstalledNames(new Set((boxMcp.servers || []).map((s) => s.name)));
    } catch (e) {
      setLoadError((e as Error).message || "Network error loading tools");
      setCatalog([]);
    }
  }, [agentId, boxUrl, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const decorated = useMemo(() => {
    if (!catalog) return [];
    return catalog
      .map((t) => ({ ...t, installed: installedNames.has(t.mcpName) }))
      .sort((a, b) => {
        if (a.installed !== b.installed) return a.installed ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
  }, [catalog, installedNames]);

  const availableCount = decorated.filter((t) => !t.installed).length;

  const setEnv = useCallback((toolId: string, key: string, val: string) => {
    setEnvValues((prev) => ({ ...prev, [`${toolId}:${key}`]: val }));
  }, []);

  const missingRequired = useCallback(
    (t: ToolMeta): boolean =>
      t.env.some((f) => f.required && !(envValues[`${t.id}:${f.key}`] || "").trim()),
    [envValues],
  );

  const install = useCallback(
    async (t: ToolMeta) => {
      if (acting) return;
      setActing(t.id);
      setRowError((p) => ({ ...p, [t.id]: "" }));
      try {
        const env: Record<string, string> = {};
        for (const f of t.env) {
          const v = (envValues[`${t.id}:${f.key}`] || "").trim();
          if (v) env[f.key] = v;
        }
        const r = await fetch(`/api/hivra/agents/${agentId}/tools`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tools: [{ id: t.id, env }] }),
        });
        const j = await readJson(r);
        if (!r.ok || !j || j.success !== true) {
          setRowError((p) => ({ ...p, [t.id]: (j?.error as string) || `Install failed (${r.status})` }));
          return;
        }
        setInstalledNames((prev) => new Set(prev).add(t.mcpName));
        // Drop the plaintext secret from React state now it's on the box — a later
        // Remove re-renders empty inputs; a re-install can't resend a stale value.
        setEnvValues((prev) => {
          const next = { ...prev };
          for (const f of t.env) delete next[`${t.id}:${f.key}`];
          return next;
        });
        onChanged();
      } catch (e) {
        setRowError((p) => ({ ...p, [t.id]: (e as Error).message || "Network error" }));
      } finally {
        setActing(null);
      }
    },
    [agentId, acting, envValues, onChanged],
  );

  const remove = useCallback(
    async (t: ToolMeta) => {
      if (acting) return;
      setActing(t.id);
      setRowError((p) => ({ ...p, [t.id]: "" }));
      try {
        const r = await fetch(`/api/hivra/agents/${agentId}/tools/${encodeURIComponent(t.id)}`, {
          method: "DELETE",
        });
        const j = await readJson(r);
        if (!r.ok || !j || j.success !== true) {
          setRowError((p) => ({ ...p, [t.id]: (j?.error as string) || `Remove failed (${r.status})` }));
          return;
        }
        setInstalledNames((prev) => {
          const next = new Set(prev);
          next.delete(t.mcpName);
          return next;
        });
        onChanged();
      } catch (e) {
        setRowError((p) => ({ ...p, [t.id]: (e as Error).message || "Network error" }));
      } finally {
        setActing(null);
      }
    },
    [agentId, acting, onChanged],
  );

  const inputStyle: React.CSSProperties = {
    padding: "7px 9px",
    border: "1px solid var(--etched-border)",
    background: "rgba(255,255,255,0.04)",
    color: "var(--ink-black)",
    fontSize: 12,
    fontFamily: "var(--font-mono), monospace",
    outline: "none",
    minWidth: 0,
    width: "100%",
    boxSizing: "border-box",
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add tools"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 100%)",
          maxHeight: "min(82vh, 760px)",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-surface, #fff)",
          border: "1px solid var(--etched-border)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "20px 22px 14px", borderBottom: "1px solid var(--etched-border)" }}>
          <div>
            <div className="mono" style={{ ...mono, marginBottom: 6 }}>Add tools</div>
            <h3 className="serif" style={{ fontSize: "clamp(1.2rem, 3vw, 1.6rem)", fontWeight: 400, margin: 0, color: "var(--ink-black)" }}>
              Tool catalog
            </h3>
            <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: "6px 0 0", lineHeight: 1.5, maxWidth: 480 }}>
              Attach a capability to this agent — each tool wires up an MCP server (and any teaching skills) on the box. Credentials stay on the box and are never shown back here.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-secondary)", padding: "5px 7px", cursor: "pointer", display: "inline-flex", flexShrink: 0 }}
          >
            <X size={14} />
          </button>
        </div>

        <div style={{ overflowY: "auto", padding: "16px 22px", flex: 1, minHeight: 0 }}>
          {catalog === null ? (
            <div style={{ padding: 48, textAlign: "center" }}><Loader2 size={18} style={{ animation: "spin 1s linear infinite", opacity: 0.5 }} /></div>
          ) : loadError ? (
            <div style={{ border: "1px dashed var(--etched-border)", padding: "24px 20px", textAlign: "center", color: "#e06c5a", fontSize: 13.5 }}>
              {loadError}
              <div style={{ marginTop: 12 }}>
                <button type="button" onClick={() => void load()} style={{ border: "1px solid var(--etched-border)", background: "transparent", color: "var(--ink-black)", padding: "6px 14px", cursor: "pointer", fontSize: 12.5 }}>Retry</button>
              </div>
            </div>
          ) : decorated.length === 0 ? (
            <div style={{ border: "1px dashed var(--etched-border)", padding: "28px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: 13.5 }}>
              No installable tools in the catalog yet.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {decorated.map((t) => {
                const busy = acting === t.id;
                const blocked = !t.installed && missingRequired(t);
                return (
                  <div
                    key={t.id}
                    style={{
                      border: `1px solid ${t.installed ? "var(--gold-leaf)" : "var(--etched-border)"}`,
                      background: t.installed ? "rgba(197,160,89,0.06)" : "rgba(255,255,255,0.03)",
                      padding: "12px 14px",
                      display: "grid",
                      gap: 10,
                      minWidth: 0,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, minWidth: 0 }}>
                      <span style={{ marginTop: 2, flexShrink: 0, width: 16, height: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--gold-leaf)" }}>
                        {t.installed ? <Check size={14} /> : <Wrench size={13} style={{ opacity: 0.5 }} />}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <strong className="serif" style={{ fontSize: 15.5, fontWeight: 400, color: "var(--ink-black)" }}>{t.name}</strong>
                          <span className="mono" style={{ ...mono, fontSize: 9, opacity: 0.85, color: t.installed ? "var(--text-muted)" : "var(--gold-leaf)" }}>
                            {t.installed ? "Installed" : "Available"}
                          </span>
                          <span className="mono" style={{ ...mono, fontSize: 9 }}>{t.category}</span>
                          {t.skillCount > 0 ? <span className="mono" style={{ ...mono, fontSize: 9 }}>+{t.skillCount} skill{t.skillCount > 1 ? "s" : ""}</span> : null}
                        </div>
                        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5, marginTop: 4 }}>
                          {t.description}
                        </div>
                      </div>
                    </div>

                    {/* Credential inputs — only when not yet installed and the tool needs them. */}
                    {!t.installed && t.env.length > 0 ? (
                      <div style={{ display: "grid", gap: 7, paddingLeft: 28 }}>
                        {t.env.map((f) => (
                          <label key={f.key} style={{ display: "grid", gap: 3 }}>
                            <span className="mono" style={{ ...mono, fontSize: 9, opacity: 0.8 }}>
                              {f.label}{f.required ? " *" : " (optional)"}
                            </span>
                            <input
                              type={f.secret ? "password" : "text"}
                              autoComplete={f.secret ? "new-password" : "off"}
                              value={envValues[`${t.id}:${f.key}`] || ""}
                              onChange={(e) => setEnv(t.id, f.key, e.target.value)}
                              placeholder={f.placeholder || f.key}
                              style={inputStyle}
                            />
                          </label>
                        ))}
                      </div>
                    ) : null}

                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, paddingLeft: 28 }}>
                      <span style={{ fontSize: 11.5, color: "#e06c5a", minHeight: 14 }}>{rowError[t.id] || ""}</span>
                      {t.installed ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void remove(t)}
                          style={{ border: "1px solid var(--etched-border)", background: "transparent", color: "#e06c5a", padding: "6px 14px", cursor: busy ? "default" : "pointer", fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6 }}
                        >
                          {busy ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={12} />}
                          Remove
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy || blocked}
                          onClick={() => void install(t)}
                          style={{
                            border: "1px solid var(--gold-leaf)",
                            background: busy || blocked ? "transparent" : "var(--gold-leaf)",
                            color: busy || blocked ? "var(--text-muted)" : "var(--ink-black)",
                            padding: "6px 16px",
                            cursor: busy || blocked ? "default" : "pointer",
                            fontSize: 12.5,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          {busy ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Plus size={12} />}
                          Install
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 22px", borderTop: "1px solid var(--etched-border)", flexWrap: "wrap" }}>
          <div className="mono" style={{ ...mono, opacity: 0.7 }}>
            {catalog && !loadError ? `${availableCount} available` : ""}
          </div>
          <button type="button" onClick={onClose} style={{ border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-secondary)", padding: "8px 16px", cursor: "pointer", fontSize: 13 }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
