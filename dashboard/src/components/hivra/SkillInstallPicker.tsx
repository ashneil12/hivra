"use client";

// SkillInstallPicker — a modal over HivraSkills that lets the user browse the
// curated catalog and one-click install skills onto this box. The diff
// (Installed vs Available) is computed against the live box /api/skills list.
// Install is a POST to the in-app installer route, which SSHes the SKILL.md onto
// the box (the box has no skills write endpoint). On success the parent reloads
// its installed list.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Check, Plus, X, Sparkles } from "lucide-react";

import { listBoxSkills } from "@/lib/hivra/agent-api";
import { isCuratedSkillInstalled } from "@/lib/hivra/curated-skill-match";

const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  opacity: 0.62,
};

interface SkillMeta {
  id: string;
  name: string;
  description: string;
  category: string | null;
  installedAs: string | null;
}

async function readJson(r: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function SkillInstallPicker({
  agentId,
  boxUrl,
  token,
  onClose,
  onInstalled,
}: {
  agentId: string;
  boxUrl: string;
  token?: string | null;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [catalog, setCatalog] = useState<SkillMeta[] | null>(null);
  const [installedNames, setInstalledNames] = useState<{ name: string }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    setCatalog(null);
    try {
      const [catRes, boxSkills] = await Promise.all([
        fetch(`/api/hivra/agents/${agentId}/skills/install`, { cache: "no-store" }),
        listBoxSkills(boxUrl, token),
      ]);
      const j = await readJson(catRes);
      if (!catRes.ok || !j || j.success !== true) {
        setLoadError((j?.error as string) || `Couldn't load the skill catalog (${catRes.status})`);
        setCatalog([]);
        return;
      }
      const d = j.data as { supported?: boolean; skills?: SkillMeta[] };
      setCatalog(d.skills || []);
      setInstalledNames((boxSkills || []).map((s) => ({ name: s.name })));
    } catch (e) {
      setLoadError((e as Error).message || "Network error loading skills");
      setCatalog([]);
    }
  }, [agentId, boxUrl, token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Decorate each catalog entry with its installed state (live diff).
  const decorated = useMemo(() => {
    if (!catalog) return [];
    return catalog
      .map((s) => ({ ...s, installed: isCuratedSkillInstalled(s, installedNames) }))
      .sort((a, b) => {
        // Available first, then alphabetical.
        if (a.installed !== b.installed) return a.installed ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
  }, [catalog, installedNames]);

  const availableCount = decorated.filter((s) => !s.installed).length;

  const toggle = useCallback((id: string, installed: boolean) => {
    if (installed) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const install = useCallback(async () => {
    if (installing || selected.size === 0) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const r = await fetch(`/api/hivra/agents/${agentId}/skills/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillIds: Array.from(selected) }),
      });
      const j = await readJson(r);
      if (!r.ok || !j || j.success !== true) {
        setInstallError((j?.error as string) || `Install failed (${r.status})`);
        return;
      }
      setSelected(new Set());
      onInstalled(); // parent refreshes its installed list
      onClose();
    } catch (e) {
      setInstallError((e as Error).message || "Network error during install");
    } finally {
      setInstalling(false);
    }
  }, [agentId, selected, installing, onInstalled, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add skills"
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
            <div className="mono" style={{ ...mono, marginBottom: 6 }}>Add skills</div>
            <h3 className="serif" style={{ fontSize: "clamp(1.2rem, 3vw, 1.6rem)", fontWeight: 400, margin: 0, color: "var(--ink-black)" }}>
              Curated catalog
            </h3>
            <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: "6px 0 0", lineHeight: 1.5, maxWidth: 460 }}>
              Pick skills to install onto this agent. Each install writes the skill onto the box — the agent keeps it for good.
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
              No installable skills in the catalog.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {decorated.map((s) => {
                const checked = selected.has(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={s.installed}
                    onClick={() => toggle(s.id, s.installed)}
                    aria-pressed={checked}
                    style={{
                      textAlign: "left",
                      border: `1px solid ${checked ? "var(--gold-leaf)" : "var(--etched-border)"}`,
                      background: checked ? "rgba(197,160,89,0.08)" : "rgba(255,255,255,0.03)",
                      padding: "12px 14px",
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 12,
                      cursor: s.installed ? "default" : "pointer",
                      opacity: s.installed ? 0.62 : 1,
                      minWidth: 0,
                    }}
                  >
                    <span style={{ marginTop: 2, flexShrink: 0, width: 16, height: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--gold-leaf)" }}>
                      {s.installed ? <Check size={14} /> : checked ? <Check size={14} /> : <Sparkles size={13} style={{ opacity: 0.5 }} />}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <strong className="serif" style={{ fontSize: 15.5, fontWeight: 400, color: "var(--ink-black)" }}>{s.name}</strong>
                        <span className="mono" style={{ ...mono, fontSize: 9, opacity: 0.85, color: s.installed ? "var(--text-muted)" : "var(--gold-leaf)" }}>
                          {s.installed ? "Installed" : "Available"}
                        </span>
                        {s.category ? <span className="mono" style={{ ...mono, fontSize: 9 }}>{s.category}</span> : null}
                      </span>
                      <span style={{ display: "block", fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5, marginTop: 4 }}>
                        {s.description || "No description."}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 22px", borderTop: "1px solid var(--etched-border)", flexWrap: "wrap" }}>
          <div className="mono" style={{ ...mono, opacity: 0.7 }}>
            {installError ? <span style={{ color: "#e06c5a", textTransform: "none", letterSpacing: 0, fontSize: 12 }}>{installError}</span>
              : catalog && !loadError ? `${selected.size} selected · ${availableCount} available` : ""}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onClose} disabled={installing} style={{ border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-secondary)", padding: "8px 16px", cursor: installing ? "default" : "pointer", fontSize: 13 }}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void install()}
              disabled={installing || selected.size === 0}
              style={{
                border: "1px solid var(--gold-leaf)",
                background: selected.size === 0 || installing ? "transparent" : "var(--gold-leaf)",
                color: selected.size === 0 || installing ? "var(--text-muted)" : "var(--ink-black)",
                padding: "8px 18px",
                cursor: installing || selected.size === 0 ? "default" : "pointer",
                fontSize: 13,
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
              }}
            >
              {installing ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Plus size={13} />}
              {installing ? "Installing…" : `Install${selected.size ? ` ${selected.size}` : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
