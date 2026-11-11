"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Network, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import {
  buildPrivateNetworkPolicy,
  HIVRA_TAILNET_TAG,
  isPrivateNetworkV2Enabled,
  NETBIRD_POLICY_STEPS,
  TAILSCALE_MIN_VERSION,
  type PrivateNetworkProvider,
} from "@/lib/hivra/private-network";
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
  /** Present on a fresh check (connect or refresh), not on the saved copy. */
  provider?: "tailscale" | "netbird";
  visiblePeerCount?: number;
  canSeeOtherDevices?: boolean;
  taggedHivra?: boolean;
};

const DEFAULT_SERVER = "https://controlplane.tailscale.com";
const PANEL_CSS = `@media (max-width: 767px) { .private-access-actions > button { flex: 1 1 140px; justify-content: center; } }`;

const PROVIDER_LABEL: Record<PrivateNetworkProvider, string> = {
  tailscale: "Tailscale", headscale: "Headscale", netbird: "NetBird",
};

function inferProvider(connection: Connection): PrivateNetworkProvider {
  if (connection.provider === "netbird") return "netbird";
  if (connection.loginServer === DEFAULT_SERVER) return "tailscale";
  try {
    if (new URL(connection.loginServer).hostname.endsWith("netbird.io")) return "netbird";
  } catch { /* fall through */ }
  return "headscale";
}

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
  const v2 = isPrivateNetworkV2Enabled();
  const [provider, setProvider] = useState<PrivateNetworkProvider>("tailscale");
  const [netbirdServer, setNetbirdServer] = useState("");
  const [switching, setSwitching] = useState(false);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
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
      if (body.data?.connection?.loginServer && !v2) setLoginServer(body.data.connection.loginServer);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Private access could not be loaded.");
    } finally { setLoading(false); }
  }, [agentId, v2]);

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
          ? (v2
            ? { action: kind, provider, authKey: submittedKey,
              ...(provider === "netbird"
                ? (netbirdServer.trim() ? { loginServer: netbirdServer.trim() } : {})
                : { loginServer: provider === "headscale" ? loginServer : DEFAULT_SERVER }) }
            : { action: kind, authKey: submittedKey, loginServer: advanced ? loginServer : DEFAULT_SERVER })
          : { action: kind }),
      });
      const body = await readResponse(response);
      if (body.data && Object.hasOwn(body.data, "connection")) setConnection(body.data.connection ?? null);
      if (body.data && Object.hasOwn(body.data, "pending")) setPending(body.data.pending === true);
      else if (body.success === true) setPending(false);
      if (!response.ok || body.success !== true) throw new Error(body.error || "Private access could not be changed.");
      if (kind === "connect") setSwitching(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Private access could not be changed.");
    } finally { setAction(null); }
  }

  const busy = action !== null;
  const connected = connection?.state === "connected";
  const showForm = supported && !pending && (!connection || (v2 && switching));
  const connectedProvider = connection ? inferProvider(connection) : null;
  async function copyPolicy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied("yes"); } catch { setCopied("no"); }
  }
  useReportManageFeedback(onFeedbackChange, error ? { kind: "alert", message: error }
    : action && action !== "refresh" ? { kind: "status", message: "Updating private access…" } : null);
  const buttonStyle: React.CSSProperties = {
    border: "1px solid var(--etched-border)", background: "transparent", color: "var(--ink-black)",
    padding: "8px 12px", minHeight: 40, fontSize: 11, fontWeight: 700, cursor: busy ? "default" : "pointer",
    display: "inline-flex", alignItems: "center", gap: 7, opacity: busy ? 0.55 : 1,
  };
  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", border: "1px solid var(--etched-border)", background: "var(--hg-fill-1)",
    color: "var(--ink-black)", padding: "9px 11px", fontFamily: "var(--font-mono)", fontSize: 12,
  };

  return (
    <section id="private-access" aria-labelledby="private-access-title" style={{ marginBottom: 20 }}>
      <style>{PANEL_CSS}</style>
      <div id="private-access-title" className="mono" style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.16em", color: "var(--text-muted)", marginBottom: 10 }}>
        Private access
      </div>
      <div style={{ border: "1px solid var(--hg-stroke)", borderRadius: 14, background: "var(--hg-glass)", backdropFilter: "blur(var(--hg-glass-blur)) saturate(1.3)", WebkitBackdropFilter: "blur(var(--hg-glass-blur)) saturate(1.3)", boxShadow: "var(--hg-glass-edge), var(--hg-shadow-sm)", padding: 18, display: "grid", gap: 14, gridTemplateColumns: "minmax(0, 1fr)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
          <Network size={17} aria-hidden="true" style={{ marginTop: 2, color: connected ? "var(--hg-ok)" : "var(--text-muted)" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, color: "var(--ink-black)", fontWeight: 650 }}>{v2 ? "Tailscale, Headscale or NetBird" : "Tailscale or Headscale"}</div>
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

        {showForm ? (
          <div style={{ display: "grid", gap: 10 }}>
            {v2 ? <div role="radiogroup" aria-label="Private network" style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12 }}>
              {(["tailscale", "headscale", "netbird"] as const).map(option => (
                <label key={option} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="radio" name="private-network-provider" checked={provider === option} onChange={() => setProvider(option)} />
                  {PROVIDER_LABEL[option]}
                </label>
              ))}
            </div> : null}
            {v2 && switching && connection ? <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Hivra leaves your current network first, then joins this one. Your computer stays reachable through Hivra the whole time.
            </div> : null}
            <label style={{ display: "grid", gap: 6, fontSize: 11.5, color: "var(--text-secondary)" }}>
              One-time enrollment key
              <input type="password" autoComplete="off" value={authKey} onChange={event => setAuthKey(event.target.value)}
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
                placeholder={v2 && provider === "netbird" ? "Paste a NetBird setup key" : "Paste a Tailscale auth key or Headscale preauth key"}
                style={inputStyle} />
            </label>
            {v2 ? <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {provider === "netbird"
                ? "In NetBird, make a setup key that works once and puts this computer in a group called hivra. Hivra uses it once and does not keep it."
                : `In your admin page, make a one-off, pre-approved key with the tag ${HIVRA_TAILNET_TAG}. Hivra uses it once and does not keep it. Needs Tailscale ${TAILSCALE_MIN_VERSION} or newer on the computer.`}
            </div> : null}
            {!v2 ? <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11.5, color: "var(--text-muted)" }}>
              <input type="checkbox" checked={advanced} onChange={event => setAdvanced(event.target.checked)} />
              Use a Headscale coordination server
            </label> : null}
            {v2 && provider === "netbird" ? <label style={{ display: "grid", gap: 6, fontSize: 11.5, color: "var(--text-secondary)" }}>
              NetBird server (only if you run your own)
              <input type="url" inputMode="url" value={netbirdServer} onChange={event => setNetbirdServer(event.target.value)}
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
                placeholder="https://api.netbird.io"
                style={inputStyle} />
            </label> : null}
            {(v2 ? provider === "headscale" : advanced) ? <label style={{ display: "grid", gap: 6, fontSize: 11.5, color: "var(--text-secondary)" }}>
              HTTPS coordination URL
              <input type="url" inputMode="url" value={loginServer} onChange={event => setLoginServer(event.target.value)}
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
                placeholder="https://headscale.example.com"
                style={inputStyle} />
            </label> : null}
            <div className="private-access-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" disabled={busy || !authKey.trim()} onClick={() => void mutate("connect")} style={buttonStyle}>
                {action === "connect" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <ShieldCheck size={14} />}
                {switching && connection ? "Switch private network" : "Connect private network"}
              </button>
              {switching && connection ? <button type="button" disabled={busy} onClick={() => setSwitching(false)} style={buttonStyle}>Cancel</button> : null}
            </div>
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
          {v2 && connection && !pending && !switching ? <button type="button" disabled={busy || !supported} onClick={() => setSwitching(true)} style={buttonStyle}>
            Use a different network
          </button> : null}
          {/* Two-step disconnect: Cancel takes the Disconnect slot so a double tap cannot confirm. */}
          {connection && !pending ? confirmDisconnect
            ? <button type="button" onClick={() => setConfirmDisconnect(false)} style={buttonStyle}>Cancel</button>
            : <button type="button" disabled={busy || !supported} onClick={() => setConfirmDisconnect(true)} style={buttonStyle}>
              {action === "disconnect" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Unplug size={14} />} Disconnect
            </button> : null}
        </div> : null}
        {confirmDisconnect && connection && !pending ? <div style={{ border: "1px solid color-mix(in srgb, var(--hg-bad) 40%, transparent)", background: "color-mix(in srgb, var(--hg-bad) 4%, transparent)", padding: 12, display: "grid", gap: 10 }}>
          <div style={{ fontSize: 12, color: "var(--ink-black)", lineHeight: 1.5 }}>Disconnect this computer? Reconnecting needs a new one-time enrollment key.</div>
          <div className="private-access-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" disabled={busy || !supported} onClick={() => { setConfirmDisconnect(false); void mutate("disconnect"); }}
              style={{ ...buttonStyle, color: "var(--hg-bad)", borderColor: "color-mix(in srgb, var(--hg-bad) 50%, transparent)" }}>
              <Unplug size={14} /> Disconnect computer
            </button>
          </div>
        </div> : null}
        {connection ? <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Disconnect logs this computer out while leaving the local service available for a verified refresh or later reconnect. Your Tailscale or Headscale admin page may retain an offline device record for its own retention period.
        </div> : null}
        {v2 && connection && connected && connectedProvider ? <div style={{ display: "grid", gap: 8, fontSize: 12, lineHeight: 1.5 }}>
          {connection.canSeeOtherDevices === true ? <div role="status" style={{ border: "1px solid color-mix(in srgb, var(--hg-warn, var(--hg-bad)) 40%, transparent)", padding: 10, color: "var(--ink-black)" }}>
            Your network shows this computer {connection.visiblePeerCount === 1 ? "1 other device" : `${connection.visiblePeerCount ?? "some"} other devices`}.
            If you haven&apos;t added the policy below yet, it may be able to reach them. This is what the computer can see, not a proof of what it can reach.
          </div> : connection.canSeeOtherDevices === false ? <div style={{ color: "var(--text-muted)" }}>
            Your network shows this computer no other devices. This is what it can see, not a proof.
          </div> : null}
          {connectedProvider !== "netbird" && connection.taggedHivra === false ? <div role="status" style={{ color: "var(--ink-black)" }}>
            This computer joined without the {HIVRA_TAILNET_TAG} tag, so the policy below doesn&apos;t cover it. Disconnect, then connect again with a key that has the tag.
          </div> : null}
          <details key={String(connection.canSeeOtherDevices === true)} open={connection.canSeeOtherDevices === true ? true : undefined}>
            <summary style={{ cursor: "pointer", fontWeight: 650 }}>Keep your other devices safe</summary>
            {connectedProvider === "netbird" ? <ol style={{ margin: "8px 0 0", paddingLeft: 18, color: "var(--text-secondary)" }}>
              {NETBIRD_POLICY_STEPS.map(step => <li key={step}>{step}</li>)}
            </ol> : <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <div style={{ color: "var(--text-secondary)" }}>
                Paste this into your {PROVIDER_LABEL[connectedProvider]} policy file. Your own devices can reach this computer on SSH; this computer can reach nothing.
                {connectedProvider === "headscale" ? " Replace you@ with your Headscale user." : ""}
              </div>
              <pre className="mono" aria-label="Policy to copy" style={{ margin: 0, padding: 10, overflowX: "auto", fontSize: 11, border: "1px solid var(--etched-border)", background: "var(--hg-fill-1)" }}>{buildPrivateNetworkPolicy(connectedProvider)}</pre>
              <div className="private-access-actions" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button type="button" onClick={() => void copyPolicy(buildPrivateNetworkPolicy(connectedProvider))} style={buttonStyle}>Copy policy</button>
                {copied === "yes" ? <span role="status">Copied</span> : copied === "no" ? <span role="status">Couldn&apos;t copy. Select the text and copy it.</span> : null}
              </div>
            </div>}
          </details>
        </div> : null}
        {error ? <div role="alert" style={{ fontSize: 12, color: "var(--hg-bad)", lineHeight: 1.5 }}>{error}</div> : null}
      </div>
    </section>
  );
}
