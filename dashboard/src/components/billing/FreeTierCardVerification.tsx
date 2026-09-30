"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type StripeElementsOptions } from "@stripe/stripe-js";
import { AlertTriangle, CheckCircle2, CreditCard, Loader2 } from "lucide-react";

import { BillingDialog, billingDialogStyles as styles } from "@/components/billing/BillingDialog";
import { DEFAULT_CARD_REQUIRED_MESSAGE } from "@/lib/billing/card-required";
import { isCryptoBillingUiEnabled } from "@/lib/billing/format";

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

/**
 * Stripe's card form lives in an iframe that cannot read the dashboard's CSS
 * variables, so its appearance is resolved from the live tokens once the form
 * is created: light or dark to match the dashboard, square corners, ink text.
 */
function stripeAppearance(): NonNullable<StripeElementsOptions["appearance"]> {
  const root = typeof document !== "undefined" ? document.documentElement : null;
  const token = (name: string, fallback: string) => {
    if (!root || typeof getComputedStyle !== "function") return fallback;
    return getComputedStyle(root).getPropertyValue(name).trim() || fallback;
  };
  const dark = Boolean(root?.classList.contains("dark"));
  return {
    theme: dark ? "night" : "stripe",
    variables: {
      colorPrimary: token("--ink-black", dark ? "#fdfcf9" : "#111111"),
      colorText: token("--ink-black", dark ? "#fdfcf9" : "#111111"),
      colorBackground: token("--bg-surface", dark ? "#141414" : "#ffffff"),
      colorDanger: token("--red", "#dc2626"),
      borderRadius: "0px",
      fontFamily: "system-ui, sans-serif",
    },
  };
}

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
      appearance: stripeAppearance(),
    };
  }, [clientSecret]);

  if (!open) return null;

  return (
    <BillingDialog
      icon={<CreditCard size={17} />}
      eyebrow="Free plan"
      title="Card verification required"
      description={message || DEFAULT_CARD_REQUIRED_MESSAGE}
      onClose={onClose}
      // A stray tap outside must not throw away half-typed card details.
      dismissOnBackdrop={false}
    >
      {loading && (
        <div className={styles.text} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Loader2 size={15} className={styles.spin} aria-hidden="true" />
          Starting secure card verification...
        </div>
      )}

      {error && (
        <div role="alert" className={styles.callout} data-tone="danger">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {stripePromise && elementsOptions && (
        <Elements stripe={stripePromise} options={elementsOptions}>
          <FreeTierCardVerificationForm onVerified={onVerified} />
        </Elements>
      )}
    </BillingDialog>
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

  const disabled = !stripe || !elements || submitting;

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <PaymentElement options={{ layout: "tabs" }} />

      {error && (
        <div role="alert" className={styles.callout} data-tone="danger">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {verified && (
        <div role="status" className={styles.callout} data-tone="success">
          <CheckCircle2 size={14} aria-hidden="true" />
          <span>
            {retryReady
              ? "Your card is verified. If the launch didn't start again, launch it now."
              : "Card verified. Launching again…"}
          </span>
        </div>
      )}

      <button
        type={retryReady ? "button" : "submit"}
        disabled={disabled}
        aria-busy={submitting || undefined}
        onClick={retryReady ? () => void onVerified() : undefined}
        className={`${styles.button} ${styles.primary} ${styles.block}`}
      >
        {submitting && <Loader2 size={14} className={styles.spin} aria-hidden="true" />}
        {retryReady ? "Launch again" : submitting ? "Verifying..." : "Verify Card"}
      </button>

      <p className={styles.fineprint}>
        This is a fraud-prevention card-on-file check for Free plan access.
        {/* Token access is a way round the card only where it is on offer. */}
        {isCryptoBillingUiEnabled() ? " Crypto/token access does not require this card flow." : null}
      </p>
    </form>
  );
}
