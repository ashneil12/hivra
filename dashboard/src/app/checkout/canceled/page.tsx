'use client';

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { ArrowRight, CreditCard, Loader2 } from "lucide-react";

import { redirectToCheckoutUrl, requestSubscriptionCheckout } from "@/lib/billing/client";
import { BILLING_SUBSCRIBE_REASON } from "@/lib/billing/subscribe-errors";
import { planReturnParams, safeReturnPath, withReturnParams } from "@/lib/safe-return-path";
import { LAUNCH_ROUTE } from "@/lib/hivra/launch-navigation";
import InteractiveBackground from "@/components/InteractiveBackground";
import funnelStyles from "@/components/public-site/public-site.module.css";
import { ACTIVE_PLAN_KEYS, type PlanKey } from "@/lib/subscription";
import { formatPlanSize, type PlanSizeKey } from "@/lib/blog/plan-facts";

// Ash's words for this page (13-checkout-canceled.md). The page only knows that this checkout attempt was
// left; whether a payment completed elsewhere is the billing page's to say, so the words point there.
const CANCELED_HEADING = "Your checkout wasn\u2019t completed.";
const CANCELED_LEAD =
  "No subscription has been activated through this checkout attempt. You can return to pricing, review your plan and try again whenever you\u2019re ready.";

/** The two paid sizes the site names by price and size, never by plan name. */
const PLAN_SIZE_KEY: Partial<Record<PlanKey, PlanSizeKey>> = { operator: "entry", fleet: "larger" };

const QUIET_LINK_STYLE = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  minHeight: 44,
  padding: "0 8px",
  fontSize: 13,
  textDecoration: "none",
} as const;

/** Billing's Plans tab, keeping the way back to where checkout started. */
function differentPlanHref(returnTo: string | null): string {
  const query = new URLSearchParams({ tab: "plans" });
  if (returnTo) query.set("returnTo", returnTo);
  return `/dashboard/billing?${query.toString()}`;
}

function CheckoutCanceledFallback() {
  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
      <Loader2 size={24} style={{ opacity: 0.3, animation: "spin 1s linear infinite" }} />
    </div>
  );
}

function CheckoutCanceledContent() {
  const searchParams = useSearchParams();
  const { isLoaded, isSignedIn } = useAuth();

  const planParam = searchParams?.get("plan");
  // With no plan in the link the retry is the entry size, like /get-started. It never
  // starts a checkout for the dearer size the person did not pick.
  const planKey: PlanKey =
    planParam && (ACTIVE_PLAN_KEYS as string[]).includes(planParam)
      ? (planParam as PlanKey)
      : "operator";
  const sizeKey = PLAN_SIZE_KEY[planKey];
  const planLine = sizeKey ? formatPlanSize(sizeKey, "compact") : null;
  // Checkout started from a launch (or another dashboard page) goes back
  // there. Only a same-origin dashboard path is ever followed.
  const returnTo = safeReturnPath(searchParams?.get("returnTo"));

  const [status, setStatus] = useState<"idle" | "subscribing" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleRetry() {
    setStatus("subscribing");
    setError(null);

    const result = await requestSubscriptionCheckout(planKey, "monthly", { returnTo });

    if (result.ok) {
      if (result.activated) {
        window.location.href = withReturnParams(returnTo ?? LAUNCH_ROUTE, planReturnParams(planKey));
        return;
      }

      const navigation = redirectToCheckoutUrl(result.url);
      if (!navigation.ok) {
        setError(navigation.message);
        setStatus("error");
        return;
      }
      return;
    }

    if (result.reason === BILLING_SUBSCRIBE_REASON.ACTIVE_SUBSCRIPTION) {
      window.location.href = "/dashboard";
      return;
    }

    setError(result.message);
    setStatus("error");
  }

  if (!isLoaded) {
    return <CheckoutCanceledFallback />;
  }

  if (!isSignedIn) {
    return (
      <main id="main-content" style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: 440, padding: "2rem" }}>
          <h1 className="serif" style={{ fontSize: "1.75rem", fontWeight: 400, lineHeight: 1.2, marginBottom: "0.75rem" }}>
            {CANCELED_HEADING}
          </h1>
          <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: "1.5rem", lineHeight: 1.6 }}>{CANCELED_LEAD}</p>
          <p style={{ fontSize: 14, marginBottom: "1rem" }}>Please sign in to restart checkout.</p>
          <a
            href={`/get-started?plan=${planKey}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 24px",
              background: "var(--ink-black)",
              color: "var(--bg-surface)",
              textDecoration: "none",
              fontFamily: "var(--font-mono), monospace",
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
            }}
          >
            Sign Up <ArrowRight size={14} aria-hidden="true" />
          </a>
          {/* The lead says "return to pricing", so the way there is on the page for someone who is not signed in too. */}
          <div style={{ marginTop: "0.75rem" }}>
            <a href="/pricing" style={{ ...QUIET_LINK_STYLE, color: "var(--ink-black)" }}>
              Back to pricing
            </a>
          </div>
        </div>
      </main>
    );
  }

  return (
    <>
      <InteractiveBackground />
      <main
        id="main-content"
        className={funnelStyles.funnelPage}
        style={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: "2rem",
          position: "relative",
          zIndex: 10,
        }}
      >
        <div
          className={funnelStyles.funnelCard}
          style={{
            border: "1px solid var(--etched-border)",
            background: "var(--bg-surface)",
            padding: "3rem",
            maxWidth: 480,
            width: "100%",
            textAlign: "center",
            boxShadow: "0 24px 80px rgba(0,0,0,0.06)",
            position: "relative",
          }}
        >
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--gold-leaf)" }} />

          <div
            style={{
              width: 48,
              height: 48,
              margin: "0 auto 1.5rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: status === "error" ? "1px solid rgba(239,68,68,0.3)" : "1px solid var(--etched-border)",
              background: status === "error" ? "rgba(239,68,68,0.05)" : "var(--bg-elevated)",
            }}
          >
            {status === "error" ? (
              <span aria-hidden="true" style={{ fontSize: 20 }}>×</span>
            ) : status === "subscribing" ? (
              <Loader2 size={20} style={{ animation: "spin 1.2s linear infinite", opacity: 0.6 }} />
            ) : (
              <CreditCard size={20} style={{ opacity: 0.5 }} />
            )}
          </div>
          <h1 className="serif" style={{ fontSize: "1.75rem", fontWeight: 400, lineHeight: 1.2, marginBottom: "0.75rem" }}>
            {CANCELED_HEADING}
          </h1>
          {status === "error" ? (
            <p role="alert" style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: "1rem", lineHeight: 1.6 }}>
              {error}
            </p>
          ) : null}
          <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: "1rem", lineHeight: 1.6 }}>{CANCELED_LEAD}</p>
          <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: "2rem", lineHeight: 1.6 }}>
            If you expected a payment to succeed, check your{" "}
            <a href="/dashboard/billing" style={{ color: "var(--ink-black)", textDecoration: "underline", textUnderlineOffset: 3 }}>
              billing page
            </a>{" "}
            before trying again to avoid duplicate attempts.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <button
              onClick={handleRetry}
              disabled={status === "subscribing"}
              style={{
                padding: "13px 24px",
                background: "var(--ink-black)",
                color: "var(--bg-surface)",
                border: "none",
                cursor: status === "subscribing" ? "wait" : "pointer",
                fontFamily: "var(--font-mono), monospace",
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexWrap: "wrap",
                gap: "4px 10px",
                opacity: status === "subscribing" ? 0.8 : 1,
              }}
            >
              {status === "subscribing" ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <CreditCard size={13} />}
              {status === "subscribing" ? "Restarting checkout..." : "Try again"}
              {status !== "subscribing" && planLine ? (
                <span style={{ fontSize: 11, letterSpacing: "0.04em", textTransform: "none", opacity: 0.8 }}>{planLine}</span>
              ) : null}
            </button>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5, margin: 0 }}>
              Secure Stripe checkout. If your previous checkout is still open, we&apos;ll resume it automatically.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "0 20px" }}>
              <a href="/pricing" style={{ ...QUIET_LINK_STYLE, color: "var(--ink-black)" }}>
                Back to pricing
              </a>
              <a href="/dashboard" style={{ ...QUIET_LINK_STYLE, color: "var(--ink-black)" }}>
                Open dashboard
              </a>
            </div>
            {returnTo ? (
              <a
                href={returnTo}
                style={{ ...QUIET_LINK_STYLE, color: "var(--text-secondary)" }}
              >
                <span aria-hidden="true">← </span>
                {returnTo.startsWith("/dashboard/launch") ? "Back to your launch" : "Back"}
              </a>
            ) : null}
            <a
              href={differentPlanHref(returnTo)}
              style={{ ...QUIET_LINK_STYLE, color: "var(--text-secondary)" }}
            >
              Choose a different plan <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
      </main>
    </>
  );
}

export default function CheckoutCanceledPage() {
  return (
    <Suspense fallback={<CheckoutCanceledFallback />}>
      <CheckoutCanceledContent />
    </Suspense>
  );
}
