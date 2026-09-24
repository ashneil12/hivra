'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle, Coins, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { BillingDialog, billingDialogStyles as dialog } from '@/components/billing/BillingDialog';
import { ManagedVeniceDepositView } from '@/components/billing/ManagedVeniceDepositView';
import {
  DepositAddressField,
  OpenInWalletLink,
  TOKEN_PAYMENT_FINALITY,
  TransferAmountField,
  wholeTokenQuoteRawAmount,
  TokenContractLine,
} from '@/components/billing/TransferDetails';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { clientLog } from '@/lib/client/logger';
import { hermesosTransferUri } from '@/lib/billing/eip681';
import type { ManagedVeniceTokenQuotePayload } from '@/lib/billing/managed-venice-client';
import { YEARLY_TOKEN_USD, displayTokenUnit } from '@/lib/billing/token-plan-prices';
import type { ManagedVeniceWalletType } from '@/lib/venice/managed-credit-topup';
import {
  type YearlyTokenQuotePayload,
  type YearlyTokenSubscriptionPayload,
} from '@/lib/billing/format';
import styles from './YearlyTokenPanels.module.css';

/**
 * Yearly-token billing modals and their progress stepper for the billing
 * dashboard. Extracted verbatim from page.tsx.
 */
/**
 * Top-of-page banner that renders whenever the user has an unconsumed
 * yearly $HermesOS quote in flight. Quotes live 20 min server-side;
 * this component runs a 1-second countdown locally so the user always
 * sees how much time is left without having to open the modal.
 *
 * Surfaces:
 *   - Tier label (Pro / Power)
 *   - Locked token amount (with thousands separators)
 *   - Deposit address tail (last 8 hex chars)
 *   - Live countdown to expiry
 *   - "Resume payment" → opens the modal with the persisted quote
 *
 * Durability fix for "I clicked Pay, closed the tab, came back, and
 * couldn't find my quote." Now reload-safe.
 */
/**
 * Multi-stage progress card for the yearly $HermesOS payment flow.
 *
 * Stages (left → right):
 *   1. Quote locked          — quote was minted, address shown
 *   2. Tokens received       — cron / on-demand check saw tokens
 *                              land at the deposit address; sub row
 *                              inserted, quote consumed
 *   3. Subscription active   — yearly_token_subscriptions.status=active
 *   4. Swept to treasury     — sweep_status=swept; tx_hash recorded
 *
 * State derivation:
 *   - Active quote, no sub                 → stage 1
 *   - Sub exists, sweep_status=pending     → stage 2-3 transitioning
 *   - Sub exists, sweep_status=swept       → all 4 done; show celebrate
 *   - Sub exists, sweep_status=failed      → show warning; sub still
 *                                            grants tier even if sweep
 *                                            stalled (cron retries)
 *
 * Accompanying countdown (stage 1) shows MM:SS to expiry. While in
 * stage 1, a "Check now" button POSTs to /yearly-token-quote/check-now
 * to short-circuit the 5-min cron cadence — once the user sees their
 * own tx land on chain they can hit Check Now and progress in seconds.
 */
export function YearlyPaymentProgress({
  tier,
  quote,
  subscription,
  onResume,
  onCheckNow,
  checkingNow,
}: {
  tier: "pro" | "power";
  quote: YearlyTokenQuotePayload | null;
  subscription: YearlyTokenSubscriptionPayload | null;
  onResume: () => void;
  onCheckNow: () => void;
  checkingNow: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  const tierName = tier === "power" ? "Power" : "Pro";
  const formatted = quote ? quote.tokensRequiredDisplay.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : "—";
  const remainingMs = quote ? Math.max(0, Date.parse(quote.expiresAt) - now) : 0;
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  const countdown = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  const quoteExpired = quote ? remainingMs <= 0 : false;

  // Stage status — each stage is "pending" | "active" | "done" | "failed".
  // active = the user is on this step right now (gets the spinner)
  // done   = behind us, draws a check
  // pending = ahead of us, dimmed
  type StageStatus = "pending" | "active" | "done" | "failed";
  // A subscription only completes THIS payment if it was created by this
  // quote. While a renewal quote is open, the user's current subscription
  // belongs to an earlier payment and must not mark the new one as done.
  const subActive =
    subscription !== null && (!quote || subscription.yearlyQuoteId === quote.id);
  // A payment reached this quote but needs an operator (a different amount,
  // or it arrived after the quote expired). The user must not pay again.
  const underReview = quote?.status === "manual_review" && !subActive;
  // Past the countdown the quote can no longer be paid, but a payment already
  // on its way is still picked up (and reviewed) during the late grace.
  const watchingLate = quoteExpired && !underReview && !subActive;
  // Three user-visible stages. "Settled" (the treasury sweep) used to
  // be a fourth stage but it's an operator concern — once the tier is
  // active, the user is done. Sweep status stays in the DB for ops
  // bookkeeping but isn't surfaced here.
  const stages: Array<{ key: string; label: string; sub: string; status: StageStatus }> = [
    {
      key: "quote",
      label: "Quote locked",
      sub: quote ? `Send ${formatted} ${displayTokenUnit(quote.tokenSymbol)}` : "Sent",
      status: quote && !subActive ? "active" : "done",
    },
    {
      key: "received",
      label: "Tokens received",
      sub: subActive
        ? "Detected on chain"
        : underReview
          ? "Under review"
          : watchingLate
            ? "Watching for a late payment"
            : "Waiting…",
      status: subActive ? "done" : quote ? "active" : "pending",
    },
    {
      key: "active",
      label: "Tier active",
      sub: subActive && subscription
        ? `Until ${new Date(subscription.expiresAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`
        : "Activating…",
      status: subActive ? "done" : "pending",
    },
  ];

  const allDone = stages.every((s) => s.status === "done");
  const tone = allDone ? "success" : underReview ? "warning" : undefined;
  // Screen readers get the expiry as a fixed clock time; the ticking MM:SS
  // is visual only, so the live region isn't re-announced every second.
  const expiresAtLabel = quote
    ? new Date(quote.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className={styles.banner} data-tone={tone}>
      <div className={styles.head}>
        {/* The live region holds only the stage title and message, which
            change when the payment moves on, never on the 1s tick. */}
        <div className={styles.headText} role="status" aria-live="polite" aria-atomic="true">
          <span className={styles.eyebrow}>
            <Coins size={13} aria-hidden="true" />
            {allDone
              ? `${tierName} tier active`
              : underReview
                ? "Payment under review"
                : quoteExpired
                ? "Quote expired"
                : subActive
                  ? `Activating ${tierName}`
                  : `Yearly $HermesOS · ${tierName}`}
          </span>
          <span className={styles.message}>
            {allDone
              ? `Done. Your ${tierName} subscription is live until ${
                  subscription
                    ? new Date(subscription.expiresAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })
                    : "next year"
                }.`
              : subActive
                ? `Tokens received · finishing up activation`
                : underReview
                  ? `We received a payment for this quote that needs a quick manual check (a different amount, or it arrived after the quote expired). Please don't send another payment — we'll sort it out and email you.`
                  : quoteExpired
                    ? `If you already sent the tokens, don't send them again: payments that arrive up to 2 hours late are still found and reviewed. Otherwise, start a fresh quote.`
                    : `Send tokens to your deposit address. We check every 5 minutes, or select "Check now" once your transfer confirms.`}
          </span>
        </div>

        <div className={styles.actions}>
          {quote && !subActive && !quoteExpired && (
            <>
              <span className={`notranslate ${styles.countdown}`} translate="no" aria-hidden="true" data-testid="yearly-countdown">
                {countdown}
              </span>
              <span className={styles.srOnly}>{`Quote expires at ${expiresAtLabel}`}</span>
            </>
          )}
          {quote && !subActive && !underReview && (
            <>
              <button
                type="button"
                onClick={onCheckNow}
                disabled={checkingNow}
                aria-busy={checkingNow || undefined}
                className={styles.action}
                title="Skip the 5-minute wait and check the deposit address now"
              >
                {checkingNow ? (
                  <Loader2 size={13} className={styles.spin} aria-hidden="true" />
                ) : (
                  <RefreshCw size={13} aria-hidden="true" />
                )}
                Check now
              </button>
              {!quoteExpired && (
                <button type="button" onClick={onResume} className={`${styles.action} ${styles.actionPrimary}`}>
                  Open quote <ArrowRight size={13} aria-hidden="true" />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <ol className={styles.stages}>
        {stages.map((stage, idx) => (
          <ProgressStage key={stage.key} index={idx} stage={stage} />
        ))}
      </ol>

      <BankrTrustFooter />
    </div>
  );
}
export function ProgressStage({
  index,
  stage,
}: {
  index: number;
  stage: { key: string; label: string; sub: string; status: "pending" | "active" | "done" | "failed" };
}) {
  let icon: ReactNode;
  switch (stage.status) {
    case "done":
      icon = <CheckCircle size={14} aria-hidden="true" />;
      break;
    case "active":
      icon = <Loader2 size={14} className={styles.spin} aria-hidden="true" />;
      break;
    case "failed":
      icon = <AlertTriangle size={14} aria-hidden="true" />;
      break;
    default: // pending
      icon = (
        <span className={styles.stageIndex} aria-hidden="true">
          {index + 1}
        </span>
      );
      break;
  }

  return (
    <li className={styles.stage} data-status={stage.status}>
      <span className={styles.stageHead}>
        {icon}
        {stage.label}
      </span>
      <span className={styles.stageSub}>{stage.sub}</span>
    </li>
  );
}
export function ManagedVeniceDepositModal({
  tokenPaymentsEnabled = false,
  isOpen,
  walletType,
  amountUsd,
  loading,
  error,
  quote,
  onClose,
  onWalletTypeChange,
  onAmountChange,
  onStartHermesTopUp,
  onStartCardTopUp,
  onQuoteUpdate,
  onRefreshSummary,
}: {
  isOpen: boolean;
  tokenPaymentsEnabled?: boolean;
  walletType: ManagedVeniceWalletType;
  amountUsd: number;
  loading: boolean;
  error: string | null;
  quote: ManagedVeniceTokenQuotePayload | null;
  onClose: () => void;
  onWalletTypeChange: (walletType: ManagedVeniceWalletType) => void;
  onAmountChange: (amountUsd: number) => void;
  onStartHermesTopUp: () => void;
  onStartCardTopUp: () => void;
  onQuoteUpdate: (quote: ManagedVeniceTokenQuotePayload) => void;
  onRefreshSummary: () => void | boolean | Promise<void | boolean>;
}) {
  const [refreshingWallet, setRefreshingWallet] = useState(false);
  const [walletRefreshStatus, setWalletRefreshStatus] = useState<"idle" | "refreshed" | "failed">("idle");

  useEffect(() => {
    if (!isOpen) return;
    setRefreshingWallet(false);
    setWalletRefreshStatus("idle");
  }, [isOpen]);

  if (!isOpen) return null;

  async function refreshWalletSummary() {
    if (refreshingWallet) return;
    setRefreshingWallet(true);
    setWalletRefreshStatus("idle");
    try {
      // fetchManagedVeniceSummary never rejects — it resolves false when
      // the refresh failed (and nulls the wallet panel). Treat an explicit
      // false as failure so we don't flash "Wallet refreshed" over an
      // emptied panel; a void resolution still counts as success for
      // handlers that don't report.
      const outcome = await onRefreshSummary();
      setWalletRefreshStatus(outcome === false ? "failed" : "refreshed");
    } catch (refreshError) {
      setWalletRefreshStatus("failed");
      clientLog.error("managed Venice wallet refresh failed", refreshError, {
        source: "managed-venice-deposit-modal",
        failureType: "managed_venice_wallet_refresh_failed",
        errorName: refreshError instanceof Error ? refreshError.name : typeof refreshError,
      });
    } finally {
      setRefreshingWallet(false);
    }
  }

  const quoteActive = Boolean(quote && walletType === "hermesos" && quote.status === "active");
  const quoteSettled = Boolean(quote && walletType === "hermesos" && quote.status === "settled");

  return (
    <ManagedVeniceDepositView
      title="Top up managed Venice credits"
      description="Venice runs at provider rates with no Hivra markup. Card credits add exactly what you pay."
      // $HermesOS stays reachable only for a flow that already chose it
      // (a deep link into a token top-up) and only while token payments are on.
      walletOptions={tokenPaymentsEnabled && walletType === "hermesos" ? ["hermesos", "card"] : ["card"]}
      walletType={walletType}
      onWalletTypeChange={onWalletTypeChange}
      calculatorId="managed-venice-billing-top-up"
      amountUsd={amountUsd}
      onAmountChange={onAmountChange}
      error={error}
      quote={quote}
      onQuoteUpdate={onQuoteUpdate}
      onQuoteSettled={() => {
        void onRefreshSummary();
      }}
      quoteInFlight={quoteActive}
      quoteSettled={quoteSettled}
      loading={loading}
      onStart={walletType === "hermesos" ? onStartHermesTopUp : onStartCardTopUp}
      refreshingWallet={refreshingWallet}
      walletRefreshStatus={walletRefreshStatus}
      onRefreshWallet={() => void refreshWalletSummary()}
      onClose={onClose}
    />
  );
}
/**
 * "Pay yearly with $HermesOS" modal. Shows the live-priced quote
 * (locked for 20 min), the user's personal credit_deposit address,
 * and a copyable token amount. Once they send the tokens, the
 * yearly-token-sweep cron picks it up within ~5 min and the user
 * gets 365 days of their tier; tokens flow to the founder treasury
 * automatically.
 */
export function YearlyTokenPaymentModal({
  isOpen,
  tier,
  loading,
  error,
  quote,
  onClose,
  reviewPending = false,
}: {
  isOpen: boolean;
  tier: "pro" | "power" | null;
  loading: boolean;
  error: string | null;
  /** A payment for this tier is already under manual review. */
  reviewPending?: boolean;
  quote: {
    id: string;
    tier: "pro" | "power";
    usdTargetCents: number;
    priceUsdAtQuote: string;
    tokensRequiredDisplay: string;
    tokenSymbol: string;
    tokenAddress?: string;
    depositAddress: string;
    expiresAt: string;
    status: string;
    /** Exact amount in base units, as sent by /api/billing/yearly-token-quote. */
    tokensRequiredRaw?: string;
    tokenDecimals?: number;
  } | null;
  onClose: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isOpen) return;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [isOpen]);

  if (!isOpen) return null;

  const tierName = tier === "power" ? "Power" : "Pro";
  const remainingMs = quote ? Math.max(0, Date.parse(quote.expiresAt) - now) : 0;
  const expired = quote ? remainingMs <= 0 : false;
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  const countdown = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  // Format the digit-string token amount with US-locale commas without
  // a lossy BigInt → Number roundtrip.
  const formatted = quote
    ? quote.tokensRequiredDisplay.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : "—";
  const payable = Boolean(quote && !loading && !expired);
  // While a payment for this tier is under review the user is told not to pay
  // again, so there is no one-tap wallet link (the copy fields stay).
  const walletHref =
    quote && payable && !reviewPending
      ? hermesosTransferUri({
          tokenSymbol: quote.tokenSymbol,
          tokenDecimals: quote.tokenDecimals,
          tokenAddress: quote.tokenAddress,
          depositAddress: quote.depositAddress,
          amountRaw: wholeTokenQuoteRawAmount(quote),
        })
      : null;

  return (
    <BillingDialog
      ariaLabel={`Pay ${tierName} yearly with $HermesOS`}
      eyebrow="Pay 1 year with $HermesOS"
      title={tier ? `${tierName} · $${YEARLY_TOKEN_USD[tier]}/yr` : tierName}
      onClose={onClose}
      footer={
        payable ? (
          <div className={styles.quoteMeta}>
            <span className={`notranslate ${styles.expires}`} translate="no">
              {`Expires in ${countdown}`}
            </span>
            <span className={styles.locked}>Quote locked</span>
          </div>
        ) : undefined
      }
    >
      {loading && (
        <div className={dialog.callout} role="status">
          <Loader2 size={14} className={dialog.spin} aria-hidden="true" />
          <span className="mono">Locking today&apos;s price…</span>
        </div>
      )}

      {error && (
        <ErrorBanner
          error={error}
          context={{
            source: "client.diagnostic",
            route: "/api/billing/wallet/quote",
            metadata: { surface: "BillingCryptoTopUpQuote" },
          }}
        />
      )}

      {reviewPending && (
        <div role="note" className={dialog.callout} data-tone="warning">
          <AlertTriangle size={15} aria-hidden="true" />
          <p style={{ margin: 0 }}>
            A payment for {tierName} is already under review. You don&apos;t need to pay again unless we ask you to —
            we&apos;ll sort it out and email you.
          </p>
        </div>
      )}

      {quote && !loading && expired && (
        <>
          <div role="status" className={dialog.callout} data-tone="danger">
            <AlertTriangle size={15} aria-hidden="true" />
            <p style={{ margin: 0 }}>
              <strong>This quote expired.</strong> If you already sent the tokens, don&apos;t send them again: payments
              that arrive up to 2 hours late are still found and reviewed. Otherwise, close this and start a fresh quote.
            </p>
          </div>
          <BankrTrustFooter />
        </>
      )}

      {quote && payable && (
        <>
          <TransferAmountField
            label="Step 1 · Send exactly"
            amount={formatted}
            unit={displayTokenUnit(quote.tokenSymbol)}
            copyValue={quote.tokensRequiredDisplay}
            copyTitle="Copies the amount without separators, ready to paste into a wallet"
          >
            ${(quote.usdTargetCents / 100).toFixed(2)} worth at{" "}
            <code className="mono">${quote.priceUsdAtQuote}</code> per token. Send the full amount in a single transfer.
          </TransferAmountField>

          <TokenContractLine tokenAddress={quote.tokenAddress} tokenSymbol={quote.tokenSymbol} />

          <DepositAddressField
            label="Step 2 · To this address (Base network)"
            address={quote.depositAddress}
            qrLabel="Yearly payment address QR code"
            qrSize={128}
          />

          <OpenInWalletLink href={walletHref} />

          <p className={dialog.fineprint}>
            Once your transfer lands, your {tierName} tier activates within ~5 minutes for 365 days. No auto-renewal — paying again before it ends adds another year after your current end date.{" "}
            <strong>{TOKEN_PAYMENT_FINALITY}</strong>
          </p>

          <BankrTrustFooter />
        </>
      )}
    </BillingDialog>
  );
}
/**
 * Compact "Powered by Bankr" line at the bottom of the yearly payment
 * surfaces (yearly modal, durable progress banner): it names the partner
 * that issues the deposit address and the network to pay on.
 *
 * It makes no custody claim. The yearly deposit wallet is created by Hivra
 * through Bankr, Hivra holds a sweep-only key for it, and yearly-sweep moves
 * each confirmed payment to Hivra's treasury. The user cannot withdraw from
 * it, so it must never be described as non-custodial or withdrawable.
 */
export function BankrTrustFooter() {
  return (
    <div className={styles.trust}>
      <ShieldCheck size={12} aria-hidden="true" />
      <span>
        Powered by{" "}
        <a href="https://bankr.bot" target="_blank" rel="noopener noreferrer">
          Bankr
        </a>
        {" "}· payment address on Base
      </span>
    </div>
  );
}
