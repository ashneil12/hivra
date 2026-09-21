"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type StripeElementsOptions } from "@stripe/stripe-js";
import { AlertTriangle, CheckCircle2, CreditCard, Loader2, X } from "lucide-react";

import { DEFAULT_CARD_REQUIRED_MESSAGE } from "@/lib/billing/card-required";

const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
const stripePromise = publishableKey ? loadStripe(publishableKey) : null;
const WEBHOOK_SYNC_DELAY_MS = 1500;

type SetupIntentResponse = {
  success?: boolean;
  data?: {
    clientSecret?: unknown;
  };
  error?: unknown;
};

interface FreeTierCardVerificationProps {
  open: boolean;
  message?: string | null;
  onClose: () => void;
  onVerified: () => Promise<void> | void;
}

export function FreeTierCardVerification({
  open,
  message,
  onClose,
  onVerified,
}: FreeTierCardVerificationProps) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setClientSecret(null);
      setLoading(false);
      setError(null);
      return;
    }

    if (!stripePromise) {
      setError(
        "Card verification is not configured yet. Add NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY to enable this check."
      );
      return;
    }

    const controller = new AbortController();

    async function createSetupIntent() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch("/api/billing/setup-intent", {
          method: "POST",
          signal: controller.signal,
        });
        const json = (await response.json().catch(() => null)) as SetupIntentResponse | null;
        const clientSecretValue = json?.data?.clientSecret;

        if (!response.ok || !json?.success || typeof clientSecretValue !== "string") {
          throw new Error(
            typeof json?.error === "string" && json.error.trim()
              ? json.error
              : "Could not start card verification. Please try again."
          );
        }

        setClientSecret(clientSecretValue);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setError(err instanceof Error ? err.message : "Could not start card verification.");
      } finally {
        setLoading(false);
      }
    }

    void createSetupIntent();

    return () => controller.abort();
  }, [open]);

  const elementsOptions = useMemo<StripeElementsOptions | undefined>(() => {
    if (!clientSecret) return undefined;

    return {
      clientSecret,
      appearance: {
        theme: "stripe",
        variables: {
          colorPrimary: "#111111",
          colorText: "#111111",
          colorDanger: "#dc2626",
          borderRadius: "0px",
          fontFamily: "Inter, system-ui, sans-serif",
        },
      },
    };
  }, [clientSecret]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="free-tier-card-verification-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        background: "rgba(0,0,0,0.42)",
        backdropFilter: "blur(8px)",
      }}
    >
      <div
        style={{
          width: "min(100%, 520px)",
          background: "var(--bg-surface)",
          color: "var(--ink-black)",
          border: "1px solid var(--etched-border)",
          boxShadow: "0 24px 70px rgba(0,0,0,0.22)",
          padding: "clamp(1.25rem, 4vw, 2rem)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <div
            style={{
              width: 36,
              height: 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-elevated)",
              border: "1px solid var(--etched-border)",
              flexShrink: 0,
            }}
          >
            <CreditCard size={17} />
          </div>

          <div style={{ minWidth: 0, flex: 1 }}>
            <h2
              id="free-tier-card-verification-title"
              className="serif"
              style={{ margin: 0, fontSize: "1.35rem", fontWeight: 700, lineHeight: 1.2 }}
            >
              Card verification required
            </h2>
            <p style={{ margin: "0.5rem 0 0", fontSize: 13, lineHeight: 1.6, color: "var(--text-secondary)" }}>
              {message || DEFAULT_CARD_REQUIRED_MESSAGE}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close card verification"
            style={{
              width: 34,
              height: 34,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid var(--etched-border)",
              background: "transparent",
              color: "var(--ink-black)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <X size={15} />
          </button>
        </div>

        <div style={{ marginTop: "1.5rem" }}>
          {loading && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-secondary)" }}>
              <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} />
              Starting secure card verification...
            </div>
          )}

          {error && (
            <div
              role="alert"
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                border: "1px solid rgba(220,38,38,0.25)",
                background: "rgba(220,38,38,0.06)",
                padding: "0.85rem",
                color: "#991b1b",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{error}</span>
            </div>
          )}

          {stripePromise && elementsOptions && (
            <Elements stripe={stripePromise} options={elementsOptions}>
              <FreeTierCardVerificationForm onVerified={onVerified} />
            </Elements>
          )}
        </div>
      </div>
    </div>
  );
}

function FreeTierCardVerificationForm({
  onVerified,
}: {
  onVerified: () => Promise<void> | void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [retryReady, setRetryReady] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stripe || !elements || submitting) return;

    setSubmitting(true);
    setError(null);
    setRetryReady(false);

    const result = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
    });

    if (result.error) {
      setError(result.error.message ?? "Card verification failed. Please check the card details.");
      setSubmitting(false);
      return;
    }

    setVerified(true);
    await new Promise((resolve) => window.setTimeout(resolve, WEBHOOK_SYNC_DELAY_MS));
    await onVerified();
    if (!mountedRef.current) {
      return;
    }
    setRetryReady(true);
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <PaymentElement options={{ layout: "tabs" }} />

      {error && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            border: "1px solid rgba(220,38,38,0.25)",
            background: "rgba(220,38,38,0.06)",
            padding: "0.85rem",
            color: "#991b1b",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{error}</span>
        </div>
      )}

      {verified && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            border: "1px solid rgba(22,163,74,0.25)",
            background: "rgba(22,163,74,0.06)",
            padding: "0.85rem",
            color: "#166534",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <CheckCircle2 size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            {retryReady
              ? "Card verification is saved. If provisioning did not resume, retry deployment now."
              : "Card verification accepted. Retrying deployment..."}
          </span>
        </div>
      )}

      <button
        type={retryReady ? "button" : "submit"}
        disabled={!stripe || !elements || submitting}
        onClick={retryReady ? () => void onVerified() : undefined}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          width: "100%",
          minHeight: 46,
          border: "none",
          background: "var(--btn-bg)",
          color: "var(--btn-text)",
          cursor: !stripe || !elements || submitting ? "not-allowed" : "pointer",
          opacity: !stripe || !elements || submitting ? 0.65 : 1,
          fontFamily: "var(--font-mono), monospace",
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.12em",
        }}
      >
        {submitting && <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />}
        {retryReady ? "Retry Deployment" : submitting ? "Verifying..." : "Verify Card"}
      </button>

      <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" }}>
        This is a fraud-prevention card-on-file check for Free plan access. Crypto/token access does not
        require this card flow.
      </p>
    </form>
  );
}
