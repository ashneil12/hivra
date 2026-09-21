"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Cloud,
  Link2,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";

interface LaneInstance {
  id: string;
  name: string;
  status: string;
  gateway_url?: string | null;
}

// The callback must point at the local Workspace app. Restricting to loopback
// hosts prevents an attacker from crafting a connect link that exfiltrates the
// one-time code to an external server.
function isAllowedCallback(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "[::1]" ||
      u.hostname === "::1"
    );
  } catch {
    return false;
  }
}

const RUNNING_STATES = new Set(["running", "active"]);
const PENDING_STATES = new Set(["provisioning", "pending", "restoring", "archiving"]);

function statusMeta(status: string) {
  const s = (status || "").toLowerCase();
  if (RUNNING_STATES.has(s)) return { color: "#22c55e", glow: "0 0 10px rgba(34,197,94,0.55)", label: "Running" };
  if (PENDING_STATES.has(s)) return { color: "var(--yellow)", glow: "0 0 9px rgba(212,160,55,0.55)", label: s.charAt(0).toUpperCase() + s.slice(1) };
  if (s === "error" || s === "failed") return { color: "#ef4444", glow: "none", label: s.charAt(0).toUpperCase() + s.slice(1) };
  return { color: "#9ca3af", glow: "none", label: status ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown" };
}

const monoLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono), 'Space Mono', monospace",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.22em",
  fontWeight: 700,
};

const SCOPED_CSS = `
.wcc-shell { min-height: 100vh; background: var(--vellum-bg); color: var(--ink-black); display: flex; flex-direction: column; align-items: center; padding: clamp(2rem, 7vw, 4rem) 1rem; }
.wcc-card { background: var(--bg-surface); border: 1px solid var(--etched-border); transition: border-color .3s ease, transform .3s ease; }
.wcc-agent:hover { border-color: var(--ink-black); }
.wcc-btn { transition: all .2s ease; }
.wcc-btn:hover:not(:disabled) { border-color: var(--ink-black); }
.wcc-btn-solid:hover:not(:disabled) { opacity: .86; letter-spacing: .14em; }
.wcc-in { animation: wcc-fade .5s cubic-bezier(.16,1,.3,1) both; }
@keyframes wcc-fade { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes wcc-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
.wcc-prov { background: linear-gradient(90deg, rgba(212,160,55,0.06) 0%, rgba(212,160,55,0.16) 50%, rgba(212,160,55,0.06) 100%); background-size: 200% 100%; animation: wcc-shimmer 1.8s linear infinite; }
@media (prefers-reduced-motion: reduce) { .wcc-in, .wcc-prov { animation: none; } }
`;

type Tone = "ghost" | "solid";

function PanelButton({ icon, label, onClick, disabled, busy, tone = "ghost", full }: { icon?: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; busy?: boolean; tone?: Tone; full?: boolean }) {
  const toneStyle: React.CSSProperties =
    tone === "solid"
      ? { background: "var(--ink-black)", color: "var(--bg-surface)", borderColor: "var(--ink-black)" }
      : { background: "transparent", color: "var(--ink-black)", borderColor: "var(--etched-border)" };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`wcc-btn ${tone === "solid" ? "wcc-btn-solid" : ""}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        padding: "9px 14px",
        border: "1px solid",
        fontFamily: "var(--font-mono), 'Space Mono', monospace",
        fontSize: 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        fontWeight: 700,
        cursor: disabled || busy ? "not-allowed" : "pointer",
        opacity: disabled && !busy ? 0.4 : 1,
        whiteSpace: "nowrap",
        width: full ? "100%" : undefined,
        ...toneStyle,
      }}
    >
      {busy ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : icon}
      {label}
    </button>
  );
}

function Brand() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "2rem" }}>
      <div style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", color: "var(--gold-leaf)" }}>
        <Cloud size={16} />
      </div>
      <span className="serif" style={{ fontSize: 16, fontWeight: 600 }}>Hermes</span>
      <span className="mono" style={{ ...monoLabel, fontSize: 8, opacity: 0.5 }}>Workspace Cloud</span>
    </div>
  );
}

function ConnectInner() {
  const params = useSearchParams();
  const callback = params.get("callback") || "";
  const state = params.get("state") || "";
  const challenge = params.get("challenge") || "";

  const [instances, setInstances] = useState<LaneInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSubscription, setNeedsSubscription] = useState(false);

  const paramsValid = Boolean(callback) && Boolean(state) && Boolean(challenge) && isAllowedCallback(callback);

  const loadInstances = useCallback(async () => {
    const res = await fetch("/api/workspace-cloud/instances", { credentials: "include" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || "Failed to load instances");
    setInstances((body?.data ?? []) as LaneInstance[]);
  }, []);

  useEffect(() => {
    if (!paramsValid) {
      setLoading(false);
      return;
    }
    loadInstances()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [paramsValid, loadInstances]);

  // Auto-poll while a freshly launched agent is still provisioning.
  const anyPending = useMemo(() => instances.some((i) => PENDING_STATES.has((i.status || "").toLowerCase())), [instances]);
  useEffect(() => {
    if (!paramsValid || !anyPending) return;
    const t = setInterval(() => {
      loadInstances().catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [paramsValid, anyPending, loadInstances]);

  const launchNew = useCallback(async () => {
    setBusy("launch");
    setError(null);
    try {
      const res = await fetch("/api/workspace-cloud/instances", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Workspace Cloud Agent" }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 402 || res.status === 403) {
        setNeedsSubscription(true);
        throw new Error(body?.error || "A Workspace Cloud subscription is required.");
      }
      if (!res.ok) throw new Error(body?.error || "Failed to launch");
      await loadInstances();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [loadInstances]);

  const subscribe = useCallback(async (plan: "ws_cloud_pro" | "ws_cloud_power") => {
    setBusy(`sub:${plan}`);
    setError(null);
    try {
      const res = await fetch("/api/workspace-cloud/billing/subscribe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, cadence: "monthly" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.data?.url) throw new Error(body?.error || "Could not start checkout");
      window.location.href = body.data.url as string;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }, []);

  const connect = useCallback(
    async (instanceId: string) => {
      setBusy(`connect:${instanceId}`);
      setError(null);
      try {
        const res = await fetch("/api/workspace-cloud/handoff", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instanceId, challenge }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || "Failed to start handoff");
        const code = body?.data?.code as string;
        const url = new URL(callback);
        url.searchParams.set("code", code);
        url.searchParams.set("state", state);
        setConnecting(true);
        window.location.href = url.toString();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(null);
      }
    },
    [callback, challenge, state]
  );

  /* ── invalid link ─────────────────────────────────────────────────────── */
  if (!paramsValid) {
    return (
      <div className="wcc-shell">
        <style dangerouslySetInnerHTML={{ __html: SCOPED_CSS }} />
        <div className="wcc-card wcc-in" style={{ maxWidth: 480, width: "100%", padding: "clamp(2rem, 6vw, 3rem)", textAlign: "center" }}>
          <div style={{ width: 54, height: 54, margin: "0 auto 1.25rem", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.05)", color: "#ef4444" }}>
            <AlertTriangle size={24} />
          </div>
          <h1 className="serif" style={{ fontSize: "1.6rem", fontWeight: 400, marginBottom: 12 }}>Invalid connection link</h1>
          <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.65 }}>
            This page must be opened from the Hermes Workspace app. The link is missing required
            parameters or points at a non-local callback.
          </p>
        </div>
      </div>
    );
  }

  /* ── connecting ───────────────────────────────────────────────────────── */
  if (connecting) {
    return (
      <div className="wcc-shell">
        <style dangerouslySetInnerHTML={{ __html: SCOPED_CSS }} />
        <div className="wcc-card wcc-in" style={{ maxWidth: 480, width: "100%", padding: "clamp(2.5rem, 7vw, 4rem)", textAlign: "center" }}>
          <div style={{ width: 54, height: 54, margin: "0 auto 1.5rem", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", background: "rgba(255, 44, 45,0.06)", color: "var(--gold-leaf)" }}>
            <Loader2 size={24} style={{ animation: "spin 1s linear infinite" }} />
          </div>
          <h1 className="serif" style={{ fontSize: "1.6rem", fontWeight: 400, marginBottom: 12 }}>Linking your Workspace…</h1>
          <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.65 }}>
            Returning you to the Hermes Workspace app. You can close this tab if it doesn&apos;t
            redirect automatically.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="wcc-shell">
      <style dangerouslySetInnerHTML={{ __html: SCOPED_CSS }} />
      <div style={{ maxWidth: 560, width: "100%" }}>
        <Brand />

        <p className="mono" style={{ ...monoLabel, fontSize: 10, color: "var(--gold-leaf)", marginBottom: 12 }}>Secure Handoff</p>
        <h1 className="serif" style={{ fontSize: "clamp(1.9rem, 6vw, 2.6rem)", fontWeight: 400, lineHeight: 1.1, marginBottom: 14 }}>Connect a cloud agent</h1>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 8 }}>
          Pick a running Workspace Cloud agent to link to this device — your local Hermes Workspace
          will be pointed at it securely.
        </p>
        <p style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: "2rem" }}>
          <Sparkles size={13} style={{ color: "var(--gold-leaf)", flexShrink: 0, marginTop: 3 }} />
          <span>Your model &amp; API key from Hermes Workspace are used — nothing secret is stored in the app.</span>
        </p>

        {error && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.05)", color: "#ef4444", fontSize: 13, marginBottom: "1.5rem" }}>
            <AlertTriangle size={15} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="wcc-card" style={{ padding: "2.5rem", textAlign: "center" }}>
            <Loader2 size={20} style={{ animation: "spin 1s linear infinite", opacity: 0.4 }} />
          </div>
        ) : (
          <>
            {/* agent list */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: "1.25rem" }}>
              {instances.map((inst) => {
                const meta = statusMeta(inst.status);
                const running = RUNNING_STATES.has((inst.status || "").toLowerCase());
                const pending = PENDING_STATES.has((inst.status || "").toLowerCase());
                return (
                  <div key={inst.id} className="wcc-card wcc-agent wcc-in" style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px" }}>
                    <div style={{ width: 40, height: 40, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", background: "rgba(255, 44, 45,0.06)", color: "var(--gold-leaf)" }}>
                      <Bot size={19} />
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="serif" style={{ fontSize: "1.05rem", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inst.name}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 3 }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: meta.color, boxShadow: meta.glow, ...(pending ? { animation: "pulse-soft 1.8s ease-in-out infinite" } : {}) }} />
                        <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", opacity: 0.6 }}>{pending ? "Setting up…" : meta.label}</span>
                      </div>
                    </div>
                    <PanelButton
                      icon={<Link2 size={13} />}
                      label={running ? "Connect" : pending ? "Starting" : "Unavailable"}
                      tone={running ? "solid" : "ghost"}
                      busy={busy === `connect:${inst.id}`}
                      disabled={!running || !!busy}
                      onClick={() => connect(inst.id)}
                    />
                  </div>
                );
              })}

              {instances.length === 0 && (
                <div className="wcc-card" style={{ padding: "2rem", textAlign: "center" }}>
                  <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>No cloud agents yet — launch one to connect.</p>
                </div>
              )}
            </div>

            {/* subscribe paywall */}
            {needsSubscription && (
              <div className="wcc-card wcc-in" style={{ padding: "1.5rem", marginBottom: "1.25rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                  <Lock size={16} style={{ color: "var(--gold-leaf)" }} />
                  <span className="serif" style={{ fontSize: "1.15rem", fontWeight: 500 }}>Subscribe to launch a cloud agent</span>
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <PanelButton icon={<Sparkles size={13} />} label="Pro · $9.99/mo" tone="solid" busy={busy === "sub:ws_cloud_pro"} disabled={!!busy} onClick={() => subscribe("ws_cloud_pro")} full />
                  <PanelButton icon={<Sparkles size={13} />} label="Power · $19.99/mo" tone="ghost" busy={busy === "sub:ws_cloud_power"} disabled={!!busy} onClick={() => subscribe("ws_cloud_power")} full />
                </div>
              </div>
            )}

            {/* actions */}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <PanelButton icon={<Plus size={14} />} label={busy === "launch" ? "Launching…" : "Launch new agent"} tone={instances.length === 0 ? "solid" : "ghost"} busy={busy === "launch"} disabled={!!busy} onClick={launchNew} />
              <button type="button" onClick={() => loadInstances().catch((e) => setError(String(e)))} disabled={!!busy} className="wcc-btn" title="Refresh" style={{ width: 40, height: 40, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", background: "transparent", color: "var(--ink-black)", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.4 : 1 }}>
                <RefreshCw size={14} />
              </button>
              {instances.some((i) => RUNNING_STATES.has((i.status || "").toLowerCase())) && (
                <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
                  <ArrowRight size={13} /> Pick an agent above
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ConnectClient() {
  return (
    <Suspense
      fallback={
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--vellum-bg)", color: "var(--ink-black)" }}>
          <Loader2 size={20} style={{ animation: "spin 1s linear infinite", opacity: 0.4 }} />
        </div>
      }
    >
      <ConnectInner />
    </Suspense>
  );
}
