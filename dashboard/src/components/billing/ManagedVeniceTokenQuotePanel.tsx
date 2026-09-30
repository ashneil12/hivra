'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle, Loader2, RefreshCw, Sparkles, Wallet } from "lucide-react";

import { clientLog } from "@/lib/client/logger";
import { formatMicroUsd } from "@/components/billing/ManagedVeniceSubsidyBanner";
import {
  DepositAddressField,
  OpenInWalletLink,
  TOKEN_PAYMENT_FINALITY,
  TransferAmountField,
  TokenContractLine,
} from "@/components/billing/TransferDetails";
import { hermesosTransferUri } from "@/lib/billing/eip681";
import { displayTokenUnit } from "@/lib/billing/token-plan-prices";
import {
  checkManagedVeniceHermesQuote,
  type ManagedVeniceTokenQuotePayload,
} from "@/lib/billing/managed-venice-client";
import styles from "./ManagedVeniceTokenQuotePanel.module.css";

const GROUPED = /\B(?=(\d{3})+(?!\d))/g;

// Exact decimal rendering of a raw token amount (BigInt only, no floats).
function formatTokenAmount(rawValue: string, decimals: number, grouped = true) {
  const raw = BigInt(rawValue || "0");
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  const wholeText = grouped ? whole.toString().replace(GROUPED, ",") : whole.toString();
  return fractionText ? `${wholeText}.${fractionText}` : wholeText;
}

const BACKGROUND_CHECK_INTERVAL_MS = 15_000;
const INITIAL_BACKGROUND_CHECK_DELAY_MS = 15_000;
const INITIAL_POLL_MESSAGE = "Send the exact Base transfer, then keep this page open or press Verify payment.";
const CHECKING_POLL_MESSAGE = "Checking Base for your transfer...";
const CHECK_UNAVAILABLE_MESSAGE = "We couldn't check Base right now. Your quote is still active; press Verify payment again in a moment.";
// Shown once a quote's window + late-payment grace has been fully checked with
// no matching payment: the quote is closed server-side and will never settle.
const QUOTE_CLOSED_MESSAGE = "This quote closed without a matching payment. Request a new quote to top up.";

export function ManagedVeniceTokenQuotePanel({
  quote,
  availableBalanceMicroUsd,
  onQuoteUpdate,
  onSettled,
  onContinue,
}: {
  quote: ManagedVeniceTokenQuotePayload;
  availableBalanceMicroUsd?: number | null;
  onQuoteUpdate?: (quote: ManagedVeniceTokenQuotePayload) => void;
  onSettled?: () => void | Promise<void>;
  onContinue?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [pollMessage, setPollMessage] = useState(INITIAL_POLL_MESSAGE);
  const [polling, setPolling] = useState(false);
  const [manualChecking, setManualChecking] = useState(false);
  // Set when a check reports the quote closed, so polling stops even if the
  // parent does not feed the updated quote back in.
  const [closedByCheck, setClosedByCheck] = useState(false);
  const checkInFlightRef = useRef(false);

  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  const checkQuote = useCallback(async (options: {
    manual?: boolean;
    isCancelled?: () => boolean;
  } = {}) => {
    const manual = options.manual === true;
    if (checkInFlightRef.current) {
      if (manual) setPollMessage("A payment check is already running. Give it a moment.");
      return;
    }

    checkInFlightRef.current = true;
    if (manual) {
      setManualChecking(true);
      setPollMessage(CHECKING_POLL_MESSAGE);
    } else {
      setPolling(true);
    }

    try {
      const result = await checkManagedVeniceHermesQuote(quote.id);
      if (options.isCancelled?.()) return;

      if (!result.ok) {
        setPollMessage(result.message || CHECK_UNAVAILABLE_MESSAGE);
        clientLog.warn("managed Venice Hivra top-up check failed", {
          source: "managed-venice-token-quote-panel",
          route: "/api/billing/managed-venice/hermesos/check",
          failureType: "managed_venice_hermesos_check_failed",
          quoteId: quote.id,
          reason: result.reason,
          message: result.message,
        });
        return;
      }
      if (result.quote) {
        onQuoteUpdate?.(result.quote);
      }
      if (result.status === "settled") {
        setPollMessage("Payment confirmed. Your managed Venice credits are active.");
        await onSettled?.();
        return;
      }
      if (result.status === "underconfirmed") {
        setPollMessage(
          `Transfer detected. Waiting for confirmations${typeof result.confirmations === "number" ? ` (${result.confirmations}/3)` : ""}...`
        );
        return;
      }
      if (result.status === "manual_review_required") {
        setPollMessage("Transfer found, but it needs review because the amount or timing did not match the quote.");
        return;
      }
      if (result.status === "cancelled") {
        setClosedByCheck(true);
        setPollMessage(QUOTE_CLOSED_MESSAGE);
        return;
      }
      setPollMessage(
        manual
          ? "No matching transfer found yet. Confirm you sent it on Base to this address for the exact amount, then try again."
          : "Waiting for the exact Base transfer. If you already sent it, confirmations can take a moment."
      );
    } finally {
      checkInFlightRef.current = false;
      if (!options.isCancelled?.()) {
        if (manual) setManualChecking(false);
        else setPolling(false);
      }
    }
  }, [onQuoteUpdate, onSettled, quote.id]);

  const quoteClosed = quote.status === "cancelled" || closedByCheck;

  useEffect(() => {
    if ((quote.status !== "active" && quote.status !== "expired") || quoteClosed) return;
    let cancelled = false;

    const initialHandle = window.setTimeout(() => void checkQuote({ isCancelled: () => cancelled }), INITIAL_BACKGROUND_CHECK_DELAY_MS);
    const intervalHandle = window.setInterval(() => void checkQuote({ isCancelled: () => cancelled }), BACKGROUND_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(initialHandle);
      window.clearInterval(intervalHandle);
    };
  }, [checkQuote, quote.status, quoteClosed]);

  const remainingMs = Math.max(0, Date.parse(quote.expiresAt) - now);
  const expired = remainingMs <= 0;
  const settled = quote.status === "settled";
  const manualReview = quote.status === "manual_review_required";
  const countdown = `${String(Math.floor(remainingMs / 60000)).padStart(2, "0")}:${String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, "0")}`;
  const exactTokenAmount = formatTokenAmount(quote.tokenAmountRaw, quote.tokenDecimals, false);
  const displayTokenAmount = formatTokenAmount(quote.tokenAmountRaw, quote.tokenDecimals, true);
  const checking = polling || manualChecking;

  if (settled) {
    const balanceMicroUsd =
      typeof availableBalanceMicroUsd === "number"
        ? availableBalanceMicroUsd
        : quote.creditValueMicroUsd;

    return (
      <div className={styles.settled}>
        <div className={styles.settledHead}>
          <div className={styles.settledTitle}>
            <span className={styles.settledIcon} aria-hidden="true">
              <CheckCircle size={17} />
            </span>
            <div>
              <div className="mono" style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em" }}>
                Payment confirmed
              </div>
              <p className={styles.settledCopy}>Managed Venice credits are active.</p>
            </div>
          </div>
          <span className={styles.statusLabel}>Ready to deploy</span>
        </div>

        <div className={styles.tiles}>
          <div className={styles.tile}>
            <span className={styles.tileLabel}>
              <Wallet size={13} aria-hidden="true" />
              Wallet balance
            </span>
            <strong className={styles.tileValue}>{formatMicroUsd(balanceMicroUsd, 4)}</strong>
          </div>
          <div className={styles.tile}>
            <span className={styles.tileLabel}>
              <Sparkles size={13} aria-hidden="true" />
              Credits added
            </span>
            <strong className={styles.tileValue}>{formatMicroUsd(quote.creditValueMicroUsd, 2)}</strong>
            {quote.bonusValueMicroUsd > 0 && (
              <p className={styles.tileNote}>Includes {formatMicroUsd(quote.bonusValueMicroUsd, 2)} bonus</p>
            )}
          </div>
        </div>

        {quote.transactionHash && (
          <p className={`notranslate ${styles.txHash}`} translate="no">
            Confirmed on Base: {quote.transactionHash}
          </p>
        )}

        {onContinue && (
          <button type="button" onClick={onContinue} className={styles.continueButton}>
            Continue to deploy setup
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }

  if (quoteClosed) {
    return (
      <div className={styles.closed}>
        <span className={styles.statusLabel} data-tone="danger">
          <AlertCircle size={14} aria-hidden="true" />
          Quote closed
        </span>
        <p role="status">{QUOTE_CLOSED_MESSAGE}</p>
      </div>
    );
  }

  // Only a live, payable quote gets a one-tap wallet link: never an expired
  // rate window or a transfer that is already waiting for review.
  const walletHref =
    !expired && !manualReview
      ? hermesosTransferUri({
          tokenSymbol: quote.tokenSymbol,
          tokenDecimals: quote.tokenDecimals,
          tokenAddress: quote.tokenAddress,
          depositAddress: quote.depositAddress,
          amountRaw: quote.tokenAmountRaw,
        })
      : null;
  const tone = manualReview ? "danger" : undefined;

  return (
    <div className={styles.panel} data-tone={tone}>
      <div className={styles.statusRow}>
        <span className={styles.statusLabel} data-tone={tone}>
          {polling ? (
            <Loader2 size={14} className={styles.spin} aria-hidden="true" />
          ) : manualReview ? (
            <AlertCircle size={14} aria-hidden="true" />
          ) : (
            <CheckCircle size={14} aria-hidden="true" />
          )}
          {manualReview ? "Review needed" : "Rate locked"}
        </span>
        <span className={`notranslate ${styles.countdown}`} translate="no" data-tone={expired ? "danger" : undefined}>
          {expired ? "Rate window ended" : `Expires in ${countdown}`}
        </span>
      </div>

      <TransferAmountField
        label="Send exactly"
        amount={displayTokenAmount}
        unit={displayTokenUnit(quote.tokenSymbol)}
        copyValue={exactTokenAmount}
        copyTitle="Copies the exact amount without separators, ready to paste into a wallet"
      >
        Pay {formatMicroUsd(quote.paidValueMicroUsd, 2)} at ${quote.snapshotPriceUsd} per token; we credit {formatMicroUsd(quote.creditValueMicroUsd, 2)}
        {quote.bonusValueMicroUsd > 0 ? ` including ${formatMicroUsd(quote.bonusValueMicroUsd, 2)} bonus` : ""}. Send one Base transfer.{" "}
        <strong>{TOKEN_PAYMENT_FINALITY}</strong>
      </TransferAmountField>

      <TokenContractLine tokenAddress={quote.tokenAddress} tokenSymbol={quote.tokenSymbol} />

      <DepositAddressField
        label="Deposit address · Base network"
        address={quote.depositAddress}
        qrLabel="Managed Venice deposit address QR code"
      />

      <OpenInWalletLink href={walletHref} />

      <div className={styles.verifyRow}>
        <p role="status" className={styles.pollMessage}>
          {expired
            ? "The rate window has ended. If you already sent the exact transfer, we are still checking it here; otherwise start a fresh quote."
            : pollMessage}
        </p>
        <button
          type="button"
          onClick={() => void checkQuote({ manual: true })}
          disabled={checking}
          aria-busy={checking || undefined}
          className={styles.verifyButton}
        >
          {checking ? (
            <Loader2 size={13} className={styles.spin} aria-hidden="true" />
          ) : (
            <RefreshCw size={13} aria-hidden="true" />
          )}
          {checking ? "Checking..." : "Verify payment"}
        </button>
      </div>
    </div>
  );
}
