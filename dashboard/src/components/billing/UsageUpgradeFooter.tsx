"use client";

// UsageUpgradeFooter — Moment #2 of the free→paid bridge.
//
// Appended under the "Your agent at work" activity summary (AgentActivityPanel)
// once a FREE user has real usage on screen — show-value-then-ask. Gated by the
// caller on isUsageUpgradeCtaEnabled() && isFreePlanInfo(plan) && hasUsage, so it
// only ever reaches free users who already got value, and never a paying one.
//
// Same upgrade funnel as the rest of the app: paywall_viewed on render,
// upgrade_clicked on click, both surface:'usage_summary'; CTA deep-links to
// billing with attribution params.

import { useEffect } from "react";
import { ArrowUpRight } from "lucide-react";

import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE } from "@/lib/blog/plan-facts";
import { captureClient } from "@/lib/telemetry/posthog-client";

const BILLING_HREF = "/dashboard/billing?from=paywall&feature=always_on";

export function UsageUpgradeFooter() {
  useEffect(() => {
    try {
      captureClient("paywall_viewed", {
        surface: "usage_summary",
        feature: "always_on",
        plan: "free",
      });
    } catch {
      // ignore — analytics must never break the surface
    }
  }, []);

  return (
    <div
      data-testid="usage-upgrade-footer"
      style={{
        border: "1px solid var(--etched-border)",
        borderTop: "2px solid var(--gold-leaf)",
        background: "rgba(255,255,255,0.025)",
        padding: "1.1rem 1.25rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "grid", gap: 6, minWidth: 0, flex: "1 1 420px" }}>
        <span
          className="mono"
          style={{
            fontSize: 9,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            fontWeight: 700,
            color: "var(--gold-leaf)",
          }}
        >
          Your agent&apos;s earning its keep
        </span>
        <span style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          {`That's real work from your agent. Every computer that Hivra Cloud runs for you needs a paid plan, from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. A free account works with a computer or server you connect yourself. A paid computer stays on and is not paused for inactivity.`}
        </span>
      </div>
      <a
        href={BILLING_HREF}
        onClick={() => {
          captureClient("upgrade_clicked", {
            surface: "usage_summary",
            feature: "always_on",
            from_plan: "free",
            to_plan: "operator",
          });
        }}
        className="mono"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: "var(--ink-black, #1a1a1a)",
          color: "var(--bg-surface, #ffffff)",
          border: "none",
          padding: "10px 16px",
          fontSize: 11,
          fontWeight: 700,
          cursor: "pointer",
          textDecoration: "none",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          whiteSpace: "nowrap",
        }}
      >
        See plans <ArrowUpRight size={13} strokeWidth={2.5} />
      </a>
    </div>
  );
}
