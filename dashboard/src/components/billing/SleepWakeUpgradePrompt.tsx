"use client";

// SleepWakeUpgradePrompt — Moment #1 of the free→paid bridge.
//
// Rendered in place of the plain "Warming up your agent" banner when a FREE
// agent that was inactivity-paused (paused_reason='inactivity') is re-opened.
// The agent is still auto-waking underneath (the page fires the start action);
// this just carries the always-on Pro pitch ALONGSIDE the wake progress instead
// of a silent boot spinner. Gated by the caller on
// isSleepUpgradePromptEnabled() && isFreePlanInfo(plan), so a paying customer
// never sees it.
//
// Mirrors the proven ram_cap banner: same blue wake styling, a single upgrade
// CTA that deep-links to billing with attribution params, and PostHog events on
// the shared upgrade funnel — paywall_viewed on render, upgrade_clicked on click,
// both surface:'sleep_wake_banner'.

import { useEffect } from "react";
import { Loader2 } from "lucide-react";

import { captureClient } from "@/lib/telemetry/posthog-client";

const BILLING_HREF = "/dashboard/billing?from=paywall&feature=always_on";

export function SleepWakeUpgradePrompt({
  instanceId,
  instanceName,
}: {
  instanceId: string;
  instanceName?: string | null;
}) {
  // Impression event — once per mount (the banner mounts fresh when a paused
  // free agent is opened). Best-effort; analytics must never break the surface.
  useEffect(() => {
    try {
      captureClient("paywall_viewed", {
        surface: "sleep_wake_banner",
        feature: "always_on",
        plan: "free",
        instance_id: instanceId,
      });
    } catch {
      // ignore
    }
  }, [instanceId]);

  return (
    <div
      data-testid="instance-sleep-wake-upgrade-banner"
      className="instance-chat-banner"
      style={{
        background: "rgba(59, 130, 246, 0.10)",
        borderBottom: "1px solid rgba(59, 130, 246, 0.24)",
        padding: "12px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        zIndex: 49,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: "1 1 460px" }}>
        <Loader2 size={18} strokeWidth={2.25} style={{ color: "#1d4ed8" }} className="animate-spin" />
        <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span
            className="mono"
            style={{ fontSize: 11, fontWeight: 700, color: "#1d4ed8", textTransform: "uppercase", letterSpacing: "0.12em" }}
          >
            Warming up your agent
          </span>
          <span style={{ fontSize: 13, color: "rgba(17, 24, 39, 0.78)", lineHeight: 1.45 }}>
            {instanceName ? `${instanceName} slept` : "Your agent slept"} after 4 idle days. Waking it back
            up now, about 30 seconds. Free agents sleep. Pro agents never do, so yours stays on 24/7 and is
            ready the second you are.
          </span>
        </div>
      </div>
      <div className="instance-chat-banner-actions" style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
        <a
          href={BILLING_HREF}
          onClick={() => {
            captureClient("upgrade_clicked", {
              surface: "sleep_wake_banner",
              feature: "always_on",
              limit_type: "inactivity",
              instance_id: instanceId,
              from_plan: "free",
              to_plan: "operator",
            });
          }}
          className="mono"
          style={{
            background: "#1a1a1a",
            color: "#ffffff",
            border: "none",
            padding: "8px 14px",
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
            textDecoration: "none",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            whiteSpace: "nowrap",
          }}
        >
          Keep it always-on
        </a>
      </div>
    </div>
  );
}
