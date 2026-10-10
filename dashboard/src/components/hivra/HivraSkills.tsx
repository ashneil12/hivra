"use client";

// HivraSkills — lists the agent's installed skills (~/.claude/skills or
// ~/.codex/skills SKILL.md), in the Command Center vocabulary, with a remove
// action. Talks to the box's token-gated /api/skills (+ DELETE /api/skills/:id).
// Add new skills from the Terminal.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Loader2, Sparkles, Boxes, Trash2, Plus } from "lucide-react";

import { listBoxSkills, deleteBoxSkill, type BoxSkill } from "@/lib/hivra/agent-api";
import { SkillInstallPicker } from "@/components/hivra/SkillInstallPicker";

const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  opacity: 0.62,
};

// The destructive remove control grows to a 44px square on touch screens.
const SKILLS_CSS = `@media (pointer: coarse) { .skill-remove { min-width: 44px; min-height: 44px; } }`;

export function HivraSkills({ boxUrl, token }: { boxUrl: string; token?: string | null }) {
  const params = useParams();
  const rawId = params?.id;
  const agentId = Array.isArray(rawId) ? rawId[0] : (rawId as string | undefined);
  const [skills, setSkills] = useState<BoxSkill[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const load = useCallback(() => {
    void listBoxSkills(boxUrl, token).then(setSkills);
  }, [boxUrl, token]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = useCallback(
    async (s: BoxSkill) => {
      if (removing) return;
      if (!window.confirm(`Remove the "${s.name}" skill from this agent? This deletes the skill folder on the box.`)) return;
      setRemoving(s.id);
      const res = await deleteBoxSkill(boxUrl, s.id, token);
      if (!res.ok) {
        window.alert(res.error || "Failed to remove skill");
      } else {
        setSkills((prev) => (prev ? prev.filter((x) => x.id !== s.id) : prev));
      }
      setRemoving(null);
    },
    [boxUrl, token, removing],
  );

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "32px 20px", height: "100%", overflowY: "auto" }}>
      <style>{SKILLS_CSS}</style>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, marginBottom: 6, flexWrap: "wrap" }}>
        <div>
          <div className="mono" style={{ ...mono, marginBottom: 6 }}>Skills</div>
          <h2 className="serif" style={{ fontSize: "clamp(1.6rem, 4vw, 2.2rem)", fontWeight: 400, margin: 0, color: "var(--ink-black)" }}>
            {skills === null ? "Skills" : `${skills.length} installed`}
          </h2>
        </div>
        {agentId ? (
          <button
            type="button"
            onClick={() => setPicking(true)}
            style={{ border: "1px solid var(--gold-leaf)", background: "transparent", color: "var(--ink-black)", padding: "8px 16px", minHeight: 40, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13 }}
          >
            <Plus size={14} style={{ color: "var(--gold-leaf)" }} /> Add skills
          </button>
        ) : null}
      </div>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "8px 0 22px", lineHeight: 1.6 }}>
        Capabilities the agent can invoke. Add skills from the curated catalog above, or remove one below. Skills live on the box (<span className="mono" style={{ ...mono, textTransform: "none", letterSpacing: 0, fontSize: 12 }}>~/.claude/skills</span>).
      </p>

      {skills === null ? (
        <div style={{ padding: 40, textAlign: "center" }}><Loader2 size={18} style={{ animation: "spin 1s linear infinite", opacity: 0.5 }} /></div>
      ) : skills.length === 0 ? (
        <div style={{ border: "1px dashed var(--etched-border)", padding: "28px 20px", textAlign: "center", color: "var(--text-muted)", fontSize: 13.5 }}>
          No skills installed yet.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))", gap: 12 }}>
          {skills.map((s) => (
            <div key={s.id} style={{ border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.035)", padding: 16, display: "grid", gap: 8, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <Sparkles size={14} style={{ color: "var(--gold-leaf)", flexShrink: 0 }} />
                <strong className="serif" style={{ fontSize: 17, fontWeight: 400, color: "var(--ink-black)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</strong>
                <button
                  type="button"
                  onClick={() => void remove(s)}
                  disabled={removing === s.id}
                  aria-label="Remove skill"
                  title="Remove skill"
                  className="skill-remove"
                  style={{ border: "1px solid var(--etched-border)", background: "transparent", color: "#e06c5a", padding: "4px 6px", cursor: removing === s.id ? "default" : "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                >
                  {removing === s.id ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={12} />}
                </button>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {s.description || "No description."}
              </div>
            </div>
          ))}
        </div>
      )}
      {skills && skills.length > 0 ? (
        <div className="mono" style={{ ...mono, display: "inline-flex", alignItems: "center", gap: 7, marginTop: 18, opacity: 0.5 }}>
          <Boxes size={12} /> read from the box · skills dir
        </div>
      ) : null}

      {picking && agentId ? (
        <SkillInstallPicker
          agentId={agentId}
          boxUrl={boxUrl}
          token={token}
          onClose={() => setPicking(false)}
          onInstalled={load}
        />
      ) : null}
    </div>
  );
}
