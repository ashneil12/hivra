"use client";

import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  Cpu,
  Loader2,
  MemoryStick,
  X,
} from "lucide-react";
import { useRef, useState, type RefObject } from "react";

import {
  redirectToCheckoutUrl,
  requestSubscriptionCheckout,
} from "@/lib/billing/client";
import { BILLING_SUBSCRIBE_REASON } from "@/lib/billing/subscribe-errors";
import { PLANS, type PlanKey } from "@/lib/subscription";

import styles from "./Infrastructure.module.css";
import { useInfrastructureDialog } from "./useInfrastructureDialog";

type PaidPlanKey = Extract<PlanKey, "operator" | "fleet">;

const PAID_PLANS: PaidPlanKey[] = ["operator", "fleet"];

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function HivraCloudPurchaseDialog({
  onClose,
  onActivated,
  returnFocusRef,
}: {
  onClose: () => void;
  onActivated: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [selectedPlan, setSelectedPlan] = useState<PaidPlanKey>("operator");
  const [cadence, setCadence] = useState<"monthly" | "yearly">("monthly");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useInfrastructureDialog({
    onClose,
    closeOnEscape: !submitting,
    initialFocusRef: closeButtonRef,
    returnFocusRef,
  });

  async function continueToCheckout() {
    setSubmitting(true);
    setError(null);
    const result = await requestSubscriptionCheckout(selectedPlan, cadence);
    if (!result.ok) {
      if (result.reason === BILLING_SUBSCRIBE_REASON.ACTIVE_SUBSCRIPTION) {
        onActivated();
        return;
      }
      setSubmitting(false);
      setError(result.message);
      return;
    }
    if (result.activated) {
      onActivated();
      return;
    }
    const navigation = redirectToCheckoutUrl(result.url);
    if (!navigation.ok) {
      setSubmitting(false);
      setError(navigation.message);
    }
  }

  return (
    <div className={styles.modalBackdrop}>
      <section
        ref={dialogRef}
        className={`${styles.wizard} ${styles.hivraCloudPurchaseDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hivra-cloud-purchase-title"
        tabIndex={-1}
      >
        <header className={styles.wizardHeader}>
          <div>
            <span className={styles.eyebrow}>Managed capacity</span>
            <h1 id="hivra-cloud-purchase-title">Choose Hivra Cloud power</h1>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            disabled={submitting}
            aria-label="Close Hivra Cloud purchase"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.wizardBody}>
          <div className={styles.providerGuide}>
            <span className={styles.providerGuideIcon} aria-hidden="true"><Cloud size={20} /></span>
            <div>
              <strong>Hivra operates the servers for you.</strong>
              <p>
                Choose a compute pool now. When you launch an agent, you decide how
                much of that CPU and RAM the computer receives.
              </p>
            </div>
          </div>

          <div className={styles.cloudCadence} role="group" aria-label="Billing cadence">
            <button
              type="button"
              aria-pressed={cadence === "monthly"}
              className={cadence === "monthly" ? styles.cloudCadenceActive : ""}
              onClick={() => setCadence("monthly")}
              disabled={submitting}
            >
              Monthly
            </button>
            <button
              type="button"
              aria-pressed={cadence === "yearly"}
              className={cadence === "yearly" ? styles.cloudCadenceActive : ""}
              onClick={() => setCadence("yearly")}
              disabled={submitting}
            >
              Yearly
            </button>
          </div>

          <div className={styles.cloudPlanGrid} role="radiogroup" aria-label="Hivra Cloud plan">
            {PAID_PLANS.map((key) => {
              const plan = PLANS[key];
              const selected = selectedPlan === key;
              const price = cadence === "yearly" ? plan.yearlyPrice : plan.price;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`${styles.cloudPlanOption} ${selected ? styles.cloudPlanOptionActive : ""}`}
                  onClick={() => setSelectedPlan(key)}
                  disabled={submitting}
                >
                  <span className={styles.cloudPlanCheck} aria-hidden="true">
                    {selected ? <Check size={13} /> : null}
                  </span>
                  <span className={styles.sectionLabel}>{key === "operator" ? "Balanced" : "More headroom"}</span>
                  <strong>{plan.name}</strong>
                  <span className={styles.cloudPlanPrice}>
                    {money(price)} <small>/ {cadence === "yearly" ? "year" : "month"}</small>
                  </span>
                  <span className={styles.cloudPlanFact}><Cpu size={13} aria-hidden="true" /> {plan.totalCpu} vCPU pool</span>
                  <span className={styles.cloudPlanFact}><MemoryStick size={13} aria-hidden="true" /> {plan.totalRam / 1024} GB RAM pool</span>
                  <span className={styles.cloudPlanFact}>{plan.maxAgents} active agents</span>
                </button>
              );
            })}
          </div>

          <div className={styles.providerSafetyNote}>
            <Check size={17} aria-hidden="true" />
            <div>
              <strong>No charge happens in this window.</strong>
              <span>
                Continue opens secure Stripe Checkout with the selected plan and cadence.
                The final amount is confirmed there before payment.
              </span>
            </div>
          </div>

          {error ? (
            <div className={styles.formError} role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}

          <div className={styles.wizardActions}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={submitting}>
              <ArrowLeft size={14} aria-hidden="true" /> Cancel
            </button>
            <button type="button" className={styles.primaryButton} onClick={() => void continueToCheckout()} disabled={submitting}>
              {submitting ? <Loader2 size={15} className={styles.spin} aria-hidden="true" /> : <Cloud size={15} aria-hidden="true" />}
              {submitting ? "Opening checkout..." : "Continue to secure checkout"}
              {!submitting ? <ArrowRight size={14} aria-hidden="true" /> : null}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
