"use client";

// Wave 5.2 — agent templates surface. Save a configured agent as a named,
// reusable template; manage visibility (private / link / public); copy the
// share link; delete; and one-click launch (fork) from a template.
//
// Client-only: every read/write goes through the canary-gated /api/hivra/*
// routes (the dashboard layout already enforces Clerk auth). No sidebar changes
// — this page is reached from a link on /dashboard/library.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Save, Trash2, Rocket, Link2, Lock, Globe, Copy, Check } from "lucide-react";

import { DashboardPageShell } from "@/components/layout/DashboardPageShell";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import { clientLog } from "@/lib/client/logger";

type Visibility = "private" | "link" | "public";

interface OwnerTemplate {
  id: string;
  slug: string;
  type: string;
  name: string | null;
  goal: string | null;
  personality: string | null;
  emoji: string | null;
  visibility: Visibility;
  share_token: string | null;
  created_at: string;
}

interface LaunchableAgent {
  id: string;
  name: string | null;
  type: string;
  emoji: string | null;
  status?: string;
}

const MONO = "var(--font-mono), monospace";

// Row controls share one boxy 44px control shape.
const ROW_CONTROL: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 5,
  minHeight: 44,
  minWidth: 44,
  padding: "0 12px",
  fontFamily: MONO,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  fontWeight: 600,
};

export default function TemplatesPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<LaunchableAgent[]>([]);
  const [templates, setTemplates] = useState<OwnerTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [busyTemplateId, setBusyTemplateId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Deleting and publishing are one tap away from each other on a phone, so
  // both ask inline before they act.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmPublicId, setConfirmPublicId] = useState<string | null>(null);
  // The confirm pair replaces the trash button, so focus follows it there and
  // back: Cancel on open (the safe default), the trash button after Cancel.
  const confirmDeleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const deleteTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const refocusDeleteTriggerIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (confirmDeleteId) {
      confirmDeleteCancelRef.current?.focus();
      return;
    }
    const id = refocusDeleteTriggerIdRef.current;
    refocusDeleteTriggerIdRef.current = null;
    if (id) deleteTriggerRefs.current.get(id)?.focus();
  }, [confirmDeleteId]);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [agentsRes, templatesRes] = await Promise.all([
        fetch("/api/hivra/agents").then((r) => r.json()).catch(() => null),
        fetch("/api/hivra/templates").then((r) => r.json()).catch(() => null),
      ]);
      if (agentsRes?.success) setAgents(agentsRes.data.agents ?? []);
      if (templatesRes?.success) setTemplates(templatesRes.data.templates ?? []);
      // If neither list could load, surface a real error rather than leaving the
      // user on a silent empty state with no idea anything failed.
      if (!agentsRes?.success && !templatesRes?.success) {
        setError("Couldn't load your agents and templates. Please try again.");
      }
    } catch (err) {
      clientLog.error("Failed to load templates surface", err, { source: "hivra-templates" });
      setError("Couldn't load your agents and templates. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const saveAsTemplate = useCallback(async (agentId: string) => {
    setSavingId(agentId);
    setError(null);
    try {
      const res = await fetch("/api/hivra/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Could not save that agent as a template.");
        return;
      }
      setTemplates((prev) => [data.data.template as OwnerTemplate, ...prev]);
    } catch (err) {
      clientLog.error("Save as template failed", err, { source: "hivra-templates" });
      setError("Could not save that agent as a template.");
    } finally {
      setSavingId(null);
    }
  }, []);

  const changeVisibility = useCallback(async (id: string, visibility: Visibility) => {
    setConfirmPublicId(null);
    setBusyTemplateId(id);
    setError(null);
    try {
      const res = await fetch(`/api/hivra/templates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Could not update visibility.");
        return;
      }
      const updated = data.data.template as OwnerTemplate;
      setTemplates((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch (err) {
      clientLog.error("Change template visibility failed", err, { source: "hivra-templates" });
      setError("Could not update visibility.");
    } finally {
      setBusyTemplateId(null);
    }
  }, []);

  const deleteTemplate = useCallback(async (id: string) => {
    setConfirmDeleteId(null);
    setBusyTemplateId(id);
    setError(null);
    try {
      const res = await fetch(`/api/hivra/templates/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Could not delete that template.");
        return;
      }
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      clientLog.error("Delete template failed", err, { source: "hivra-templates" });
      setError("Could not delete that template.");
    } finally {
      setBusyTemplateId(null);
    }
  }, []);

  const copyShareLink = useCallback(async (template: OwnerTemplate) => {
    if (!template.share_token) return;
    const url = `${window.location.origin}/dashboard/templates/shared/${template.share_token}`;
    const ok = await copyTextToClipboard(url);
    if (ok) {
      setCopiedId(template.id);
      setTimeout(() => setCopiedId((cur) => (cur === template.id ? null : cur)), 2000);
    }
  }, []);

  const launchFromTemplate = useCallback((template: OwnerTemplate) => {
    // Hand off to the deploy/welcome flow with a templateId so the picker can
    // pre-fill identity and the launch POST forks it.
    router.push(`/dashboard/welcome?step=agent-type&templateId=${encodeURIComponent(template.id)}`);
  }, [router]);

  return (
    <DashboardPageShell maxWidth={1000}>
      <header style={{ marginBottom: "2.5rem" }}>
        <button
          onClick={() => router.push("/dashboard/library")}
          style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, padding: "0 2px", background: "none", border: "none", cursor: "pointer", marginBottom: "0.75rem", fontFamily: MONO, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.5 }}
        >
          <ArrowLeft size={12} /> Library
        </button>
        <h2 className="serif" style={{ fontSize: "3rem", fontWeight: 300, lineHeight: 1.1, marginBottom: "1rem" }}>
          Agent <em style={{ fontStyle: "italic" }}>templates</em>
        </h2>
        <p style={{ opacity: 0.8, fontSize: 14, maxWidth: 620, lineHeight: 1.6 }}>
          Snapshot a configured agent into a reusable template, then launch it again in one click — or
          share it with a link. Templates carry the agent&apos;s setup (goal, personality, emoji, provider),
          never your private notes or any API key.
        </p>
      </header>

      {error && (
        <div role="alert" style={{ marginBottom: "1.5rem", padding: "0.75rem 1rem", border: "1px solid var(--etched-border)", background: "var(--bg-elevated)", fontFamily: MONO, fontSize: 12 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "3rem" }}>
          <Loader2 size={18} style={{ animation: "spin 1s linear infinite", opacity: 0.55 }} />
        </div>
      ) : (
        <>
          {/* Save-as-template picker over the user's agents */}
          <section style={{ marginBottom: "3rem" }}>
            <h3 className="mono" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: "1.25rem", opacity: 0.6 }}>
              Save an agent as a template
            </h3>
            {agents.length === 0 ? (
              <div style={{ padding: "2rem", textAlign: "center", border: "1px dashed var(--etched-border)", opacity: 0.6, fontFamily: MONO, fontSize: 12 }}>
                No agents yet — launch one first, then come back to template it.
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "1rem" }}>
                {agents.map((agent) => (
                  <div key={agent.id} style={{ border: "1px solid var(--etched-border)", background: "var(--bg-surface)", padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span style={{ fontSize: 20 }}>{agent.emoji || "🤖"}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{agent.name || "Agent"}</div>
                        <div className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.5 }}>{agent.type}</div>
                      </div>
                    </div>
                    <button
                      onClick={() => saveAsTemplate(agent.id)}
                      disabled={savingId === agent.id}
                      style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 44, padding: "9px", background: "var(--btn-bg)", color: "var(--btn-text)", border: "none", cursor: savingId === agent.id ? "default" : "pointer", fontFamily: MONO, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", fontWeight: 600, opacity: savingId === agent.id ? 0.6 : 1 }}
                    >
                      {savingId === agent.id ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Save size={13} />}
                      Save as template
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* My templates */}
          <section>
            <h3 className="mono" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: "1.25rem", opacity: 0.6 }}>
              My templates
            </h3>
            {templates.length === 0 ? (
              <div style={{ padding: "2rem", textAlign: "center", border: "1px dashed var(--etched-border)", opacity: 0.6, fontFamily: MONO, fontSize: 12 }}>
                No templates yet.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                {templates.map((t) => {
                  const busy = busyTemplateId === t.id;
                  const confirmingDelete = confirmDeleteId === t.id;
                  const confirmingPublic = confirmPublicId === t.id;
                  return (
                    <div key={t.id} style={{ border: "1px solid var(--etched-border)", background: "var(--bg-surface)", padding: "1.25rem", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "1rem", justifyContent: "space-between" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", minWidth: 0 }}>
                        <span style={{ fontSize: 22 }}>{t.emoji || "🤖"}</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 15, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name || "Untitled"}</div>
                          <div className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.5, overflowWrap: "anywhere" }}>
                            {t.type}{t.goal ? ` · ${t.goal}` : ""}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                        {/* Visibility selector */}
                        <div role="group" aria-label="Template visibility" style={{ display: "inline-flex", border: "1px solid var(--etched-border)" }}>
                          {(["private", "link", "public"] as Visibility[]).map((v) => {
                            const active = t.visibility === v;
                            const Icon = v === "private" ? Lock : v === "link" ? Link2 : Globe;
                            return (
                              <button
                                key={v}
                                type="button"
                                aria-pressed={active}
                                onClick={() => {
                                  if (active) return;
                                  // Public lists the template for everyone; ask first.
                                  if (v === "public") setConfirmPublicId(t.id);
                                  else void changeVisibility(t.id, v);
                                }}
                                disabled={busy || active}
                                title={v}
                                style={{ ...ROW_CONTROL, background: active ? "var(--btn-bg)" : "transparent", color: active ? "var(--btn-text)" : "var(--ink-black)", border: "none", borderRight: v !== "public" ? "1px solid var(--etched-border)" : "none", cursor: active || busy ? "default" : "pointer" }}
                              >
                                <Icon size={12} aria-hidden="true" /> {v}
                              </button>
                            );
                          })}
                        </div>

                        {t.share_token ? (
                          <button
                            type="button"
                            onClick={() => copyShareLink(t)}
                            title="Copy share link"
                            style={{ ...ROW_CONTROL, background: "transparent", border: "1px solid var(--etched-border)", cursor: "pointer" }}
                          >
                            {copiedId === t.id ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                            {copiedId === t.id ? "Copied" : "Link"}
                          </button>
                        ) : null}

                        <button
                          type="button"
                          onClick={() => launchFromTemplate(t)}
                          title="Launch from this template"
                          style={{ ...ROW_CONTROL, background: "var(--btn-bg)", color: "var(--btn-text)", border: "none", cursor: "pointer" }}
                        >
                          <Rocket size={12} aria-hidden="true" /> Launch
                        </button>

                        {confirmingDelete ? (
                          <div role="group" aria-label="Confirm delete" style={{ display: "flex", gap: "0.5rem", marginLeft: "auto" }}>
                            <button
                              type="button"
                              onClick={() => deleteTemplate(t.id)}
                              disabled={busy}
                              style={{ ...ROW_CONTROL, background: "transparent", border: "1px solid var(--hivra-red)", color: "var(--hivra-red)", cursor: busy ? "default" : "pointer" }}
                            >
                              {busy ? <Loader2 size={12} aria-hidden="true" style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={12} aria-hidden="true" />}
                              Delete?
                            </button>
                            <button
                              ref={confirmDeleteCancelRef}
                              type="button"
                              onClick={() => {
                                refocusDeleteTriggerIdRef.current = t.id;
                                setConfirmDeleteId(null);
                              }}
                              disabled={busy}
                              style={{ ...ROW_CONTROL, background: "transparent", border: "1px solid var(--etched-border)", color: "var(--ink-black)", cursor: busy ? "default" : "pointer" }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            ref={(node) => {
                              if (node) deleteTriggerRefs.current.set(t.id, node);
                              else deleteTriggerRefs.current.delete(t.id);
                            }}
                            type="button"
                            onClick={() => setConfirmDeleteId(t.id)}
                            disabled={busy}
                            title="Delete template"
                            aria-label="Delete template"
                            style={{ ...ROW_CONTROL, padding: 0, marginLeft: "auto", background: "transparent", border: "1px solid var(--etched-border)", cursor: busy ? "default" : "pointer", color: "var(--ink-black)", opacity: busy ? 0.5 : 1 }}
                          >
                            {busy ? <Loader2 size={14} aria-hidden="true" style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={14} aria-hidden="true" />}
                          </button>
                        )}
                      </div>

                      {confirmingPublic ? (
                        <div role="group" aria-label="Confirm public template" style={{ flexBasis: "100%", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem", borderTop: "1px solid var(--etched-border)", paddingTop: "0.75rem" }}>
                          <span style={{ flex: "1 1 220px", fontSize: 13, lineHeight: 1.5 }}>
                            Public templates can be found and launched by anyone. Your private notes and API keys stay out.
                          </span>
                          <button
                            type="button"
                            onClick={() => changeVisibility(t.id, "public")}
                            disabled={busy}
                            style={{ ...ROW_CONTROL, background: "var(--btn-bg)", color: "var(--btn-text)", border: "none", cursor: busy ? "default" : "pointer" }}
                          >
                            <Globe size={12} aria-hidden="true" /> Make public
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmPublicId(null)}
                            style={{ ...ROW_CONTROL, background: "transparent", border: "1px solid var(--etched-border)", color: "var(--ink-black)", cursor: "pointer" }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : !t.share_token ? (
                        <p className="mono" style={{ flexBasis: "100%", margin: 0, fontSize: 11, letterSpacing: "0.04em", opacity: 0.6 }}>
                          Private · switch to Link or Public to create a share link.
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </DashboardPageShell>
  );
}
