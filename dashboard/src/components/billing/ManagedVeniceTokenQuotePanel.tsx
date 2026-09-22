'use client';

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle, Copy, Loader2, RefreshCw, Sparkles, Wallet } from "lucide-react";

import { copyTextToClipboard } from "@/lib/client/clipboard";
import { clientLog } from "@/lib/client/logger";
import { LocalAddressQr } from "@/components/billing/LocalAddressQr";
import { formatMicroUsd } from "@/components/billing/ManagedVeniceSubsidyBanner";
import {
  checkManagedVeniceHermesQuote,
  type ManagedVeniceTokenQuotePayload,
} from "@/lib/billing/managed-venice-client";

function formatTokenAmount(rawValue: string, decimals: number, grouped = true) {
  const raw = BigInt(rawValue || "0");
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  const wholeText = grouped ? Number(whole).toLocaleString("en-US") : whole.toString();
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
  const [copiedAmount, setCopiedAmount] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);
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
  const borderColor = settled ? "#16a34a" : manualReview ? "#b3261e" : "#16a34a";
  const checking = polling || manualChecking;

  if (settled) {
    const balanceMicroUsd =
      typeof availableBalanceMicroUsd === "number"
        ? availableBalanceMicroUsd
        : quote.creditValueMicroUsd;

    return (
      <div
        style={{
          border: "1px solid #16a34a",
          background: "linear-gradient(135deg, rgba(22,163,74,0.12), rgba(255, 44, 45,0.10))",
          padding: "16px",
          display: "grid",
          gap: 14,
          marginTop: 14,
          boxShadow: "0 18px 40px rgba(22,163,74,0.10)",
          animation: "managedVeniceConfirmedCard 680ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <style>{`
          @keyframes managedVeniceConfirmedCard {
            0% { transform: translateY(8px) scale(0.985); opacity: 0; }
            100% { transform: translateY(0) scale(1); opacity: 1; }
          }
          @keyframes managedVeniceConfirmedPulse {
            0% { box-shadow: 0 0 0 0 rgba(22, 163, 74, 0.35); }
            70% { box-shadow: 0 0 0 12px rgba(22, 163, 74, 0); }
            100% { box-shadow: 0 0 0 0 rgba(22, 163, 74, 0); }
          }
        `}</style>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#16a34a" }}>
            <span
              style={{
                width: 30,
                height: 30,
                border: "1px solid #16a34a",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                animation: "managedVeniceConfirmedPulse 1.6s ease-out 1",
              }}
            >
              <CheckCircle size={17} />
            </span>
            <div>
              <div className="mono" style={{ fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.13em" }}>
                Payment confirmed
              </div>
              <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "var(--text-secondary)" }}>
                Managed Venice credits are active.
              </p>
            </div>
          </div>
          <span className="mono" style={{ fontSize: 10, color: "#16a34a", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            Ready to deploy
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
          <div style={{ border: "1px solid rgba(22,163,74,0.28)", background: "rgba(255,255,255,0.04)", padding: "11px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
              <Wallet size={13} style={{ color: "#16a34a" }} />
              <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", opacity: 0.62, fontWeight: 800 }}>
                Wallet balance
              </span>
            </div>
            <strong style={{ fontSize: 20 }}>{formatMicroUsd(balanceMicroUsd, 4)}</strong>
          </div>
          <div style={{ border: "1px solid rgba(255, 44, 45,0.35)", background: "rgba(255, 44, 45,0.08)", padding: "11px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
              <Sparkles size={13} style={{ color: "var(--gold-leaf)" }} />
              <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", opacity: 0.62, fontWeight: 800 }}>
                Credits added
              </span>
            </div>
            <strong style={{ fontSize: 20 }}>{formatMicroUsd(quote.creditValueMicroUsd, 2)}</strong>
            {quote.bonusValueMicroUsd > 0 && (
              <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--text-secondary)" }}>
                Includes {formatMicroUsd(quote.bonusValueMicroUsd, 2)} bonus
              </p>
            )}
          </div>
        </div>

        {quote.transactionHash && (
          <p className="mono" style={{ margin: 0, fontSize: 10, opacity: 0.58, wordBreak: "break-all" }}>
            Confirmed on Base: {quote.transactionHash}
          </p>
        )}

        {onContinue && (
          <button
            type="button"
            onClick={onContinue}
            style={{
              justifySelf: "start",
              border: "none",
              background: "var(--btn-bg)",
              color: "var(--btn-text)",
              padding: "10px 14px",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              fontFamily: "var(--font-mono), monospace",
              fontSize: 10,
              fontWeight: 900,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
            }}
          >
            Continue to deploy setup
            <ArrowRight size={13} />
          </button>
        )}
      </div>
    );
  }

  if (quoteClosed) {
    return (
      <div style={{ border: "1px solid #b3261e", padding: "14px 16px", display: "grid", gap: 10, marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#b3261e" }}>
          <AlertCircle size={14} />
          <span className="mono" style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            Quote closed
          </span>
        </div>
        <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
          {QUOTE_CLOSED_MESSAGE}
        </p>
      </div>
    );
  }

  return (
    <div style={{ border: `1px solid ${borderColor}`, padding: "14px 16px", display: "grid", gap: 14, marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: borderColor }}>
          {polling && !settled ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <CheckCircle size={14} />}
          <span className="mono" style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            {settled ? "Payment confirmed" : manualReview ? "Review needed" : "Rate locked"}
          </span>
        </div>
        <span className="mono" style={{ fontSize: 10, color: settled ? "#16a34a" : expired ? "#b3261e" : "#16a34a" }}>
          {settled ? "Confirmed" : expired ? "Rate window ended" : `Expires in ${countdown}`}
        </span>
      </div>

      <div>
        <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.14em", opacity: 0.55, fontWeight: 700 }}>
          Send exactly
        </span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
          <span className="serif" style={{ fontSize: "1.55rem", fontWeight: 700 }}>
            {displayTokenAmount} <span style={{ fontSize: "0.95rem", opacity: 0.7 }}>{quote.tokenSymbol}</span>
          </span>
          <button
            type="button"
            onClick={async () => {
              const ok = await copyTextToClipboard(exactTokenAmount);
              if (!ok) return;
              setCopiedAmount(true);
              window.setTimeout(() => setCopiedAmount(false), 1400);
            }}
            style={{ padding: "5px 9px", border: "1px solid var(--etched-border)", background: "transparent", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono), monospace", fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em" }}
          >
            {copiedAmount ? <CheckCircle size={11} /> : <Copy size={11} />}
            {copiedAmount ? "Copied" : "Copy"}
          </button>
        </div>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-secondary)" }}>
          Pay {formatMicroUsd(quote.paidValueMicroUsd, 2)} at ${quote.snapshotPriceUsd} per token; we credit {formatMicroUsd(quote.creditValueMicroUsd, 2)}
          {quote.bonusValueMicroUsd > 0 ? ` including ${formatMicroUsd(quote.bonusValueMicroUsd, 2)} bonus` : ""}. Send one Base transfer.
        </p>
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <p role="status" style={{ margin: 0, fontSize: 12, color: settled ? "#16a34a" : "var(--text-secondary)", flex: "1 1 260px" }}>
            {settled
              ? "Payment confirmed. You can continue with deployment."
              : expired
                ? "The rate window has ended. If you already sent the exact transfer, we are still checking it here; otherwise start a fresh quote."
                : pollMessage}
          </p>
          <button
            type="button"
            onClick={() => void checkQuote({ manual: true })}
            disabled={checking}
            style={{
              border: "1px solid var(--etched-border)",
              background: checking ? "rgba(255, 44, 45,0.08)" : "transparent",
              color: "var(--ink-black)",
              padding: "8px 10px",
              cursor: checking ? "wait" : "pointer",
              opacity: checking ? 0.72 : 1,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontFamily: "var(--font-mono), monospace",
              fontSize: 9,
              fontWeight: 900,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            {checking ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={12} />}
            {checking ? "Checking..." : "Verify payment"}
          </button>
        </div>
      </div>

      <div style={{ border: "1px solid var(--etched-border)", padding: "0.75rem", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <LocalAddressQr address={quote.depositAddress} size={124} label="Managed Venice deposit address QR code" />
        <div style={{ flex: "1 1 230px", minWidth: 0, display: "grid", gap: 8 }}>
          <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.14em", opacity: 0.55, fontWeight: 700 }}>
            Deposit address
          </span>
          <code className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
            {quote.depositAddress}
          </code>
          <button
            type="button"
            onClick={async () => {
              const ok = await copyTextToClipboard(quote.depositAddress);
              if (!ok) return;
              setCopiedAddress(true);
              window.setTimeout(() => setCopiedAddress(false), 1400);
            }}
            style={{ justifySelf: "start", padding: "5px 9px", border: "1px solid var(--etched-border)", background: "transparent", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono), monospace", fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em" }}
          >
            {copiedAddress ? <CheckCircle size={11} /> : <Copy size={11} />}
            {copiedAddress ? "Copied" : "Copy address"}
          </button>
        </div>
      </div>
    </div>
  );
}
