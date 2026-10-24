'use client';

import { useEffect, useState, useRef, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { Loader2, ArrowRight } from "lucide-react";
import { captureClient } from "@/lib/telemetry/posthog-client";
import { ACTIVE_PLAN_KEYS, type Cadence, type PlanKey } from "@/lib/subscription";
import { FREE_ACCOUNT_SENTENCE, HOSTED_COMPUTE_NEEDS_PLAN_SHORT } from "@/lib/blog/plan-facts";
import { redirectToCheckoutUrl, requestSubscriptionCheckout } from "@/lib/billing/client";
import { BILLING_SUBSCRIBE_REASON } from "@/lib/billing/subscribe-errors";
import { buildAgentLaunchHref } from "@/lib/hivra/launch-navigation";
import { buildAgentTypeQuery, resolveWelcomeAgentTypeKey } from "@/lib/welcome-agent-catalog";
import InteractiveBackground from "@/components/InteractiveBackground";
import funnelStyles from "@/components/public-site/public-site.module.css";

const ACTIVATION_ROUTE = "/get-started/activate";

// Routed through captureClient (NOT the raw posthog singleton): PostHogProvider
// defers posthog.init() via requestIdleCallback (up to ~2s), so a raw
// posthog.capture() that fires before init completes is silently dropped.
// captureClient queues early calls and flushes them once init completes, and
// never throws, so funnel observability can't block signup or checkout.
function captureActivationEvent(event: string, properties: Record<string, unknown>) {
  captureClient(event, {
    source: "get-started-activate",
    route: ACTIVATION_ROUTE,
    ...properties,
  });
}

// Ash's words for this page (10-get-started-activate.md). The page hands a signed-in visitor straight on to
// checkout (or free activation), so there are no account steps to complete here: each state says what is
// really happening, under the same heading.
const ACTIVATE_HEADING = "Finish setting up your Hivra account.";
// A paid plan is about to run a computer. A free account is not: it works with a computer or server the
// person connects, and Hivra runs none for it (owner decision, 21 Oct 2026), so it must not be promised one.
const ACTIVATE_LEAD_PAID = "You\u2019re nearly ready to run your first computer.";
const ACTIVATE_LEAD_FREE = "Your free account is nearly ready.";

function ActivateHeading() {
  return (
    <h1 className="serif" style={{ fontSize: "1.75rem", fontWeight: 400, lineHeight: 1.2, marginBottom: "0.75rem" }}>
      {ACTIVATE_HEADING}
    </h1>
  );
}

function ActivateSmallPrint() {
  return (
    <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, margin: "1.75rem 0 0", textWrap: "pretty" }}>
      If an activation link has expired, request a new one through the <span style={{ whiteSpace: "nowrap" }}>sign-in</span>{" "}
      flow. Never share activation codes or links with somebody else.
    </p>
  );
}

/**
 * /get-started/activate
 *
 * This is the intermediate page Clerk redirects to after successful signup.
 * It automatically triggers the Stripe checkout flow for the selected plan.
 *
 * Also handles:
 * - legacy canceled=true URLs by forwarding them to the dedicated recovery page
 * - 409 recovery (existing session resumed automatically)
 */
export default function ActivatePage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <Loader2 size={24} style={{ opacity: 0.3, animation: "spin 1s linear infinite" }} />
      </div>
    }>
      <ActivatePageContent />
    </Suspense>
  );
}

function ActivatePageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();

  const planParam = searchParams?.get("plan");
  const planExplicit = Boolean(planParam && (ACTIVE_PLAN_KEYS as string[]).includes(planParam));
  // When the plan param is missing or invalid we fall back to Free, but we must
  // NOT silently auto-activate it — a paid user who loses the param would land
  // on Free without consent. `planExplicit` gates the auto-checkout effect below
  // so an inferred Free plan is surfaced for explicit confirmation instead.
  const planKey: PlanKey = planExplicit ? (planParam as PlanKey) : "free";
  // Yearly is opt-in via ?cadence=yearly (carried from the /get-started
  // toggle through Clerk's redirect). Free has no yearly price, so any stray
  // cadence param on a free signup falls back to monthly.
  const cadence: Cadence =
    searchParams?.get("cadence") === "yearly" && planKey !== "free" ? "yearly" : "monthly";
  const agentTypeKey = resolveWelcomeAgentTypeKey(searchParams?.get("agentType"));
  const agentTypeQuery = buildAgentTypeQuery(agentTypeKey);
  const lead = planKey === "free" ? ACTIVATE_LEAD_FREE : ACTIVATE_LEAD_PAID;

  // When Stripe cancel_url brings us back, ?canceled=true is set
  const wasCanceled = searchParams?.get("canceled") === "true";

  const [status, setStatus] = useState<"loading" | "subscribing" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const triggeredRef = useRef(false);
  const isMountedRef = useRef(true);
  const isNavigatingRef = useRef(false);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Funnel step: a signed-in user reached the activation page — the second step
  // of the onboarding funnel where issue #131 sees the ~88% drop from
  // /get-started. Fire once; canceled returns are handled by the recovery page.
  const pageViewedRef = useRef(false);
  useEffect(() => {
    if (!isLoaded || !isSignedIn || wasCanceled || pageViewedRef.current) return;
    pageViewedRef.current = true;
    captureActivationEvent("activation_page_viewed", {
      plan: planKey,
      cadence,
      authState: "signed_in",
    });
  }, [isLoaded, isSignedIn, wasCanceled, planKey, cadence]);

  const triggerCheckout = useCallback(async () => {
    captureActivationEvent("activation_started", {
      plan: planKey,
      authState: isSignedIn ? "signed_in" : "signed_out",
      checkoutCanceled: wasCanceled,
    });

    const result = await requestSubscriptionCheckout(planKey, cadence);

    if (result.ok) {
      if (result.activated) {
        // Launch, with the agent the visitor picked on the way in, if any.
        const destination = buildAgentLaunchHref(resolveWelcomeAgentTypeKey(searchParams?.get("agentType")));
        captureActivationEvent("activation_dashboard_reached", {
          plan: planKey,
          destination,
          outcome: "free_plan_activated",
        });
        isNavigatingRef.current = true;
        router.replace(destination);
        return;
      }

      // Funnel step (paid plans): a Stripe checkout session was minted and we
      // are handing the user off to it. Emitted before the navigation so the
      // event is sent even as the page unloads.
      captureActivationEvent("activation_checkout_redirected", {
        plan: planKey,
        cadence,
      });

      const navigation = redirectToCheckoutUrl(result.url);
      if (navigation.ok) {
        isNavigatingRef.current = true;
        return;
      }

      if (!isMountedRef.current || isNavigatingRef.current) return;
      captureActivationEvent("activation_failed", {
        plan: planKey,
        failureType: "checkout_navigation_blocked",
        recoverable: true,
      });
      setError(navigation.message);
      setStatus("error");
      return;
    }

    if (result.reason === BILLING_SUBSCRIBE_REASON.ACTIVE_SUBSCRIPTION) {
      captureActivationEvent("activation_dashboard_reached", {
        plan: planKey,
        destination: "/dashboard",
        outcome: "active_subscription",
      });
      isNavigatingRef.current = true;
      router.replace("/dashboard");
      return;
    }

    if (!isMountedRef.current || isNavigatingRef.current) return;
    captureActivationEvent("activation_failed", {
      plan: planKey,
      failureType: result.reason ?? "subscribe_request_failed",
      recoverable: true,
    });
    setError(result.message);
    setStatus("error");
  }, [cadence, isSignedIn, planKey, router, searchParams, wasCanceled]);

  useEffect(() => {
    if (wasCanceled) {
      router.replace(`/checkout/canceled?plan=${planKey}`);
      return;
    }
    if (!isLoaded || !isSignedIn) return;
    // No explicit plan in the URL — surface the choice instead of auto-activating
    // Free. The confirm-plan screen drives checkout explicitly via the buttons.
    if (!planExplicit) return;
    if (triggeredRef.current) return;
    triggeredRef.current = true;

    queueMicrotask(() => {
      if (isMountedRef.current && !isNavigatingRef.current) {
        setStatus("subscribing");
      }
    });
    queueMicrotask(() => {
      if (isMountedRef.current && !isNavigatingRef.current) {
        void triggerCheckout();
      }
    });
  }, [isLoaded, isSignedIn, wasCanceled, triggerCheckout, planKey, router, planExplicit]);

  function handleRetry() {
    triggeredRef.current = false;
    setStatus("subscribing");
    setError(null);
    void triggerCheckout();
  }

  // Wait for Clerk to load
  if (!isLoaded) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <Loader2 size={24} style={{ opacity: 0.3, animation: "spin 1s linear infinite" }} />
      </div>
    );
  }

  // Not signed in: send back to get-started
  if (!isSignedIn) {
    return (
      <main id="main-content" style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "2rem" }}>
        <div style={{ textAlign: "center", maxWidth: 440 }}>
          <ActivateHeading />
          <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: "0.75rem", lineHeight: 1.6 }}>{lead}</p>
          <p style={{ fontSize: 14, marginBottom: "1rem" }}>Please sign in to continue.</p>
          <a
            href={`/get-started?plan=${planKey}${cadence === "yearly" ? "&cadence=yearly" : ""}${agentTypeQuery}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              padding: "12px 24px",
              background: "var(--ink-black)", color: "var(--bg-surface)",
              textDecoration: "none",
              fontFamily: "var(--font-mono), monospace",
              fontSize: 11, fontWeight: 700, textTransform: "uppercase",
              letterSpacing: "0.12em",
            }}
          >
            Return to sign in <ArrowRight size={14} aria-hidden="true" />
          </a>
          <ActivateSmallPrint />
        </div>
      </main>
    );
  }

  if (wasCanceled) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <Loader2 size={24} style={{ opacity: 0.4, animation: "spin 1s linear infinite" }} />
          <span className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.15em", opacity: 0.5 }}>
            Loading checkout recovery...
          </span>
        </div>
      </div>
    );
  }

  // No explicit plan was passed — do NOT silently activate Free. Surface the
  // inferred plan so the user sees (and can correct) what they're activating.
  // Once they explicitly proceed, status flips to "subscribing"/"error" and the
  // normal loading/error card below takes over.
  if (!planExplicit && status === "loading") {
    return (
      <>
        <InteractiveBackground />
        <main id="main-content" className={funnelStyles.funnelPage} style={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: "2rem",
          position: "relative",
          zIndex: 10,
        }}>
          <div className={funnelStyles.funnelCard} style={{
            border: "1px solid var(--etched-border)",
            background: "var(--bg-surface)",
            padding: "3rem",
            maxWidth: 480,
            width: "100%",
            textAlign: "center",
            boxShadow: "0 24px 80px rgba(0,0,0,0.06)",
            position: "relative",
          }}>
            {/* Gold bar */}
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--gold-leaf)" }} />

            <ActivateHeading />
            <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: "1.5rem", lineHeight: 1.6 }}>{lead}</p>

            <h2 className="serif" style={{ fontSize: "1.15rem", fontWeight: 400, marginBottom: "0.75rem" }}>
              You&rsquo;re setting up a <em>free account</em>
            </h2>

            <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: "2rem", lineHeight: 1.6 }}>
              We didn&rsquo;t see a plan selection, so we&rsquo;ve defaulted to a free account. {FREE_ACCOUNT_SENTENCE}{" "}
              Confirm to continue, or choose a paid plan instead.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <button
                onClick={() => {
                  setStatus("subscribing");
                  void triggerCheckout();
                }}
                style={{
                  padding: "12px 24px",
                  background: "var(--ink-black)", color: "var(--bg-surface)",
                  border: "none", cursor: "pointer",
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: 11, fontWeight: 700, textTransform: "uppercase",
                  letterSpacing: "0.12em",
                }}
              >
                Continue with a free account
              </button>
              <a
                href={`/get-started${agentTypeQuery ? `?${agentTypeQuery.replace(/^&/, "")}` : ""}`}
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
                  padding: "12px 24px",
                  border: "1px solid var(--etched-border)",
                  color: "var(--ink-black)", textDecoration: "none",
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: 11, fontWeight: 700, textTransform: "uppercase",
                  letterSpacing: "0.12em",
                }}
              >
                Choose a plan <ArrowRight size={14} aria-hidden="true" />
              </a>
            </div>
            <ActivateSmallPrint />
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <InteractiveBackground />
      <main id="main-content" className={funnelStyles.funnelPage} style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
        position: "relative",
        zIndex: 10,
      }}>
        <div className={funnelStyles.funnelCard} style={{
          border: "1px solid var(--etched-border)",
          background: "var(--bg-surface)",
          padding: "3rem",
          maxWidth: 480,
          width: "100%",
          textAlign: "center",
          boxShadow: "0 24px 80px rgba(0,0,0,0.06)",
          position: "relative",
        }}>
          {/* Gold bar */}
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--gold-leaf)" }} />

          {/* ── ERROR STATE ── */}
          {status === "error" && (
            <>
              <ActivateHeading />
              <div style={{
                width: 48, height: 48, margin: "0 auto 1.5rem",
                display: "flex", alignItems: "center", justifyContent: "center",
                border: "1px solid rgba(239,68,68,0.3)",
                background: "rgba(239,68,68,0.05)",
              }}>
                <span aria-hidden="true" style={{ fontSize: 20 }}>×</span>
              </div>
              <h2 className="serif" style={{ fontSize: "1.15rem", fontWeight: 400, marginBottom: "0.75rem" }}>
                Something went wrong
              </h2>
              <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: "2rem", lineHeight: 1.6 }}>
                {error}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                <button
                  onClick={handleRetry}
                  style={{
                    padding: "12px 24px",
                    background: "var(--ink-black)", color: "var(--bg-surface)",
                    border: "none", cursor: "pointer",
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: 11, fontWeight: 700, textTransform: "uppercase",
                    letterSpacing: "0.12em",
                  }}
                >
                  Try again
                </button>
                <a
                  href="/dashboard/billing"
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 44, padding: "0 8px", fontSize: 13, color: "var(--text-secondary)", textDecoration: "none" }}
                >
                  or go to billing page <span aria-hidden="true">→</span>
                </a>
              </div>
              <ActivateSmallPrint />
            </>
          )}

          {/* ── LOADING / SUBSCRIBING STATE ── */}
          {(status === "loading" || status === "subscribing") && (
            <>
              {/* No step strip: Launch, which opens next, has the only step counter. */}
              {/* Loading animation */}
              <div style={{
                width: 56, height: 56, margin: "0 auto 1.5rem",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Loader2 size={32} style={{ animation: "spin 1.5s linear infinite", color: "var(--gold-leaf)" }} />
              </div>

              <ActivateHeading />

              <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: "0.75rem", lineHeight: 1.6 }}>
                {lead}
              </p>

              <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: "0.5rem", lineHeight: 1.6 }}>
                {planKey === "free"
                  ? `Launch opens next, where you can connect your own computer or server. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT}`
                  : "Preparing secure checkout. You\u2019ll choose what to launch once your plan is active."}
              </p>
              <ActivateSmallPrint />
            </>
          )}
        </div>
      </main>
    </>
  );
}
