"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Network, RefreshCw, ShieldCheck, Unplug } from "lucide-react";

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

async function readResponse(response: Response): Promise<{
  success?: boolean;
  error?: string;
  data?: { supported?: boolean; pending?: boolean; connection?: Connection | null };
}> {
  try { return await response.json(); } catch { return {}; }
}

export function HivraPrivateAccessPanel({ agentId }: { agentId: string }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [supported, setSupported] = useState(true);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"connect" | "refresh" | "disconnect" | null>(null);
  const [authKey, setAuthKey] = useState("");
  const [loginServer, setLoginServer] = useState(DEFAULT_SERVER);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setPending(body.data?.pending === true);
      setConnection(body.data?.connection ?? null);
      if (body.data?.connection?.loginServer) setLoginServer(body.data.connection.loginServer);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Private access could not be loaded.");
    } finally { setLoading(false); }
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

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
  const buttonStyle: React.CSSProperties = {
    border: "1px solid var(--etched-border)", background: "transparent", color: "var(--ink-black)",
    padding: "8px 12px", fontSize: 11, fontWeight: 700, cursor: busy ? "default" : "pointer",
    display: "inline-flex", alignItems: "center", gap: 7, opacity: busy ? 0.55 : 1,
  };

  return (
    <section id="private-access" aria-labelledby="private-access-title" style={{ marginBottom: 20 }}>
      <div id="private-access-title" className="mono" style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.16em", color: "var(--text-muted)", marginBottom: 10 }}>
        Private access
      </div>
      <div style={{ border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.035)", padding: 18, display: "grid", gap: 14 }}>
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
          <div aria-live="polite" style={{ borderTop: "1px solid var(--etched-border)", paddingTop: 12, display: "grid", gap: 7, fontSize: 12 }}>
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
                placeholder="Paste a Tailscale auth key or Headscale preauth key"
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", padding: "9px 11px", fontFamily: "var(--font-mono), monospace", fontSize: 12 }} />
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11.5, color: "var(--text-muted)" }}>
              <input type="checkbox" checked={advanced} onChange={event => setAdvanced(event.target.checked)} />
              Use a Headscale coordination server
            </label>
            {advanced ? <label style={{ display: "grid", gap: 6, fontSize: 11.5, color: "var(--text-secondary)" }}>
              HTTPS coordination URL
              <input type="url" value={loginServer} onChange={event => setLoginServer(event.target.value)}
                placeholder="https://headscale.example.com"
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", padding: "9px 11px", fontFamily: "var(--font-mono), monospace", fontSize: 12 }} />
            </label> : null}
            <button type="button" disabled={busy || !authKey.trim()} onClick={() => void mutate("connect")} style={buttonStyle}>
              {action === "connect" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <ShieldCheck size={14} />}
              Connect private network
            </button>
          </div>
        ) : null}

        {!supported && !loading ? <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {pending ? "A private-access change needs a fresh guest observation before another change."
            : "Private access currently requires a running, owner-bound Ubuntu computer on Proxmox with no other operation in progress. This computer does not meet that support contract."}
        </div> : null}

        {connection || pending ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" disabled={busy || (!supported && !pending)} onClick={() => void mutate("refresh")} style={buttonStyle}>
            {action === "refresh" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />} Refresh status
          </button>
          {connection && !pending ? <button type="button" disabled={busy || !supported} onClick={() => void mutate("disconnect")} style={buttonStyle}>
            {action === "disconnect" ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Unplug size={14} />} Disconnect
          </button> : null}
        </div> : null}
        {connection ? <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Disconnect logs this computer out while leaving the local service available for a verified refresh or later reconnect. Your Tailscale or Headscale admin page may retain an offline device record for its own retention period.
        </div> : null}
        {error ? <div role="alert" style={{ fontSize: 12, color: "#e06c5a", lineHeight: 1.5 }}>{error}</div> : null}
      </div>
    </section>
  );
}
