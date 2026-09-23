'use client';

import { AlertCircle, AlertTriangle, Loader2, TrendingDown, TrendingUp } from 'lucide-react';

import { BillingDialog, billingDialogStyles as styles } from '@/components/billing/BillingDialog';

type ChangePlanMode = "in_place" | "checkout";

export interface ChangePlanResourceDiff {
  agents: number;
  cpu: number;
  ramGb: number;
}

interface ChangePlanModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  planName: string;
  priceInCents: number;
  loading: boolean;
  mode?: ChangePlanMode;
  /**
   * "downgrade" confirms a move to a smaller plan: it spells out what the
   * smaller plan takes away and how the proration credit works. Defaults to
   * "upgrade", whose copy is unchanged.
   */
  direction?: "upgrade" | "downgrade";
  /** The plan the user is on now (named in the downgrade copy). */
  currentPlanName?: string;
  /**
   * How much the plan's resources change. Only the size matters: signs are
   * ignored and `direction` says whether it is gained or lost.
   */
  resourceDiff?: ChangePlanResourceDiff;
  /**
   * Billing period of `priceInCents` on the upgrade/checkout ledger. A card
   * checkout can be yearly ("/yr", with the yearly price); an in-place change
   * and a downgrade always bill monthly. Defaults to "/mo".
   */
  priceUnit?: ChangePlanPriceUnit;
  /** Agents and computers the account has now (downgrade copy only). */
  agentsInUse?: number;
  /** Agent and computer slots on the smaller plan (downgrade copy only). */
  targetAgentSlots?: number;
}

export type ChangePlanPriceUnit = "/mo" | "/yr";

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function magnitude(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.abs(value) : 0;
}

/** Plain-English lines for what a downgrade removes. Zero and unknown values are skipped. */
export function describeResourceLoss(diff: ChangePlanResourceDiff | undefined): string[] {
  if (!diff) return [];
  const lines: string[] = [];
  const agents = magnitude(diff.agents);
  const cpu = magnitude(diff.cpu);
  const ramGb = magnitude(diff.ramGb);
  if (agents > 0) {
    lines.push(`${numberFormat.format(agents)} fewer agent and computer ${agents === 1 ? "slot" : "slots"}`);
  }
  if (cpu > 0) lines.push(`${numberFormat.format(cpu)} fewer vCPU`);
  if (ramGb > 0) lines.push(`${numberFormat.format(ramGb)} GB less memory`);
  return lines;
}

function formatPrice(priceInCents: number) {
  return `$${(priceInCents / 100).toFixed(2)}`;
}

function countOf(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * One sentence naming how far over the smaller plan's slot count the account
 * is, or null when that is unknown or it fits. The change-plan route does not
 * stop or remove anything, so this is the user's to fix.
 */
export function describeSlotOverage(
  planName: string,
  agentsInUse: number | undefined,
  targetAgentSlots: number | undefined
): string | null {
  const inUse = countOf(agentsInUse);
  const slots = countOf(targetAgentSlots);
  if (inUse === null || slots === null || inUse <= slots) return null;
  const over = inUse - slots;
  return `You have ${inUse} agents and computers; ${planName} has ${slots} ${slots === 1 ? "slot" : "slots"}. Remove ${over} before you launch another.`;
}

export function ChangePlanModal({
  isOpen,
  onClose,
  onConfirm,
  planName,
  priceInCents,
  loading,
  mode = "in_place",
  direction = "upgrade",
  currentPlanName,
  resourceDiff,
  priceUnit = "/mo",
  agentsInUse,
  targetAgentSlots,
}: ChangePlanModalProps) {
  if (!isOpen) return null;

  const isCheckoutMode = mode === "checkout";
  // A checkout is a new purchase, so it keeps the checkout copy even if the
  // caller labelled the move a downgrade.
  const isDowngrade = direction === "downgrade" && !isCheckoutMode;

  const cancelButton = (label: string) => (
    <button
      type="button"
      disabled={loading}
      onClick={onClose}
      className={`${styles.button} ${styles.secondary}`}
    >
      {label}
    </button>
  );

  const confirmButton = (label: string) => (
    <button
      type="button"
      onClick={onConfirm}
      disabled={loading}
      aria-busy={loading || undefined}
      className={`${styles.button} ${styles.primary}`}
    >
      {loading ? <Loader2 size={15} className={styles.spin} aria-hidden="true" /> : null}
      {loading ? 'Processing...' : label}
    </button>
  );

  if (isDowngrade) {
    const losses = describeResourceLoss(resourceDiff);
    const slotOverage = describeSlotOverage(planName, agentsInUse, targetAgentSlots);
    const fromPlan = currentPlanName || "your current plan";
    return (
      <BillingDialog
        icon={<TrendingDown size={18} />}
        eyebrow="Change plan"
        title={`Switch to ${planName}`}
        description={
          currentPlanName
            ? `You're moving from ${currentPlanName} to ${planName}. The change takes effect as soon as you confirm.`
            : `The change takes effect as soon as you confirm.`
        }
        onClose={onClose}
        closeDisabled={loading}
        footer={
          <>
            {cancelButton(currentPlanName ? `Keep ${currentPlanName}` : "Keep current plan")}
            {confirmButton(`Switch to ${planName}`)}
          </>
        }
      >
        <dl className={styles.ledger}>
          <div className={styles.ledgerRow}>
            <dt>New plan</dt>
            <dd>{planName}</dd>
          </div>
          <div className={styles.ledgerRow}>
            <dt>New recurring charge</dt>
            <dd>
              <span className={`serif ${styles.price}`}>{formatPrice(priceInCents)}</span>
              <span className={styles.priceUnit}>/mo</span>
            </dd>
          </div>
        </dl>

        <section aria-labelledby="change-plan-losses" style={{ display: 'grid', gap: '0.55rem' }}>
          <h3 id="change-plan-losses" className={`mono ${styles.label}`} style={{ margin: 0 }}>
            What you give up
          </h3>
          {losses.length > 0 ? (
            <ul className={styles.lossList}>
              {losses.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.text}>
              {planName}&apos;s smaller limits on agents, vCPU and memory apply right away.
            </p>
          )}
          {/* The change-plan route caps each agent at the smaller plan's
              per-agent size but never stops, removes or re-splits agents, so
              the copy must not promise that everything fits. */}
          <p className={styles.text}>
            Each agent is capped at {planName}&apos;s per-agent size. Nothing is stopped or re-split for you: if
            you&apos;re running more agents than {planName} allows, or they use more vCPU or memory than its pool,
            shrink or remove some before you launch or grow agents.
          </p>
          {slotOverage ? (
            <div role="note" className={styles.callout} data-tone="warning" data-testid="change-plan-slot-overage">
              <AlertTriangle size={16} aria-hidden="true" />
              <p style={{ margin: 0 }}>{slotOverage}</p>
            </div>
          ) : null}
        </section>

        <div className={styles.callout}>
          <AlertCircle size={16} aria-hidden="true" />
          <p style={{ margin: 0 }}>
            <strong>Proration credit.</strong> Stripe credits the unused time on {fromPlan} to your account.
            The credit comes off your next invoices; it isn&apos;t refunded to your card.
          </p>
        </div>
      </BillingDialog>
    );
  }

  const title = isCheckoutMode ? "Open Secure Checkout" : "Confirm Upgrade";
  const description = isCheckoutMode
    ? "This plan has to be changed through Stripe Checkout."
    : "You are about to upgrade your subscription plan.";
  const notice = isCheckoutMode
    ? "Your current access stays active while checkout is pending. New plan access starts after checkout completes."
    : "Your new plan's limits apply right away. The price difference for the rest of this billing period is added to your next invoice.";
  const confirmLabel = isCheckoutMode ? "Open Checkout" : "Confirm Upgrade";
  // Only a card checkout can be yearly; an in-place change bills monthly.
  const recurringUnit: ChangePlanPriceUnit = isCheckoutMode ? priceUnit : "/mo";

  return (
    <BillingDialog
      icon={<TrendingUp size={18} />}
      eyebrow="Change plan"
      title={title}
      description={description}
      onClose={onClose}
      closeDisabled={loading}
      footer={
        <>
          {cancelButton("Cancel")}
          {confirmButton(confirmLabel)}
        </>
      }
    >
      <dl className={styles.ledger}>
        <div className={styles.ledgerRow}>
          <dt>New Plan Selected</dt>
          <dd>
            <span className={`serif ${styles.price}`}>{planName}</span>
          </dd>
        </div>
        <div className={styles.ledgerRow}>
          <dt>New Recurring Charge</dt>
          <dd>
            <span className={`serif ${styles.price}`}>{formatPrice(priceInCents)}</span>
            <span className={styles.priceUnit}>{recurringUnit}</span>
          </dd>
        </div>
      </dl>

      <div className={styles.callout}>
        <AlertCircle size={16} aria-hidden="true" />
        <p style={{ margin: 0 }}>{notice}</p>
      </div>
    </BillingDialog>
  );
}
