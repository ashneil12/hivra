"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { UserButton } from "@clerk/nextjs";
import {
  AlertTriangle,
  Bot,
  Check,
  Clock,
  Cloud,
  Copy,
  Cpu,
  CreditCard,
  Link2,
  Loader2,
  Lock,
  MemoryStick,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wifi,
  X,
} from "lucide-react";

interface LaneInstance {
  id: string;
  name: string;
  status: string;
  gateway_url?: string | null;
  created_at?: string;
  cpu_limit?: number | null;
  ram_limit?: number | null;
  config?: { model?: string | null } | null;
}

interface LaneStatus {
  subscribed: boolean;
  status: string | null;
  instanceLimit: number;
  instanceCount: number;
  currentPeriodEnd: string | null;
  plan: { key: string; name: string; priceLabel: string } | null;
  offer: { key: string; name: string; priceLabel: string };
}

/* ─────────────────────────────────────────────────────────────────────────
   Hermes Workspace Cloud — single-agent control panel.
   One cloud agent per tier: launch it, connect to it from the Hermes Workspace
   app, manage it here. Self-contained (own billing, no Hivra cross-links).
   Styled to the Hivra "Vellum & Ink" system.
   ──────────────────────────────────────────────────────────────────────── */

const RUNNING_STATES = new Set(["running", "active"]);
const PENDING_STATES = new Set(["provisioning", "pending", "restoring", "archiving"]);
const PAUSED_STATES = new Set(["paused", "stopped", "suspended", "cold_archived"]);

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function statusMeta(status: string) {
  const s = (status || "").toLowerCase();
  if (RUNNING_STATES.has(s)) return { color: "#22c55e", glow: "0 0 10px rgba(34,197,94,0.55)", label: "Running" };
  if (PENDING_STATES.has(s)) return { color: "var(--yellow)", glow: "0 0 9px rgba(212,160,55,0.55)", label: titleCase(s) };
  if (s === "error" || s === "failed") return { color: "#ef4444", glow: "none", label: titleCase(s) };
  if (PAUSED_STATES.has(s)) return { color: "#9ca3af", glow: "none", label: s === "cold_archived" ? "Archived" : titleCase(s) };
  return { color: "#9ca3af", glow: "none", label: status ? titleCase(s) : "Unknown" };
}

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

function hostOf(url?: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function networkOf(url?: string | null): string {
  const host = hostOf(url);
  const parts = host.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : host || "hermesos.cloud";
}

function isPending(status: string): boolean {
  return PENDING_STATES.has((status || "").toLowerCase());
}

const monoLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono), 'Space Mono', monospace",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.22em",
  fontWeight: 700,
};

const SCOPED_CSS = `
.wc-shell { min-height: 100vh; background: var(--vellum-bg); color: var(--ink-black); }
.wc-card { background: var(--bg-surface); border: 1px solid var(--etched-border); box-shadow: 0 4px 20px -5px rgba(0,0,0,0.05); }
.wc-btn { transition: all .2s ease; }
.wc-btn:hover:not(:disabled) { border-color: var(--ink-black); }
.wc-btn-solid:hover:not(:disabled) { opacity: .86; letter-spacing: .14em; }
.wc-btn-danger:hover:not(:disabled) { background: rgba(239,68,68,0.08); }
.wc-link { transition: color .2s ease, opacity .2s ease; }
.wc-link:hover { color: var(--ink-black); opacity: 1 !important; }
.wc-chip { transition: border-color .2s ease, color .2s ease; }
.wc-chip:hover { border-color: var(--gold-leaf); }
.wc-in { animation: wc-fade-up .5s cubic-bezier(.16,1,.3,1) both; }
@keyframes wc-fade-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.wc-overlay { animation: wc-fade .2s ease both; }
.wc-modal { animation: wc-pop .28s cubic-bezier(.16,1,.3,1) both; }
.wc-toast { animation: wc-slide .3s cubic-bezier(.16,1,.3,1) both; }
@keyframes wc-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes wc-pop { from { opacity: 0; transform: translateY(14px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes wc-slide { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: translateX(0); } }
@keyframes wc-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
.wc-prov { background: linear-gradient(90deg, rgba(212,160,55,0.06) 0%, rgba(212,160,55,0.16) 50%, rgba(212,160,55,0.06) 100%); background-size: 200% 100%; animation: wc-shimmer 1.8s linear infinite; }
@media (prefers-reduced-motion: reduce) { .wc-in, .wc-overlay, .wc-modal, .wc-toast, .wc-prov { animation: none; } }
@media (pointer: coarse) { .wc-btn { min-height: 44px; min-width: 44px; } }
@media (max-width: 480px) { .wc-toasts { left: 16px; right: 16px !important; max-width: none !important; } }
`;

/* ── primitive button ───────────────────────────────────────────────────── */

type Tone = "ghost" | "solid" | "danger";

function PanelButton({
  icon,
  label,
  onClick,
  disabled,
  busy,
  tone = "ghost",
  full,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: Tone;
  full?: boolean;
}) {
  const toneStyle: React.CSSProperties =
    tone === "solid"
      ? { background: "var(--ink-black)", color: "var(--bg-surface)", borderColor: "var(--ink-black)" }
      : tone === "danger"
        ? { background: "transparent", color: "#ef4444", borderColor: "rgba(239,68,68,0.5)" }
        : { background: "transparent", color: "var(--ink-black)", borderColor: "var(--etched-border)" };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`wc-btn ${tone === "solid" ? "wc-btn-solid" : tone === "danger" ? "wc-btn-danger" : ""}`}
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

/* ── toasts ─────────────────────────────────────────────────────────────── */

interface Toast { id: number; kind: "success" | "error"; text: string }

function ToastStack({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="wc-toasts" style={{ position: "fixed", right: 18, bottom: "calc(18px + env(safe-area-inset-bottom, 0px))", zIndex: 10000, display: "flex", flexDirection: "column", gap: 10, maxWidth: 360 }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className="wc-toast"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "11px 14px",
            background: "var(--bg-surface)",
            border: `1px solid ${t.kind === "error" ? "rgba(239,68,68,0.4)" : "rgba(34,197,94,0.4)"}`,
            boxShadow: "0 10px 30px -8px rgba(0,0,0,0.3)",
            color: "var(--ink-black)",
            fontSize: 13,
          }}
        >
          {t.kind === "error" ? <AlertTriangle size={15} style={{ color: "#ef4444", flexShrink: 0 }} /> : <Check size={15} style={{ color: "var(--green)", flexShrink: 0 }} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/* ── launch modal ───────────────────────────────────────────────────────── */

function LaunchModal({ onClose, onLaunch, busy }: { onClose: () => void; onLaunch: (name: string) => void; busy: boolean }) {
  const [name, setName] = useState("Workspace Cloud Agent");
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const inputId = useId();
  useEffect(() => {
    // On touch screens focusing the field would open the keyboard over a prefilled
    // name; focus the dialog itself so screen readers still move into it.
    if (window.matchMedia("(pointer: coarse)").matches) modalRef.current?.focus();
    else inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="wc-overlay" onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)", backdropFilter: "blur(4px)", padding: 16 }}>
      <div ref={modalRef} className="wc-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={(e) => e.stopPropagation()} style={{ background: "var(--bg-surface)", border: "1px solid var(--etched-border)", width: 460, maxWidth: "94vw", maxHeight: "calc(100dvh - 32px)", overflowY: "auto", boxShadow: "0 24px 50px rgba(0,0,0,0.28)", outline: "none" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--etched-border)" }}>
          <h3 id={titleId} className="serif" style={{ fontSize: "1.3rem", fontWeight: 500 }}>Launch your cloud agent</h3>
          <button type="button" onClick={onClose} className="wc-btn" aria-label="Close" style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>
            <X size={15} />
          </button>
        </div>
        <div style={{ padding: 20 }}>
          <label htmlFor={inputId} className="mono" style={{ ...monoLabel, fontSize: 9, opacity: 0.55, display: "block", marginBottom: 8 }}>Agent name</label>
          <input
            id={inputId}
            ref={inputRef}
            value={name}
            enterKeyHint="go"
            autoCapitalize="words"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && onLaunch(name.trim())}
            maxLength={60}
            style={{ width: "100%", padding: "11px 13px", border: "1px solid var(--etched-border)", background: "var(--bg-elevated)", color: "var(--ink-black)", fontSize: 14, outline: "none" }}
          />
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 16, padding: "11px 13px", border: "1px solid var(--etched-border)", background: "rgba(255, 44, 45,0.05)" }}>
            <Sparkles size={14} style={{ color: "var(--gold-leaf)", flexShrink: 0, marginTop: 2 }} />
            <span style={{ fontSize: 12, lineHeight: 1.6, color: "var(--text-secondary)" }}>
              Provisions a fresh Hermes agent on the Workspace Cloud lane. Boot + setup takes a few minutes; connect to it from the Hermes Workspace app once it&apos;s running.
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
            <PanelButton label="Cancel" tone="ghost" onClick={onClose} />
            <PanelButton icon={<Plus size={14} />} label={busy ? "Launching…" : "Launch agent"} tone="solid" busy={busy} disabled={!name.trim()} onClick={() => onLaunch(name.trim())} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── paywall (paid plans only — no free tier on the cloud lane) ──────────── */

function Paywall({ offer, onSubscribe, busy }: { offer: LaneStatus["offer"]; onSubscribe: () => void; busy: boolean }) {
  return (
    <div className="wc-card wc-in" style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "clamp(2.5rem, 8vw, 4rem) 2rem" }}>
      <div style={{ width: 60, height: 60, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", background: "rgba(255, 44, 45,0.06)", color: "var(--gold-leaf)", marginBottom: "1.5rem" }}>
        <Lock size={26} />
      </div>
      <h2 className="serif" style={{ fontSize: "clamp(1.4rem, 5vw, 1.9rem)", fontWeight: 400, marginBottom: 12 }}>Subscribe to Workspace Cloud</h2>
      <p style={{ fontSize: 13.5, color: "var(--text-secondary)", maxWidth: 420, lineHeight: 1.65, marginBottom: "1.5rem" }}>
        Run a dedicated cloud Hermes agent and connect to it from the Hermes Workspace app — chat from anywhere, on any device.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: "1.75rem", textAlign: "left" }}>
        {["One dedicated cloud agent, always on", "Connect securely from the Workspace app", "Pause, restart & manage anytime"].map((f) => (
          <span key={f} style={{ display: "inline-flex", alignItems: "center", gap: 9, fontSize: 13, color: "var(--text-secondary)" }}>
            <Check size={14} style={{ color: "var(--green)", flexShrink: 0 }} /> {f}
          </span>
        ))}
      </div>
      <div style={{ display: "inline-flex", alignItems: "baseline", gap: 8, marginBottom: "1.25rem" }}>
        <span className="serif" style={{ fontSize: "1.6rem", fontWeight: 500 }}>{offer.name}</span>
        {offer.priceLabel && <span className="mono" style={{ fontSize: 12, opacity: 0.6 }}>{offer.priceLabel}</span>}
      </div>
      <PanelButton icon={<Sparkles size={14} />} label={busy ? "Redirecting…" : "Subscribe"} tone="solid" busy={busy} onClick={onSubscribe} />
    </div>
  );
}

/* ── single-agent info row ──────────────────────────────────────────────── */

function InfoRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "11px 0", borderBottom: "1px solid var(--etched-border)" }}>
      <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.14em", opacity: 0.5, display: "inline-flex", alignItems: "center", gap: 7 }}>
        <span style={{ color: "var(--gold-leaf)" }}>{icon}</span> {label}
      </span>
      <span style={{ fontSize: 13, textAlign: "right", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{children}</span>
    </div>
  );
}

/* ── the single agent panel ─────────────────────────────────────────────── */

function AgentPanel({
  inst,
  busy,
  onPower,
  onDelete,
  onRename,
  onCopy,
}: {
  inst: LaneInstance;
  busy: string | null;
  onPower: (id: string, action: "start" | "stop" | "reboot") => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => Promise<boolean>;
  onCopy: (url: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(inst.name);
  const [confirming, setConfirming] = useState(false);
  const [health, setHealth] = useState<{ loading: boolean; healthy?: boolean; latencyMs?: number } | null>(null);

  const meta = statusMeta(inst.status);
  const running = RUNNING_STATES.has((inst.status || "").toLowerCase());
  const pending = isPending(inst.status);
  const isBusy = (a: string) => busy === `${inst.id}:${a}`;
  const anyBusy = Boolean(busy && busy.startsWith(`${inst.id}:`));
  const model = inst.config?.model || "Set from the Workspace app";

  const checkHealth = useCallback(async () => {
    setHealth({ loading: true });
    try {
      const res = await fetch(`/api/workspace-cloud/instances/${inst.id}/health`, { credentials: "include" });
      const d = (await res.json().catch(() => ({})))?.data ?? {};
      setHealth({ loading: false, healthy: !!d.healthy, latencyMs: d.latencyMs });
    } catch {
      setHealth({ loading: false, healthy: false });
    }
  }, [inst.id]);

  const [code, setCode] = useState<string | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [codeErr, setCodeErr] = useState<string | null>(null);

  const mintCode = useCallback(async () => {
    setCodeBusy(true);
    setCodeErr(null);
    try {
      const res = await fetch("/api/workspace-cloud/handoff", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceId: inst.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.data?.code) throw new Error(body?.error || "Couldn't create a code");
      setCode(body.data.code as string);
      setCodeCopied(false);
    } catch (e) {
      setCodeErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCodeBusy(false);
    }
  }, [inst.id]);

  const copyCode = useCallback(() => {
    if (!code) return;
    void navigator.clipboard?.writeText(code).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1800);
    });
  }, [code]);

  return (
    <div className="wc-card wc-in" style={{ padding: "clamp(1.25rem, 4vw, 2rem)" }}>
      {/* header: identity + status */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: "1.5rem" }}>
        <div style={{ width: 52, height: 52, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", background: "rgba(255, 44, 45,0.06)", color: "var(--gold-leaf)" }}>
          <Bot size={26} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          {editing ? (
            <div style={{ display: "flex", gap: 8 }}>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} style={{ flex: 1, minWidth: 0, padding: "8px 11px", border: "1px solid var(--gold-leaf)", background: "var(--bg-elevated)", color: "var(--ink-black)", fontSize: 16, outline: "none" }} />
              <PanelButton label="Save" tone="solid" busy={isBusy("rename")} disabled={!name.trim() || name.trim() === inst.name} onClick={async () => { if (await onRename(inst.id, name.trim())) setEditing(false); }} />
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <h2 className="serif" style={{ fontSize: "clamp(1.4rem, 4vw, 1.8rem)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inst.name}</h2>
              <button type="button" onClick={() => { setName(inst.name); setEditing(true); }} className="wc-btn" title="Rename" style={{ width: 28, height: 28, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>
                <Pencil size={12} />
              </button>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: meta.color, boxShadow: meta.glow, ...(pending ? { animation: "pulse-soft 1.8s ease-in-out infinite" } : {}) }} />
            <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", opacity: 0.75 }}>{meta.label}</span>
            <span className="mono" style={{ fontSize: 10, opacity: 0.4 }}>· ID {inst.id.split("-")[0]}</span>
          </div>
        </div>
      </div>

      {pending && (
        <div className="wc-prov" style={{ padding: "10px 13px", marginBottom: "1.5rem", border: "1px solid rgba(255, 44, 45,0.25)", display: "flex", alignItems: "center", gap: 8 }}>
          <Loader2 size={13} style={{ animation: "spin 1s linear infinite", color: "var(--gold-leaf)" }} />
          <span className="mono" style={{ fontSize: 11, letterSpacing: "0.04em", color: "var(--text-secondary)" }}>Setting up your agent — this takes a few minutes…</span>
        </div>
      )}

      {/* info grid */}
      <div style={{ marginBottom: "1.5rem" }}>
        <InfoRow icon={<Sparkles size={12} />} label="Model">{model}</InfoRow>
        <InfoRow icon={<Cpu size={12} />} label="vCPU">{inst.cpu_limit ? `${inst.cpu_limit}` : "—"}</InfoRow>
        <InfoRow icon={<MemoryStick size={12} />} label="Memory">{inst.ram_limit ? `${Math.round(inst.ram_limit / 1024)} GB` : "—"}</InfoRow>
        <InfoRow icon={<Cloud size={12} />} label="Region">wrk1 · {networkOf(inst.gateway_url)}</InfoRow>
        <InfoRow icon={<Clock size={12} />} label="Created">{inst.created_at ? relativeTime(inst.created_at) : "—"}</InfoRow>
        <InfoRow icon={<Wifi size={12} />} label="Agent health">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {health == null ? (
              <span style={{ opacity: 0.6 }}>—</span>
            ) : health.loading ? (
              <span style={{ opacity: 0.6 }}>Pinging…</span>
            ) : health.healthy ? (
              <span style={{ color: "var(--green)" }}>Responding{health.latencyMs != null ? ` · ${health.latencyMs}ms` : ""}</span>
            ) : (
              <span style={{ color: "#ef4444" }}>Not responding</span>
            )}
            <button type="button" onClick={checkHealth} disabled={!!health?.loading} className="wc-btn" title="Check health" style={{ width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>
              <RefreshCw size={11} style={health?.loading ? { animation: "spin 1s linear infinite" } : undefined} />
            </button>
          </span>
        </InfoRow>
      </div>

      {/* gateway */}
      {hostOf(inst.gateway_url) && (
        <button type="button" onClick={() => inst.gateway_url && onCopy(inst.gateway_url)} className="wc-chip" title="Copy gateway URL" style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "10px 12px", border: "1px solid var(--etched-border)", background: "var(--bg-elevated)", cursor: "pointer", marginBottom: "1.5rem" }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textAlign: "left" }}>{inst.gateway_url}</span>
          <Copy size={13} style={{ opacity: 0.5 }} />
        </button>
      )}

      {/* connect to Workspace — paste-a-code pairing */}
      <div style={{ padding: "14px 16px", border: "1px solid var(--etched-border)", background: "rgba(255, 44, 45,0.04)", marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Link2 size={15} style={{ color: "var(--gold-leaf)" }} />
          <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 700 }}>Connect to Workspace</span>
        </div>
        {code ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", border: "1px solid var(--etched-border)", background: "var(--bg-surface)" }}>
              <code className="mono" style={{ fontSize: 13, letterSpacing: "0.03em", color: "var(--ink-black)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{code}</code>
              <button type="button" onClick={copyCode} title="Copy code" className="wc-btn" style={{ width: 30, height: 30, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", background: "transparent", color: codeCopied ? "var(--green)" : "var(--text-muted)", cursor: "pointer" }}>
                {codeCopied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 8, lineHeight: 1.6 }}>
              Paste this into the <span style={{ color: "var(--ink-black)", fontWeight: 600 }}>Hermes Workspace app</span> to link this agent. Expires in 5 minutes · single use.
            </p>
            <button type="button" onClick={mintCode} disabled={codeBusy} className="wc-link mono" style={{ ...monoLabel, fontSize: 9, marginTop: 8, background: "none", border: "none", color: "var(--ink-black)", opacity: 0.55, cursor: codeBusy ? "default" : "pointer", padding: 0 }}>
              {codeBusy ? "Generating…" : "↻ Generate new code"}
            </button>
          </>
        ) : (
          <>
            <p style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 12 }}>
              Generate a one-time code and paste it into the Hermes Workspace app to connect to this agent. Your model key is applied to the agent securely.
            </p>
            <PanelButton icon={<Link2 size={13} />} label={codeBusy ? "Generating…" : "Get connection code"} tone="solid" busy={codeBusy} onClick={mintCode} />
          </>
        )}
        {codeErr && <p style={{ fontSize: 11.5, color: "#ef4444", marginTop: 8 }}>{codeErr}</p>}
      </div>

      {/* controls */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {running ? (
          <PanelButton icon={<Pause size={13} />} label="Pause" busy={isBusy("stop")} disabled={anyBusy || pending} onClick={() => onPower(inst.id, "stop")} />
        ) : (
          <PanelButton icon={<Play size={13} />} label="Start" busy={isBusy("start")} disabled={anyBusy || pending} onClick={() => onPower(inst.id, "start")} />
        )}
        <PanelButton icon={<RotateCcw size={13} />} label="Restart" busy={isBusy("reboot")} disabled={anyBusy || pending} onClick={() => onPower(inst.id, "reboot")} />
      </div>

      {/* danger zone */}
      <div style={{ borderTop: "1px dashed rgba(239,68,68,0.3)", paddingTop: "1.25rem", marginTop: "1.5rem" }}>
        <h4 className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", color: "#ef4444", marginBottom: 12 }}>Danger zone</h4>
        {confirming ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>This permanently destroys the VM and its data, and frees your one agent slot. This cannot be undone.</span>
            <div style={{ display: "flex", gap: 8 }}>
              <PanelButton label="Cancel" tone="ghost" onClick={() => setConfirming(false)} />
              <PanelButton icon={<Trash2 size={13} />} label="Delete agent" tone="danger" busy={isBusy("delete")} onClick={() => onDelete(inst.id)} />
            </div>
          </div>
        ) : (
          <PanelButton icon={<Trash2 size={13} />} label="Delete this agent" tone="danger" disabled={anyBusy} onClick={() => setConfirming(true)} />
        )}
      </div>
    </div>
  );
}

/* ── main ───────────────────────────────────────────────────────────────── */

export function DashboardClient() {
  const [instances, setInstances] = useState<LaneInstance[]>([]);
  const [status, setStatus] = useState<LaneStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  const copy = useCallback(
    (url: string) => {
      void navigator.clipboard?.writeText(url).then(
        () => toast("success", "Gateway URL copied"),
        () => toast("error", "Couldn't copy")
      );
    },
    [toast]
  );

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace-cloud/status", { credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (res.ok) setStatus(body?.data as LaneStatus);
    } catch {
      /* non-fatal */
    }
  }, []);

  const load = useCallback(async (soft = false) => {
    if (soft) setRefreshing(true);
    try {
      const res = await fetch("/api/workspace-cloud/instances", { credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Failed to load");
      setInstances((body?.data ?? []) as LaneInstance[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadStatus();
  }, [load, loadStatus]);

  const agent = instances[0] ?? null;
  const anyPending = useMemo(() => instances.some((i) => isPending(i.status)), [instances]);
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(() => {
      void load(true);
      void loadStatus();
    }, 5000);
    return () => clearInterval(t);
  }, [anyPending, load, loadStatus]);

  const power = useCallback(
    async (id: string, action: "start" | "stop" | "reboot") => {
      setBusy(`${id}:${action}`);
      setError(null);
      try {
        const res = await fetch(`/api/workspace-cloud/instances/${id}/power`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Action failed");
        toast("success", action === "stop" ? "Agent paused" : action === "start" ? "Agent starting" : "Agent restarting");
        await load(true);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        setError(m);
        toast("error", m);
      } finally {
        setBusy(null);
      }
    },
    [load, toast]
  );

  const launch = useCallback(
    async (name: string) => {
      setBusy("launch");
      setError(null);
      try {
        const res = await fetch("/api/workspace-cloud/instances", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 402 || res.status === 403) {
          setLaunchOpen(false);
          await loadStatus();
          const m = body?.error || "A Workspace Cloud subscription is required.";
          setError(m);
          toast("error", m);
          return;
        }
        if (!res.ok) throw new Error(body?.error || "Launch failed");
        setLaunchOpen(false);
        toast("success", "Agent launching — provisioning now");
        await load(true);
        await loadStatus();
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        setError(m);
        toast("error", m);
      } finally {
        setBusy(null);
      }
    },
    [load, loadStatus, toast]
  );

  const subscribe = useCallback(async () => {
    setSubscribing(true);
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
      const m = e instanceof Error ? e.message : String(e);
      setError(m);
      toast("error", m);
      setSubscribing(false);
    }
  }, [status, toast]);

  const rename = useCallback(
    async (id: string, name: string): Promise<boolean> => {
      setBusy(`${id}:rename`);
      try {
        const res = await fetch(`/api/workspace-cloud/instances/${id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Rename failed");
        toast("success", "Agent renamed");
        await load(true);
        return true;
      } catch (e) {
        toast("error", e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load, toast]
  );

  const destroy = useCallback(
    async (id: string) => {
      setBusy(`${id}:delete`);
      setError(null);
      try {
        const res = await fetch(`/api/workspace-cloud/instances/${id}`, {
          method: "DELETE",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Delete failed");
        toast("success", "Agent deleted");
        await load(true);
        await loadStatus();
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        setError(m);
        toast("error", m);
      } finally {
        setBusy(null);
      }
    },
    [load, loadStatus, toast]
  );

  const notSubscribed = status != null && !status.subscribed;
  const renewLabel = status?.currentPeriodEnd ? new Date(status.currentPeriodEnd).toLocaleDateString() : null;

  return (
    <div className="wc-shell">
      <style dangerouslySetInnerHTML={{ __html: SCOPED_CSS }} />

      {/* top brand bar */}
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
          <a href="/workspace-cloud/billing" className="wc-link mono" style={{ ...monoLabel, fontSize: 10, opacity: 0.6, textDecoration: "none", color: "var(--ink-black)", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <CreditCard size={13} /> Billing
          </a>
          <UserButton />
        </div>
      </header>

      <main style={{ maxWidth: 720, margin: "0 auto", padding: "clamp(2rem, 6vw, 3.5rem) clamp(1rem, 5vw, 2.5rem) 4rem" }}>
        {/* hero */}
        <div style={{ marginBottom: "2.5rem" }}>
          <p className="mono" style={{ ...monoLabel, fontSize: 10, color: "var(--gold-leaf)", marginBottom: 12 }}>Cloud Control</p>
          <h1 className="serif" style={{ fontSize: "clamp(2.2rem, 7vw, 3.4rem)", fontWeight: 400, lineHeight: 1.05, letterSpacing: "-0.01em" }}>Workspace Cloud</h1>
          <p style={{ marginTop: 14, fontSize: 14, color: "var(--text-secondary)", maxWidth: 460, lineHeight: 1.6 }}>
            Your cloud Hermes agent. Connect to it from the Hermes Workspace app — manage, pause, and restart it here.
          </p>
          {status?.subscribed && status.plan && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: 16, padding: "5px 11px", border: "1px solid var(--etched-border)", background: "rgba(255, 44, 45,0.05)" }}>
              <ShieldCheck size={13} style={{ color: "var(--gold-leaf)" }} />
              <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.75 }}>
                {status.plan.name}
                {renewLabel ? ` · renews ${renewLabel}` : ""}
              </span>
            </div>
          )}
        </div>

        {error && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.05)", color: "#ef4444", fontSize: 13, marginBottom: "1.75rem" }}>
            <AlertTriangle size={15} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}

        {notSubscribed ? (
          <Paywall offer={status.offer} onSubscribe={subscribe} busy={subscribing} />
        ) : loading ? (
          <div className="wc-card" style={{ minHeight: 280, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Loader2 size={20} style={{ animation: "spin 1s linear infinite", opacity: 0.4 }} />
          </div>
        ) : agent ? (
          <AgentPanel inst={agent} busy={busy} onPower={power} onDelete={destroy} onRename={rename} onCopy={copy} />
        ) : (
          <div className="wc-card wc-in" style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "clamp(2.5rem, 8vw, 4.5rem) 2rem" }}>
            <div style={{ width: 60, height: 60, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", background: "rgba(255, 44, 45,0.06)", color: "var(--gold-leaf)", marginBottom: "1.5rem" }}>
              <Cloud size={26} />
            </div>
            <h2 className="serif" style={{ fontSize: "clamp(1.3rem, 5vw, 1.7rem)", fontWeight: 400, marginBottom: 10 }}>Launch your cloud agent</h2>
            <p style={{ fontSize: 13.5, color: "var(--text-secondary)", maxWidth: 380, lineHeight: 1.65, marginBottom: "1.75rem" }}>
              Spin up your dedicated cloud Hermes agent, then connect to it from the Hermes Workspace app to chat from anywhere.
            </p>
            <PanelButton icon={<Plus size={14} />} label="Launch agent" tone="solid" disabled={!!busy} onClick={() => setLaunchOpen(true)} />
          </div>
        )}

        {/* footer */}
        <footer style={{ marginTop: "3rem", paddingTop: "1.75rem", borderTop: "1px solid var(--etched-border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <span className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", opacity: 0.4, textTransform: "uppercase" }}>Hermes Workspace Cloud</span>
          <a href="/workspace-cloud/billing" className="wc-link mono" style={{ ...monoLabel, fontSize: 10, textDecoration: "none", color: "var(--ink-black)", opacity: 0.6, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <CreditCard size={13} /> Manage billing
          </a>
        </footer>
      </main>

      {launchOpen && <LaunchModal onClose={() => setLaunchOpen(false)} onLaunch={launch} busy={busy === "launch"} />}
      <ToastStack toasts={toasts} />
    </div>
  );
}
