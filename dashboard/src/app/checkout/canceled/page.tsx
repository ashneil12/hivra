'use client';

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { ArrowRight, CreditCard, Loader2 } from "lucide-react";

import { redirectToCheckoutUrl, requestSubscriptionCheckout } from "@/lib/billing/client";
import { BILLING_SUBSCRIBE_REASON } from "@/lib/billing/subscribe-errors";
import InteractiveBackground from "@/components/InteractiveBackground";
import funnelStyles from "@/components/public-site/public-site.module.css";
import { ACTIVE_PLAN_KEYS, PLANS, formatPrice, type PlanKey } from "@/lib/subscription";

const PLAN_GUIDE: Record<PlanKey, string> = {
  free: "Free is best for trying Hermes with one guarded agent before you need paid compute.",
  operator: "Pro is best for solo work, hackathon builds, and your first live agent.",
  fleet: "Power is best for multi-agent workflows, heavier browsing, and more shared compute.",
  command: "Command is best for the biggest jobs, faster scaling, and maximum compute headroom.",
};

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
  const planKey: PlanKey =
    planParam && (ACTIVE_PLAN_KEYS as string[]).includes(planParam)
      ? (planParam as PlanKey)
      : "fleet";
  const plan = PLANS[planKey];

  const [status, setStatus] = useState<"idle" | "subscribing" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleRetry() {
    setStatus("subscribing");
    setError(null);

    const result = await requestSubscriptionCheckout(planKey);

    if (result.ok) {
      if (result.activated) {
        window.location.href = "/dashboard/welcome?step=agent-type";
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
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: 420 }}>
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
            Sign Up <ArrowRight size={14} />
          </a>
        </div>
      </div>
    );
  }

  return (
    <>
      <InteractiveBackground />
      <div
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

          {status === "error" ? (
            <>
              <div
                style={{
                  width: 48,
                  height: 48,
                  margin: "0 auto 1.5rem",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid rgba(239,68,68,0.3)",
                  background: "rgba(239,68,68,0.05)",
                }}
              >
                <span style={{ fontSize: 20 }}>×</span>
              </div>
              <h1 className="serif" style={{ fontSize: "1.5rem", fontWeight: 400, marginBottom: "0.75rem" }}>
                Something went wrong
              </h1>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: "2rem", lineHeight: 1.6 }}>
                {error}
              </p>
            </>
          ) : (
            <>
              <div
                style={{
                  width: 48,
                  height: 48,
                  margin: "0 auto 1.5rem",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid var(--etched-border)",
                  background: "var(--bg-elevated)",
                }}
              >
                {status === "subscribing" ? (
                  <Loader2 size={20} style={{ animation: "spin 1.2s linear infinite", opacity: 0.6 }} />
                ) : (
                  <CreditCard size={20} style={{ opacity: 0.5 }} />
                )}
              </div>
              <h1 className="serif" style={{ fontSize: "1.5rem", fontWeight: 400, marginBottom: "0.75rem" }}>
                Checkout paused
              </h1>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: "2rem", lineHeight: 1.6 }}>
                You closed Stripe before completing payment, so <strong>nothing was charged</strong>. Your account is ready whenever you want to finish activating <strong>{plan.name}</strong>.
              </p>
            </>
          )}

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
                gap: 8,
                opacity: status === "subscribing" ? 0.8 : 1,
              }}
            >
              {status === "subscribing" ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <CreditCard size={13} />}
              {status === "subscribing" ? "Restarting Checkout..." : `Try Again — ${plan.name} - ${formatPrice(plan.price)}/mo`}
            </button>
            <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, margin: 0 }}>
              Secure Stripe checkout. If your previous checkout is still open, we&apos;ll resume it automatically.
            </p>
            <div
              style={{
                padding: "12px 14px",
                border: "1px solid var(--etched-border)",
                background: "var(--bg-elevated)",
                textAlign: "left",
              }}
            >
              <p
                className="mono"
                style={{
                  fontSize: 9,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  color: "var(--text-muted)",
                  margin: "0 0 0.5rem",
                  fontWeight: 700,
                }}
              >
                Need a different fit?
              </p>
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: "var(--text-secondary)" }}>
                {PLAN_GUIDE[planKey]}
              </p>
            </div>
            <a
              href={`/dashboard/welcome?plan=${planKey}`}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 44, padding: "0 8px", fontSize: 12, color: "var(--text-muted)", textDecoration: "none" }}
            >
              Choose a different plan →
            </a>
          </div>
        </div>
      </div>
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
