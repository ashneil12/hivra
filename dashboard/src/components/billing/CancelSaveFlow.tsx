"use client";

// CancelSaveFlow — the one-question save step in front of subscription
// cancellation.
//
// Asks "What's making you cancel?" (radio), shows ONE save offer matched to
// the reason, and always keeps a clear "Cancel anyway" visible that proceeds
// with the original cancel flow unchanged (the billing page passes its
// existing portal handler). Never a trap: backdrop, X, "Keep my plan" and
// "Cancel anyway" all work at every step, with or without an answer.
//
// Persistence: on "Cancel anyway" (or accepting an offer) the answered
// survey is fire-and-forgotten to POST /api/billing/churn-survey and a
// churn_survey_submitted {reason, plan} PostHog event is captured. Failures
// in either are swallowed — observability must never block cancelling.

import { useState } from "react";
import { X } from "lucide-react";
import posthog from "posthog-js";

import type { ChurnSurveyReason } from "@/lib/billing/churn-survey";
import { PLANS, formatPrice } from "@/lib/subscription";

const SUPPORT_EMAIL = "info@hermesos.cloud";

const MONTHLY = PLANS.operator.price; // cents
const YEARLY = PLANS.operator.yearlyPrice; // cents
const YEARLY_SAVINGS_PCT = Math.round((1 - YEARLY / (MONTHLY * 12)) * 100); // ~34

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
  ctaHref: string;
};

function offerForReason(reason: ChurnSurveyReason): Offer {
  switch (reason) {
    case "too_expensive":
      return {
        title: "Yearly costs about a third less",
        body: `Pro yearly is ${formatPrice(YEARLY)}/yr instead of ${formatPrice(MONTHLY)}/mo — about ${YEARLY_SAVINGS_PCT}% off for the same plan.`,
        ctaLabel: `Switch to yearly — ${formatPrice(YEARLY)}/yr`,
        ctaHref: "/dashboard/billing?cadence=yearly&from=cancel_save",
      };
    case "not_using":
      return {
        title: "You could pause instead",
        body: "If you're just busy, email us and we'll pause your billing instead of losing your agent's setup and memory — picking back up later takes one reply.",
        ctaLabel: "Email us about pausing",
        ctaHref: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Pause my subscription")}`,
      };
    case "missing_feature":
      return {
        title: "Tell the founder what's missing",
        body: "Feature requests from cancelling users go to the top of the list. Replies land directly with Ash, the founder.",
        ctaLabel: "Email the founder",
        ctaHref: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Missing feature (was about to cancel)")}`,
      };
    case "something_broke":
      return {
        title: "Let us fix it first",
        body: "If something broke, that's on us. Email the founder directly — broken-for-a-paying-user is the first thing we fix.",
        ctaLabel: "Email the founder",
        ctaHref: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Something broke (was about to cancel)")}`,
      };
    case "other":
      return {
        title: "Tell us what happened",
        body: "Whatever it is, a one-line reply helps us fix it for the next person. Replies land directly with Ash, the founder.",
        ctaLabel: "Email the founder",
        ctaHref: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Why I cancelled")}`,
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
  /** Current plan key (e.g. "operator"), analytics + survey context only. */
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

  const offer = reason ? offerForReason(reason) : null;

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
        aria-label="Before you cancel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 460,
          border: "1px solid var(--ink-black)",
          background: "var(--bg-surface)",
          boxShadow: "4px 4px 0px var(--ink-black)",
          position: "relative", padding: "2rem",
          maxHeight: "85vh", overflowY: "auto",
        }}
      >
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

        <span className="mono" style={{
          fontFamily: "var(--font-mono), monospace", fontSize: 9, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: "0.15em", color: "var(--text-muted)",
        }}>
          Before you cancel
        </span>

        <h2 className="serif" style={{ fontSize: "1.5rem", fontWeight: 400, margin: "0.5rem 0 0.5rem", color: "var(--ink-black)" }}>
          What&rsquo;s making you cancel?
        </h2>
        <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, margin: "0 0 1rem" }}>
          One question, then you can cancel either way.
        </p>

        <fieldset style={{ border: "none", padding: 0, margin: "0 0 1rem", display: "flex", flexDirection: "column", gap: 8 }}>
          <legend style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
            What&rsquo;s making you cancel?
          </legend>
          {REASON_OPTIONS.map((option) => (
            <label
              key={option.value}
              style={{
                display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
                border: "1px solid var(--etched-border)",
                background: reason === option.value ? "var(--bg-elevated)" : "transparent",
                padding: "9px 12px", fontSize: 13, color: "var(--ink-black)",
              }}
            >
              <input
                type="radio"
                name="churn-reason"
                value={option.value}
                checked={reason === option.value}
                onChange={() => setReason(option.value)}
                style={{ accentColor: "var(--ink-black)" }}
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
            style={{
              width: "100%", boxSizing: "border-box", marginBottom: "1rem",
              border: "1px solid var(--etched-border)", background: "var(--bg-surface)",
              padding: "9px 12px", fontSize: 13, color: "var(--ink-black)",
              fontFamily: "inherit", resize: "vertical",
            }}
          />
        )}

        {offer && (
          <div
            data-testid="save-offer"
            style={{
              border: "1px solid var(--ink-black)", background: "var(--bg-elevated)",
              padding: "14px 16px", marginBottom: "1.25rem", position: "relative",
            }}
          >
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--gold-leaf)" }} />
            <h3 className="serif" style={{ fontSize: "1.05rem", fontWeight: 700, margin: "4px 0 6px", color: "var(--ink-black)" }}>
              {offer.title}
            </h3>
            <p style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.6, margin: "0 0 12px" }}>
              {offer.body}
            </p>
            <a
              href={offer.ctaHref}
              onClick={() => {
                capture("churn_save_offer_clicked", { reason, plan: plan ?? null });
                submitSurvey();
              }}
              className="mono"
              style={{
                display: "inline-block", padding: "10px 16px", textDecoration: "none",
                background: "var(--ink-black)", color: "var(--bg-surface)",
                border: "1px solid var(--ink-black)",
                fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em",
              }}
            >
              {offer.ctaLabel}
            </a>
          </div>
        )}

        {/* Never trap: both exits always visible, no reason required. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
          <button
            type="button"
            onClick={handleCancelAnyway}
            style={{
              width: "100%", boxSizing: "border-box", cursor: "pointer",
              padding: "12px 20px", background: "transparent",
              border: "1px solid var(--etched-border)", color: "var(--text-secondary)",
              fontFamily: "var(--font-mono), monospace",
              fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em",
            }}
          >
            Cancel anyway
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "none", background: "transparent", cursor: "pointer",
              fontSize: 12, color: "var(--text-muted)", padding: 4,
            }}
          >
            Never mind — keep my plan
          </button>
        </div>
      </div>
    </div>
  );
}
