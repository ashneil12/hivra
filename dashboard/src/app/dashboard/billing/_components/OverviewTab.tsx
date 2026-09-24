'use client';

import { ArrowRight, ChevronRight, CreditCard, Loader2, RefreshCw, Shield, ShieldCheck } from "lucide-react";
import { formatMicroUsd } from "@/components/billing/ManagedVeniceSubsidyBanner";
import { FREE_IDLE_SLEEP_DAYS, activePlanPriceLine } from "@/lib/billing/plan-display";
import { interpolateCopy } from "@/lib/billing/format";
import type { BillingController } from "../useBillingController";
import type { BillingTabId } from "./billing-tabs";
import { EmptyPlate, RatingPlate } from "./RatingPlate";
import styles from "../Billing.module.css";

export interface OverviewCopy {
  plateEyebrow: string;
  changePlan: string;
  noPlanTitle: string;
  manageSubscription: string;
  opening: string;
  slots: string;
  cpu: string;
  memory: string;
  creditsTitle: string;
  creditsAvailable: string;
  plate: {
    slots: string;
    vcpu: string;
    memory: string;
    idlePolicy: string;
    alwaysOn: string;
    /** "Sleeps after {days} idle days" */
    sleepsAfterIdle: string;
  };
}

/**
 * Model credits the user can spend right now: the card wallet plus the
 * $HermesOS wallet (Credits shows each one).
 */
export function availableModelCreditsMicroUsd(summary: {
  wallets: { card: { availableMicroUsd: number }; hermesos: { availableMicroUsd: number } };
}): number {
  return summary.wallets.card.availableMicroUsd + summary.wallets.hermesos.availableMicroUsd;
}

/** Why a paid plan that holds the account runs nothing, and how it is
 * settled. Only what billing observed: the row's status. */
export function planOnHoldText(hold: { reason: "payment_overdue" | "no_slots"; billingPortal: boolean }): string {
  if (hold.reason === "payment_overdue") {
    return hold.billingPortal
      ? "A payment didn't go through, so this plan isn't active right now. Pay the open invoice or update your card in the billing portal."
      : "A payment didn't go through, so this plan isn't active right now. Contact support to settle it.";
  }
  return hold.billingPortal
    ? "This plan has no agent slots right now. Check your subscription in the billing portal."
    : "This plan has no agent slots right now. Contact support to check it.";
}

/** True when the card controls (Stripe portal) apply to this plan. */
export function paysByCard(plan: { key: string; source?: string } | null | undefined): boolean {
  if (!plan || plan.key === "free") return false;
  return plan.source === "stripe" || !plan.source;
}

export function OverviewTab({
  c,
  copy,
  refreshing,
  onGoTo,
  onRefresh,
}: {
  c: BillingController;
  copy: OverviewCopy;
  refreshing: boolean;
  onGoTo: (tab: BillingTabId) => void;
  onRefresh: () => void;
}) {
  const plan = c.data?.plan ?? null;
  const usage = c.data?.usage ?? null;
  const hasPlan = Boolean(c.data?.subscribed && plan && usage);
  const planOnHold = hasPlan ? null : c.data?.planOnHold ?? null;
  const management = c.subscriptionManagement;
  const showPortal = management.showStripePortalButton && paysByCard(plan);

  // Backups: shown only when something is true or can be bought. The add-on
  // is offered only where the backup route would accept it.
  const addonTargetId = c.backupAddonInstanceIds[0] ?? null;
  const backupsIncluded = Boolean(c.backupAddon?.includedWithPlan);
  const hasBackupAddon = usage?.instances.some((instance) => instance.backups_enabled) ?? false;
  const showBackups =
    Boolean(usage && usage.instances.length > 0) && (backupsIncluded || hasBackupAddon || addonTargetId !== null);
  const includedOnly = backupsIncluded && !hasBackupAddon;

  return (
    <div className={styles.stack}>
      {hasPlan && plan && usage ? (
        <RatingPlate
          plan={plan}
          usage={usage}
          eyebrow={copy.plateEyebrow}
          priceLine={activePlanPriceLine({
            planKey: plan.key,
            source: plan.source,
            currentPeriodEnd: plan.currentPeriodEnd,
          })}
          specLabels={copy.plate}
          idlePolicy={
            plan.key === "free"
              ? interpolateCopy(copy.plate.sleepsAfterIdle, { days: String(FREE_IDLE_SLEEP_DAYS) })
              : copy.plate.alwaysOn
          }
          labels={{ slots: copy.slots, cpu: copy.cpu, memory: copy.memory }}
          actions={
            <>
              <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => onGoTo("plans")}>
                {copy.changePlan}
                <ArrowRight size={14} aria-hidden="true" />
              </button>

              {/* Management controls are routed by source: Apple IAP
                  subscriptions are managed in the App Store, never the
                  Stripe portal; $HermesOS plans have no card to manage. */}
              {showPortal && (
                <button
                  type="button"
                  className={`${styles.button} ${styles.secondary}`}
                  onClick={() => void c.handlePortal()}
                  disabled={c.portalLoading}
                >
                  {c.portalLoading ? (
                    <Loader2 size={14} className={styles.spin} aria-hidden="true" />
                  ) : (
                    <CreditCard size={14} aria-hidden="true" />
                  )}
                  {c.portalLoading ? copy.opening : copy.manageSubscription}
                </button>
              )}

              {management.showAppleManageLink && (
                <a
                  href={management.appleManageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${styles.button} ${styles.secondary}`}
                >
                  <CreditCard size={14} aria-hidden="true" />
                  Manage in the App Store
                </a>
              )}

              <button
                type="button"
                className={styles.iconButton}
                onClick={onRefresh}
                disabled={refreshing}
                aria-label="Refresh usage"
                title="Refresh usage"
              >
                <RefreshCw size={15} className={refreshing ? styles.spin : undefined} aria-hidden="true" />
              </button>

              {management.showStripeCancelButton && (
                <button
                  type="button"
                  className={`${styles.textButton} ${styles.plateActionsEnd}`}
                  onClick={() => c.setShowCancelSaveFlow(true)}
                >
                  Cancel subscription
                </button>
              )}
            </>
          }
        />
      ) : planOnHold ? (
        <EmptyPlate
          eyebrow={copy.plateEyebrow}
          title={`${planOnHold.name} plan on hold`}
          text={planOnHoldText(planOnHold)}
          action={
            <>
              {planOnHold.billingPortal ? (
                <button
                  type="button"
                  className={`${styles.button} ${styles.primary}`}
                  onClick={() => void c.handlePortal()}
                  disabled={c.portalLoading}
                >
                  {c.portalLoading ? (
                    <Loader2 size={14} className={styles.spin} aria-hidden="true" />
                  ) : (
                    <CreditCard size={14} aria-hidden="true" />
                  )}
                  {c.portalLoading ? copy.opening : "Open billing portal"}
                </button>
              ) : (
                // A live Stripe subscription still bills this plan, so a new
                // plan would be refused until it is settled in the portal.
                // Without one (a manual or token plan), Checkout still works.
                <button
                  type="button"
                  className={`${styles.button} ${styles.primary}`}
                  onClick={() => onGoTo("plans")}
                >
                  See plans
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              )}
            </>
          }
        />
      ) : (
        <EmptyPlate
          eyebrow={copy.plateEyebrow}
          title={copy.noPlanTitle}
          text="Pick a plan to run agents and computers on Hivra's servers."
          action={
            <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => onGoTo("plans")}>
              Choose a plan
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          }
        />
      )}

      {c.flags.billingV2Enabled && (
        <div className={styles.tiles}>
          <button type="button" className={styles.tile} onClick={() => onGoTo("credits")}>
            <span className={styles.tileLabel}>{copy.creditsTitle}</span>
            <span className={styles.tileValue}>{c.creditBalance.toLocaleString()}</span>
            <span className={styles.tileSub}>{copy.creditsAvailable}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          {c.managedVeniceSummary && (
            <button type="button" className={styles.tile} onClick={() => onGoTo("credits")}>
              <span className={styles.tileLabel}>Model credits</span>
              <span className={styles.tileValue}>
                {formatMicroUsd(availableModelCreditsMicroUsd(c.managedVeniceSummary))}
              </span>
              <span className={styles.tileSub}>available for managed models</span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {showBackups && (
        <section className={styles.panel} aria-labelledby="billing-backups-title">
          <div className={styles.panelHead}>
            <div>
              <p className={styles.panelEyebrow}>{includedOnly ? "Backups" : "Server backup add-on"}</p>
              <h3 className={styles.panelTitle} id="billing-backups-title">
                {includedOnly ? "Daily backups" : "Daily snapshots"}
              </h3>
              <p className={styles.panelText}>
                {includedOnly
                  ? "Included with your plan. Your machines are backed up automatically every day."
                  : "Server-level protection. Full disk snapshots created every 24 hours, retained for 7 days."}
              </p>
            </div>
            <div className={styles.controlRow}>
              {c.backupsEnabled ? (
                <span className={`${styles.statusTag} ${styles.statusGood}`}>
                  <ShieldCheck size={13} aria-hidden="true" /> Protected
                </span>
              ) : (
                <span className={styles.statusTag}>
                  <Shield size={13} aria-hidden="true" /> Not protected
                </span>
              )}
              <span className={styles.priceTag}>{includedOnly ? "Included" : "+$10/mo"}</span>
            </div>
          </div>

          {/* Also disabled during a usage refresh, so the button never acts
              on data from before the last change. */}
          {!c.backupsEnabled && addonTargetId && (
            <div className={styles.panelActions}>
              <button
                type="button"
                className={`${styles.button} ${styles.secondary}`}
                onClick={() => void c.handleEnableBackup(addonTargetId)}
                disabled={!!c.enablingBackup || refreshing}
              >
                {c.enablingBackup ? (
                  <Loader2 size={14} className={styles.spin} aria-hidden="true" />
                ) : (
                  <ShieldCheck size={14} aria-hidden="true" />
                )}
                {c.enablingBackup ? "Enabling..." : "Enable Daily Backups — $10/mo"}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
