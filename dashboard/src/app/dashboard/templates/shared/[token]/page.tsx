"use client";

// Wave 5.2 — public shared view of an agent template (reached via a share link).
// Shows the template's identity (name, goal, personality, emoji, provider) — with
// the owner's private `context` never exposed — and a "Use this template" button
// that forks it into a new agent via the launch flow.

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Rocket, ArrowLeft } from "lucide-react";

import { DashboardPageShell } from "@/components/layout/DashboardPageShell";
import { clientLog } from "@/lib/client/logger";

interface SharedTemplate {
  id: string;
  slug: string;
  type: string;
  name: string | null;
  goal: string | null;
  personality: string | null;
  emoji: string | null;
}

const MONO = "var(--font-mono), monospace";

export default function SharedTemplatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [template, setTemplate] = useState<SharedTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/hivra/templates/shared/${token}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.success) setTemplate(data.data.template as SharedTemplate);
        else setNotFound(true);
      })
      .catch((err) => {
        if (cancelled) return;
        clientLog.error("Failed to load shared template", err, { source: "hivra-templates-shared" });
        setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const useTemplate = useCallback(() => {
    if (!template) return;
    // Fork on launch: the welcome/deploy flow reads templateId and the launch
    // POST resolves it (visibility-checked, context already stripped here).
    router.push(`/dashboard/welcome?step=agent-type&templateId=${encodeURIComponent(template.id)}`);
  }, [router, template]);

  return (
    <DashboardPageShell maxWidth={640}>
      <button
        onClick={() => router.push("/dashboard/templates")}
        style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", marginBottom: "2rem", fontFamily: MONO, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.5 }}
      >
        <ArrowLeft size={12} /> Templates
      </button>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "3rem" }}>
          <Loader2 size={18} style={{ animation: "spin 1s linear infinite", opacity: 0.55 }} />
        </div>
      ) : notFound || !template ? (
        <div style={{ padding: "3rem", textAlign: "center", border: "1px dashed var(--etched-border)", opacity: 0.7, fontFamily: MONO, fontSize: 12 }}>
          This template link is no longer available.
        </div>
      ) : (
        <div style={{ border: "1px solid var(--ink-black)", background: "var(--bg-surface)", padding: "2rem", boxShadow: "6px 6px 0px rgba(0,0,0,0.08)" }}>
          <div className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.5, marginBottom: "1.5rem" }}>
            Shared agent template
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
            <span style={{ fontSize: 40 }}>{template.emoji || "🤖"}</span>
            <div>
              <h2 className="serif" style={{ fontSize: "2rem", fontWeight: 300, lineHeight: 1.1 }}>{template.name || "Untitled agent"}</h2>
              <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.5, marginTop: 4 }}>{template.type}</div>
            </div>
          </div>

          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.5rem 1.5rem", marginBottom: "2rem", fontSize: 13 }}>
            {template.goal && (
              <>
                <dt className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.5, alignSelf: "center" }}>Goal</dt>
                <dd style={{ margin: 0 }}>{template.goal}</dd>
              </>
            )}
            {template.personality && (
              <>
                <dt className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.5, alignSelf: "center" }}>Personality</dt>
                <dd style={{ margin: 0 }}>{template.personality}</dd>
              </>
            )}
          </dl>

          <button
            onClick={useTemplate}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "12px", background: "var(--btn-bg)", color: "var(--btn-text)", border: "none", cursor: "pointer", fontFamily: MONO, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.15em", fontWeight: 600 }}
          >
            <Rocket size={14} /> Use this template
          </button>
          <p style={{ marginTop: "1rem", fontSize: 11, opacity: 0.55, textAlign: "center", lineHeight: 1.5 }}>
            Launches a new agent on your account with this setup. The creator&apos;s private notes and
            any API keys are never included.
          </p>
        </div>
      )}
    </DashboardPageShell>
  );
}
