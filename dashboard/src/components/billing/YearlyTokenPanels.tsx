'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle, Coins, Copy, CreditCard, Loader2, RefreshCw, ShieldCheck, Wallet, X } from 'lucide-react';
import { LocalAddressQr } from '@/components/billing/LocalAddressQr';
import { ManagedVeniceTokenQuotePanel } from '@/components/billing/ManagedVeniceTokenQuotePanel';
import { ManagedVeniceTopUpCalculator } from '@/components/billing/ManagedVeniceTopUpCalculator';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { copyTextToClipboard } from '@/lib/client/clipboard';
import { clientLog } from '@/lib/client/logger';
import type { ManagedVeniceTokenQuotePayload } from '@/lib/billing/managed-venice-client';
import {
  formatManagedVeniceUsd,
  getManagedVeniceTopUpQuote,
  type ManagedVeniceWalletType,
} from '@/lib/venice/managed-credit-topup';
import {
  type YearlyTokenQuotePayload,
  type YearlyTokenSubscriptionPayload,
} from '@/lib/billing/format';

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
      sub: quote ? `Send ${formatted} ${quote.tokenSymbol}` : "Sent",
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
  const anyFailed = stages.some((s) => s.status === "failed");

  let bannerColor: string;
  let bannerBg: string;
  if (allDone) {
    bannerColor = "rgba(22,163,74,0.5)";
    bannerBg = "rgba(22,163,74,0.06)";
  } else if (anyFailed) {
    bannerColor = "rgba(179,38,30,0.5)";
    bannerBg = "rgba(179,38,30,0.05)";
  } else {
    bannerColor = "var(--gold-leaf)";
    bannerBg = "rgba(255, 44, 45,0.08)";
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        border: `1px solid ${bannerColor}`,
        background: bannerBg,
        padding: "1.25rem 1.5rem",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            className="mono"
            style={{
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: "0.18em",
              fontWeight: 700,
              color: "var(--gold-leaf)",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Coins size={11} />
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
          <span style={{ fontSize: 13, color: "var(--ink-black)", lineHeight: 1.45 }}>
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
                    : `Send tokens to your deposit address. Cron checks every 5 min, or hit "Check now" once your tx confirms.`}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {quote && !subActive && !quoteExpired && (
            <span
              className="mono"
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#16a34a",
                fontVariantNumeric: "tabular-nums",
                padding: "5px 10px",
                border: "1px solid rgba(22,163,74,0.3)",
                background: "rgba(22,163,74,0.05)",
                letterSpacing: "0.06em",
              }}
            >
              {countdown}
            </span>
          )}
          {quote && !subActive && !underReview && (
            <>
              <button
                type="button"
                onClick={onCheckNow}
                disabled={checkingNow}
                style={{
                  padding: "9px 16px",
                  background: "transparent",
                  color: "var(--ink-black)",
                  border: "1px solid var(--gold-leaf)",
                  cursor: checkingNow ? "wait" : "pointer",
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  opacity: checkingNow ? 0.6 : 1,
                }}
                title="Skip the 5-min cron wait — check the deposit wallet right now"
              >
                {checkingNow ? (
                  <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} />
                ) : (
                  <RefreshCw size={11} />
                )}
                Check now
              </button>
              {!quoteExpired && (
                <button
                  type="button"
                  onClick={onResume}
                  style={{
                    padding: "10px 16px",
                    background: "var(--ink-black)",
                    color: "var(--bg-surface)",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.12em",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  Open quote <ArrowRight size={11} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 8,
        }}
      >
        {stages.map((stage, idx) => (
          <ProgressStage key={stage.key} index={idx} stage={stage} />
        ))}
      </div>

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
  let bgColor: string;
  let borderColor: string;
  let icon: React.ReactNode;
  let labelColor: string = "var(--ink-black)";

  switch (stage.status) {
    case "done":
      bgColor = "rgba(22,163,74,0.06)";
      borderColor = "rgba(22,163,74,0.45)";
      icon = <CheckCircle size={14} style={{ color: "#16a34a" }} />;
      break;
    case "active":
      bgColor = "rgba(255, 44, 45,0.10)";
      borderColor = "var(--gold-leaf)";
      icon = <Loader2 size={14} style={{ color: "var(--gold-leaf)", animation: "spin 1s linear infinite" }} />;
      break;
    case "failed":
      bgColor = "rgba(179,38,30,0.06)";
      borderColor = "rgba(179,38,30,0.45)";
      icon = <AlertTriangle size={14} style={{ color: "#b3261e" }} />;
      labelColor = "#b3261e";
      break;
    default: // pending
      bgColor = "transparent";
      borderColor = "var(--etched-border)";
      icon = (
        <span
          className="mono"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 14,
            height: 14,
            border: "1px solid currentColor",
            fontSize: 8,
            opacity: 0.5,
          }}
        >
          {index + 1}
        </span>
      );
      labelColor = "rgba(0,0,0,0.55)";
      break;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "10px 12px",
        border: `1px solid ${borderColor}`,
        background: bgColor,
        transition: "background 200ms ease, border 200ms ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {icon}
        <span
          className="mono"
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            fontWeight: 700,
            color: labelColor,
          }}
        >
          {stage.label}
        </span>
      </div>
      <span
        style={{
          fontSize: 11,
          color: "var(--text-secondary)",
          lineHeight: 1.4,
          opacity: stage.status === "pending" ? 0.55 : 1,
        }}
      >
        {stage.sub}
      </span>
    </div>
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

  const topUpQuote = getManagedVeniceTopUpQuote(amountUsd, walletType);

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

  const walletButton = (
    value: ManagedVeniceWalletType,
    label: string,
    description: string,
    icon: ReactNode
  ) => {
    const active = walletType === value;
    return (
      <button
        type="button"
        onClick={() => onWalletTypeChange(value)}
        style={{
          padding: "13px 14px",
          textAlign: "left",
          border: `1px solid ${active ? (value === "hermesos" ? "var(--gold-leaf)" : "var(--ink-black)") : "var(--etched-border)"}`,
          background: active
            ? value === "hermesos"
              ? "rgba(255, 44, 45,0.13)"
              : "var(--bg-elevated)"
            : "transparent",
          cursor: "pointer",
          minHeight: 104,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          {icon}
          <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 800 }}>
            {label}
          </span>
        </div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: "var(--text-secondary)" }}>
          {description}
        </p>
      </button>
    );
  };

  const quoteActive = Boolean(quote && walletType === "hermesos" && quote.status === "active");
  const quoteSettled = Boolean(quote && walletType === "hermesos" && quote.status === "settled");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Top up managed Venice credits"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.62)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "1rem",
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--etched-border)",
          padding: "clamp(1.25rem, 4vw, 2rem)",
          maxWidth: 680,
          width: "100%",
          maxHeight: "92vh",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          boxShadow: "0 24px 80px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
          <div>
            <div className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.18em", opacity: 0.55, fontWeight: 700 }}>
              Managed Venice LLM credits
            </div>
            <h2 className="serif" style={{ fontSize: "1.7rem", fontWeight: 700, margin: "4px 0 0" }}>
              Top up before launch
            </h2>
            <p style={{ margin: "8px 0 0", color: "var(--text-secondary)", fontSize: 12.5, lineHeight: 1.6, maxWidth: 540 }}>
              Venice runs at provider rates with no Hivra markup. Card credits add exactly what you pay.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ padding: 7, border: "1px solid var(--etched-border)", background: "transparent", cursor: "pointer" }}
          >
            <X size={14} />
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          {tokenPaymentsEnabled && walletType === "hermesos" && walletButton(
            "hermesos",
            "Pay with $HermesOS",
            "Up to 20% more credits during the launch wave, then the 10% standard bonus.",
            <Wallet size={15} style={{ color: "var(--gold-leaf)" }} />
          )}
          {walletButton(
            "card",
            "Pay by card",
            "Stripe checkout. No Venice markup; card credits stay at straight provider-rate value.",
            <CreditCard size={15} />
          )}
        </div>

        <ManagedVeniceTopUpCalculator
          id="managed-venice-billing-top-up"
          amountUsd={amountUsd}
          walletType={walletType}
          onAmountChange={onAmountChange}
        />

        <div style={{ border: "1px dashed var(--etched-border)", padding: "12px 14px", background: "rgba(255,255,255,0.03)", fontSize: 12, lineHeight: 1.6, color: "var(--text-secondary)" }}>
          {walletType === "hermesos" ? (
            <>
              <strong style={{ color: "var(--ink-black)" }}>$250 lifetime launch bonus cap.</strong>{" "}
              That is about $1,250 of $HermesOS top-ups at the full 20% launch bonus. After that, $HermesOS top-ups continue at the 10% standard bonus.
            </>
          ) : (
            <>
              <strong style={{ color: "var(--ink-black)" }}>Card terms: zero markup.</strong>{" "}
              {formatManagedVeniceUsd(topUpQuote.paidUsd)} adds {formatManagedVeniceUsd(topUpQuote.totalCreditsUsd)} of managed Venice credits.
            </>
          )}
        </div>

        {error && (
          <ErrorBanner
            error={error}
            context={{
              source: "client.diagnostic",
              route:
                walletType === "hermesos"
                  ? "/api/billing/managed-venice/hermesos/quote"
                  : "/api/billing/managed-venice/card/top-up",
              metadata: { surface: "ManagedVeniceDepositModal" },
            }}
          />
        )}

        {quote && walletType === "hermesos" && (
          <ManagedVeniceTokenQuotePanel
            quote={quote}
            onQuoteUpdate={onQuoteUpdate}
            onSettled={() => {
              void onRefreshSummary();
            }}
          />
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => void refreshWalletSummary()}
              disabled={refreshingWallet}
              aria-busy={refreshingWallet}
              style={{ display: "inline-flex", alignItems: "center", gap: 8, border: "1px solid var(--etched-border)", background: "transparent", padding: "10px 12px", cursor: refreshingWallet ? "wait" : "pointer", opacity: refreshingWallet ? 0.62 : 1, fontFamily: "var(--font-mono), monospace", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em" }}
            >
              {refreshingWallet && <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />}
              {refreshingWallet ? "Refreshing..." : "Refresh wallet"}
            </button>
            {!refreshingWallet && walletRefreshStatus !== "idle" && (
              <span
                role="status"
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: 800,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  color: walletRefreshStatus === "refreshed" ? "#16a34a" : "#dc2626",
                }}
              >
                {walletRefreshStatus === "refreshed" ? "Wallet refreshed" : "Refresh failed. Try again."}
              </span>
            )}
          </div>
          {walletType === "hermesos" && (quoteActive || quoteSettled) ? (
            <span
              className="mono"
              style={{
                border: "1px solid var(--etched-border)",
                color: quoteSettled ? "#16a34a" : "var(--text-secondary)",
                padding: "10px 12px",
                fontSize: 10,
                fontWeight: 900,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
              }}
            >
              {quoteSettled ? "Credits confirmed" : "Use verify payment above"}
            </span>
          ) : (
            <button
              type="button"
              onClick={walletType === "hermesos" ? onStartHermesTopUp : onStartCardTopUp}
              disabled={loading}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                border: "none",
                background: "var(--btn-bg)",
                color: "var(--btn-text)",
                padding: "12px 18px",
                cursor: loading ? "wait" : "pointer",
                opacity: loading ? 0.62 : 1,
                fontFamily: "var(--font-mono), monospace",
                fontSize: 10,
                fontWeight: 900,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
              }}
            >
              {loading ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : walletType === "hermesos" ? <Wallet size={13} /> : <CreditCard size={13} />}
              {loading
                ? "Starting..."
                : walletType === "hermesos"
                  ? "Start $HermesOS top-up"
                  : "Start card checkout"}
              {!loading && walletType === "card" && <ArrowRight size={13} />}
            </button>
          )}
        </div>
      </div>
    </div>
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
    depositAddress: string;
    expiresAt: string;
    status: string;
  } | null;
  onClose: () => void;
}) {
  const [copiedAmount, setCopiedAmount] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Pay ${tierName} yearly with $HermesOS`}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "1rem",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--etched-border)",
          padding: "clamp(1.5rem, 4vw, 2.5rem)",
          maxWidth: 540,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <div>
            <div className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.18em", opacity: 0.55, fontWeight: 700 }}>
              Pay 1 year with $HermesOS
            </div>
            <h2 className="serif" style={{ fontSize: "1.5rem", fontWeight: 700, marginTop: 4, marginBottom: 0 }}>
              {tierName} · ${tier === "power" ? "99" : "49"}/yr
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              padding: 6,
              border: "1px solid var(--etched-border)",
              background: "transparent",
              cursor: "pointer",
            }}
          >
            <X size={14} />
          </button>
        </div>

        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "1rem", border: "1px solid var(--etched-border)" }}>
            <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
            <span className="mono" style={{ fontSize: 11 }}>Locking today&apos;s price…</span>
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
          <div
            role="note"
            style={{ border: "1px solid var(--gold-leaf)", padding: "0.65rem 0.85rem", fontSize: 12.5, lineHeight: 1.5 }}
          >
            A payment for {tierName} is already under review. You don&apos;t need to pay again unless we ask you to —
            we&apos;ll sort it out and email you.
          </div>
        )}

        {quote && !loading && expired && (
          <>
            <div
              role="status"
              style={{ border: "1px solid rgba(179,38,30,0.5)", padding: "0.75rem 0.9rem", fontSize: 13, lineHeight: 1.5 }}
            >
              <strong>This quote expired.</strong> If you already sent the tokens, don&apos;t send them again: payments
              that arrive up to 2 hours late are still found and reviewed. Otherwise, close this and start a fresh quote.
            </div>
            <BankrTrustFooter />
          </>
        )}

        {quote && !loading && !expired && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.16em", opacity: 0.55, fontWeight: 700 }}>
                Step 1 · Send exactly
              </span>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span className="serif" style={{ fontSize: "1.65rem", fontWeight: 700, lineHeight: 1.1 }}>
                  {formatted} <span style={{ fontSize: "0.95rem", opacity: 0.7 }}>{quote.tokenSymbol}</span>
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await copyTextToClipboard(quote.tokensRequiredDisplay);
                    if (!ok) return;
                    setCopiedAmount(true);
                    window.setTimeout(() => setCopiedAmount(false), 1600);
                  }}
                  style={{
                    padding: "5px 9px",
                    border: "1px solid var(--etched-border)",
                    background: "transparent",
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {copiedAmount ? <CheckCircle size={11} /> : <Copy size={11} />}
                  {copiedAmount ? "Copied" : "Copy"}
                </button>
              </div>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                ${(quote.usdTargetCents / 100).toFixed(2)} worth at{" "}
                <code className="mono">${quote.priceUsdAtQuote}</code> per token. Send the full amount in a single transfer.
              </span>
            </div>

            <div
              style={{
                border: "1px solid var(--etched-border)",
                padding: "0.65rem 0.85rem",
                background: "var(--bg-elevated, transparent)",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.16em", opacity: 0.55, fontWeight: 700 }}>
                Step 2 · To this address (Base network)
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <LocalAddressQr address={quote.depositAddress} size={128} label="Yearly payment address QR code" />
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", flex: "1 1 220px", minWidth: 0 }}>
                  <code className="mono" style={{ fontSize: 12.5, wordBreak: "break-all", flex: 1, minWidth: 0 }}>
                    {quote.depositAddress}
                  </code>
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await copyTextToClipboard(quote.depositAddress);
                      if (!ok) return;
                      setCopiedAddress(true);
                      window.setTimeout(() => setCopiedAddress(false), 1600);
                    }}
                    style={{
                      padding: "5px 9px",
                      border: "1px solid var(--etched-border)",
                      background: "transparent",
                      fontFamily: "var(--font-mono), monospace",
                      fontSize: 9,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    {copiedAddress ? <CheckCircle size={11} /> : <Copy size={11} />}
                    {copiedAddress ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 11, color: "#16a34a" }}>
                {`Expires in ${countdown}`}
              </span>
              <span className="mono" style={{ fontSize: 9, opacity: 0.55, letterSpacing: "0.12em", textTransform: "uppercase" }}>
                Quote locked
              </span>
            </div>

            <p style={{ fontSize: 11, color: "var(--text-muted, var(--text-secondary))", margin: 0, lineHeight: 1.55 }}>
              Once your transfer lands, your {tierName} tier activates within ~5 minutes for 365 days. No auto-renewal — paying again before it ends adds another year after your current end date.
            </p>

            <BankrTrustFooter />
          </>
        )}
      </div>
    </div>
  );
}
/**
 * Compact "Powered by Bankr" trust signal. Renders at the bottom of
 * crypto-payment surfaces (yearly modal, durable progress banner) so
 * users sending real money to a deposit address see a familiar
 * partner name + a one-line reassurance about wallet custody.
 *
 * Bankr is the wallet-as-a-service partner backing the deposit
 * addresses; the user's $HermesOS-lock wallet is fully withdrawable
 * by them at any time. The yearly_subscription wallet is sweep-only
 * (operator-side); we don't claim withdrawability there.
 */
export function BankrTrustFooter() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        marginTop: 8,
        paddingTop: 10,
        borderTop: "1px solid var(--etched-border)",
      }}
    >
      <ShieldCheck size={11} style={{ opacity: 0.55, color: "var(--ink-black)" }} />
      <span
        className="mono"
        style={{
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: "0.16em",
          fontWeight: 700,
          opacity: 0.55,
          color: "var(--ink-black)",
        }}
      >
        Powered by{" "}
        <a
          href="https://bankr.bot"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--gold-leaf)", textDecoration: "none", letterSpacing: "0.16em" }}
        >
          Bankr
        </a>
        {" "}· non-custodial deposits on Base
      </span>
    </div>
  );
}
