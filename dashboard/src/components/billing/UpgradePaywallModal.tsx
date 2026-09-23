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
import { CalendarClock, Database, Globe, Layers, Lock } from "lucide-react";
import posthog from "posthog-js";

import { BillingDialog, billingDialogStyles as styles } from "@/components/billing/BillingDialog";
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
    <BillingDialog
      ariaLabel={content.title}
      icon={content.icon}
      eyebrow="Pro feature"
      title={content.title}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.quiet} onClick={onClose}>
            Not now
          </button>
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
            className={`mono ${styles.button} ${styles.primary}`}
          >
            Upgrade to Pro, {PRO_PRICE}
          </a>
        </>
      }
    >
      <p className={styles.text}>{content.body}</p>
      <p className={styles.example}>{content.example}</p>

      {/* Plan comparison */}
      <dl className={styles.ledger}>
        <div className={styles.ledgerRow}>
          <dt>Free</dt>
          <dd>Not included</dd>
        </div>
        <div className={styles.ledgerRow}>
          <dt>Pro · {PRO_PRICE}</dt>
          <dd>
            Included · {PLANS.operator.specs.cpu} · {PLANS.operator.specs.agents}
          </dd>
        </div>
      </dl>
    </BillingDialog>
  );
}
