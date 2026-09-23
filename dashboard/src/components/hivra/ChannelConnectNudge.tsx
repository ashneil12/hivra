"use client";

// ChannelConnectNudge — the one-line post-deploy banner on the agent page.
//
// Fresh deploys land on /dashboard/agent/[id]?welcome=1 with no channel
// connected, which means the agent can never reach the user once they close
// the tab. When the welcome param is present and the box's Telegram bot is NOT
// connected, this nudges them toward the Telegram tab — once, dismissably
// (localStorage, per box). Probe and render are self-contained so the page
// only decides placement.
//
// Funnel instrumentation: channel_connect_nudge_shown / _clicked / _dismissed.

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Send, X } from "lucide-react";
import posthog from "posthog-js";

import { telegramStatus } from "@/lib/hivra/agent-api";

const DISMISS_KEY_PREFIX = "hermes:channel_nudge_dismissed:";
const NUDGE_CSS = `@media (max-width: 767px), (pointer: coarse) {
  .channel-nudge-connect { min-height: 44px; }
  .channel-nudge-dismiss { min-width: 44px; min-height: 44px; }
}`;

// Instrumentation must never break the agent page.
function capture(event: string, properties: Record<string, unknown>) {
  try {
    posthog.capture(event, properties);
  } catch {
    // Best-effort only.
  }
}

export function ChannelConnectNudge({
  boxUrl,
  token,
  boxId,
  onConnect,
}: {
  boxUrl: string;
  token?: string | null;
  boxId: string;
  /** Takes the user to the Telegram tab (the page owns tab state). */
  onConnect: () => void;
}) {
  const searchParams = useSearchParams();
  const welcome = searchParams?.get("welcome") === "1";
  const dismissKey = `${DISMISS_KEY_PREFIX}${boxId}`;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(dismissKey) === "1";
    } catch {
      return false;
    }
  });
  const [connected, setConnected] = useState<boolean | null>(null);
  const shownRef = useRef(false);

  // Only probe when the nudge could actually show — fresh welcome landings.
  useEffect(() => {
    if (!welcome || dismissed) return;
    let alive = true;
    void telegramStatus(boxUrl, token).then((status) => {
      if (alive) setConnected(status.connected);
    });
    return () => {
      alive = false;
    };
  }, [welcome, dismissed, boxUrl, token]);

  const visible = welcome && !dismissed && connected === false;

  useEffect(() => {
    if (visible && !shownRef.current) {
      shownRef.current = true;
      capture("channel_connect_nudge_shown", { channel: "telegram", box_id: boxId });
    }
  }, [visible, boxId]);

  if (!visible) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(dismissKey, "1");
    } catch {
      // Privacy mode — the nudge just won't stay dismissed.
    }
    setDismissed(true);
    capture("channel_connect_nudge_dismissed", { channel: "telegram", box_id: boxId });
  };

  return (
    <div
      role="status"
      data-testid="channel-connect-nudge"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        padding: "7px 16px",
        borderBottom: "1px solid var(--etched-border)",
        background: "rgba(255,255,255,0.03)",
        fontSize: 12.5,
        color: "var(--text-secondary)",
        minWidth: 0,
      }}
    >
      <style>{NUDGE_CSS}</style>
      {/* Max-content basis: one line on wide screens; on a phone the copy wraps in full and the actions drop below it. */}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flex: "0 1 auto", minWidth: 0 }}>
        <Send size={13} style={{ color: "var(--gold-leaf)", flexShrink: 0 }} />
        <span style={{ minWidth: 0, whiteSpace: "normal", lineHeight: 1.45 }}>
          Your agent can reach you when work is done — connect Telegram.
        </span>
      </span>
      <button
        type="button"
        onClick={() => {
          capture("channel_connect_nudge_clicked", { channel: "telegram", box_id: boxId });
          onConnect();
        }}
        className="mono channel-nudge-connect"
        style={{
          border: "1px solid var(--etched-border)",
          background: "transparent",
          color: "var(--ink-black)",
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          padding: "8px 12px",
          cursor: "pointer",
          flexShrink: 0,
          whiteSpace: "nowrap",
        }}
      >
        Connect Telegram
      </button>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="channel-nudge-dismiss"
        style={{
          border: "none",
          background: "transparent",
          cursor: "pointer",
          color: "var(--text-muted)",
          padding: 4,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}
