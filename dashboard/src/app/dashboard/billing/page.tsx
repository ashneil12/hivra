'use client';

import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { PLANS, getPlanDiff, isPlanUpgrade } from "@/lib/subscription";
import { isPlanKey, planYearlyPriceCents } from "@/lib/billing/plan-display";
import { buildHermesFadeSlideVariants, buildHermesStaggerVariants } from "@/components/ui/motion";
import { TabPanel, Tabs, tabDomId } from "@/components/ui/Tabs";
import { CancelSaveFlow } from "@/components/billing/CancelSaveFlow";
import { ChangePlanModal } from "@/components/dashboard/ChangePlanModal";
import { useLocale } from "@/components/i18n/LocaleProvider";
// Yearly-token modals live in "@/components/billing/YearlyTokenPanels".
import {
  ManagedVeniceDepositModal,
  YearlyTokenPaymentModal,
} from "@/components/billing/YearlyTokenPanels";
import { useBillingController } from "./useBillingController";
import {
  BILLING_TAB_LABELS,
  BILLING_TABS_ID_PREFIX,
  billingTabUrl,
  deepLinkBillingTab,
  isBillingTabId,
  resolveBillingTab,
  visibleBillingTabs,
  type BillingTabId,
} from "./_components/billing-tabs";
import { BillingAlerts } from "./_components/BillingAlerts";
import { CreditsTab, MANAGED_VENICE_ANCHOR_ID } from "./_components/CreditsTab";
import { HistoryTab } from "./_components/HistoryTab";
import { OverviewTab } from "./_components/OverviewTab";
import { PaymentMethodsTab } from "./_components/PaymentMethodsTab";
import { PlansTab } from "./_components/PlansTab";
import { YearlyPaymentBanner } from "./_components/YearlyPaymentBanner";
import styles from "./Billing.module.css";

// ── Main Component ────────────────────────────────────────────────────────────

// The URL hash as an external store. On a client navigation
// (router.push("/dashboard/billing#managed-venice")) Next writes the new URL
// only when it commits, after this page has rendered once with the previous
// URL; the store's post-commit check sees the new hash and re-renders, so a
// hash link lands on its tab either way.
function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
}
const readHash = () => window.location.hash;
const readServerHash = () => "";

export default function BillingPage() {
  return (
    <Suspense
      fallback={
        <div className={styles.loading}>
          <Loader2 size={20} className={styles.spin} aria-hidden="true" />
        </div>
      }
    >
      <BillingPageContent />
    </Suspense>
  );
}

function BillingPageContent() {
  const c = useBillingController();
  const { copy } = useLocale();
  const billingCopy = copy.dashboard.billing;
  const reduceMotion = Boolean(useReducedMotion());
  const sectionVariants = buildHermesFadeSlideVariants(reduceMotion, { offset: 12 });
  const sectionGroupVariants = buildHermesStaggerVariants(reduceMotion, 0.06);

  // ── Tabs ─────────────────────────────────────────────────────────────────
  // Tab state lives here, never in a child, so refreshes and plan changes
  // keep the user where they were. The first tab comes from the inbound link
  // (read once: the page strips some deep-link params as soon as it acts on
  // them); after that the user's choice wins and is mirrored to ?tab=.
  const searchParams = useSearchParams();
  const hash = useSyncExternalStore(subscribeToHash, readHash, readServerHash);
  const [requestedTab, setRequestedTab] = useState<BillingTabId | null>(() => deepLinkBillingTab(searchParams, null));
  // Query params keep precedence; the hash only fills in when they asked for
  // no tab and the user hasn't picked one.
  const linkedTab = requestedTab ?? deepLinkBillingTab(null, hash);
  // Follow ?tab= when something else changes it (a link to this page while
  // it is open). Adjusting state during render is React's pattern for this.
  const urlTab = searchParams?.get("tab") ?? null;
  const [seenUrlTab, setSeenUrlTab] = useState(urlTab);
  if (urlTab !== seenUrlTab) {
    setSeenUrlTab(urlTab);
    if (isBillingTabId(urlTab)) setRequestedTab(urlTab);
  }

  const visibleTabs = visibleBillingTabs(c.flags);
  const hasPlan = Boolean(c.data?.subscribed && c.data.plan);
  const activeTab = resolveBillingTab({ requested: linkedTab, visible: visibleTabs, subscribed: hasPlan });

  const selectTab = useCallback((tab: BillingTabId) => {
    setRequestedTab(tab);
    if (typeof window !== "undefined") {
      // replaceState (not router.replace/push): keeps every other param and
      // the hash, adds no history entry and does not re-render the route.
      window.history.replaceState(null, "", billingTabUrl(window.location.href, tab));
    }
  }, []);

  const tabsTopRef = useRef<HTMLDivElement | null>(null);
  const goToTab = useCallback(
    (tab: BillingTabId) => {
      selectTab(tab);
      window.requestAnimationFrame(() => {
        tabsTopRef.current?.scrollIntoView?.({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
        document.getElementById(tabDomId(BILLING_TABS_ID_PREFIX, tab))?.focus({ preventScroll: true });
      });
    },
    [selectTab, reduceMotion]
  );

  // The full-page loader is for the first load only. Later refreshes keep
  // the page (and tab, and any open disclosure) mounted.
  const showInitialLoader = c.status.loading && !c.data;
  const refreshing = c.status.loading && !!c.data;

  // Plan changes happen deep in the Plans tab, but their result shows in the
  // alerts above the tabs. Once the change-plan dialog has closed, bring a
  // new result into view (and focus) when it is off screen, e.g. on a phone.
  const alertsRef = useRef<HTMLDivElement | null>(null);
  const planChangeResult = c.violation ?? c.successMsg;
  const shownResultRef = useRef<string | null>(null);
  const dialogOpen = Boolean(c.confirmingPlan);
  useEffect(() => {
    if (!planChangeResult) {
      shownResultRef.current = null;
      return;
    }
    if (dialogOpen || shownResultRef.current === planChangeResult) return;
    shownResultRef.current = planChangeResult;
    const alerts = alertsRef.current;
    if (!alerts) return;
    const rect = alerts.getBoundingClientRect();
    if (rect.top >= 0 && rect.top < window.innerHeight) return;
    alerts.scrollIntoView?.({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
    alerts.focus({ preventScroll: true });
  }, [planChangeResult, dialogOpen, reduceMotion]);

  // `#managed-venice` links land on the model credits section.
  const hashScrolledRef = useRef(false);
  useEffect(() => {
    if (showInitialLoader || hashScrolledRef.current) return;
    if (hash.replace(/^#/, "") !== MANAGED_VENICE_ANCHOR_ID || activeTab !== "credits") return;
    hashScrolledRef.current = true;
    document.getElementById(MANAGED_VENICE_ANCHOR_ID)?.scrollIntoView?.({ block: "start" });
  }, [showInitialLoader, hash, activeTab]);

  const handleRefresh = () => {
    c.fetchUsage();
    if (c.flags.billingV2Enabled) {
      void c.fetchBillingActivity();
    }
  };

  // ── Loading ────────────────────────────────────────────────────────────────

  if (c.status.confirming) {
    return (
      <div className={styles.loading}>
        <Loader2 size={24} className={styles.spin} aria-hidden="true" />
        <span className={styles.loadingLabel}>Activating your subscription...</span>
      </div>
    );
  }

  if (showInitialLoader) {
    return (
      <div className={styles.loading}>
        <Loader2 size={20} className={styles.spin} aria-hidden="true" />
        <span className={styles.srOnly}>Loading billing</span>
      </div>
    );
  }

  // ── Change-plan confirmation inputs ───────────────────────────────────────
  const currentKey = isPlanKey(c.currentPlanKey) ? c.currentPlanKey : null;
  const confirmingPlan = c.confirmingPlan;
  const confirmDirection: "upgrade" | "downgrade" =
    confirmingPlan && currentKey && confirmingPlan !== currentKey && !isPlanUpgrade(currentKey, confirmingPlan)
      ? "downgrade"
      : "upgrade";
  // A checkout charges the cadence chosen on the Plans tab, so a Yearly
  // checkout confirms the yearly price. In-place changes always bill monthly.
  const confirmingYearlyCents = confirmingPlan ? planYearlyPriceCents(confirmingPlan) : null;
  const yearlyCheckout =
    c.changePlanRequiresCheckout && c.cadence === "yearly" && confirmingYearlyCents !== null;
  const confirmPriceInCents = confirmingPlan
    ? yearlyCheckout && confirmingYearlyCents !== null
      ? confirmingYearlyCents
      : PLANS[confirmingPlan].price
    : 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <motion.div
      className={styles.page}
      initial="hidden"
      animate="visible"
      variants={sectionGroupVariants}
    >
      <motion.header className={styles.header} variants={sectionVariants}>
        <div className={styles.headerText}>
          <p className={styles.eyebrow}>{billingCopy.eyebrow}</p>
          <h1 className={styles.title}>
            {billingCopy.titlePrefix}
            {billingCopy.titleSeparator}
            <em>{billingCopy.titleEmphasis}</em>
            {billingCopy.titleSuffix}
          </h1>
          <p className={styles.subtitle}>{billingCopy.subtitle}</p>
        </div>
        <div aria-live="polite">
          {refreshing && (
            <span className={styles.refreshing}>
              <Loader2 size={12} className={styles.spin} aria-hidden="true" />
              {billingCopy.refreshing}
            </span>
          )}
        </div>
      </motion.header>

      <BillingAlerts c={c} containerRef={alertsRef} />

      {/* Yearly $HermesOS payment in flight. Ungated by the crypto flag on
          purpose: it is what stops someone paying twice. */}
      <YearlyPaymentBanner
        activeQuotes={c.yearly.activeQuotes}
        pendingQuotes={c.yearly.pendingQuotes}
        recentSubs={c.yearly.recentSubs}
        checkingNow={c.yearly.checkingNow}
        onResume={c.handleResumeYearlyQuote}
        onCheckNow={() => void c.handleCheckNow()}
      />

      <div ref={tabsTopRef} style={{ scrollMarginTop: 72 }}>
        <Tabs
          className={styles.tabs}
          idPrefix={BILLING_TABS_ID_PREFIX}
          label="Billing sections"
          value={activeTab}
          onChange={selectTab}
          items={visibleTabs.map((id) => ({ id, label: BILLING_TAB_LABELS[id] }))}
        />
      </div>

      {visibleTabs.map((id) => (
        <TabPanel key={id} idPrefix={BILLING_TABS_ID_PREFIX} id={id} active={id === activeTab}>
          <motion.div key={id} initial="hidden" animate="visible" variants={sectionVariants}>
            {id === "overview" && (
              <OverviewTab
                c={c}
                refreshing={refreshing}
                onGoTo={goToTab}
                onRefresh={handleRefresh}
                copy={{
                  plateEyebrow: billingCopy.activePlan.title,
                  changePlan: billingCopy.switcher.title,
                  noPlanTitle: billingCopy.noSubscription.title,
                  manageSubscription: billingCopy.activePlan.manageSubscription,
                  opening: billingCopy.activePlan.opening,
                  slots: billingCopy.activePlan.agents,
                  cpu: billingCopy.activePlan.cpuBudget,
                  memory: billingCopy.activePlan.ramBudget,
                  creditsTitle: billingCopy.credits.title,
                  creditsAvailable: billingCopy.credits.available,
                  plate: billingCopy.plate,
                }}
              />
            )}
            {id === "plans" && <PlansTab c={c} heading={billingCopy.switcher.title} />}
            {id === "payments" && <PaymentMethodsTab c={c} onGoTo={goToTab} />}
            {id === "credits" && <CreditsTab c={c} variants={sectionVariants} />}
            {id === "history" && <HistoryTab c={c} variants={sectionVariants} />}
          </motion.div>
        </TabPanel>
      ))}

      {/* ── Dialogs: always at the page root, outside the tabs ──────────── */}

      {c.showCancelSaveFlow && c.data?.plan && (
        <CancelSaveFlow
          plan={c.data.plan.key}
          onClose={() => c.setShowCancelSaveFlow(false)}
          onCancelAnyway={() => {
            c.setShowCancelSaveFlow(false);
            // The ORIGINAL cancel flow, unchanged: cancellation happens in
            // the Stripe billing portal.
            void c.handlePortal();
          }}
        />
      )}

      <ChangePlanModal
        isOpen={!!confirmingPlan}
        onClose={() => c.setConfirmingPlan(null)}
        onConfirm={() => confirmingPlan && c.handleChangePlan(confirmingPlan)}
        planName={confirmingPlan ? PLANS[confirmingPlan].name : ""}
        priceInCents={confirmPriceInCents}
        priceUnit={yearlyCheckout ? "/yr" : "/mo"}
        loading={!!c.changingPlan}
        mode={c.changePlanRequiresCheckout ? "checkout" : "in_place"}
        direction={confirmDirection}
        currentPlanName={c.data?.plan?.name}
        resourceDiff={confirmingPlan && currentKey ? getPlanDiff(currentKey, confirmingPlan) : undefined}
        agentsInUse={c.data?.usage?.agentCount}
        targetAgentSlots={confirmingPlan ? PLANS[confirmingPlan].maxAgents : undefined}
      />

      <ManagedVeniceDepositModal
        isOpen={c.managedVeniceDeposit.open}
        tokenPaymentsEnabled={c.flags.billingV2Enabled}
        walletType={c.managedVeniceDeposit.wallet}
        amountUsd={c.managedVeniceDeposit.amountUsd}
        loading={c.managedVeniceDeposit.loading}
        error={c.managedVeniceDeposit.error}
        quote={c.managedVeniceDeposit.quote}
        onClose={() => {
          c.setManagedVeniceDepositOpen(false);
          c.setManagedVeniceDepositError(null);
          c.setManagedVeniceTokenQuote(null);
        }}
        onWalletTypeChange={(walletType) => {
          c.setManagedVeniceDepositWallet(walletType);
          c.setManagedVeniceDepositError(null);
          c.setManagedVeniceTokenQuote(null);
        }}
        onAmountChange={(amountUsd) => {
          c.setManagedVeniceDepositAmountUsd(amountUsd);
          c.setManagedVeniceDepositError(null);
          c.setManagedVeniceTokenQuote(null);
        }}
        onStartHermesTopUp={c.handleManagedVeniceHermesTopUp}
        onStartCardTopUp={c.handleManagedVeniceCardTopUp}
        onQuoteUpdate={c.setManagedVeniceTokenQuote}
        onRefreshSummary={c.fetchManagedVeniceSummary}
      />

      <YearlyTokenPaymentModal
        isOpen={!!c.yearly.tier}
        tier={c.yearly.tier}
        loading={c.yearly.loading}
        error={c.yearly.error}
        quote={c.yearly.quote}
        onClose={c.handleYearlyTokenClose}
        reviewPending={c.yearly.reviewPending}
      />
    </motion.div>
  );
}
