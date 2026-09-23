"use client";

// CancelSaveFlow — the one-question save step in front of subscription
// cancellation.
//
// Asks "What's making you cancel?" (radio), shows at most ONE save offer
// matched to the reason (every offer is an email to support; "too expensive"
// quotes the user's own plan's yearly price and is skipped for a plan with
// no yearly price), and always keeps a clear "Cancel anyway" visible that proceeds
// with the original cancel flow unchanged (the billing page passes its
// existing portal handler). Never a trap: backdrop, X, "Keep my plan" and
// "Cancel anyway" all work at every step, with or without an answer.
//
// Persistence: on "Cancel anyway" (or accepting an offer) the answered
// survey is fire-and-forgotten to POST /api/billing/churn-survey and a
// churn_survey_submitted {reason, plan} PostHog event is captured. Failures
// in either are swallowed — observability must never block cancelling.

import { useState } from "react";
import posthog from "posthog-js";

import { BillingDialog, billingDialogStyles as styles } from "@/components/billing/BillingDialog";
import type { ChurnSurveyReason } from "@/lib/billing/churn-survey";
import { PLANS, formatPrice, type PlanKey } from "@/lib/subscription";
import { SUPPORT_EMAIL } from "@/lib/support-channels";

const REASON_OPTIONS: Array<{ value: ChurnSurveyReason; label: string }> = [
  { value: "too_expensive", label: "It's too expensive" },
  { value: "not_using", label: "I'm not using it" },
  { value: "missing_feature", label: "It's missing a feature I need" },
  { value: "something_broke", label: "Something broke" },
  { value: "other", label: "Something else" },
];

type Offer = {
  title: string;
  body: string;
  ctaLabel: string;
  /** Every offer is an email to support; the address is also shown as text. */
  ctaHref: string;
};

function supportMailto(subject: string) {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

/**
 * The yearly price for the plan the user is on now, from PLANS. Null when
 * the plan is unknown or has no yearly price (e.g. Command), so no yearly
 * offer is made.
 */
export function yearlyOfferPrices(plan: string | null | undefined) {
  if (!plan || !Object.prototype.hasOwnProperty.call(PLANS, plan)) return null;
  const entry = PLANS[plan as PlanKey] as { name: string; price: number; yearlyPrice?: number };
  const monthly = entry.price;
  const yearly = entry.yearlyPrice ?? 0;
  if (!(monthly > 0) || !(yearly > 0) || yearly >= monthly * 12) return null;
  return {
    planName: entry.name,
    monthly,
    yearly,
    savingsPct: Math.round((1 - yearly / (monthly * 12)) * 100),
  };
}

function offerForReason(reason: ChurnSurveyReason, plan: string | null | undefined): Offer | null {
  switch (reason) {
    case "too_expensive": {
      // A live card subscription can't switch itself to yearly (subscribe
      // rejects an active subscription and change-plan bills monthly), so
      // this is a request to support, priced from the user's own plan.
      const prices = yearlyOfferPrices(plan);
      if (!prices) return null;
      return {
        title: `Yearly costs about ${prices.savingsPct}% less`,
        body: `${prices.planName} yearly is ${formatPrice(prices.yearly)}/yr instead of ${formatPrice(prices.monthly)}/mo for the same plan. Switching an existing card subscription to yearly isn't self-serve yet, so email us and we'll switch it for you.`,
        ctaLabel: "Email us to switch to yearly",
        ctaHref: supportMailto(`Switch my ${prices.planName} plan to yearly billing`),
      };
    }
    case "not_using":
      return {
        title: "You could pause instead",
        body: "If you're just busy, email us and we'll pause your billing instead of losing your agent's setup and memory — picking back up later takes one reply.",
        ctaLabel: "Email us about pausing",
        ctaHref: supportMailto("Pause my subscription"),
      };
    case "missing_feature":
      return {
        title: "Tell the founder what's missing",
        body: "Feature requests from cancelling users go to the top of the list. Replies land directly with Ash, the founder.",
        ctaLabel: "Email the founder",
        ctaHref: supportMailto("Missing feature (was about to cancel)"),
      };
    case "something_broke":
      return {
        title: "Let us fix it first",
        body: "If something broke, that's on us. Email the founder directly — broken-for-a-paying-user is the first thing we fix.",
        ctaLabel: "Email the founder",
        ctaHref: supportMailto("Something broke (was about to cancel)"),
      };
    case "other":
      return {
        title: "Tell us what happened",
        body: "Whatever it is, a one-line reply helps us fix it for the next person. Replies land directly with Ash, the founder.",
        ctaLabel: "Email the founder",
        ctaHref: supportMailto("Why I cancelled"),
      };
  }
}

function capture(event: string, properties: Record<string, unknown>) {
  try {
    posthog.capture(event, properties);
  } catch {
    // Observability must never break the cancel path.
  }
}

export function CancelSaveFlow({
  plan,
  onClose,
  onCancelAnyway,
}: {
  /** Current plan key (e.g. "operator"): survey context and the yearly offer's prices. */
  plan?: string | null;
  /** Quiet dismiss — user keeps their subscription. */
  onClose: () => void;
  /** Proceeds with the ORIGINAL cancel flow, unchanged. */
  onCancelAnyway: () => void;
}) {
  const [reason, setReason] = useState<ChurnSurveyReason | null>(null);
  const [detail, setDetail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const submitSurvey = () => {
    if (!reason || submitted) return;
    setSubmitted(true);
    capture("churn_survey_submitted", { reason, plan: plan ?? null });
    try {
      void fetch("/api/billing/churn-survey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason,
          ...(detail.trim() ? { detail: detail.trim() } : {}),
        }),
      }).catch(() => {});
    } catch {
      // Fire-and-forget — never block the cancel path on the survey.
    }
  };

  const handleCancelAnyway = () => {
    submitSurvey();
    onCancelAnyway();
  };

  const offer = reason ? offerForReason(reason, plan) : null;

  return (
    <BillingDialog
      ariaLabel="Before you cancel"
      eyebrow="Before you cancel"
      title={<>What&rsquo;s making you cancel?</>}
      description="One question, then you can cancel either way."
      size="sm"
      onClose={onClose}
      footer={
        // Never trap: both exits always visible, no reason required.
        <>
          <button type="button" className={styles.quiet} onClick={onClose}>
            Never mind — keep my plan
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.secondary}`}
            onClick={handleCancelAnyway}
          >
            Cancel anyway
          </button>
        </>
      }
    >
      <fieldset className={styles.choices}>
        <legend className={styles.srOnly}>What&rsquo;s making you cancel?</legend>
        {REASON_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={styles.choice}
            data-selected={reason === option.value ? "true" : undefined}
          >
            <input
              type="radio"
              name="churn-reason"
              value={option.value}
              checked={reason === option.value}
              onChange={() => setReason(option.value)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>

      {reason === "other" && (
        <textarea
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder="What happened? (optional)"
          aria-label="Tell us more"
          rows={3}
          maxLength={2000}
          className={styles.textarea}
        />
      )}

      {offer && (
        <div data-testid="save-offer" className={styles.offer}>
          <h3 className={`serif ${styles.offerTitle}`}>{offer.title}</h3>
          <p className={styles.text}>{offer.body}</p>
          <a
            href={offer.ctaHref}
            onClick={() => {
              capture("churn_save_offer_clicked", { reason, plan: plan ?? null });
              submitSurvey();
            }}
            className={`mono ${styles.button} ${styles.primary}`}
          >
            {offer.ctaLabel}
          </a>
          {/* mailto links don't open a mail app everywhere, so the address is
              shown as text beside the link. */}
          <p className={styles.fineprint}>
            Or write to{" "}
            <span className={`mono notranslate ${styles.supportAddress}`} translate="no" data-testid="save-offer-address">
              {SUPPORT_EMAIL}
            </span>
          </p>
        </div>
      )}
    </BillingDialog>
  );
}
