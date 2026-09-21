"use client";

import { useCallback, useEffect, useState } from "react";
import { UserButton } from "@clerk/nextjs";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Cloud,
  CreditCard,
  ExternalLink,
  Loader2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

interface LaneStatus {
  subscribed: boolean;
  status: string | null;
  instanceLimit: number;
  instanceCount: number;
  currentPeriodEnd: string | null;
  plan: { key: string; name: string; priceLabel: string } | null;
  offer: { key: string; name: string; priceLabel: string };
}

const monoLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono), 'Space Mono', monospace",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.22em",
  fontWeight: 700,
};

const SCOPED_CSS = `
.wcb-shell { min-height: 100vh; background: var(--vellum-bg); color: var(--ink-black); }
.wcb-card { background: var(--bg-surface); border: 1px solid var(--etched-border); box-shadow: 0 4px 20px -5px rgba(0,0,0,0.05); }
.wcb-btn { transition: all .2s ease; }
.wcb-btn:hover:not(:disabled) { border-color: var(--ink-black); }
.wcb-btn-solid:hover:not(:disabled) { opacity: .86; letter-spacing: .14em; }
.wcb-link { transition: color .2s ease, opacity .2s ease; }
.wcb-link:hover { color: var(--ink-black); opacity: 1 !important; }
.wcb-in { animation: wcb-up .5s cubic-bezier(.16,1,.3,1) both; }
@keyframes wcb-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .wcb-in { animation: none; } }
`;

function Button({
  icon,
  label,
  onClick,
  busy,
  solid,
  full,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  busy?: boolean;
  solid?: boolean;
  full?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`wcb-btn ${solid ? "wcb-btn-solid" : ""}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        padding: "9px 14px",
        border: "1px solid",
        borderColor: solid ? "var(--ink-black)" : "var(--etched-border)",
        background: solid ? "var(--ink-black)" : "transparent",
        color: solid ? "var(--bg-surface)" : "var(--ink-black)",
        fontFamily: "var(--font-mono), 'Space Mono', monospace",
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        fontWeight: 700,
        cursor: busy ? "not-allowed" : "pointer",
        whiteSpace: "nowrap",
        width: full ? "100%" : undefined,
      }}
    >
      {busy ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : icon}
      {label}
    </button>
  );
}

function statusBadge(status: string | null) {
  const s = (status || "").toLowerCase();
  if (s === "active") return { label: "Active", color: "var(--green)", bg: "rgba(34,197,94,0.1)" };
  if (s === "trialing") return { label: "Trialing", color: "var(--gold-leaf)", bg: "rgba(255, 44, 45,0.12)" };
  if (s === "past_due") return { label: "Past due", color: "#ef4444", bg: "rgba(239,68,68,0.1)" };
  return { label: s ? s : "Inactive", color: "var(--text-muted)", bg: "rgba(0,0,0,0.04)" };
}

export function BillingClient() {
  const [status, setStatus] = useState<LaneStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace-cloud/status", { credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (res.ok) setStatus(body?.data as LaneStatus);
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const subscribe = useCallback(async () => {
    setBusy("subscribe");
    setError(null);
    try {
      const res = await fetch("/api/workspace-cloud/billing/subscribe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: status?.offer.key ?? "ws_cloud_pro", cadence: "monthly" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.data?.url) throw new Error(body?.error || "Couldn't start checkout");
      window.location.href = body.data.url as string;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }, [status]);

  const manage = useCallback(async () => {
    setBusy("portal");
    setError(null);
    try {
      const res = await fetch("/api/workspace-cloud/billing/portal", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.data?.url) throw new Error(body?.error || "Couldn't open billing portal");
      window.location.href = body.data.url as string;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }, []);

  const subscribed = status?.subscribed === true;
  const badge = statusBadge(status?.status ?? null);
  const renew = status?.currentPeriodEnd ? new Date(status.currentPeriodEnd).toLocaleDateString() : null;

  return (
    <div className="wcb-shell">
      <style dangerouslySetInnerHTML={{ __html: SCOPED_CSS }} />

      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px clamp(1rem, 5vw, 2.5rem)", borderBottom: "1px solid var(--etched-border)", background: "var(--bg-surface)" }}>
        <a href="/workspace-cloud" style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none", color: "inherit" }}>
          <div style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", color: "var(--gold-leaf)" }}>
            <Cloud size={16} />
          </div>
          <div style={{ lineHeight: 1.1 }}>
            <span className="serif" style={{ fontSize: 16, fontWeight: 600 }}>Hermes</span>
            <span className="mono" style={{ ...monoLabel, fontSize: 8, opacity: 0.5, marginLeft: 8 }}>Workspace Cloud</span>
          </div>
        </a>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <a href="/workspace-cloud" className="wcb-link mono" style={{ ...monoLabel, fontSize: 10, opacity: 0.6, textDecoration: "none", color: "var(--ink-black)", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ArrowLeft size={13} /> Dashboard
          </a>
          <UserButton />
        </div>
      </header>

      <main style={{ maxWidth: 620, margin: "0 auto", padding: "clamp(2rem, 6vw, 3.5rem) clamp(1rem, 5vw, 2.5rem) 4rem" }}>
        <div style={{ marginBottom: "2.25rem" }}>
          <p className="mono" style={{ ...monoLabel, fontSize: 10, color: "var(--gold-leaf)", marginBottom: 12 }}>Billing</p>
          <h1 className="serif" style={{ fontSize: "clamp(2rem, 6vw, 3rem)", fontWeight: 400, lineHeight: 1.05 }}>Subscription</h1>
        </div>

        {error && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.05)", color: "#ef4444", fontSize: 13, marginBottom: "1.5rem" }}>
            <AlertTriangle size={15} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="wcb-card" style={{ minHeight: 220, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Loader2 size={20} style={{ animation: "spin 1s linear infinite", opacity: 0.4 }} />
          </div>
        ) : subscribed ? (
          <div className="wcb-card wcb-in" style={{ padding: "clamp(1.5rem, 4vw, 2rem)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: "1.5rem" }}>
              <div>
                <h2 className="serif" style={{ fontSize: "1.7rem", fontWeight: 500 }}>{status?.plan?.name ?? "Workspace Cloud"}</h2>
                {status?.plan?.priceLabel && <p className="mono" style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>{status.plan.priceLabel}</p>}
              </div>
              <span className="mono" style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", padding: "4px 10px", color: badge.color, background: badge.bg, border: `1px solid ${badge.color}33` }}>
                {badge.label}
              </span>
            </div>

            <div style={{ marginBottom: "1.75rem" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 0", borderBottom: "1px solid var(--etched-border)" }}>
                <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.14em", opacity: 0.5, display: "inline-flex", alignItems: "center", gap: 7 }}><Bot size={12} style={{ color: "var(--gold-leaf)" }} /> Agents</span>
                <span style={{ fontSize: 13 }}>{status?.instanceCount ?? 0} of {status?.instanceLimit ?? 1} used</span>
              </div>
              {renew && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 0", borderBottom: "1px solid var(--etched-border)" }}>
                  <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.14em", opacity: 0.5, display: "inline-flex", alignItems: "center", gap: 7 }}><ShieldCheck size={12} style={{ color: "var(--gold-leaf)" }} /> Renews</span>
                  <span style={{ fontSize: 13 }}>{renew}</span>
                </div>
              )}
            </div>

            <Button icon={<ExternalLink size={13} />} label={busy === "portal" ? "Opening…" : "Manage subscription"} solid busy={busy === "portal"} onClick={manage} />
            <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 12, lineHeight: 1.6 }}>
              Update your card, view invoices, or cancel in the Stripe billing portal.
            </p>
          </div>
        ) : (
          <div className="wcb-card wcb-in" style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "clamp(2.5rem, 8vw, 4rem) 2rem" }}>
            <div style={{ width: 56, height: 56, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", background: "rgba(255, 44, 45,0.06)", color: "var(--gold-leaf)", marginBottom: "1.5rem" }}>
              <Cloud size={24} />
            </div>
            <h2 className="serif" style={{ fontSize: "clamp(1.4rem, 5vw, 1.8rem)", fontWeight: 400, marginBottom: 12 }}>Subscribe to Workspace Cloud</h2>
            <p style={{ fontSize: 13.5, color: "var(--text-secondary)", maxWidth: 400, lineHeight: 1.65, marginBottom: "1.5rem" }}>
              One dedicated cloud Hermes agent you connect to from the Workspace app.
            </p>
            <div style={{ display: "inline-flex", alignItems: "baseline", gap: 8, marginBottom: "1.5rem" }}>
              <span className="serif" style={{ fontSize: "1.6rem", fontWeight: 500 }}>{status?.offer.name ?? "Workspace Cloud Pro"}</span>
              {status?.offer.priceLabel && <span className="mono" style={{ fontSize: 12, opacity: 0.6 }}>{status.offer.priceLabel}</span>}
            </div>
            <Button icon={<Sparkles size={14} />} label={busy === "subscribe" ? "Redirecting…" : "Subscribe"} solid busy={busy === "subscribe"} onClick={subscribe} />
          </div>
        )}

        <footer style={{ marginTop: "2.5rem", display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
          <CreditCard size={12} />
          <span>Payments are handled securely by Stripe. Workspace Cloud billing is separate from your Hermes Workspace app.</span>
        </footer>
      </main>
    </div>
  );
}
