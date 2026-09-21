'use client';

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import {
  Loader2, CreditCard, Shield, AlertTriangle,
  Cpu, HardDrive, Users, TrendingUp, CheckCircle,
  ChevronRight, RefreshCw, X, ShieldCheck, Lock,
  Coins,
} from "lucide-react";
import {
  PLANS, ACTIVE_PLAN_KEYS,
  formatPrice, isPlanUpgrade, getPlanDiff, type PlanKey,
} from "@/lib/subscription";
import { buildHermesFadeSlideVariants, buildHermesStaggerVariants } from "@/components/ui/motion";
import {
  redirectToCheckoutUrl,
  requestCreditTopUpCheckout,
  requestSubscriptionCheckout,
} from "@/lib/billing/client";
import { resolveSubscriptionManagementView } from "@/lib/billing/subscription-management-copy";
import { clientLog } from "@/lib/client/logger";
import { CancelSaveFlow } from "@/components/billing/CancelSaveFlow";
import { ManagedVeniceByokSwitchPanel } from "@/components/billing/ManagedVeniceByokSwitchPanel";
import { ManagedVeniceKeysPanel } from "@/components/billing/ManagedVeniceKeysPanel";
import { BillingActivityPanel, type BillingActivityData } from "@/components/billing/BillingActivityPanel";
import { ManagedVeniceWalletPanel } from "@/components/billing/ManagedVeniceWalletPanel";
import { ChangePlanModal } from "@/components/dashboard/ChangePlanModal";
import { ReportProblemLink } from "@/components/support/ReportProblemLink";
import { useLocale } from "@/components/i18n/LocaleProvider";
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
// Billing dashboard building blocks (meters, toggles, tabs and the credits /
// crypto / token panels) live in "@/components/billing/BillingPanels".
import {
  CadenceToggle,
  CreditsPanel,
  CryptoModeToggle,
  CryptoTopUpPanel,
  ResourceBar,
  StatusBadge,
  TokenHoldingPanel,
} from "@/components/billing/BillingPanels";
// Yearly-token modals and the payment progress stepper live in
// "@/components/billing/YearlyTokenPanels".
import {
  ManagedVeniceDepositModal,
  YearlyPaymentProgress,
  YearlyTokenPaymentModal,
} from "@/components/billing/YearlyTokenPanels";



// ── Types ─────────────────────────────────────────────────────────────────────

interface Instance {
  id: string;
  name: string;
  status: string;
  cpu: number;
  ram: number;
  disk_size_gb?: number;
  disk_upgraded?: boolean;
  backups_enabled?: boolean;
}

interface UsageData {
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
    source?:
      | "stripe"
      | "free"
      | "token_holding"
      | "token_yearly"
      | "workspace_cloud"
      | "apple_iap";
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
    instances: Instance[];
  } | null;
  credits: {
    balance: number;
    monthlyGrant: number;
    unit: string;
  };
}


// ── Main Component ────────────────────────────────────────────────────────────

export default function BillingPage() {
  return (
    <Suspense fallback={
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", flex: 1 }}>
        <Loader2 size={20} style={{ opacity: 0.3, animation: "spin 1s linear infinite" }} />
      </div>
    }>
      <BillingPageContent />
    </Suspense>
  );
}

function BillingPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { copy } = useLocale();
  const billingCopy = copy.dashboard.billing;
  const reduceMotion = Boolean(useReducedMotion());
  const sectionVariants = buildHermesFadeSlideVariants(reduceMotion, { offset: 16 });
  const sectionGroupVariants = buildHermesStaggerVariants(reduceMotion, 0.08);
  const billingV2Enabled = isBillingV2UiEnabled();
  const cryptoBillingEnabled = isCryptoBillingUiEnabled();
  const creditTopUpsEnabled = isCreditTopUpsUiEnabled();
  const selfServeDowngradeEnabled = isSelfServeDowngradeUiEnabled();

  const [data, setData] = useState<UsageData | null>(null);
  const [activity, setActivity] = useState<BillingActivityData | null>(null);
  const [managedVeniceSummary, setManagedVeniceSummary] = useState<ManagedVeniceDashboardSummary | null>(null);
  const [tokenHolding, setTokenHolding] = useState<TokenHoldingData | null>(null);
  const [loading, setLoading] = useState(true);
  // paywall_viewed fires once per mount when the plan grid first renders
  // (post-load). The ref guards against re-fires on data refreshes.
  const paywallViewedRef = useRef(false);
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
  // Durable active-quotes state. Quotes survive a 20-min server lifetime
  // in `yearly_token_quotes`; we GET them on page mount so a refresh /
  // back-nav surfaces the same locked amount + countdown via the banner
  // instead of pretending nothing's in flight.
  const [activeYearlyQuotes, setActiveYearlyQuotes] = useState<{
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

  const fetchUsage = useCallback(() => {
    setLoading(true);
    fetch("/api/billing/usage", { cache: "no-store" })
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
        setRecentYearlySubs({ pro: null, power: null });
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (body?.success) {
        setActiveYearlyQuotes({
          pro: (body.data?.pro as YearlyTokenQuotePayload | null) ?? null,
          power: (body.data?.power as YearlyTokenQuotePayload | null) ?? null,
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

          router.replace("/dashboard/welcome?subscription=success&step=agent-type");
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
    if (cryptoBillingEnabled && linkYearlyToken && (linkPlan === "operator" || linkPlan === "fleet" || linkPlan === "pro" || linkPlan === "power")) {
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
      // Defer to next tick so state updates from above settle first.
      const timer = window.setTimeout(() => {
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
            const res = await fetch("/api/billing/yearly-token-quote", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tier }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.ok && body?.success) {
              setYearlyTokenQuote(body.data);
            } else {
              setYearlyTokenError(body?.error || `Failed to get quote (${res.status}).`);
            }
          } finally {
            setYearlyTokenLoading(false);
          }
        })();
      }, 50);
      return () => window.clearTimeout(timer);
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
      const result = await requestSubscriptionCheckout(planKey as PlanKey, cadence);
      if (result.ok) {
        if (result.activated) {
          router.push("/dashboard/welcome?step=agent-type");
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

  // While a yearly $HermesOS quote is active OR an activated sub still
  // has sweep_status='pending', poll every 15 s so the dashboard banner
  // animates through stages (waiting → activated → swept) without the
  // user refreshing. The interval auto-stops when nothing's in flight.
  useEffect(() => {
    const hasActiveQuote =
      activeYearlyQuotes.pro !== null || activeYearlyQuotes.power !== null;
    const hasPendingSweep =
      (recentYearlySubs.pro !== null && recentYearlySubs.pro.sweepStatus === "pending") ||
      (recentYearlySubs.power !== null && recentYearlySubs.power.sweepStatus === "pending");
    if (!hasActiveQuote && !hasPendingSweep) return;
    const handle = window.setInterval(() => {
      void loadYearlyQuotes();
    }, 15_000);
    return () => window.clearInterval(handle);
  }, [
    activeYearlyQuotes.pro,
    activeYearlyQuotes.power,
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
    setYearlyTokenTier(null);
    setYearlyTokenQuote(null);
    setYearlyTokenError(null);
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
        fetchUsage();
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
          router.push("/dashboard/welcome?step=agent-type");
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
        fetchUsage();
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

  // ── Loading ────────────────────────────────────────────────────────────────

  if (confirming) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", flex: 1, gap: 16 }}>
        <Loader2 size={24} style={{ opacity: 0.4, animation: "spin 1s linear infinite" }} />
        <span className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.15em", opacity: 0.5 }}>
          Activating your subscription...
        </span>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", flex: 1 }}>
        <Loader2 size={20} style={{ opacity: 0.3, animation: "spin 1s linear infinite" }} />
      </div>
    );
  }

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
  const backupsEnabled = data?.usage?.instances.some((i) => i.backups_enabled) ?? false;
  const firstInstanceId = data?.usage?.instances[0]?.id;
  const backupIntentInstance = data?.usage?.instances.find((instance) => instance.id === backupIntentInstanceId) ?? null;
  const shouldShowBackupIntent = backupIntent && !backupsEnabled;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} style={{ maxWidth: 960, margin: "1rem auto 5rem", padding: "clamp(1.5rem, 5vw, 3rem)", paddingTop: "calc(env(safe-area-inset-top, 0px) + clamp(1.5rem, 5vw, 3rem))", width: "100%" }}>

      {/* Header */}
      <motion.header initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }} style={{ marginBottom: "3rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--btn-bg)", color: "var(--btn-text)", display: "inline-block" }} />
          <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.3em", opacity: 0.6 }}>
            {billingCopy.eyebrow}
          </span>
        </div>
        <h1 className="serif" style={{ fontSize: "clamp(2.5rem, 8vw, 3.5rem)", fontWeight: 300, lineHeight: 1.1 }}>
          {billingCopy.titlePrefix}{billingCopy.titleSeparator}<em>{billingCopy.titleEmphasis}</em>{billingCopy.titleSuffix}
        </h1>
        <p style={{ marginTop: 16, color: "var(--text-secondary)", fontSize: 14 }}>Manage your plan and pay by card. No wallet required.</p>
      </motion.header>

      {/* Success Banner */}
      {successMsg && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px", marginBottom: "2rem",
          background: "transparent", border: "1px solid #16a34a",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <CheckCircle size={16} style={{ color: "#16a34a", flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: "var(--ink-black)", fontWeight: 500 }}>{successMsg}</span>
          </div>
          <button onClick={() => setSuccessMsg(null)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
            <X size={14} style={{ color: "#16a34a" }} />
          </button>
        </div>
      )}

      {checkoutConfirmError && (
        <div style={{
          padding: "1.5rem 2rem", marginBottom: "2rem",
          background: "transparent", border: "1px solid #dc2626",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "0.5rem" }}>
            <AlertTriangle size={16} style={{ color: "#dc2626", flexShrink: 0 }} />
            <span className="mono" style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#dc2626" }}>
              Checkout Not Confirmed
            </span>
          </div>
          <p style={{ fontSize: 13, color: "var(--ink-black)", margin: 0 }}>
            {checkoutConfirmError}
          </p>
          <div style={{ marginTop: "0.75rem" }}>
            <ReportProblemLink
              surface="billing-checkout"
              summary="Checkout not confirmed"
              errorContext={checkoutConfirmError}
              style={{ color: "#dc2626" }}
            />
          </div>
          <button
            onClick={() => setCheckoutConfirmError(null)}
            style={{ marginTop: "1rem", fontSize: 11, fontWeight: 700, color: "#dc2626", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-mono), monospace", textTransform: "uppercase", letterSpacing: "0.1em" }}
          >
            Dismiss
          </button>
        </div>
      )}

      {shouldShowBackupIntent && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 16, padding: "14px 20px", marginBottom: "2rem",
          background: "transparent", border: "1px solid var(--ink-black)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ShieldCheck size={16} style={{ color: "var(--ink-black)", flexShrink: 0 }} />
            <div>
              <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.14em", opacity: 0.55, fontWeight: 700, marginBottom: 4 }}>
                Backup Protection
              </div>
              <span style={{ fontSize: 13, color: "var(--ink-black)", fontWeight: 500 }}>
                Finish enabling daily backups{backupIntentInstance ? ` for ${backupIntentInstance.name}` : ""}.
              </span>
            </div>
          </div>
          <button
            onClick={() => {
              const targetInstanceId = backupIntentInstance?.id || firstInstanceId;
              if (targetInstanceId) {
                void handleEnableBackup(targetInstanceId);
              }
            }}
            disabled={!!enablingBackup || !(backupIntentInstance?.id || firstInstanceId)}
            style={{
              background: "var(--btn-bg)", color: "var(--btn-text)",
              border: "none", padding: "10px 16px",
              cursor: enablingBackup ? "wait" : "pointer",
              fontFamily: "var(--font-mono), monospace", fontSize: 10,
              fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em",
              display: "inline-flex", alignItems: "center", gap: 8, whiteSpace: "nowrap",
              opacity: enablingBackup ? 0.7 : 1,
            }}
          >
            {enablingBackup ? (
              <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
            ) : (
              <ShieldCheck size={14} />
            )}
            {enablingBackup ? "Enabling..." : "Enable Daily Backups"}
          </button>
        </div>
      )}

      {/* Downgrade blocked banner */}
      {violation && (
        <div style={{
          padding: "1.5rem 2rem", marginBottom: "2rem",
          background: "transparent", border: "1px solid #dc2626",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "0.5rem" }}>
            <AlertTriangle size={16} style={{ color: "#dc2626", flexShrink: 0 }} />
            <span className="mono" style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#dc2626" }}>
              Plan Change Not Available
            </span>
          </div>
          <p style={{ fontSize: 13, color: "var(--ink-black)", margin: 0 }}>
            {violation}
          </p>
          <button
            onClick={() => setViolation(null)}
            style={{ marginTop: "1rem", fontSize: 11, fontWeight: 700, color: "#dc2626", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-mono), monospace", textTransform: "uppercase", letterSpacing: "0.1em" }}
          >
            Dismiss
          </button>
        </div>
      )}

      {data?.subscribed && data.plan && data.usage ? (
        <motion.div initial="hidden" animate="visible" variants={sectionGroupVariants}>
          {/* ── Active Plan Panel ─────────────────────────────────────────── */}
          <motion.div variants={sectionVariants} style={{
            border: "1px solid var(--ink-black)", background: "var(--bg-surface)",
            padding: "clamp(1.5rem, 4vw, 2.5rem)", marginBottom: "2rem",
            boxShadow: "4px 4px 0px var(--ink-black)",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem", marginBottom: "2rem" }}>
              <div>
                <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.5, fontWeight: 700 }}>
                  {billingCopy.activePlan.title}
                </span>
                <h3 className="serif" style={{ fontSize: "2rem", fontWeight: 700, marginTop: 4 }}>
                  {data.plan.name}
                  {data.plan.veniceBoost?.active && (
                    <span style={{ color: "rgba(255, 44, 45,1)" }}> Plus</span>
                  )}
                </h3>
                <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginTop: 4 }}>
                  {data.plan.source === "token_holding" ? (
                    <span className="mono" style={{ fontSize: 11, opacity: 0.7, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                      {billingCopy.activePlan.heldViaTokens}
                    </span>
                  ) : (
                    <>
                      <span className="serif" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
                        {formatPrice(data.plan.price)}
                      </span>
                      <span className="mono" style={{ fontSize: 10, opacity: 0.5 }}>{billingCopy.activePlan.perMonth}</span>
                    </>
                  )}
                </div>
                {data.plan.veniceBoost?.active && (
                  <div
                    className="mono"
                    style={{ fontSize: 10, marginTop: 6, color: "rgba(255, 44, 45,0.95)", letterSpacing: "0.04em" }}
                  >
                    Venice boost · +{data.plan.veniceBoost.cpuBonus} vCPU / +{data.plan.veniceBoost.ramBonusMb / 1024} GB per agent
                  </div>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                <StatusBadge status={data.plan.status} />
                {data.plan.source === "token_holding" ? (
                  <span className="mono" style={{ fontSize: 9, opacity: 0.5 }}>
                    Eligible while threshold held
                  </span>
                ) : (
                  data.plan.currentPeriodEnd && (
                    <span className="mono" style={{ fontSize: 9, opacity: 0.5 }}>
                      Renews {new Date(data.plan.currentPeriodEnd).toLocaleDateString()}
                    </span>
                  )
                )}
              </div>
            </div>

            {/* Resource Bars */}
            <ResourceBar
              label={billingCopy.activePlan.agents}
              used={data.usage.agentCount}
              total={data.usage.maxAgents}
              unit=""
            />
            <ResourceBar
              label={billingCopy.activePlan.cpuBudget}
              used={data.usage.usedCpu}
              total={data.usage.totalCpu}
              unit="vCPU"
            />
            <ResourceBar
              label={billingCopy.activePlan.ramBudget}
              used={data.usage.usedRam / 1024}
              total={data.usage.totalRam / 1024}
              unit="GB"
            />

            {/* Action buttons. Management controls are routed by source:
                Apple IAP subscriptions are managed in the App Store — never
                the Stripe portal (see subscription-management-copy.ts). */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", marginTop: "2rem" }}>
              {subscriptionManagement.showStripePortalButton && (
                <button
                  onClick={handlePortal}
                  disabled={portalLoading}
                  style={{
                    background: "var(--btn-bg)", color: "var(--btn-text)",
                    border: "none", padding: "14px 24px", cursor: portalLoading ? "wait" : "pointer",
                    fontFamily: "var(--font-mono), monospace", fontSize: 11,
                    fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em",
                    display: "flex", alignItems: "center", gap: 8, opacity: portalLoading ? 0.7 : 1,
                  }}
                >
                  {portalLoading ? (
                    <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
                  ) : (
                    <CreditCard size={14} />
                  )}
                  {portalLoading ? billingCopy.activePlan.opening : billingCopy.activePlan.manageSubscription}
                </button>
              )}

              {subscriptionManagement.showAppleManageLink && (
                <a
                  href={subscriptionManagement.appleManageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    background: "var(--btn-bg)", color: "var(--btn-text)",
                    border: "none", padding: "14px 24px", cursor: "pointer",
                    fontFamily: "var(--font-mono), monospace", fontSize: 11,
                    fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em",
                    display: "flex", alignItems: "center", gap: 8,
                    textDecoration: "none",
                  }}
                >
                  <CreditCard size={14} />
                  Manage in the App Store
                </a>
              )}

              <button
                onClick={() => {
                  fetchUsage();
                  if (billingV2Enabled) {
                    void fetchBillingActivity();
                  }
                }}
                style={{
                  background: "transparent", color: "var(--ink-black)",
                  border: "1px solid var(--etched-border)", padding: "14px 20px",
                  cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                }}
                title="Refresh usage"
              >
                <RefreshCw size={14} />
              </button>

              {subscriptionManagement.showStripeCancelButton && (
                <button
                  type="button"
                  onClick={() => setShowCancelSaveFlow(true)}
                  style={{
                    background: "transparent", color: "var(--text-muted)",
                    border: "none", padding: "14px 4px", cursor: "pointer",
                    fontSize: 12, textDecoration: "underline", textUnderlineOffset: 3,
                  }}
                >
                  Cancel subscription
                </button>
              )}

            </div>

            {showCancelSaveFlow && (
              <CancelSaveFlow
                plan={data.plan.key}
                onClose={() => setShowCancelSaveFlow(false)}
                onCancelAnyway={() => {
                  setShowCancelSaveFlow(false);
                  // The ORIGINAL cancel flow, unchanged: cancellation happens
                  // in the Stripe billing portal.
                  void handlePortal();
                }}
              />
            )}
          </motion.div>

          {/* ── Server Backups ────────────────────────────────────────────── */}
          {data.usage.instances.length > 0 && (
            <motion.div variants={sectionVariants} style={{
              border: "1px solid var(--etched-border)", background: "var(--bg-surface)",
              padding: "clamp(1.5rem, 4vw, 2rem)", marginBottom: "2rem",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem", marginBottom: "1.25rem" }}>
                <div>
                  <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.5, fontWeight: 700 }}>
                    Server Backup Addon
                  </span>
                  <h3 className="serif" style={{ fontSize: "1.4rem", fontWeight: 700, marginTop: 4 }}>Daily Snapshots</h3>
                  <p style={{ fontSize: 12, opacity: 0.55, marginTop: 6, maxWidth: 480, lineHeight: 1.6 }}>
                    Server-level protection. Full disk snapshots created every 24 hours, retained for 7 days.
                    Restore to any checkpoint instantly — covers your entire server.
                  </p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                  {backupsEnabled ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#16a34a", fontFamily: "var(--font-mono), monospace", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                      <ShieldCheck size={14} /> Protected
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono), monospace", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.4 }}>
                      <Shield size={14} /> Not Protected
                    </div>
                  )}
                  <span className="mono" style={{ fontSize: 10, opacity: 0.4 }}>+$10 / month</span>
                </div>
              </div>

              {!backupsEnabled && firstInstanceId && (
                <button
                  onClick={() => handleEnableBackup(firstInstanceId)}
                  disabled={!!enablingBackup}
                  style={{
                    background: "var(--btn-bg)", color: "var(--btn-text)",
                    border: "none", padding: "12px 22px",
                    cursor: enablingBackup ? "wait" : "pointer",
                    fontFamily: "var(--font-mono), monospace", fontSize: 11,
                    fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em",
                    display: "flex", alignItems: "center", gap: 8,
                    opacity: enablingBackup ? 0.7 : 1, transition: "opacity 0.2s",
                  }}
                >
                  {enablingBackup ? (
                    <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
                  ) : (
                    <ShieldCheck size={14} />
                  )}
                  {enablingBackup ? "Enabling..." : "Enable Daily Backups — $10/mo"}
                </button>
              )}
            </motion.div>
          )}

          {/* ── Plan Switcher ─────────────────────────────────────────────── */}
          <motion.div variants={sectionVariants} style={{ marginBottom: "3rem" }}>
            <div style={{ marginBottom: "1.5rem" }}>
              <span className="mono" style={{
                fontSize: 9, textTransform: "uppercase", letterSpacing: "0.2em",
                opacity: 0.5, fontWeight: 700,
              }}>
                {billingCopy.switcher.title}
              </span>
              <p style={{ fontSize: 13, opacity: 0.6, marginTop: 4 }}>
                {billingCopy.switcher.description}
              </p>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1rem" }}>
              {ACTIVE_PLAN_KEYS.map((key) => {
                const plan = PLANS[key];
                const isCurrent = key === currentPlanKey;
                const isUpgrade = currentPlanKey ? isPlanUpgrade(currentPlanKey, key) : false;
                const diff = currentPlanKey && !isCurrent ? getPlanDiff(currentPlanKey, key) : null;
                const isChanging = changingPlan === key;
                const isDowngrade = !isCurrent && !isUpgrade;
                // A self-serve downgrade is only offered between PAID tiers and
                // only when both the UI flag is on AND the account can change
                // plans in-place (a live Stripe sub). `changePlanRequiresCheckout`
                // is already true for free / non-in-place rows, so guarding on
                // it keeps free→paid and unlinked rows out. Moving to free is a
                // cancellation, handled elsewhere — never offered here.
                const canSelfServeDowngrade =
                  isDowngrade &&
                  selfServeDowngradeEnabled &&
                  !changePlanRequiresCheckout &&
                  key !== "free";

                return (
                  <div
                    key={key}
                    style={{
                      border: isCurrent
                        ? "2px solid var(--ink-black)"
                        : "1px solid var(--etched-border)",
                      background: isCurrent ? "var(--card-inverted-bg)" : "var(--bg-surface)",
                      color: isCurrent ? "var(--card-inverted-text)" : "var(--ink-black)",
                      padding: "1.5rem",
                      position: "relative",
                      opacity: isChanging ? 0.7 : 1,
                      transition: "opacity 0.2s",
                    }}
                  >
                    {/* Current plan label */}
                    {isCurrent && (
                      <div style={{
                        position: "absolute", top: -1, left: -1, right: -1,
                        height: 3, background: "var(--gold-leaf)",
                      }} />
                    )}

                    <div style={{ marginBottom: "1rem" }}>
                      <span className="mono" style={{
                        fontSize: 9, textTransform: "uppercase", letterSpacing: "0.2em",
                        opacity: 0.5, fontWeight: 700,
                      }}>
                        {isCurrent ? billingCopy.switcher.currentPlan : isUpgrade ? billingCopy.switcher.upgrade : billingCopy.switcher.lowerTier}
                      </span>
                      <h4 className="serif" style={{ fontSize: "1.2rem", fontWeight: 700, marginTop: 2, marginBottom: 4 }}>
                        {plan.name}
                      </h4>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                        <span className="serif" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
                          {formatPrice(plan.price)}
                        </span>
                        <span className="mono" style={{ fontSize: 10, opacity: 0.4 }}>/mo</span>
                      </div>
                    </div>

                    {/* Resource limits */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: "1rem" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                        <Users size={11} style={{ opacity: 0.5 }} />
                        <span>{plan.maxAgents >= 999 ? billingCopy.switcher.unlimited : plan.maxAgents} {billingCopy.switcher.agents}</span>
                        {diff && diff.agents !== 0 && (
                          <span style={{
                            fontSize: 9, fontWeight: 700, fontFamily: "var(--font-mono), monospace",
                            color: diff.agents > 0 ? "#16a34a" : "#dc2626",
                          }}>
                            {diff.agents > 0 ? `+${diff.agents}` : diff.agents}
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                        <Cpu size={11} style={{ opacity: 0.5 }} />
                        <span>{plan.totalCpu} vCPU</span>
                        {diff && diff.cpu !== 0 && (
                          <span style={{
                            fontSize: 9, fontWeight: 700, fontFamily: "var(--font-mono), monospace",
                            color: diff.cpu > 0 ? "#16a34a" : "#dc2626",
                          }}>
                            {diff.cpu > 0 ? `+${diff.cpu}` : diff.cpu}
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                        <HardDrive size={11} style={{ opacity: 0.5 }} />
                        <span>{plan.totalRam / 1024}GB RAM</span>
                        {diff && diff.ramGb !== 0 && (
                          <span style={{
                            fontSize: 9, fontWeight: 700, fontFamily: "var(--font-mono), monospace",
                            color: diff.ramGb > 0 ? "#16a34a" : "#dc2626",
                          }}>
                            {diff.ramGb > 0 ? `+${diff.ramGb}` : diff.ramGb}GB
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Downgrade not available indicator (shown only when
                        self-serve downgrade is NOT offered for this card) */}
                    {isDowngrade && !canSelfServeDowngrade && (
                      <div style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "8px 10px", background: "transparent",
                        border: "1px solid var(--etched-border)", marginBottom: "0.75rem",
                      }}>
                        <Lock size={10} style={{ opacity: 0.4, flexShrink: 0 }} />
                        <span style={{
                          fontSize: 10, opacity: 0.5,
                          fontFamily: "var(--font-mono), monospace",
                        }}>
                          Downgrade not available
                        </span>
                      </div>
                    )}

                    {/* Proration-credit note for an offered downgrade */}
                    {canSelfServeDowngrade && (
                      <div style={{
                        display: "flex", alignItems: "flex-start", gap: 6,
                        padding: "8px 10px", background: "transparent",
                        border: "1px solid var(--etched-border)", marginBottom: "0.75rem",
                      }}>
                        <Coins size={10} style={{ opacity: 0.5, flexShrink: 0, marginTop: 2 }} />
                        <span style={{
                          fontSize: 10, opacity: 0.6, lineHeight: 1.4,
                          fontFamily: "var(--font-mono), monospace",
                        }}>
                          You&apos;ll get account credit for unused time on your current plan.
                        </span>
                      </div>
                    )}

                    {/* Action button */}
                    {isCurrent ? (
                      <div style={{
                        display: "flex", alignItems: "center", gap: 6,
                        fontSize: 11, opacity: 0.6, fontFamily: "var(--font-mono), monospace",
                        textTransform: "uppercase", letterSpacing: "0.08em",
                      }}>
                        <CheckCircle size={12} />
                        {billingCopy.switcher.active}
                      </div>
                    ) : isUpgrade ? (
                      <button
                        onClick={() => setConfirmingPlan(key)}
                        disabled={!!changingPlan}
                        style={{
                          width: "100%", padding: "10px 16px", fontSize: 11,
                          fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em",
                          cursor: changingPlan ? "wait" : "pointer",
                          background: "var(--btn-bg)",
                          color: "var(--btn-text)",
                          border: "none",
                          fontFamily: "var(--font-mono), monospace",
                          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                        }}
                      >
                        {isChanging ? (
                          <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                        ) : (
                          <><TrendingUp size={12} /> {billingCopy.switcher.upgrade}</>
                        )}
                      </button>
                    ) : canSelfServeDowngrade ? (
                      <button
                        onClick={() => handleChangePlan(key)}
                        disabled={!!changingPlan}
                        style={{
                          width: "100%", padding: "10px 16px", fontSize: 11,
                          fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em",
                          cursor: changingPlan ? "wait" : "pointer",
                          background: "transparent",
                          color: "var(--ink-black)",
                          border: "1px solid var(--ink-black)",
                          fontFamily: "var(--font-mono), monospace",
                          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                        }}
                      >
                        {isChanging ? (
                          <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                        ) : (
                          <>Switch to a smaller plan</>
                        )}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </motion.div>


          {/* ── Guarantee ─────────────────────────────────────────────────── */}
          <div style={{
            display: "flex", alignItems: "center", gap: 10, padding: "12px 20px",
            border: "1px solid var(--etched-border)", background: "transparent",
          }}>
            <Shield size={16} style={{ opacity: 0.5, flexShrink: 0 }} />
            <span className="mono" style={{
              fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em",
              opacity: 0.5, fontWeight: 600,
            }}>
              {billingCopy.switcher.guarantee}
            </span>
          </div>
        </motion.div>
      ) : (
        <motion.div initial="hidden" animate="visible" variants={sectionGroupVariants}>
          {/* ── Active yearly $HermesOS quote (durable across reload) ─── */}
          {(() => {
            // Resolve the most-relevant tier to surface in the banner.
            // Active quote wins over a recent sub; if both quotes
            // exist, surface whichever has the soonest expiry. If no
            // quote but a recent sub exists with sweep_status pending,
            // surface that so the user sees activation-in-progress.
            const candidates = [
              { quote: activeYearlyQuotes.pro, sub: recentYearlySubs.pro, tier: "pro" as const },
              { quote: activeYearlyQuotes.power, sub: recentYearlySubs.power, tier: "power" as const },
            ];
            // Prefer the one with an active quote.
            let chosen = candidates.find((c) => c.quote);
            // Otherwise, surface a sub whose sweep is still pending OR
            // a sub that just activated (paid_at within 5 minutes) so
            // the user sees the celebration.
            if (!chosen) {
              const fiveMinAgo = Date.now() - 5 * 60_000;
              chosen = candidates.find(
                (c) =>
                  c.sub &&
                  (c.sub.sweepStatus === "pending" ||
                    Date.parse(c.sub.paidAt) > fiveMinAgo),
              );
            }
            if (!chosen || (!chosen.quote && !chosen.sub)) return null;
            return (
              <motion.div variants={sectionVariants} style={{ marginBottom: "1.5rem" }}>
                <YearlyPaymentProgress
                  tier={chosen.tier}
                  quote={chosen.quote ?? null}
                  subscription={chosen.sub ?? null}
                  onResume={() => handleResumeYearlyQuote(chosen!.tier)}
                  onCheckNow={() => void handleCheckNow()}
                  checkingNow={yearlyCheckingNow}
                />
              </motion.div>
            );
          })()}

          {/* ── No Subscription — Plan Selection ────────────────────────── */}
          <motion.div variants={sectionVariants} style={{ textAlign: "center", marginBottom: "3rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", marginBottom: "1rem" }}>
              <AlertTriangle size={16} style={{ color: "#ff2c2d" }} />
              <span className="mono" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.15em", fontWeight: 700 }}>
                {billingCopy.noSubscription.title}
              </span>
            </div>
            <p style={{ fontSize: 14, color: "var(--text-secondary)", maxWidth: 500, margin: "0 auto" }}>
              Choose a plan to start deploying agents. Every plan includes BYO AI key support with zero markup.
            </p>
          </motion.div>

          {/* Payment-path tabs (Card | $HermesOS) above the plan grid.
              Each path swaps the inner sub-toggle and re-renders the
              cards with the right prices + CTAs. */}
          <motion.div variants={sectionVariants} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginBottom: "2rem" }}>
            {cryptoBillingEnabled && <details onToggle={(event) => { if (!event.currentTarget.open) setPaidPath("card"); }}>
              <summary style={{ cursor: "pointer", fontSize: 13 }}>Other payment options</summary>
              <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
                <button type="button" aria-pressed={paidPath === "card"} onClick={() => setPaidPath("card")}>Card</button>
                <button type="button" aria-pressed={paidPath === "crypto"} onClick={() => setPaidPath("crypto")}>$HermesOS</button>
              </div>
            </details>}
            {paidPath === "card" ? (
              <CadenceToggle cadence={cadence} onChange={setCadence} />
            ) : (
              <CryptoModeToggle mode={cryptoMode} onChange={setCryptoMode} />
            )}
          </motion.div>

          <motion.div
            variants={sectionVariants}
            style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "1.75rem" }}
          >
            {ACTIVE_PLAN_KEYS.map((key) => {
              const plan = PLANS[key];
              const isPopular = "popular" in plan && plan.popular;
              const hasYearly = "yearlyPrice" in plan && plan.yearlyPrice;
              const yearlyCardSavingsPct = hasYearly
                ? Math.round(((plan.price * 12 - (plan.yearlyPrice as number)) / (plan.price * 12)) * 100)
                : 0;
              const monthlyEquivalentCents = hasYearly
                ? (plan.yearlyPrice as number) / 12
                : 0;
              const isYearlyCard = paidPath === "card" && cadence === "yearly" && hasYearly;
              const displayPriceCents = isYearlyCard ? (plan.yearlyPrice as number) : plan.price;
              const tierKey: "pro" | "power" | null =
                key === "operator" ? "pro" : key === "fleet" ? "power" : null;
              // Crypto USD targets per BUILD_PLAN.md.
              //   yearly:    $49 Pro / $99 Power (sub expires after 365d)
              //   permanent: $99 Pro / $199 Power (hold-to-qualify, withdraw any time)
              const cryptoYearlyUsd = tierKey === "pro" ? 49 : tierKey === "power" ? 99 : 0;
              const cryptoHoldUsd = tierKey === "pro" ? 99 : tierKey === "power" ? 199 : 0;
              const showCardSavingsRibbon = isYearlyCard && yearlyCardSavingsPct > 0;
              const showCryptoSavingsRibbon =
                paidPath === "crypto" && cryptoMode === "yearly" && tierKey !== null;

              return (
                <motion.div
                  key={key}
                  whileHover={{ y: -4 }}
                  transition={{ type: "spring", stiffness: 380, damping: 28 }}
                  style={{
                    border: isPopular ? "2px solid var(--ink-black)" : "1px solid var(--etched-border)",
                    background: isPopular ? "var(--card-inverted-bg)" : "var(--bg-surface)",
                    color: isPopular ? "var(--card-inverted-text)" : "var(--ink-black)",
                    padding: "2.25rem 2rem",
                    display: "flex",
                    flexDirection: "column",
                    position: "relative",
                    boxShadow: isPopular
                      ? "0 16px 36px -18px rgba(255, 44, 45,0.45)"
                      : "0 8px 24px -16px rgba(0,0,0,0.18)",
                    overflow: "hidden",
                  }}
                >
                  {isPopular && (
                    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--gold-leaf)" }} />
                  )}

                  {/* Savings ribbon — gold corner anchor.
                      - Card · Yearly  → "Save N%" vs monthly
                      - Crypto · Yearly → "Save vs card" */}
                  {showCardSavingsRibbon && (
                    <motion.div
                      initial={{ opacity: 0, x: 16 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.25, ease: "easeOut" }}
                      style={{
                        position: "absolute",
                        top: 14,
                        right: -2,
                        background: "var(--gold-leaf)",
                        color: "var(--ink-black)",
                        fontFamily: "var(--font-mono), monospace",
                        fontSize: 9,
                        fontWeight: 800,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                        padding: "5px 12px 5px 14px",
                        boxShadow: "0 4px 10px -6px rgba(255, 44, 45,0.5)",
                      }}
                    >
                      Save {yearlyCardSavingsPct}%
                    </motion.div>
                  )}
                  {showCryptoSavingsRibbon && tierKey && (
                    <motion.div
                      initial={{ opacity: 0, x: 16 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.25, ease: "easeOut" }}
                      style={{
                        position: "absolute",
                        top: 14,
                        right: -2,
                        background: "var(--gold-leaf)",
                        color: "var(--ink-black)",
                        fontFamily: "var(--font-mono), monospace",
                        fontSize: 9,
                        fontWeight: 800,
                        letterSpacing: "0.12em",
                        textTransform: "uppercase",
                        padding: "5px 12px 5px 14px",
                        boxShadow: "0 4px 10px -6px rgba(255, 44, 45,0.5)",
                      }}
                    >
                      {tierKey === "pro" ? "Save 38% vs card" : "Save 34% vs card"}
                    </motion.div>
                  )}

                  <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.22em", opacity: isPopular ? 0.6 : 0.5, fontWeight: 700, marginBottom: "0.65rem" }}>
                    {isPopular ? "Recommended" : key === "operator" ? "Starter" : "Power"}
                  </span>
                  <h4 className="serif" style={{ fontSize: "1.45rem", fontWeight: 700, marginBottom: 8, letterSpacing: "-0.01em" }}>{plan.name}</h4>

                  <motion.div
                    key={`${key}-${paidPath}-${cadence}-${cryptoMode}`}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, ease: "easeOut" }}
                    style={{ marginBottom: "1.25rem" }}
                  >
                    {paidPath === "card" ? (
                      <>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                          <span className="serif" style={{ fontSize: "2.6rem", fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>
                            {formatPrice(displayPriceCents)}
                          </span>
                          <span className="mono" style={{ fontSize: 11, opacity: isPopular ? 0.55 : 0.45, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                            {isYearlyCard ? "/yr" : "/mo"}
                          </span>
                        </div>
                        {isYearlyCard && (
                          <div style={{ marginTop: 6, fontSize: 11, opacity: isPopular ? 0.6 : 0.55, fontFamily: "var(--font-mono), monospace", letterSpacing: "0.04em" }}>
                            ${monthlyEquivalentCents.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}/mo billed yearly
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                          <span className="serif" style={{ fontSize: "2.6rem", fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>
                            ${cryptoMode === "yearly" ? cryptoYearlyUsd : cryptoHoldUsd}
                          </span>
                          <span className="mono" style={{ fontSize: 11, opacity: isPopular ? 0.55 : 0.45, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                            in $HermesOS
                          </span>
                        </div>
                        <div style={{ marginTop: 6, fontSize: 11, opacity: isPopular ? 0.6 : 0.55, fontFamily: "var(--font-mono), monospace", letterSpacing: "0.04em" }}>
                          {cryptoMode === "yearly"
                            ? "Pay once · 365 days · non-refundable"
                            : "Hold to qualify · withdraw any time"}
                        </div>
                      </>
                    )}
                  </motion.div>


                  <div style={{
                    display: "flex",
                    gap: "0.85rem",
                    marginBottom: "1.25rem",
                    flexWrap: "wrap",
                    paddingBottom: "1rem",
                    borderBottom: `1px solid ${isPopular ? "rgba(255,255,255,0.1)" : "var(--etched-border)"}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, opacity: isPopular ? 0.75 : 0.6 }}>
                      <Users size={12} />
                      <span className="mono" style={{ fontSize: 10, letterSpacing: "0.04em" }}>
                        {plan.maxAgents >= 999 ? "Unlimited" : plan.maxAgents} agents
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, opacity: isPopular ? 0.75 : 0.6 }}>
                      <Cpu size={12} />
                      <span className="mono" style={{ fontSize: 10, letterSpacing: "0.04em" }}>{plan.totalCpu} vCPU</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, opacity: isPopular ? 0.75 : 0.6 }}>
                      <HardDrive size={12} />
                      <span className="mono" style={{ fontSize: 10, letterSpacing: "0.04em" }}>{plan.totalRam / 1024}GB</span>
                    </div>
                  </div>

                  <ul style={{ listStyle: "none", padding: 0, margin: 0, flex: 1, display: "flex", flexDirection: "column", gap: "0.55rem", marginBottom: "1.5rem" }}>
                    {plan.features.slice(0, 5).map((f, i) => (
                      <li key={i} style={{ fontSize: 12, lineHeight: 1.5, opacity: isPopular ? 0.85 : 0.78, display: "flex", alignItems: "flex-start", gap: 8 }}>
                        <span style={{ width: 4, height: 4, background: isPopular ? "var(--gold-leaf)" : "var(--ink-black)", display: "inline-block", flexShrink: 0, marginTop: 6 }} />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>

                  {paidPath === "card" ? (
                    <motion.button
                      onClick={() => handleSubscribe(key)}
                      disabled={!!subscribing}
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.99 }}
                      style={{
                        padding: "14px 22px", fontSize: 11, fontWeight: 700,
                        textTransform: "uppercase", letterSpacing: "0.12em",
                        cursor: subscribing ? "wait" : "pointer",
                        background: isPopular ? "var(--bg-surface)" : "var(--card-inverted-bg)",
                        color: isPopular ? "var(--ink-black)" : "var(--card-inverted-text)",
                        border: "none", fontFamily: "var(--font-mono), monospace",
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                        opacity: subscribing ? 0.7 : 1,
                      }}
                    >
                      {subscribing === key ? (
                        <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
                      ) : (
                        <>
                          Subscribe · {formatPrice(displayPriceCents)}
                          {isYearlyCard ? "/yr" : "/mo"} <ChevronRight size={14} />
                        </>
                      )}
                    </motion.button>
                  ) : tierKey ? (
                    cryptoMode === "yearly" ? (
                      <motion.button
                        type="button"
                        onClick={() => handleYearlyTokenPay(tierKey)}
                        disabled={yearlyTokenLoading}
                        whileHover={{ scale: 1.01, background: "rgba(255, 44, 45, 0.16)" }}
                        whileTap={{ scale: 0.99 }}
                        style={{
                          padding: "14px 22px",
                          fontSize: 11,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: "0.12em",
                          cursor: yearlyTokenLoading ? "wait" : "pointer",
                          background: "rgba(255, 44, 45, 0.10)",
                          color: isPopular ? "var(--card-inverted-text)" : "var(--ink-black)",
                          border: "1px solid var(--gold-leaf)",
                          fontFamily: "var(--font-mono), monospace",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 10,
                        }}
                      >
                        <Coins size={13} style={{ color: "var(--gold-leaf)" }} />
                        <span>Pay 1 year · ${cryptoYearlyUsd}</span>
                        <ChevronRight size={14} />
                      </motion.button>
                    ) : (
                      <motion.a
                        href={`/dashboard/wallet?from=billing&plan=${tierKey}`}
                        whileHover={{ scale: 1.01, background: "rgba(255, 44, 45, 0.16)" }}
                        whileTap={{ scale: 0.99 }}
                        style={{
                          padding: "14px 22px",
                          fontSize: 11,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: "0.12em",
                          cursor: "pointer",
                          background: "rgba(255, 44, 45, 0.10)",
                          color: isPopular ? "var(--card-inverted-text)" : "var(--ink-black)",
                          border: "1px solid var(--gold-leaf)",
                          fontFamily: "var(--font-mono), monospace",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 10,
                          textDecoration: "none",
                        }}
                      >
                        <Coins size={13} style={{ color: "var(--gold-leaf)" }} />
                        <span>Hold ${cryptoHoldUsd} to qualify</span>
                        <ChevronRight size={14} />
                      </motion.a>
                    )
                  ) : null}
                </motion.div>
              );
            })}
          </motion.div>

          <motion.div variants={sectionVariants} style={{ textAlign: "center", marginTop: "2.5rem" }}>
            <div style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 14,
              padding: "10px 20px",
              border: "1px solid var(--etched-border)",
              background: "var(--bg-surface)",
              flexWrap: "wrap",
              justifyContent: "center",
            }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Shield size={13} style={{ opacity: 0.55 }} />
                <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.6, fontWeight: 600 }}>
                  48-hr refund on card payments
                </span>
              </span>
              {paidPath === "crypto" && <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Coins size={13} style={{ color: "var(--gold-leaf)", opacity: 0.85 }} />
                <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.6, fontWeight: 600 }}>
                  Token payments are non-refundable
                </span>
              </span>}
            </div>
          </motion.div>
        </motion.div>
      )}


      {tokenHolding?.wallet && <p style={{ marginBottom: 16, overflowWrap: "anywhere" }}>Verified wallet: {tokenHolding.wallet.address}. Balance: {tokenHolding.snapshot?.balanceDisplay ?? "Not checked"} {tokenHolding.token.tokenSymbol}. Access: {tokenHolding.entitlement.qualifiesBaseTier ? "Qualified" : "Not qualified"}.</p>}
          {billingV2Enabled && (
            <CreditsPanel
              balance={creditBalance}
              topUpsEnabled={creditTopUpsEnabled}
              toppingUp={toppingUp}
              variants={sectionVariants}
              onTopUp={handleCreditTopUp}
            />
          )}

          {billingV2Enabled && managedVeniceSummary && (
            <>
              <ManagedVeniceWalletPanel
                summary={managedVeniceSummary}
                tokenPaymentsEnabled={billingV2Enabled}
                onDeposit={(walletType) => openManagedVeniceDeposit(walletType)}
              />
              <ManagedVeniceKeysPanel keys={managedVeniceSummary.keys} />
              <ManagedVeniceByokSwitchPanel />
            </>
          )}

          {billingV2Enabled && (
            <BillingActivityPanel
              activity={activity}
              loading={activityLoading}
              error={activityError}
              variants={sectionVariants}
              managedVeniceBriefLimit={5}
            />
          )}

          {cryptoBillingEnabled && (
            <details style={{ marginBottom: 24 }}><summary style={{ cursor: "pointer", marginBottom: 16 }}>Optional token access and payments</summary>
              <TokenHoldingPanel
                tokenHolding={tokenHolding}
                loading={tokenLoading}
                refreshing={tokenRefreshing}
                connectingWallet={walletConnecting}
                error={tokenError}
                variants={sectionVariants}
                onRefresh={handleRefreshTokenHolding}
                onConnectWallet={handleConnectWallet}
              />

              <CryptoTopUpPanel
                intent={cryptoTopUpIntent}
                error={cryptoTopUpError}
                toppingUp={cryptoToppingUp}
                variants={sectionVariants}
                onTopUp={handleCryptoTopUp}
              />
            </details>
          )}

      <p style={{ fontSize: 13, marginBottom: 24 }}><a href="/token">About optional token access</a></p>

      <ChangePlanModal
        isOpen={!!confirmingPlan}
        onClose={() => setConfirmingPlan(null)}
        onConfirm={() => confirmingPlan && handleChangePlan(confirmingPlan)}
        planName={confirmingPlan ? PLANS[confirmingPlan].name : ""}
        priceInCents={confirmingPlan ? PLANS[confirmingPlan].price : 0}
        loading={!!changingPlan}
        mode={changePlanRequiresCheckout ? "checkout" : "in_place"}
      />

      <ManagedVeniceDepositModal
        isOpen={managedVeniceDepositOpen}
        tokenPaymentsEnabled={billingV2Enabled}
        walletType={managedVeniceDepositWallet}
        amountUsd={managedVeniceDepositAmountUsd}
        loading={managedVeniceDepositLoading}
        error={managedVeniceDepositError}
        quote={managedVeniceTokenQuote}
        onClose={() => {
          setManagedVeniceDepositOpen(false);
          setManagedVeniceDepositError(null);
          setManagedVeniceTokenQuote(null);
        }}
        onWalletTypeChange={(walletType) => {
          setManagedVeniceDepositWallet(walletType);
          setManagedVeniceDepositError(null);
          setManagedVeniceTokenQuote(null);
        }}
        onAmountChange={(amountUsd) => {
          setManagedVeniceDepositAmountUsd(amountUsd);
          setManagedVeniceDepositError(null);
          setManagedVeniceTokenQuote(null);
        }}
        onStartHermesTopUp={handleManagedVeniceHermesTopUp}
        onStartCardTopUp={handleManagedVeniceCardTopUp}
        onQuoteUpdate={setManagedVeniceTokenQuote}
        onRefreshSummary={fetchManagedVeniceSummary}
      />

      <YearlyTokenPaymentModal
        isOpen={!!yearlyTokenTier}
        tier={yearlyTokenTier}
        loading={yearlyTokenLoading}
        error={yearlyTokenError}
        quote={yearlyTokenQuote}
        onClose={handleYearlyTokenClose}
      />
    </motion.div>
  );
}


