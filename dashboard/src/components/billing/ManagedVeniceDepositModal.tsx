'use client';

import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, CreditCard, Loader2, Wallet, X } from "lucide-react";

import { clientLog } from "@/lib/client/logger";
import { redirectToCheckoutUrl } from "@/lib/billing/client";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { ManagedVeniceTopUpCalculator } from "@/components/billing/ManagedVeniceTopUpCalculator";
import { ManagedVeniceTokenQuotePanel } from "@/components/billing/ManagedVeniceTokenQuotePanel";
import {
  managedVeniceUsdToMicroUsd,
  requestManagedVeniceHermesQuote,
  type ManagedVeniceTokenQuotePayload,
} from "@/lib/billing/managed-venice-client";
import {
  MANAGED_VENICE_DEFAULT_TOP_UP_USD,
  formatManagedVeniceUsd,
  getManagedVeniceTopUpQuote,
  type ManagedVeniceWalletType,
} from "@/lib/venice/managed-credit-topup";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

async function readApiPayload(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const payload = await response.json();
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function apiPayloadError(payload: Record<string, unknown> | null, fallback: string) {
  return typeof payload?.error === "string" ? payload.error : fallback;
}

function apiSuccessData(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (payload?.success !== true || !isRecord(payload.data)) return null;
  return payload.data;
}

export function ManagedVeniceDepositModal({
  isOpen,
  initialWalletType,
  initialAmountUsd,
  onClose,
  onRefreshSummary,
}: {
  isOpen: boolean;
  initialWalletType: ManagedVeniceWalletType;
  initialAmountUsd?: number;
  onClose: () => void;
  onRefreshSummary?: () => void | boolean | Promise<void | boolean>;
}) {
  const [walletType, setWalletType] = useState<ManagedVeniceWalletType>(initialWalletType);
  const [amountUsd, setAmountUsd] = useState(initialAmountUsd ?? MANAGED_VENICE_DEFAULT_TOP_UP_USD);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quote, setQuote] = useState<ManagedVeniceTokenQuotePayload | null>(null);
  const [refreshingWallet, setRefreshingWallet] = useState(false);
  const [walletRefreshStatus, setWalletRefreshStatus] = useState<"idle" | "refreshed" | "failed">("idle");

  useEffect(() => {
    if (!isOpen) return;
    setWalletType(initialWalletType);
    setAmountUsd(initialAmountUsd ?? MANAGED_VENICE_DEFAULT_TOP_UP_USD);
    setError(null);
    setNotice(null);
    setQuote(null);
    setRefreshingWallet(false);
    setWalletRefreshStatus("idle");
  }, [initialAmountUsd, initialWalletType, isOpen]);

  if (!isOpen) return null;

  const topUpQuote = getManagedVeniceTopUpQuote(amountUsd, walletType);
  const quoteActive = Boolean(
    quote &&
      walletType === "hermesos" &&
      (quote.status === "active" || quote.status === "expired")
  );
  const quoteSettled = Boolean(quote && walletType === "hermesos" && quote.status === "settled");

  async function startHermesTopUp() {
    setLoading(true);
    setError(null);
    setNotice(null);
    setQuote(null);
    try {
      const result = await requestManagedVeniceHermesQuote(amountUsd);
      if (!result.ok) {
        if (result.reason === "bankr_wallet_provisioning_pending") {
          setNotice(
            "Token top-ups are waiting on Bankr wallet provisioning. Once Bankr is connected, this same panel will show the exact $HermesOS amount, QR code, and deposit address. Card checkout is available now."
          );
          return;
        }
        throw new Error(result.message);
      }
      setQuote(result.quote);
      await onRefreshSummary?.();
    } catch (topUpError) {
      const message = topUpError instanceof Error
        ? topUpError.message
        : "We couldn't start the $HermesOS top-up yet. Please try again in a moment, or use card credits for now.";
      setError(message);
      clientLog.error("managed Venice Hivra top-up failed", topUpError, {
        source: "managed-venice-deposit-modal",
        failureType: "managed_venice_hermesos_topup_failed",
        errorName: topUpError instanceof Error ? topUpError.name : typeof topUpError,
      });
    } finally {
      setLoading(false);
    }
  }

  async function startCardTopUp() {
    setLoading(true);
    setError(null);
    setNotice(null);
    setQuote(null);
    try {
      const response = await fetch("/api/billing/managed-venice/card/top-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountMicroUsd: managedVeniceUsdToMicroUsd(amountUsd) }),
      });
      const payload = await readApiPayload(response);
      if (!response.ok) {
        throw new Error(apiPayloadError(payload, "Failed to start card checkout."));
      }
      const data = apiSuccessData(payload);
      if (!data || typeof data.url !== "string") {
        throw new Error("Stripe checkout did not return a checkout link.");
      }
      await redirectToCheckoutUrl(data.url);
    } catch (topUpError) {
      const message = topUpError instanceof Error ? topUpError.message : "Failed to start card checkout.";
      setError(message);
      clientLog.error("managed Venice card top-up failed", topUpError, {
        source: "managed-venice-deposit-modal",
        failureType: "managed_venice_card_topup_failed",
        errorName: topUpError instanceof Error ? topUpError.name : typeof topUpError,
      });
    } finally {
      setLoading(false);
    }
  }

  async function refreshWalletSummary() {
    if (refreshingWallet) return;
    setRefreshingWallet(true);
    setWalletRefreshStatus("idle");
    try {
      // Handlers may report failure by resolving false instead of
      // rejecting (the billing page's summary fetch swallows errors);
      // don't show "Wallet refreshed" over a refresh that failed.
      const outcome = await onRefreshSummary?.();
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
        onClick={() => {
          setWalletType(value);
          setQuote(null);
          setError(null);
          setNotice(null);
        }}
        style={{
          padding: "13px 14px",
          textAlign: "left",
          border: `1px solid ${active ? (value === "hermesos" ? "var(--gold-leaf)" : "var(--ink-black)") : "var(--etched-border)"}`,
          background: active ? (value === "hermesos" ? "rgba(255, 44, 45,0.13)" : "var(--bg-elevated)") : "transparent",
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
              Venice runs at provider rates with no Hivra markup. Card credits add exactly what you pay; $HermesOS top-ups can add launch bonus credits.
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
          {walletButton(
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
          id="managed-venice-deposit-top-up"
          amountUsd={amountUsd}
          walletType={walletType}
          onAmountChange={setAmountUsd}
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

        {notice && (
          <div
            role="status"
            style={{
              border: "1px solid rgba(255, 44, 45,0.5)",
              background: "rgba(255, 44, 45,0.1)",
              color: "var(--text-primary)",
              padding: "11px 13px",
              fontSize: 12,
              lineHeight: 1.55,
            }}
          >
            {notice}
          </div>
        )}

        {quote && walletType === "hermesos" && (
          <ManagedVeniceTokenQuotePanel
            quote={quote}
            onQuoteUpdate={setQuote}
            onSettled={() => {
              void onRefreshSummary?.();
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
              onClick={walletType === "hermesos" ? startHermesTopUp : startCardTopUp}
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
