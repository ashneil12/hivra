"use client";

// InstanceChannelConnect — the generic, multi-platform sibling of
// <InstanceTelegramConnect>. Telegram keeps its bespoke pairing UX (token → bot
// DMs a code → approve); every OTHER env-token channel (Discord, Slack, Signal,
// WhatsApp, Email, Matrix, …) shares this one flow, which is just:
//
//   1. read the platform's fields from INTEGRATION_DEFINITIONS
//   2. show the existing setup guide (guides.tsx)
//   3. POST the field values to /api/instances/[id]/integrations
//      (the SAME route + switch(platform) the Telegram wrapper hits)
//   4. reflect connect status from that route's GET statuses
//
// It intentionally reuses the route, the guide content, the status shape, and
// the visual tokens of <TelegramConnect> so the experience is identical, just
// generalized. No new endpoint, no new wire — the backend was already complete.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import posthog from "posthog-js";
import { Loader2, Check, Plug } from "lucide-react";

import {
  getIntegrationDefinition,
  type IntegrationDefinition,
} from "@/lib/integrations/config";
import { getGuideContent } from "@/lib/integrations/guides";
import {
  getChannelSurfaceMeta,
  type ChannelConnectStyle,
} from "@/lib/integrations/channel-surface";

// Instrumentation must never make the connect flow throw.
function captureChannelEvent(event: string, properties: Record<string, unknown>) {
  try {
    posthog.capture(event, properties);
  } catch {
    // Best-effort only.
  }
}

// Bound every save round-trip client-side (mirrors InstanceTelegramConnect). The
// integrations route can hold the connection while it restarts the box's gateway;
// without a client deadline the fetch stays pending for the function's whole
// lifetime and the button spinner reads as hung. AbortSignal.timeout fails the
// fetch with a TimeoutError we map to a friendly, retryable message.
const SAVE_FETCH_TIMEOUT_MS = 25000;

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

const SAVE_TIMEOUT_MESSAGE =
  "Saving is taking longer than expected — your agent may still be restarting. Try again in a moment.";

async function readJson(r: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  opacity: 0.62,
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid var(--etched-border)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--ink-black)",
  fontSize: 13,
  fontFamily: "var(--font-mono), monospace",
  outline: "none",
};
const primaryBtn: React.CSSProperties = {
  border: "1px solid var(--ink-black)",
  background: "var(--ink-black)",
  color: "var(--bg-surface)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  fontWeight: 800,
  padding: "11px 18px",
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  justifySelf: "start",
};

type ChannelStatus = { connected: boolean; partial?: boolean };

// Which fields the connect form should render. Telegram is handled by its own
// component, so here we render every field the definition declares except the
// `enabled`-flag pseudo-field used by QR/device-link channels (WhatsApp), which
// has no value the user types.
function visibleFields(def: IntegrationDefinition, connectStyle: ChannelConnectStyle) {
  return def.fields.filter((f) => {
    if (connectStyle === "device-link" && f.name === "enabled") return false;
    return true;
  });
}

export function InstanceChannelConnect({
  instanceId,
  platform,
  agentName,
  onStatusChange,
}: {
  instanceId: string;
  /** Must match an INTEGRATION_DEFINITIONS id (e.g. "Discord", "Slack"). */
  platform: string;
  agentName?: string | null;
  onStatusChange?: (status: ChannelStatus) => void;
}) {
  const definition = getIntegrationDefinition(platform);
  const meta = getChannelSurfaceMeta(platform);
  const connectStyle: ChannelConnectStyle = meta?.connectStyle ?? "fields";
  const label = meta?.label ?? platform;

  const fields = useMemo(
    () => (definition ? visibleFields(definition, connectStyle) : []),
    [definition, connectStyle],
  );

  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Synchronous re-entrancy lock — `busy` (React state) commits a render too
  // late to guard two near-simultaneous submits (mirrors TelegramConnect).
  const connectingRef = useRef(false);

  const channelProps = useCallback(
    () => ({ channel: platform.toLowerCase(), box_id: instanceId, target_kind: "hermes" }),
    [platform, instanceId],
  );

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/instances/${instanceId}/integrations`, { cache: "no-store" });
      const j = await readJson(r);
      const data = (j?.data ?? null) as
        | {
            statuses?: Record<string, { configured?: boolean; partial?: boolean }>;
            configuredPlatforms?: string[];
          }
        | null;
      const entry = data?.statuses?.[platform];
      const connected = Boolean(
        entry?.configured ||
          (Array.isArray(data?.configuredPlatforms) && data.configuredPlatforms.includes(platform)),
      );
      const next = { connected, partial: Boolean(entry?.partial) };
      setStatus(next);
      onStatusChange?.(next);
    } catch {
      const next = { connected: false };
      setStatus(next);
      onStatusChange?.(next);
    }
  }, [instanceId, platform, onStatusChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setField = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const missingRequired = fields
    .filter((f) => f.requiredOnConnect)
    .some((f) => !(values[f.name] ?? "").trim());

  const connect = useCallback(async () => {
    if (busy || connectingRef.current || !definition) return;
    setError(null);
    setNotice(null);
    // Trim + drop empties so the route's validator sees only provided fields.
    const credentials: Record<string, string> = {};
    for (const f of definition.fields) {
      const v = (values[f.name] ?? "").trim();
      if (v) credentials[f.name] = v;
    }
    connectingRef.current = true;
    setBusy(true);
    captureChannelEvent("channel_connect_started", channelProps());
    try {
      const r = await fetch(`/api/instances/${instanceId}/integrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, credentials }),
        signal: AbortSignal.timeout(SAVE_FETCH_TIMEOUT_MS),
      });
      const j = await readJson(r);
      if (!r.ok || !j || j.success !== true) {
        captureChannelEvent("channel_connect_failed", channelProps());
        setError((j?.error as string) || `Couldn't connect ${label} (HTTP ${r.status}).`);
        return;
      }
      captureChannelEvent("channel_connected", channelProps());
      if (connectStyle === "device-link") {
        setNotice(
          "Saved. Finish linking from your server console — see the steps above (run the QR-link command and scan it).",
        );
      }
      setValues({});
      await refresh();
    } catch (e) {
      captureChannelEvent("channel_connect_failed", channelProps());
      setError(isAbortError(e) ? SAVE_TIMEOUT_MESSAGE : ((e as Error).message || `Network error reaching ${label}.`));
    } finally {
      setBusy(false);
      connectingRef.current = false;
    }
  }, [busy, definition, values, channelProps, instanceId, platform, label, connectStyle, refresh]);

  const disconnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    let disconnectFailed = false;
    try {
      const r = await fetch(`/api/instances/${instanceId}/integrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, disconnect: true }),
        signal: AbortSignal.timeout(SAVE_FETCH_TIMEOUT_MS),
      });
      const j = await readJson(r);
      if (!r.ok || !j || j.success !== true) {
        // The strip request failed. Don't pretend it worked — surface it so the
        // user doesn't falsely believe the channel is disconnected (the trailing
        // refresh() re-reads authoritative status, but if that GET also fails it
        // would fall back to connected:false and hide this failure).
        disconnectFailed = true;
        setError((j?.error as string) || `Couldn't disconnect ${label} (HTTP ${r.status}).`);
      } else {
        captureChannelEvent("channel_disconnected", channelProps());
      }
    } catch (e) {
      disconnectFailed = true;
      setError(isAbortError(e) ? SAVE_TIMEOUT_MESSAGE : `Network error while disconnecting ${label}. Please try again.`);
    } finally {
      // Only clear the inputs when we believe the strip succeeded.
      if (!disconnectFailed) {
        setValues({});
      }
      await refresh();
      setBusy(false);
    }
  }, [busy, instanceId, platform, channelProps, refresh, label]);

  if (!definition) {
    // Defensive: a tile should never open a platform without a definition, but
    // fail soft rather than throw inside a portal.
    return (
      <div style={{ padding: "36px 20px", color: "var(--text-secondary)", fontSize: 13 }}>
        {label} isn&apos;t available on this agent yet.
      </div>
    );
  }

  const connected = Boolean(status?.connected);
  const guide = getGuideContent(platform);
  const Icon = meta?.icon ?? Plug;

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "36px 20px", height: "100%", overflowY: "auto" }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 42,
          height: 42,
          border: "1px solid var(--gold-leaf)",
          color: "var(--gold-leaf)",
          marginBottom: 16,
        }}
      >
        <Icon size={18} />
      </div>
      <h2
        className="serif"
        style={{
          fontSize: "clamp(1.7rem, 5vw, 2.3rem)",
          fontWeight: 400,
          color: "var(--ink-black)",
          margin: "0 0 10px",
          lineHeight: 1.1,
        }}
      >
        Connect {label}
      </h2>
      <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.65, margin: "0 0 24px" }}>
        {meta?.tagline ?? `Connect ${label} to ${agentName?.trim() || "your agent"}.`}
      </p>

      {error ? (
        <div
          style={{
            border: "1px solid #c0392b",
            background: "rgba(192,57,43,0.08)",
            color: "#e06c5a",
            fontSize: 13,
            padding: "10px 14px",
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          style={{
            border: "1px solid var(--etched-border)",
            background: "rgba(255,255,255,0.04)",
            color: "var(--text-secondary)",
            fontSize: 13,
            padding: "10px 14px",
            marginBottom: 16,
          }}
        >
          {notice}
        </div>
      ) : null}

      {status === null ? (
        <div style={{ padding: 30, textAlign: "center" }}>
          <Loader2 size={18} style={{ animation: "spin 1s linear infinite", opacity: 0.5 }} />
        </div>
      ) : connected ? (
        <ConnectedCard label={label} agentName={agentName} busy={busy} onDisconnect={() => void disconnect()} />
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {guide ? (
            <details style={{ border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.02)" }}>
              <summary
                className="mono"
                style={{ ...mono, opacity: 1, cursor: "pointer", padding: "10px 12px", userSelect: "none" }}
              >
                Setup guide
              </summary>
              <div style={{ padding: "4px 14px 14px" }}>{guide}</div>
            </details>
          ) : null}

          <div style={{ display: "grid", gap: 12 }}>
            {fields.map((f) => (
              <div key={f.name}>
                <div className="mono" style={{ ...mono, marginBottom: 6 }}>
                  {f.label}
                  {f.requiredOnConnect ? "" : " (optional)"}
                </div>
                <input
                  value={values[f.name] ?? ""}
                  onChange={(e) => setField(f.name, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !missingRequired) void connect();
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  style={inputStyle}
                />
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void connect()}
            disabled={busy || missingRequired}
            className="mono"
            style={{
              ...primaryBtn,
              cursor: busy || missingRequired ? "default" : "pointer",
              opacity: busy || missingRequired ? 0.5 : 1,
            }}
          >
            {busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={14} />}{" "}
            {connectStyle === "device-link" ? `Save & link ${label}` : `Connect ${label}`}
          </button>
        </div>
      )}
    </div>
  );
}

function ConnectedCard({
  label,
  agentName,
  busy,
  onDisconnect,
}: {
  label: string;
  agentName?: string | null;
  busy: boolean;
  onDisconnect: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--etched-border)",
        background: "rgba(255,255,255,0.035)",
        padding: 20,
        display: "grid",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#22c55e" }} />
        <strong className="serif" style={{ fontSize: 18, fontWeight: 400, color: "var(--ink-black)" }}>
          {label} connected
        </strong>
      </div>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0 }}>
        {agentName?.trim() || "Your agent"} is reachable on {label}. The gateway restarts the connector when you
        connect or disconnect — give it a few seconds to come up.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onDisconnect}
          disabled={busy}
          className="mono"
          style={{
            border: "1px solid var(--etched-border)",
            background: "transparent",
            color: "#e06c5a",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 800,
            padding: "9px 14px",
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : "Disconnect"}
        </button>
      </div>
    </div>
  );
}
