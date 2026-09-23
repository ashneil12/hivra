'use client';

import type { Ref } from "react";
import { AlertTriangle, CheckCircle, Info, Loader2, ShieldCheck, X } from "lucide-react";
import { ReportProblemLink } from "@/components/support/ReportProblemLink";
import type { BillingController } from "../useBillingController";
import styles from "../Billing.module.css";

/**
 * Page-level messages, shown above the tabs whichever tab is open: checkout
 * and top-up results, a checkout that could not be confirmed, the backup
 * intent from the console, and a plan change that did not go through.
 */
/**
 * Small red text on the danger alert background: the danger token darkened
 * with ink so it keeps WCAG AA contrast in the light theme (the plain token
 * is about 3.5:1 there) and stays light in the dark theme.
 */
export const DANGER_INK = "color-mix(in srgb, var(--skills-danger-text) 78%, var(--ink-black))";

export function BillingAlerts({
  c,
  containerRef,
}: {
  c: BillingController;
  /** The alerts region; the page scrolls it into view and focuses it after a plan change. */
  containerRef?: Ref<HTMLDivElement>;
}) {
  const backupTargetId = c.backupIntentTargetId;

  return (
    <div className={styles.alerts} ref={containerRef} tabIndex={-1} data-testid="billing-alerts">
      {c.successMsg && (
        <div className={`${styles.alert} ${styles.alertSuccess}`} role="status">
          <span className={styles.alertIcon} aria-hidden="true">
            <CheckCircle size={16} />
          </span>
          <div className={styles.alertBody}>
            <p className={styles.alertText}>{c.successMsg}</p>
          </div>
          <button type="button" className={styles.dismiss} aria-label="Close" onClick={() => c.setSuccessMsg(null)}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      {c.checkoutConfirmError && (
        <div className={`${styles.alert} ${styles.alertDanger}`} role="alert">
          <span className={styles.alertIcon} aria-hidden="true">
            <AlertTriangle size={16} />
          </span>
          <div className={styles.alertBody}>
            <p className={styles.alertTitle}>Checkout not confirmed</p>
            <p className={styles.alertText}>{c.checkoutConfirmError}</p>
            <div className={styles.alertActions}>
              <ReportProblemLink
                surface="billing-checkout"
                summary="Checkout not confirmed"
                errorContext={c.checkoutConfirmError}
                style={{ color: DANGER_INK }}
              />
              <button type="button" className={styles.textButton} onClick={() => c.setCheckoutConfirmError(null)}>
                Dismiss
              </button>
            </div>
          </div>
          <span aria-hidden="true" />
        </div>
      )}

      {c.shouldShowBackupIntent && backupTargetId && (
        <div className={styles.intentRow}>
          <div className={styles.intentText}>
            <ShieldCheck size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 3 }} />
            <div>
              <p className={styles.alertTitle}>Backup protection</p>
              <p className={styles.alertText}>
                Finish enabling daily backups{c.backupIntentInstance ? ` for ${c.backupIntentInstance.name}` : ""}.
              </p>
            </div>
          </div>
          <button
            type="button"
            className={`${styles.button} ${styles.primary} ${styles.intentAction}`}
            onClick={() => void c.handleEnableBackup(backupTargetId)}
            disabled={!!c.enablingBackup || c.status.loading}
          >
            {c.enablingBackup ? (
              <Loader2 size={14} className={styles.spin} aria-hidden="true" />
            ) : (
              <ShieldCheck size={14} aria-hidden="true" />
            )}
            {c.enablingBackup ? "Enabling..." : "Enable Daily Backups"}
          </button>
        </div>
      )}

      {/* The backup route would refuse the add-on for this plan or machine
          (token, Free and App Store plans; machines without a Hetzner
          server), so say so instead of offering a button that can't work. */}
      {c.shouldShowBackupIntent && !backupTargetId && (
        <div className={`${styles.alert} ${styles.alertInfo}`} role="status">
          <span className={styles.alertIcon} aria-hidden="true">
            <Info size={16} />
          </span>
          <div className={styles.alertBody}>
            <p className={styles.alertTitle}>Backup protection</p>
            <p className={styles.alertText}>
              The backup add-on isn&apos;t available for this plan or machine yet
              {c.backupIntentInstance ? ` (${c.backupIntentInstance.name})` : ""}.
            </p>
          </div>
          <span aria-hidden="true" />
        </div>
      )}

      {c.violation && (
        <div className={`${styles.alert} ${styles.alertDanger}`} role="alert">
          <span className={styles.alertIcon} aria-hidden="true">
            <AlertTriangle size={16} />
          </span>
          <div className={styles.alertBody}>
            <p className={styles.alertTitle}>Plan change didn&apos;t go through</p>
            <p className={styles.alertText}>{c.violation}</p>
            <div className={styles.alertActions}>
              <button type="button" className={styles.textButton} onClick={() => c.setViolation(null)}>
                Dismiss
              </button>
            </div>
          </div>
          <span aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
