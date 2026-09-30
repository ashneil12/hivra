"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Network, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { useReportManageFeedback, type ManageFeedback } from "./ManageLayout";

type Connection = {
  state: "connected" | "disconnected" | "unknown" | "error";
  machineName?: string | null;
  magicDnsName?: string | null;
  tailnetName?: string | null;
  loginServer: string;
  ipv4?: string | null;
  ipv6?: string | null;
  observedAt: string;
};

const DEFAULT_SERVER = "https://controlplane.tailscale.com";
const PANEL_CSS = `@media (max-width: 767px) { .private-access-actions > button { flex: 1 1 140px; justify-content: center; } }`;

type UnsupportedReason = "not_eligible" | "not_bound" | "operation_in_progress" | "not_running" | "not_ready";

// Why the server won't connect this computer right now (the GET's reason).
const UNSUPPORTED_COPY: Record<UnsupportedReason, string> = {
  not_eligible: "A private network is available on Ubuntu computers on Hivra Cloud and My server.",
  not_bound: "A private network isn't available for this computer. It was created before Hivra recorded ownership checks.",
  operation_in_progress: "Wait for the current operation to finish, then connect.",
  not_running: "Start this computer to connect it to a private network.",
  not_ready: "Wait for this computer to finish starting, then connect.",
};
const UNSUPPORTED_FALLBACK = "Private access needs a running Ubuntu computer on Hivra Cloud or My server with no other operation in progress.";

async function readResponse(response: Response): Promise<{
  success?: boolean;
  error?: string;
  data?: { supported?: boolean; reason?: string | null; pending?: boolean; connection?: Connection | null };
}> {
  try { return await response.json(); } catch { return {}; }
}

export function HivraPrivateAccessPanel({ agentId, observedStatus, onFeedbackChange }: {
  agentId: string;
  /** The computer's status; a change (say, it started) checks eligibility again. */
  observedStatus?: string;
  /** A change in progress or a failure, for Manage to show while this section is closed. */
  onFeedbackChange?: (feedback: ManageFeedback) => void;
}) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [supported, setSupported] = useState(true);
  const [reason, setReason] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"connect" | "refresh" | "disconnect" | null>(null);
  const [authKey, setAuthKey] = useState("");
  const [loginServer, setLoginServer] = useState(DEFAULT_SERVER);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Disconnect logs the computer out of the tailnet; reconnecting needs a new key.
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/hivra/agents/${encodeURIComponent(agentId)}/private-access/tailscale`, {
        cache: "no-store", credentials: "same-origin", redirect: "error",
      });
      const body = await readResponse(response);
      if (!response.ok || body.success !== true) throw new Error(body.error || "Private access could not be loaded.");
      setSupported(body.data?.supported === true);
      setReason(typeof body.data?.reason === "string" ? body.data.reason : null);
      setPending(body.data?.pending === true);
      setConnection(body.data?.connection ?? null);
      if (body.data?.connection?.loginServer) setLoginServer(body.data.connection.loginServer);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Private access could not be loaded.");
    } finally { setLoading(false); }
  }, [agentId]);

  useEffect(() => { void load(); }, [load, observedStatus]);

  async function mutate(kind: "connect" | "refresh" | "disconnect") {
    const submittedKey = authKey;
    if (kind === "connect") setAuthKey("");
    setAction(kind);
    setError(null);
    try {
      const response = await fetch(`/api/hivra/agents/${encodeURIComponent(agentId)}/private-access/tailscale`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        redirect: "error",
        body: JSON.stringify(kind === "connect"
          ? { action: kind, authKey: submittedKey, loginServer: advanced ? loginServer : DEFAULT_SERVER }
          : { action: kind }),
      });
      const body = await readResponse(response);
      if (body.data && Object.hasOwn(body.data, "connection")) setConnection(body.data.connection ?? null);
      if (body.data && Object.hasOwn(body.data, "pending")) setPending(body.data.pending === true);
      else if (body.success === true) setPending(false);
      if (!response.ok || body.success !== true) throw new Error(body.error || "Private access could not be changed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Private access could not be changed.");
    } finally { setAction(null); }
  }

  const busy = action !== null;
  const connected = connection?.state === "connected";
  useReportManageFeedback(onFeedbackChange, error ? { kind: "alert", message: error }
    : action && action !== "refresh" ? { kind: "status", message: "Updating private access…" } : null);
  const buttonStyle: React.CSSProperties = {
    border: "1px solid var(--etched-border)", background: "transparent", color: "var(--ink-black)",
    padding: "8px 12px", minHeight: 40, fontSize: 11, fontWeight: 700, cursor: busy ? "default" : "pointer",
    display: "inline-flex", alignItems: "center", gap: 7, opacity: busy ? 0.55 : 1,
  };
  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)",
    color: "var(--ink-black)", padding: "9px 11px", fontFamily: "var(--font-mono), monospace", fontSize: 12,
  };

  return (
    <section id="private-access" aria-labelledby="private-access-title" style={{ marginBottom: 20 }}>
      <style>{PANEL_CSS}</style>
      <div id="private-access-title" className="mono" style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.16em", color: "var(--text-muted)", marginBottom: 10 }}>
        Private access
      </div>
      <div style={{ border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.035)", padding: 18, display: "grid", gap: 14, gridTemplateColumns: "minmax(0, 1fr)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
          <Network size={17} aria-hidden="true" style={{ marginTop: 2, color: connected ? "#22c55e" : "var(--text-muted)" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, color: "var(--ink-black)", fontWeight: 650 }}>Tailscale or Headscale</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55, marginTop: 4 }}>
              Connect an eligible Ubuntu computer to your private network. This creates a private address; it does not publish services, open ports, enable Tailscale SSH, or replace Hivra&apos;s signed-in desktop connection.
            </div>
          </div>
          {loading ? <Loader2 aria-label="Loading private access" size={16} style={{ animation: "spin 1s linear infinite" }} /> : null}
        </div>

        {connection ? (
          <div aria-live="polite" style={{ borderTop: "1px solid var(--etched-border)", paddingTop: 12, display: "grid", gap: 7, fontSize: 12, overflowWrap: "anywhere" }}>
            <div><strong>Status:</strong> {connection.state === "connected" ? "Connected" : connection.state === "unknown" ? "Needs refresh" : connection.state}</div>
            {connection.magicDnsName ? <div><strong>Private name:</strong> <span className="mono">{connection.magicDnsName}</span></div> : null}
            {connection.ipv4 ? <div><strong>Private IPv4:</strong> <span className="mono">{connection.ipv4}</span></div> : null}
            {connection.tailnetName ? <div><strong>Network:</strong> {connection.tailnetName}</div> : null}
            <div style={{ color: "var(--text-muted)" }}>Observed {new Date(connection.observedAt).toLocaleString()}</div>
          </div>
        ) : !loading ? (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No Hivra-managed private connection is saved for this computer.</div>
        ) : null}

        {!connection && supported && !pending ? (
          <div style={{ display: "grid", gap: 10 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 11.5, color: "var(--text-secondary)" }}>
              One-time enrollment key
              <input type="password" autoComplete="off" value={authKey} onChange={event => setAuthKey(event.target.value)}
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
                placeholder="Paste a Tailscale auth key or Headscale preauth key"
                style={inputStyle} />
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11.5, color: "var(--text-muted)" }}>
              <input type="checkbox" checked={advanced} onChange={event => setAdvanced(event.target.checked)} />
              Use a Headscale coordination server
            </label>
            {advanced ? <label style={{ display: "grid", gap: 6, fontSize: 11.5, color: "var(--text-secondary)" }}>
              HTTPS coordination URL
              <input type="url" inputMode="url" value={loginServer} onChange={event => setLoginServer(event.target.value)}
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
                placeholder="https://headscale.example.com"
                style={inputStyle} />
            </label> : null}
            <button type="button" disabled={busy || !authKey.trim()} onClick={() => void mutate("connect")} style={buttonStyle}>
              {action === "connect" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <ShieldCheck size={14} />}
              Connect private network
            </button>
          </div>
        ) : null}

        {!supported && !loading ? <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {pending ? "A private-access change needs a fresh guest observation before another change."
            : reason && Object.prototype.hasOwnProperty.call(UNSUPPORTED_COPY, reason)
              ? UNSUPPORTED_COPY[reason as UnsupportedReason]
              : UNSUPPORTED_FALLBACK}
        </div> : null}

        {connection || pending ? <div className="private-access-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" disabled={busy || (!supported && !pending)} onClick={() => void mutate("refresh")} style={buttonStyle}>
            {action === "refresh" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />} Refresh status
          </button>
          {/* Two-step disconnect: Cancel takes the Disconnect slot so a double tap cannot confirm. */}
          {connection && !pending ? confirmDisconnect
            ? <button type="button" onClick={() => setConfirmDisconnect(false)} style={buttonStyle}>Cancel</button>
            : <button type="button" disabled={busy || !supported} onClick={() => setConfirmDisconnect(true)} style={buttonStyle}>
              {action === "disconnect" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Unplug size={14} />} Disconnect
            </button> : null}
        </div> : null}
        {confirmDisconnect && connection && !pending ? <div style={{ border: "1px solid rgba(192,57,43,0.4)", background: "rgba(192,57,43,0.04)", padding: 12, display: "grid", gap: 10 }}>
          <div style={{ fontSize: 12, color: "var(--ink-black)", lineHeight: 1.5 }}>Disconnect this computer? Reconnecting needs a new one-time enrollment key.</div>
          <div className="private-access-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" disabled={busy || !supported} onClick={() => { setConfirmDisconnect(false); void mutate("disconnect"); }}
              style={{ ...buttonStyle, color: "#e06c5a", borderColor: "rgba(192,57,43,0.5)" }}>
              <Unplug size={14} /> Disconnect computer
            </button>
          </div>
        </div> : null}
        {connection ? <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Disconnect logs this computer out while leaving the local service available for a verified refresh or later reconnect. Your Tailscale or Headscale admin page may retain an offline device record for its own retention period.
        </div> : null}
        {error ? <div role="alert" style={{ fontSize: 12, color: "#e06c5a", lineHeight: 1.5 }}>{error}</div> : null}
      </div>
    </section>
  );
}
