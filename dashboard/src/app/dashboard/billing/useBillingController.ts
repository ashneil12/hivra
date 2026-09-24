'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isPlanUpgrade, type PlanKey } from "@/lib/subscription";
import {
  redirectToCheckoutUrl,
  requestCreditTopUpCheckout,
  requestSubscriptionCheckout,
} from "@/lib/billing/client";
import { isPlanKey } from "@/lib/billing/plan-display";
import { readHoldAmounts, type HoldAmounts } from "@/lib/billing/hold-amounts";
import { resolveSubscriptionManagementView } from "@/lib/billing/subscription-management-copy";
import { clientLog } from "@/lib/client/logger";
import { planReturnParams, safeReturnPath, withReturnParams } from "@/lib/safe-return-path";
import { LAUNCH_ROUTE } from "@/lib/hivra/launch-navigation";
import { useTokenGeoAccess } from "@/hooks/useTokenGeoAccess";
import type { BillingActivityData } from "@/components/billing/BillingActivityPanel";
import {
  describeWalletProviderError,
  requestWalletProvider,
} from "@/lib/client/wallet-provider-errors";
import {
  MANAGED_VENICE_DEFAULT_TOP_UP_USD,
  normalizeManagedVeniceTopUpAmount,
  type ManagedVeniceWalletType,
} from "@/lib/venice/managed-credit-topup";
import {
  readManagedVeniceTokenQuote,
  type ManagedVeniceTokenQuotePayload,
} from "@/lib/billing/managed-venice-client";
// Pure formatters, validators and payload readers live in
// "@/lib/billing/format" so they can be tested without a DOM.
import {
  apiPayloadError,
  apiSuccessData,
  captureBillingEvent,
  getBrowserWalletProvider,
  isBillingV2UiEnabled,
  isCreditTopUpsUiEnabled,
  isCryptoBillingUiEnabled,
  isRecord,
  isSelfServeDowngradeUiEnabled,
  readApiPayload,
  readChallengeData,
  readCryptoTopUpIntent,
  readManagedVeniceSummary,
  readVerifiedWallet,
  readWalletAccounts,
  usdToMicroUsd,
} from "@/lib/billing/format";
import type {
  CreditTopUpPackageCredits,
  CryptoTopUpIntentData,
  ManagedVeniceDashboardSummary,
  TokenHoldingData,
  VerifiedWalletData,
  YearlyTokenQuotePayload,
  YearlyTokenSubscriptionPayload,
} from "@/lib/billing/format";

/**
 * Everything the billing page DOES, separate from how it looks: flags, state,
 * refs, fetchers, the mount effect (checkout confirmation and every deep
 * link), the paywall and yearly-poll effects, and every handler.
 *
 * Moved verbatim from app/dashboard/billing/page.tsx. The effects keep their
 * original dependency arrays, refs and timers (the yearly deep link's
 * once-only ref and deliberately-uncleared 50ms timer, the 15s yearly poll,
 * paywall_viewed once per mount). Handlers read the same values at call time.
 * The derived values the old page computed after its early returns are
 * computed here before the handlers; per render they are identical.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BillingInstance {
  id: string;
  name: string;
  status: string;
  cpu: number;
  ram: number;
  disk_size_gb?: number;
  disk_upgraded?: boolean;
  backups_enabled?: boolean;
}

export type BillingPlanSource =
  | "stripe"
  | "free"
  | "token_holding"
  | "token_yearly"
  | "workspace_cloud"
  | "apple_iap";

export interface BillingUsageData {
  subscribed: boolean;
  plan: {
    key: string;
    name: string;
    price: number;
    maxAgents: number;
    totalCpu: number;
    totalRam: number;
    status: string;
    currentPeriodEnd: string | null;
    source?: BillingPlanSource;
    tokenTier?: "pro" | "power";
    canChangePlanInPlace?: boolean;
    veniceBoost?: { active: boolean; cpuBonus: number; ramBonusMb: number };
  } | null;
  usage: {
    agentCount: number;
    maxAgents: number;
    usedCpu: number;
    totalCpu: number;
    usedRam: number;
    totalRam: number;
    instances: BillingInstance[];
    /**
     * Whether the $10/mo backup add-on can be bought, by the same checks the
     * backup-addon route makes. Missing (an older API) means "can't".
     */
    backupAddon?: {
      purchasable: boolean;
      instanceIds: string[];
      includedWithPlan: boolean;
    };
  } | null;
  credits: {
    balance: number;
    monthlyGrant: number;
    unit: string;
  };
  /**
   * Only without a plan: a paid plan that holds the account but grants it
   * nothing (a payment didn't go through, or it has no agent slots). Free
   * can't be turned on over it; the billing portal settles it.
   */
  planOnHold?: {
    key: string;
    name: string;
    status: string;
    reason: "payment_overdue" | "no_slots";
    billingPortal: boolean;
  } | null;
}

type UsageData = BillingUsageData;

/**
 * The query params this page reads. The page also mirrors its selected tab to
 * `?tab=` with window.history.replaceState, which Next syncs into
 * useSearchParams. Handing the mount effect a searchParams object whose
 * identity only changes when one of THESE params changes keeps a tab switch
 * from re-running the effect (which would re-confirm a checkout, re-show a
 * dismissed success banner and refetch everything). Any change to a billing
 * param — including the effect stripping its own deep-link params — still
 * produces a new object and re-runs the effect exactly as before.
 */
export const BILLING_QUERY_PARAM_KEYS = [
  "subscription",
  "session_id",
  "intent",
  "instanceId",
  "storage_expanded",
  "credits",
  "managedVenice",
  "wallet",
  "amountUsd",
  "plan",
  "cadence",
  "yearly_token",
  "from",
  "feature",
  "returnTo",
] as const;

function useBillingSearchParams() {
  const searchParams = useSearchParams();
  const signature = BILLING_QUERY_PARAM_KEYS
    .map((key) => `${key}=${searchParams?.get(key) ?? ""}`)
    .join("&");
  // The memo is keyed on the billing params' values, not on the object's
  // identity (see BILLING_QUERY_PARAM_KEYS). A reused object holds the same
  // values for every key this page reads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => searchParams, [signature]);
}

/** Where a plan change started from (a launch blocked on the plan) and
 * should land once the plan is confirmed, marked with the plan it moved to so
 * that page can check whether it shows yet. Only a same-origin dashboard path. */
/** With nothing to return to, a confirmed plan opens Launch, which says
 * whether the new plan shows yet. */
function launchAfterPlanChange(planKey: unknown): string {
  return withReturnParams(LAUNCH_ROUTE, planReturnParams(isPlanKey(planKey) ? planKey : null));
}

function planReturnDestination(
  params: { get(key: string): string | null } | null | undefined,
  planKey: unknown,
): string | null {
  const returnTo = safeReturnPath(params?.get("returnTo"));
  return returnTo ? withReturnParams(returnTo, planReturnParams(isPlanKey(planKey) ? planKey : null)) : null;
}

export function useBillingController() {
  const router = useRouter();
  const searchParams = useBillingSearchParams();
  const returnTo = safeReturnPath(searchParams?.get("returnTo"));
  const billingV2Enabled = isBillingV2UiEnabled();
  const cryptoBillingEnabled = isCryptoBillingUiEnabled();
  const creditTopUpsEnabled = isCreditTopUpsUiEnabled();
  const selfServeDowngradeEnabled = isSelfServeDowngradeUiEnabled();
  // Token geo-policy: "allowed" at once while the policy is dormant.
  const tokenGeo = useTokenGeoAccess();

  const [data, setData] = useState<UsageData | null>(null);
  const [activity, setActivity] = useState<BillingActivityData | null>(null);
  const [managedVeniceSummary, setManagedVeniceSummary] = useState<ManagedVeniceDashboardSummary | null>(null);
  const [tokenHolding, setTokenHolding] = useState<TokenHoldingData | null>(null);
  const [loading, setLoading] = useState(true);
  // paywall_viewed fires once per mount when the plan grid first renders
  // (post-load). The ref guards against re-fires on data refreshes.
  const paywallViewedRef = useRef(false);
  // The ?plan=&yearly_token=1 deep link is handled once per page load.
  const yearlyDeepLinkHandledRef = useRef(false);
  const [activityLoading, setActivityLoading] = useState(billingV2Enabled);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [tokenLoading, setTokenLoading] = useState(cryptoBillingEnabled);
  const [tokenRefreshing, setTokenRefreshing] = useState(false);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [cryptoTopUpIntent, setCryptoTopUpIntent] = useState<CryptoTopUpIntentData | null>(null);
  const [cryptoTopUpError, setCryptoTopUpError] = useState<string | null>(null);
  const [cryptoToppingUp, setCryptoToppingUp] = useState<CreditTopUpPackageCredits | null>(null);
  const [managedVeniceDepositOpen, setManagedVeniceDepositOpen] = useState(false);
  const [managedVeniceDepositWallet, setManagedVeniceDepositWallet] =
    useState<ManagedVeniceWalletType>("card");
  const [managedVeniceDepositAmountUsd, setManagedVeniceDepositAmountUsd] = useState(
    MANAGED_VENICE_DEFAULT_TOP_UP_USD
  );
  const [managedVeniceDepositLoading, setManagedVeniceDepositLoading] = useState(false);
  const [managedVeniceDepositError, setManagedVeniceDepositError] = useState<string | null>(null);
  const [managedVeniceTokenQuote, setManagedVeniceTokenQuote] =
    useState<ManagedVeniceTokenQuotePayload | null>(null);
  const [subscribing, setSubscribing] = useState<string | null>(null);
  // Cadence chosen on the pricing card toggle. "yearly" picks the
  // STRIPE_*_YEARLY_PRICE_ID at checkout time; "monthly" picks the
  // existing one. Defaults to monthly so first-paint matches what
  // the pricing card has shown forever.
  const [cadence, setCadence] = useState<"monthly" | "yearly">("monthly");
  // Top-level payment-path tabs above the plan grid. Mirrors the
  // welcome-flow split so the user sees the same "Card vs Crypto" choice
  // wherever they pick a plan.
  //   'card'   → Stripe Monthly | Stripe Yearly (CadenceToggle below)
  //   'crypto' → $HermesOS Yearly | $HermesOS Permanent (hold-to-qualify)
  const [paidPath, setPaidPath] = useState<"card" | "crypto">("card");
  // Crypto sub-mode used when paidPath === 'crypto'.
  const [cryptoMode, setCryptoMode] = useState<"yearly" | "permanent">("yearly");
  const [changingPlan, setChangingPlan] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  // Cancel save-flow: one survey question + a matched save offer shown
  // BEFORE the existing cancel path (the Stripe billing portal). "Cancel
  // anyway" runs handlePortal unchanged.
  const [showCancelSaveFlow, setShowCancelSaveFlow] = useState(false);
  const [toppingUp, setToppingUp] = useState<CreditTopUpPackageCredits | null>(null);
  const [enablingBackup, setEnablingBackup] = useState<string | null>(null);
  const [violation, setViolation] = useState<string | null>(null);
  const [checkoutConfirmError, setCheckoutConfirmError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [confirmingPlan, setConfirmingPlan] = useState<PlanKey | null>(null);
  // Yearly token-payment flow. Tracks which plan we're showing the
  // deposit modal for (or null if no modal is open) and the active
  // quote payload returned by the yearly-token-quote endpoint.
  const [yearlyTokenTier, setYearlyTokenTier] = useState<"pro" | "power" | null>(null);
  const [yearlyTokenQuote, setYearlyTokenQuote] = useState<YearlyTokenQuotePayload | null>(null);
  const [yearlyTokenLoading, setYearlyTokenLoading] = useState(false);
  const [yearlyTokenError, setYearlyTokenError] = useState<string | null>(null);
  // Captured when the modal opens: minting a new quote supersedes the pending
  // review in the reloaded state, but the user should still see the warning.
  const [yearlyTokenReviewPending, setYearlyTokenReviewPending] = useState(false);
  // Durable active-quotes state. Quotes survive a 20-min server lifetime
  // in `yearly_token_quotes`; we GET them on page mount so a refresh /
  // back-nav surfaces the same locked amount + countdown via the banner
  // instead of pretending nothing's in flight.
  const [activeYearlyQuotes, setActiveYearlyQuotes] = useState<{
    pro: YearlyTokenQuotePayload | null;
    power: YearlyTokenQuotePayload | null;
  }>({ pro: null, power: null });
  // Quotes that can no longer be paid but still matter, per tier: expired
  // inside the late-payment grace (a payment on its way is still picked up)
  // or a payment under manual review. Shown so nobody pays twice.
  const [pendingYearlyQuotes, setPendingYearlyQuotes] = useState<{
    pro: YearlyTokenQuotePayload | null;
    power: YearlyTokenQuotePayload | null;
  }>({ pro: null, power: null });
  // Most-recent activated yearly_token_subscriptions row per tier.
  // Drives the post-pay progress stepper — once paid_at is recent the
  // banner switches from "waiting for deposit" to "activated · sweeping"
  // to "complete · expires <date>" without needing a reload.
  const [recentYearlySubs, setRecentYearlySubs] = useState<{
    pro: YearlyTokenSubscriptionPayload | null;
    power: YearlyTokenSubscriptionPayload | null;
  }>({ pro: null, power: null });
  const [yearlyCheckingNow, setYearlyCheckingNow] = useState(false);

  const [confirming, setConfirming] = useState(false);
  const backupIntent = searchParams?.get("intent") === "backups";
  const backupIntentInstanceId = searchParams?.get("instanceId");

  // ── Derived values (computed after the early returns in the old page) ─────
  const currentPlanKey = data?.plan?.key as PlanKey | undefined;
  const changePlanRequiresCheckout =
    currentPlanKey === "free" || data?.plan?.canChangePlanInPlace === false;
  // Source-routed management controls: Apple IAP subs get "Manage in the App
  // Store"; everyone else keeps the existing Stripe portal/cancel controls.
  const subscriptionManagement = resolveSubscriptionManagementView({
    planKey: data?.plan?.key ?? null,
    source: data?.plan?.source ?? null,
  });
  const creditBalance = data?.credits?.balance ?? 0;
  const backupAddon = data?.usage?.backupAddon ?? null;
  // Backups are on when a machine has the add-on or its plan includes them.
  const backupsEnabled =
    (data?.usage?.instances.some((i) => i.backups_enabled) ?? false) || Boolean(backupAddon?.includedWithPlan);
  // Machines the add-on can actually be bought for; empty when the plan or
  // machine can't take it (the backup route would reject the purchase).
  const backupAddonInstanceIds = backupAddon?.purchasable ? backupAddon.instanceIds : [];
  const backupIntentInstance = data?.usage?.instances.find((instance) => instance.id === backupIntentInstanceId) ?? null;
  const shouldShowBackupIntent = backupIntent && !backupsEnabled;
  // The machine the console's "finish enabling backups" link is about, when
  // the add-on can be bought for it; otherwise the first machine that can.
  const backupIntentTargetId = backupIntentInstance
    ? backupAddonInstanceIds.includes(backupIntentInstance.id)
      ? backupIntentInstance.id
      : null
    : backupAddonInstanceIds[0] ?? null;


  const openManagedVeniceDeposit = useCallback(
    (walletType: ManagedVeniceWalletType, amountUsd = MANAGED_VENICE_DEFAULT_TOP_UP_USD) => {
      setManagedVeniceDepositWallet(walletType);
      setManagedVeniceDepositAmountUsd(normalizeManagedVeniceTopUpAmount(amountUsd));
      setManagedVeniceDepositError(null);
      setManagedVeniceTokenQuote(null);
      setManagedVeniceDepositOpen(true);
    },
    []
  );

  // Returns the request so a handler can wait for fresh data before it
  // re-enables its controls; other callers ignore it.
  const fetchUsage = useCallback(() => {
    setLoading(true);
    return fetch("/api/billing/usage", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (d.success) setData(d.data); })
      .catch((err) => {
        clientLog.error("Billing usage fetch failed", err, {
          source: "billing-page",
        });
      })
      .finally(() => setLoading(false));
  }, []);

  const fetchBillingActivity = useCallback(() => {
    setActivityLoading(true);
    setActivityError(null);

    return fetch("/api/billing/activity")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setActivity(d.data);
        } else {
          setActivityError(d.error || "Billing activity is unavailable right now.");
        }
      })
      .catch(() => {
        setActivityError("Billing activity is unavailable right now.");
      })
      .finally(() => setActivityLoading(false));
  }, []);

  // Resolves to false (never rejects) when the summary could not be
  // refreshed, so callers that surface refresh feedback (the deposit
  // modal's "Refresh wallet" status line) can distinguish outcomes;
  // background callers ignore the return value.
  const fetchManagedVeniceSummary = useCallback((): Promise<boolean> => {
    return fetch("/api/billing/managed-venice/summary")
      .then(readApiPayload)
      .then((payload) => {
        const summary = readManagedVeniceSummary(apiSuccessData(payload));
        if (summary) {
          setManagedVeniceSummary(summary);
          return true;
        }

        setManagedVeniceSummary(null);
        if (payload?.success === true) {
          clientLog.warn("Managed Venice summary response failed validation", {
            source: "billing-page",
            failureType: "managed_venice_summary_contract_mismatch",
            hasWallets: isRecord(payload.data) && isRecord(payload.data.wallets),
            hasDiscount: isRecord(payload.data) && isRecord(payload.data.discount),
            hasKillSwitch: isRecord(payload.data) && isRecord(payload.data.killSwitch),
            hasKeys: isRecord(payload.data) && Array.isArray(payload.data.keys),
          });
        }
        return false;
      })
      .catch((err) => {
        setManagedVeniceSummary(null);
        clientLog.warn("Managed Venice summary fetch failed", {
          source: "billing-page",
          errorName: err instanceof Error ? err.name : typeof err,
        });
        return false;
      });
  }, []);

  // Per-plan hold amounts for this user (epoch- and founders-aware), from the
  // wallet eligibility API. Refetched when the verified balance changes.
  const [holdAmounts, setHoldAmounts] = useState<HoldAmounts | null>(null);
  const tokenBalanceKey = tokenHolding?.snapshot?.balanceDisplay ?? null;
  useEffect(() => {
    if (!cryptoBillingEnabled) return;
    let cancelled = false;
    fetch("/api/billing/wallet/eligibility", { cache: "no-store" })
      .then(readApiPayload)
      .then((payload) => {
        if (!cancelled) setHoldAmounts(readHoldAmounts(apiSuccessData(payload)));
      })
      .catch((err) => {
        clientLog.warn("Billing hold amounts fetch failed", {
          source: "billing-page",
          failureType: "billing_hold_amounts_fetch_failed",
          errorName: err instanceof Error ? err.name : typeof err,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [cryptoBillingEnabled, tokenBalanceKey]);

  const fetchTokenHolding = useCallback((quiet = false) => {
    if (!quiet) setTokenLoading(true);
    setTokenError(null);

    return fetch("/api/billing/token-holding")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setTokenHolding(d.data);
        } else {
          setTokenError(d.error || "Token status is unavailable right now.");
        }
      })
      .catch(() => {
        setTokenError("Token status is unavailable right now.");
      })
      .finally(() => {
        if (!quiet) setTokenLoading(false);
      });
  }, []);

  /**
   * GET active yearly $HermesOS quotes for the current user. Called
   * on page mount and after mint/dismiss so the durable banner +
   * modal always reflect server truth. Server-side auto-expiry
   * (status='expired' on first read past expires_at) keeps stale rows
   * from re-appearing in the response.
   */
  const loadYearlyQuotes = useCallback(async () => {
    try {
      const res = await fetch("/api/billing/yearly-token-quote", { method: "GET" });
      if (!res.ok) {
        setActiveYearlyQuotes({ pro: null, power: null });
        setPendingYearlyQuotes({ pro: null, power: null });
        setRecentYearlySubs({ pro: null, power: null });
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (body?.success) {
        setActiveYearlyQuotes({
          pro: (body.data?.pro as YearlyTokenQuotePayload | null) ?? null,
          power: (body.data?.power as YearlyTokenQuotePayload | null) ?? null,
        });
        setPendingYearlyQuotes({
          pro: (body.data?.proPending as YearlyTokenQuotePayload | null) ?? null,
          power: (body.data?.powerPending as YearlyTokenQuotePayload | null) ?? null,
        });
        setRecentYearlySubs({
          pro: (body.data?.proSubscription as YearlyTokenSubscriptionPayload | null) ?? null,
          power: (body.data?.powerSubscription as YearlyTokenSubscriptionPayload | null) ?? null,
        });
      }
    } catch {
      // Best-effort — banner just won't render on transient failure.
    }
  }, []);

  useEffect(() => {
    const sessionId = searchParams?.get("session_id");
    const isSuccess = searchParams?.get("subscription") === "success";

    if (isSuccess && sessionId) {
      // Confirm payment server-side immediately, then redirect to welcome.
      // The redirect itself is not proof that Stripe settled the checkout.
      setConfirming(true);
      setCheckoutConfirmError(null);

      void (async () => {
        try {
          const response = await fetch("/api/billing/confirm-checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
          });
          const payload = await readApiPayload(response);
          const data = apiSuccessData(payload);

          if (!response.ok || data?.activated !== true) {
            const message = apiPayloadError(
              payload,
              `Checkout confirmation failed (${response.status}).`
            );
            clientLog.error("Checkout confirmation failed", new Error(message), {
              source: "billing-page",
              failureType: "checkout_confirmation_failed",
              route: "/api/billing/confirm-checkout",
              status: response.status,
              sessionId,
              payloadSuccess: payload?.success === true,
              activated: data?.activated === true,
            });
            setCheckoutConfirmError(
              "We could not confirm your checkout yet. Your payment may still settle through Stripe; refresh billing in a minute. If this keeps happening, report it below and we'll sort it out."
            );
            setConfirming(false);
            fetchUsage();
            return;
          }

          router.replace(planReturnDestination(searchParams, data?.plan) ?? launchAfterPlanChange(data?.plan));
        } catch (err) {
          clientLog.error("Checkout confirmation request failed", err, {
            source: "billing-page",
            failureType: "checkout_confirmation_request_failed",
            route: "/api/billing/confirm-checkout",
            sessionId,
            errorName: err instanceof Error ? err.name : typeof err,
          });
          setCheckoutConfirmError(
            "We could not confirm your checkout yet. Your payment may still settle through Stripe; refresh billing in a minute. If this keeps happening, report it below and we'll sort it out."
          );
          setConfirming(false);
          fetchUsage();
        }
      })();
      return;
    }

    fetchUsage();
    if (billingV2Enabled) {
      void fetchBillingActivity();
      void fetchManagedVeniceSummary();
    }
    if (cryptoBillingEnabled) {
      void fetchTokenHolding();
    }
    // Active yearly $HermesOS quotes are durable: we GET them on
    // mount so a refresh / back-nav resumes the same locked amount
    // + countdown instead of pretending nothing's in flight.
    void loadYearlyQuotes();

    if (searchParams?.get("storage_expanded") === "1") {
      setSuccessMsg("🎉 Storage expanded! Your +20GB disk expansion is being applied.");
    } else if (searchParams?.get("credits") === "success") {
      setSuccessMsg("Credits top-up complete. Your balance will refresh after Stripe confirms payment.");
    } else if (searchParams?.get("managedVenice") === "card_success") {
      setSuccessMsg("Managed Venice card top-up complete. Your LLM credits wallet will refresh after Stripe confirms payment.");
    }

    if (searchParams?.get("managedVenice") === "deposit") {
      const walletParam = searchParams?.get("wallet");
      const amountParam = Number(searchParams?.get("amountUsd"));
      const walletType: ManagedVeniceWalletType = billingV2Enabled && walletParam === "hermesos" ? "hermesos" : "card";
      const amountUsd = normalizeManagedVeniceTopUpAmount(amountParam);
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("managedVenice");
        url.searchParams.delete("wallet");
        url.searchParams.delete("amountUsd");
        window.history.replaceState(null, "", url.pathname + (url.searchParams.toString() ? "?" + url.searchParams.toString() : ""));
      }
      window.setTimeout(() => openManagedVeniceDeposit(walletType, amountUsd), 50);
    }

    // Welcome flow deep-link handling: ?plan=&cadence= for card, or
    // ?plan=&yearly_token=1 for the $HermesOS-yearly modal. Defer reading
    // these to the cadence/modal state — the card-checkout deep-link
    // pre-selects the toggle so the user lands on the right view, even
    // if Stripe checkout doesn't auto-fire.
    const linkPlan = searchParams?.get("plan");
    const linkCadence = searchParams?.get("cadence");
    const linkYearlyToken = searchParams?.get("yearly_token") === "1";
    if (linkCadence === "monthly" || linkCadence === "yearly") {
      setCadence(linkCadence);
    } else if (linkYearlyToken) {
      setCadence("yearly");
    }
    if (
      cryptoBillingEnabled &&
      linkYearlyToken &&
      !yearlyDeepLinkHandledRef.current &&
      (linkPlan === "operator" || linkPlan === "fleet" || linkPlan === "pro" || linkPlan === "power")
    ) {
      yearlyDeepLinkHandledRef.current = true;
      const tier: "pro" | "power" =
        linkPlan === "operator" || linkPlan === "pro" ? "pro" : "power";
      // Strip the deep-link params from the URL FIRST so a refresh /
      // back-nav doesn't re-fire the POST. Without this, every
      // refresh of /dashboard/billing?yearly_token=1&plan=... was
      // re-minting the modal flow and (in some races) appearing to
      // reset the 20-min countdown back to ~20:00.
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("yearly_token");
        url.searchParams.delete("plan");
        url.searchParams.delete("from");
        window.history.replaceState(null, "", url.pathname + (url.searchParams.toString() ? "?" + url.searchParams.toString() : ""));
      }
      // Defer to next tick so state updates from above settle first. The
      // timer is deliberately NOT cleared when this effect re-runs: stripping
      // the params above makes Next's router hand out a new searchParams,
      // which re-runs the effect before the timer fires (and the ref above
      // keeps it from firing twice).
      window.setTimeout(() => {
        setYearlyTokenTier(tier);
        setYearlyTokenLoading(true);
        void (async () => {
          try {
            // First check for an existing active quote; if present,
            // open the modal with that instead of POSTing a fresh one.
            // POST has locked-quote semantics anyway but the GET path
            // is cheaper and avoids any subtle race that could re-mint.
            const getRes = await fetch(
              `/api/billing/yearly-token-quote?tier=${tier}`,
              { method: "GET" },
            );
            const getBody = await getRes.json().catch(() => ({}));
            if (getRes.ok && getBody?.success && getBody.data?.quote) {
              setYearlyTokenQuote(getBody.data.quote);
              return;
            }
            // A payment for this tier is under review: don't mint a new quote
            // (that invites paying twice); the banner explains the review.
            if (getRes.ok && getBody?.success && getBody.data?.pendingQuote?.status === "manual_review") {
              setYearlyTokenTier(null);
              void loadYearlyQuotes();
              return;
            }
            const res = await fetch("/api/billing/yearly-token-quote", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tier }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.ok && body?.success) {
              setYearlyTokenQuote(body.data);
              // The banner (Check now, polling) is driven by the loaded state.
              void loadYearlyQuotes();
            } else {
              setYearlyTokenError(body?.error || `Failed to get quote (${res.status}).`);
            }
          } finally {
            setYearlyTokenLoading(false);
          }
        })();
      }, 50);
    }
  }, [billingV2Enabled, cryptoBillingEnabled, fetchBillingActivity, fetchManagedVeniceSummary, fetchUsage, fetchTokenHolding, loadYearlyQuotes, openManagedVeniceDeposit, searchParams, router]);

  // paywall_viewed: the billing plan grid is the paywall surface. Fire once
  // per mount, after the usage/plan fetch resolves so current_plan is real.
  useEffect(() => {
    if (loading || paywallViewedRef.current) return;
    paywallViewedRef.current = true;
    captureBillingEvent("paywall_viewed", {
      surface: "billing",
      current_plan: data?.plan?.key ?? "none",
    });
  }, [loading, data]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleSubscribe = async (planKey: string) => {
    captureBillingEvent("upgrade_clicked", {
      surface: "billing",
      to_plan: planKey,
      from_plan: data?.plan?.key ?? null,
      cadence,
    });
    setSubscribing(planKey);
    try {
      const result = await requestSubscriptionCheckout(planKey as PlanKey, cadence, { returnTo });
      if (result.ok) {
        if (result.activated) {
          router.push(planReturnDestination(searchParams, planKey) ?? launchAfterPlanChange(planKey));
          return;
        }

        const navigation = redirectToCheckoutUrl(result.url);
        if (!navigation.ok) {
          clientLog.error("Billing checkout navigation failed", new Error(navigation.message), {
            source: "billing-page",
            planKey,
            cadence,
            reason: "checkout_url_navigation_failed",
          });
          alert(navigation.message);
        }
      } else {
        clientLog.error("Billing checkout request failed", new Error(result.message), {
          source: "billing-page",
          planKey,
          cadence,
          reason: result.reason,
          status: result.status,
        });
        alert(result.message);
      }
    } finally {
      setSubscribing(null);
    }
  };

  /**
   * Fire the on-demand check-now endpoint — same logic as the
   * 5-min cron, run for THIS user's quote(s) right now. Cuts the
   * silent wait between "I sent the tokens" and "my tier activated"
   * from up to 5 min down to seconds.
   */
  const handleCheckNow = useCallback(async () => {
    setYearlyCheckingNow(true);
    try {
      await fetch("/api/billing/yearly-token-quote/check-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } finally {
      // Always re-load state, even if the check threw — DB might still
      // reflect a partial state change worth showing.
      await loadYearlyQuotes();
      setYearlyCheckingNow(false);
    }
  }, [loadYearlyQuotes]);

  /**
   * Resume an existing active quote — opens the modal pre-populated
   * with the persisted amount + address. No round-trip on the happy
   * path because we already have the quote in `activeYearlyQuotes`.
   */
  const handleResumeYearlyQuote = (tier: "pro" | "power") => {
    const quote = tier === "pro" ? activeYearlyQuotes.pro : activeYearlyQuotes.power;
    if (!quote) return;
    setYearlyTokenTier(tier);
    setYearlyTokenQuote(quote);
    setYearlyTokenError(null);
    setYearlyTokenLoading(false);
  };

  // While a yearly $HermesOS quote is active, an expired quote may still
  // receive a late payment, OR an activated sub still has
  // sweep_status='pending', poll every 15 s so the dashboard banner animates
  // through stages (waiting → activated → swept) without the user
  // refreshing. The interval auto-stops when nothing's in flight.
  useEffect(() => {
    const hasActiveQuote =
      activeYearlyQuotes.pro !== null || activeYearlyQuotes.power !== null;
    const hasLatePaymentWatch =
      pendingYearlyQuotes.pro?.status === "expired" || pendingYearlyQuotes.power?.status === "expired";
    const hasPendingSweep =
      (recentYearlySubs.pro !== null && recentYearlySubs.pro.sweepStatus === "pending") ||
      (recentYearlySubs.power !== null && recentYearlySubs.power.sweepStatus === "pending");
    if (!hasActiveQuote && !hasLatePaymentWatch && !hasPendingSweep) return;
    const handle = window.setInterval(() => {
      void loadYearlyQuotes();
    }, 15_000);
    return () => window.clearInterval(handle);
  }, [
    activeYearlyQuotes.pro,
    activeYearlyQuotes.power,
    pendingYearlyQuotes.pro,
    pendingYearlyQuotes.power,
    recentYearlySubs.pro,
    recentYearlySubs.power,
    loadYearlyQuotes,
  ]);


  /**
   * Open the "Pay yearly with $HermesOS" modal. POST mints a fresh
   * 20-min quote OR returns the existing active one (locked-quote
   * semantics in deposit-quotes.ts). Either way the modal lands on
   * a stable amount + deposit address. We re-load the active-quotes
   * state after success so the durable banner shows up.
   */
  const handleYearlyTokenPay = async (tier: "pro" | "power") => {
    setYearlyTokenReviewPending(
      (tier === "pro" ? pendingYearlyQuotes.pro : pendingYearlyQuotes.power)?.status === "manual_review"
    );
    setYearlyTokenTier(tier);
    setYearlyTokenLoading(true);
    setYearlyTokenError(null);
    setYearlyTokenQuote(null);
    try {
      const res = await fetch("/api/billing/yearly-token-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.success) {
        setYearlyTokenError(body?.error || `Failed to get quote (${res.status}).`);
        return;
      }
      setYearlyTokenQuote(body.data);
      // Refresh durable banner state.
      void loadYearlyQuotes();
    } catch (err) {
      setYearlyTokenError(err instanceof Error ? err.message : "Quote request failed.");
    } finally {
      setYearlyTokenLoading(false);
    }
  };

  const handleYearlyTokenClose = () => {
    setYearlyTokenReviewPending(false);
    setYearlyTokenTier(null);
    setYearlyTokenQuote(null);
    setYearlyTokenError(null);
    // Show server truth in the banner once the modal is gone.
    void loadYearlyQuotes();
  };

  const handleChangePlan = async (newPlan: PlanKey) => {
    setViolation(null);
    if (currentPlanKey === "free" || data?.plan?.canChangePlanInPlace === false) {
      setConfirmingPlan(null);
      await handleSubscribe(newPlan);
      return;
    }

    setChangingPlan(newPlan);
    // `currentPlanKey` is already narrowed to a paid tier here (the free /
    // canChangePlanInPlace===false case returned above), so this is a
    // paid→paid move; a non-upgrade target is therefore a downgrade.
    const isDowngradeClick =
      !!currentPlanKey &&
      newPlan !== currentPlanKey &&
      !isPlanUpgrade(currentPlanKey, newPlan);
    captureBillingEvent(isDowngradeClick ? "downgrade_clicked" : "upgrade_clicked", {
      surface: "billing",
      via: "change_plan",
      from_plan: currentPlanKey ?? null,
      to_plan: newPlan,
    });
    try {
      const res = await fetch("/api/billing/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPlan }),
      });
      const result = await res.json();

      if (result.success) {
        setSuccessMsg(result.data?.message || "Plan changed successfully.");
        // Keep the dialog busy until the new plan has loaded, so the page
        // never shows the old plan with live buttons in between.
        await fetchUsage();
        const returnAfterPlanChange = planReturnDestination(searchParams, newPlan);
        if (returnAfterPlanChange) router.push(returnAfterPlanChange);
      } else {
        setViolation(result.error || "Failed to change plan.");
      }
    } catch (err) {
      clientLog.error("Plan change request failed", err, {
        source: "billing-page",
        currentPlan: currentPlanKey,
        newPlan,
      });
      setViolation("Failed to change plan. Please try again.");
    } finally {
      setChangingPlan(null);
      setConfirmingPlan(null);
    }
  };

  const handleCreditTopUp = async (packageCredits: CreditTopUpPackageCredits) => {
    setToppingUp(packageCredits);
    try {
      const result = await requestCreditTopUpCheckout(packageCredits);
      if (result.ok) {
        if (result.activated) {
          router.push(LAUNCH_ROUTE);
          return;
        }

        const navigation = redirectToCheckoutUrl(result.url);
        if (!navigation.ok) {
          alert(navigation.message);
        }
      } else {
        alert(result.message);
      }
    } finally {
      setToppingUp(null);
    }
  };

  const handleCryptoTopUp = async (packageCredits: CreditTopUpPackageCredits) => {
    setCryptoToppingUp(packageCredits);
    setCryptoTopUpError(null);
    setCryptoTopUpIntent(null);
    try {
      const response = await fetch("/api/billing/crypto/top-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset: "usdc_base",
          packageCredits,
        }),
      });
      const payload = await readApiPayload(response);
      const intent = readCryptoTopUpIntent(apiSuccessData(payload));
      if (!intent) {
        setCryptoTopUpError(apiPayloadError(payload, "Could not create a crypto top-up."));
        return;
      }

      setCryptoTopUpIntent(intent);
    } catch {
      setCryptoTopUpError("Could not create a crypto top-up.");
    } finally {
      setCryptoToppingUp(null);
    }
  };

  const handleManagedVeniceHermesTopUp = async () => {
    setManagedVeniceDepositLoading(true);
    setManagedVeniceDepositError(null);
    setManagedVeniceTokenQuote(null);
    try {
      const response = await fetch("/api/billing/managed-venice/hermesos/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetPaidMicroUsd: usdToMicroUsd(managedVeniceDepositAmountUsd),
        }),
      });
      const payload = await readApiPayload(response);
      const quote = readManagedVeniceTokenQuote(apiSuccessData(payload));
      if (!quote) {
        setManagedVeniceDepositError(
          apiPayloadError(
            payload,
            "We couldn't start the $HermesOS top-up yet. Please try again in a moment, or use card credits for now."
          )
        );
        return;
      }
      setManagedVeniceTokenQuote(quote);
    } catch {
      setManagedVeniceDepositError(
        "We couldn't start the $HermesOS top-up yet. Please try again in a moment, or use card credits for now."
      );
    } finally {
      setManagedVeniceDepositLoading(false);
    }
  };

  const handleManagedVeniceCardTopUp = async () => {
    setManagedVeniceDepositLoading(true);
    setManagedVeniceDepositError(null);
    try {
      const response = await fetch("/api/billing/managed-venice/card/top-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountMicroUsd: usdToMicroUsd(managedVeniceDepositAmountUsd),
        }),
      });
      const payload = await readApiPayload(response);
      const data = apiSuccessData(payload);
      const url = typeof data?.url === "string" ? data.url : null;
      if (!url) {
        setManagedVeniceDepositError(
          apiPayloadError(payload, `Could not start card checkout (${response.status}).`)
        );
        return;
      }

      const navigation = redirectToCheckoutUrl(url);
      if (!navigation.ok) {
        setManagedVeniceDepositError(navigation.message);
      }
    } catch {
      setManagedVeniceDepositError("Could not start card checkout.");
    } finally {
      setManagedVeniceDepositLoading(false);
    }
  };

  const handleRefreshTokenHolding = async (walletOverride?: VerifiedWalletData | null) => {
    setTokenRefreshing(true);
    setTokenError(null);
    try {
      const res = await fetch("/api/billing/token-holding", { method: "POST" });
      const result = await res.json();

      if (result.success) {
        setTokenHolding((current) => ({
          token: result.data.token,
          wallet: result.data.refresh?.status === "no_verified_wallet"
            ? null
            : walletOverride ?? current?.wallet ?? null,
          snapshot: result.data.refresh?.snapshot ?? null,
          entitlement: result.data.entitlement,
        }));
      } else {
        setTokenError(result.error || "Token status is unavailable right now.");
      }
    } catch {
      setTokenError("Token status is unavailable right now.");
    } finally {
      setTokenRefreshing(false);
    }
  };

  const handleConnectWallet = async () => {
    setWalletConnecting(true);
    setTokenError(null);

    try {
      const provider = getBrowserWalletProvider();
      if (!provider) {
        setTokenError("No browser wallet found. Install a wallet that supports Base, then try again.");
        return;
      }

      const accounts = readWalletAccounts(
        await requestWalletProvider(
          provider,
          { method: "eth_requestAccounts" },
          { source: "billing-page", route: "/dashboard/billing" }
        )
      );
      const address = accounts[0];
      if (!address) {
        setTokenError("No wallet account was selected.");
        return;
      }

      const chainId = tokenHolding?.token?.chainId ?? 8453;
      const challengeResponse = await fetch("/api/billing/wallet/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, chainId }),
      });
      const challengePayload = await readApiPayload(challengeResponse);
      const challenge = readChallengeData(apiSuccessData(challengePayload));
      if (!challenge) {
        setTokenError(apiPayloadError(challengePayload, "Could not start wallet verification."));
        return;
      }

      const signature = await requestWalletProvider(
        provider,
        {
          method: "personal_sign",
          params: [challenge.message, address],
        },
        { source: "billing-page", route: "/dashboard/billing" }
      );
      if (typeof signature !== "string" || signature.trim().length === 0) {
        setTokenError("Wallet did not return a signature.");
        return;
      }

      const verifyResponse = await fetch("/api/billing/wallet/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          signature,
        }),
      });
      const verifyPayload = await readApiPayload(verifyResponse);
      const verifiedWallet = readVerifiedWallet(apiSuccessData(verifyPayload));
      if (!verifiedWallet) {
        setTokenError(apiPayloadError(verifyPayload, "Wallet verification failed."));
        return;
      }

      setTokenHolding((current) => current ? { ...current, wallet: verifiedWallet } : current);
      await handleRefreshTokenHolding(verifiedWallet);
    } catch (err) {
      setTokenError(describeWalletProviderError(
        err,
        "Wallet verification was not completed. Please try again."
      ));
    } finally {
      setWalletConnecting(false);
    }
  };

  const handlePortal = async () => {
    setPortalLoading(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const result = await res.json();
      if (result.success && result.data?.url) {
        window.location.href = result.data.url;
      } else {
        alert(result.error || "Could not open billing portal. Please try again.");
      }
    } finally {
      setPortalLoading(false);
    }
  };

  const handleEnableBackup = async (instanceId: string) => {
    setEnablingBackup(instanceId);
    try {
      const res = await fetch("/api/billing/backup-addon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceId }),
      });
      const result = await res.json();
      if (result.success) {
        // Keep the button busy until usage says backups are on.
        await fetchUsage();
        alert("Daily backups enabled successfully.");
      } else {
        alert(result.error || "Failed to enable backups");
      }
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to enable backups");
    } finally {
      setEnablingBackup(null);
    }
  };

  return {
    flags: {
      billingV2Enabled,
      cryptoBillingEnabled,
      creditTopUpsEnabled,
      selfServeDowngradeEnabled,
    },
    tokenGeo,
    status: { loading, confirming },
    /** The page a plan change returns to, when one started elsewhere. */
    returnTo,
    data,
    activity,
    activityLoading,
    activityError,
    managedVeniceSummary,
    tokenHolding,
    holdAmounts,
    tokenLoading,
    tokenRefreshing,
    walletConnecting,
    tokenError,
    cryptoTopUpIntent,
    cryptoTopUpError,
    cryptoToppingUp,
    managedVeniceDeposit: {
      open: managedVeniceDepositOpen,
      wallet: managedVeniceDepositWallet,
      amountUsd: managedVeniceDepositAmountUsd,
      loading: managedVeniceDepositLoading,
      error: managedVeniceDepositError,
      quote: managedVeniceTokenQuote,
    },
    setManagedVeniceDepositOpen,
    setManagedVeniceDepositWallet,
    setManagedVeniceDepositAmountUsd,
    setManagedVeniceDepositError,
    setManagedVeniceTokenQuote,
    subscribing,
    cadence,
    setCadence,
    paidPath,
    setPaidPath,
    cryptoMode,
    setCryptoMode,
    changingPlan,
    portalLoading,
    showCancelSaveFlow,
    setShowCancelSaveFlow,
    toppingUp,
    enablingBackup,
    violation,
    setViolation,
    checkoutConfirmError,
    setCheckoutConfirmError,
    successMsg,
    setSuccessMsg,
    confirmingPlan,
    setConfirmingPlan,
    yearly: {
      tier: yearlyTokenTier,
      quote: yearlyTokenQuote,
      loading: yearlyTokenLoading,
      error: yearlyTokenError,
      reviewPending: yearlyTokenReviewPending,
      activeQuotes: activeYearlyQuotes,
      pendingQuotes: pendingYearlyQuotes,
      recentSubs: recentYearlySubs,
      checkingNow: yearlyCheckingNow,
    },
    // Derived
    currentPlanKey,
    changePlanRequiresCheckout,
    subscriptionManagement,
    creditBalance,
    backupsEnabled,
    backupAddon,
    backupAddonInstanceIds,
    backupIntentInstance,
    backupIntentTargetId,
    shouldShowBackupIntent,
    // Fetchers
    fetchUsage,
    fetchBillingActivity,
    fetchManagedVeniceSummary,
    fetchTokenHolding,
    loadYearlyQuotes,
    // Handlers
    openManagedVeniceDeposit,
    handleSubscribe,
    handleCheckNow,
    handleResumeYearlyQuote,
    handleYearlyTokenPay,
    handleYearlyTokenClose,
    handleChangePlan,
    handleCreditTopUp,
    handleCryptoTopUp,
    handleManagedVeniceHermesTopUp,
    handleManagedVeniceCardTopUp,
    handleRefreshTokenHolding,
    handleConnectWallet,
    handlePortal,
    handleEnableBackup,
  };
}

export type BillingController = ReturnType<typeof useBillingController>;
