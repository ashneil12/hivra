'use client';

import { useEffect, useState } from "react";

import { clientLog } from "@/lib/client/logger";
import { useTokenGeoAccess } from "@/hooks/useTokenGeoAccess";
import { redirectToCheckoutUrl } from "@/lib/billing/client";
import { ManagedVeniceDepositView } from "@/components/billing/ManagedVeniceDepositView";
import {
  managedVeniceUsdToMicroUsd,
  requestManagedVeniceHermesQuote,
  type ManagedVeniceTokenQuotePayload,
} from "@/lib/billing/managed-venice-client";
import {
  MANAGED_VENICE_DEFAULT_TOP_UP_USD,
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
  const [walletTypeChoice, setWalletType] = useState<ManagedVeniceWalletType>(initialWalletType);
  // Token geo-policy: a viewer it blocks (or while it is still checking) gets
  // a card-only dialog. "allowed" at once while the policy is dormant.
  const tokenPaymentsShown = useTokenGeoAccess().status === "allowed";
  const walletType: ManagedVeniceWalletType = tokenPaymentsShown ? walletTypeChoice : "card";
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

  return (
    <ManagedVeniceDepositView
      title="Top up before launch"
      description={
        tokenPaymentsShown
          ? "Venice runs at provider rates with no Hivra markup. Card credits add exactly what you pay; $HermesOS top-ups can add launch bonus credits."
          : "Venice runs at provider rates with no Hivra markup. Card credits add exactly what you pay."
      }
      walletOptions={tokenPaymentsShown ? ["hermesos", "card"] : ["card"]}
      walletType={walletType}
      onWalletTypeChange={(value) => {
        setWalletType(value);
        setQuote(null);
        setError(null);
        setNotice(null);
      }}
      calculatorId="managed-venice-deposit-top-up"
      amountUsd={amountUsd}
      onAmountChange={setAmountUsd}
      error={error}
      notice={notice}
      quote={quote}
      onQuoteUpdate={setQuote}
      onQuoteSettled={() => {
        void onRefreshSummary?.();
      }}
      quoteInFlight={quoteActive}
      quoteSettled={quoteSettled}
      loading={loading}
      onStart={walletType === "hermesos" ? startHermesTopUp : startCardTopUp}
      refreshingWallet={refreshingWallet}
      walletRefreshStatus={walletRefreshStatus}
      onRefreshWallet={() => void refreshWalletSummary()}
      onClose={onClose}
    />
  );
}
