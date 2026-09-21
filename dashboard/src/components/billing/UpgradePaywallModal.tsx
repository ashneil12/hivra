"use client";

// UpgradePaywallModal — the shared "this feature needs Pro" surface.
//
// Replaces the raw 403 banners / dead-end buttons that locked features used to
// render. Tells the user what the feature actually does (one concrete example),
// shows the Free vs Pro line, and routes to billing with attribution params.
// Quiet dismiss everywhere — backdrop, X, and a "Not now" link. No dark patterns.
//
// Analytics: `paywall_viewed` fires once on mount, `upgrade_clicked` on the CTA
// — both with surface:'feature_lock' so the funnel can tell feature-lock
// paywalls apart from pricing-page upgrades.

import { useEffect } from "react";
import { CalendarClock, Database, Globe, Layers, Lock, X } from "lucide-react";
import posthog from "posthog-js";

import { PLANS, formatPrice } from "@/lib/subscription";

export type PaywallFeature = "browser" | "memory" | "cron" | "agents" | "generic";

/** Where this paywall was surfaced from (analytics only). Defaults to the
 *  feature-lock surface so existing callers are unchanged. */
export type PaywallSurface = "feature_lock" | "second_agent";

const PRO_PRICE = `${formatPrice(PLANS.operator.price)}/mo`;

const FEATURE_CONTENT: Record<PaywallFeature, {
  icon: React.ReactNode;
  title: string;
  body: string;
  example: string;
}> = {
  browser: {
    icon: <Globe size={18} />,
    title: "Web browsing & automation",
    body: "Your agent gets its own live Chrome. It can research, click, fill forms, and you can watch or take over any time.",
    example: "e.g. “Find the top 5 venues for the offsite, compare prices, and fill in the booking enquiry forms.”",
  },
  memory: {
    icon: <Database size={18} />,
    title: "Persistent memory",
    body: "Your agent remembers context across sessions. Projects, preferences, and past decisions carry over instead of starting cold.",
    example: "e.g. it recalls last week’s campaign numbers when you ask “how did we do vs. last week?”",
  },
  cron: {
    icon: <CalendarClock size={18} />,
    title: "Scheduled tasks",
    body: "Your agent runs jobs on a schedule without you prompting it. Recurring reports, monitors, and follow-ups happen on their own.",
    example: "e.g. “Every weekday at 8am, summarize my inbox and flag anything urgent.”",
  },
  agents: {
    icon: <Layers size={18} />,
    title: "Run a fleet of agents",
    body: "Free includes one agent. Pro runs three at once, each with its own memory, tools, and job. Real work happening in parallel while you sleep.",
    example: "e.g. one agent triaging your inbox, one tracking competitors, one shipping code, all at the same time.",
  },
  generic: {
    icon: <Lock size={18} />,
    title: "This feature needs Pro",
    body: "This capability isn’t included on the Free plan. Pro unlocks browsing, persistent memory, scheduled tasks, and 4× the compute.",
    example: "e.g. your agent goes always-on (never paused for inactivity) and gains browsing, memory, and scheduled tasks.",
  },
};

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace",
  fontSize: 9,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.15em",
  color: "var(--text-muted)",
};

function capture(event: string, properties: Record<string, unknown>) {
  try {
    posthog.capture(event, properties);
  } catch {
    // Funnel observability must never break the paywall surface itself.
  }
}

export function UpgradePaywallModal({
  feature,
  currentPlan,
  surface = "feature_lock",
  onClose,
}: {
  feature: PaywallFeature;
  /** The user's current plan key (e.g. "free"). Used for analytics only. */
  currentPlan?: string | null;
  /** Analytics surface tag. Defaults to 'feature_lock'; the second-agent wall
   *  (Moment #4) passes 'second_agent'. */
  surface?: PaywallSurface;
  onClose: () => void;
}) {
  const content = FEATURE_CONTENT[feature] ?? FEATURE_CONTENT.generic;

  // One view event per modal open (the modal is mounted fresh each open).
  useEffect(() => {
    capture("paywall_viewed", {
      surface,
      feature,
      plan: currentPlan ?? null,
    });
  }, [feature, currentPlan, surface]);

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(10, 10, 10, 0.55)",
        display: "grid", placeItems: "center", padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={content.title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 440,
          border: "1px solid var(--ink-black)",
          background: "var(--bg-surface)",
          boxShadow: "4px 4px 0px var(--ink-black)",
          position: "relative", padding: "2rem",
        }}
      >
        {/* Gold bar */}
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--gold-leaf)" }} />

        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute", top: 14, right: 14,
            border: "none", background: "transparent", cursor: "pointer",
            color: "var(--text-muted)", padding: 4, display: "inline-flex",
          }}
        >
          <X size={16} />
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <span style={{ color: "var(--gold-leaf)", display: "inline-flex" }}>{content.icon}</span>
          <span className="mono" style={labelStyle}>Pro feature</span>
        </div>

        <h2 className="serif" style={{ fontSize: "1.5rem", fontWeight: 400, margin: "0 0 0.6rem", color: "var(--ink-black)" }}>
          {content.title}
        </h2>

        <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, margin: "0 0 0.6rem" }}>
          {content.body}
        </p>
        <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, fontStyle: "italic", margin: "0 0 1.1rem" }}>
          {content.example}
        </p>

        {/* Plan comparison line */}
        <div style={{
          border: "1px solid var(--etched-border)", background: "var(--bg-elevated)",
          padding: "9px 12px", marginBottom: "1.25rem",
        }}>
          <span className="mono" style={{ fontSize: 10, letterSpacing: "0.04em", color: "var(--text-secondary)", lineHeight: 1.6, display: "block" }}>
            Free: not included · Pro ({PRO_PRICE}): included, {PLANS.operator.specs.cpu}, {PLANS.operator.specs.agents}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
          <a
            href={`/dashboard/billing?from=paywall&feature=${feature}`}
            onClick={() => {
              capture("upgrade_clicked", {
                surface,
                feature,
                plan: currentPlan ?? null,
                // Same funnel shape as the banner surfaces (sleep_wake_banner /
                // usage_summary / archive_wall) so one cross-surface query works;
                // `plan` stays for the legacy feature_lock dashboards.
                from_plan: currentPlan ?? null,
                to_plan: "operator",
              });
            }}
            className="mono"
            style={{
              width: "100%", boxSizing: "border-box", textAlign: "center",
              padding: "12px 20px", textDecoration: "none",
              background: "var(--ink-black)", color: "var(--bg-surface)",
              border: "1px solid var(--ink-black)",
              fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em",
            }}
          >
            Upgrade to Pro, {PRO_PRICE}
          </a>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "none", background: "transparent", cursor: "pointer",
              fontSize: 12, color: "var(--text-muted)", padding: 4,
            }}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
