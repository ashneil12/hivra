'use client';

import Link from "next/link";
import { ArrowRight, Check, Coins, CreditCard, Loader2, ShieldCheck } from "lucide-react";
import { TokenHoldingPanel } from "@/components/billing/BillingPanels";
import { useLocale } from "@/components/i18n/LocaleProvider";
import {
  hasPaidCardOrAppleSubscription,
  isTokenYearRenewal,
  tokenYearTierOffered,
  type PlanSource,
} from "@/lib/billing/plan-display";
import { PLANS } from "@/lib/subscription";
import {
  YEARLY_TOKEN_TIER_PLAN,
  YEARLY_TOKEN_USD,
  type YearlyTokenTier,
} from "@/lib/billing/token-plan-prices";
import type { BillingController } from "../useBillingController";
import type { BillingTabId } from "./billing-tabs";
import styles from "../Billing.module.css";

/** Verified, existing crypto rules, stated once next to every crypto path. */
export const CRYPTO_PAYMENT_RULES = [
  "Base network only.",
  "Send the exact amount in one transfer.",
  "Prices lock for 20 minutes.",
  "Token payments are final.",
  "Yearly access doesn't renew automatically.",
] as const;

const YEAR_TIERS: readonly YearlyTokenTier[] = ["pro", "power"];

function tierName(tier: YearlyTokenTier): string {
  return PLANS[YEARLY_TOKEN_TIER_PLAN[tier]].name;
}

/** "Pro · $49 a year", or "Add a year · Pro · $49" when it extends the user's own year. */
export function tokenYearButtonLabel(tier: YearlyTokenTier, renewal: boolean): string {
  return renewal
    ? `Add a year · ${tierName(tier)} · $${YEARLY_TOKEN_USD[tier]}`
    : `${tierName(tier)} · $${YEARLY_TOKEN_USD[tier]} a year`;
}

/**
 * What the Card block says. The usage API knows how the PLAN is paid, not
 * whether a card is saved (free-tier verification can save one), so the
 * copy talks about the plan's billing, never "no card on file".
 */
export function cardStatus(plan: { key: string; source?: PlanSource } | null): {
  text: string;
  action: "portal" | "apple" | null;
} {
  const source = plan?.source;
  if (!plan || plan.key === "free" || source === "free") {
    return { text: "Your plan isn't billed to a card. You'll enter card details at checkout.", action: null };
  }
  if (source === "apple_iap") {
    return { text: "You pay through the App Store. Apple keeps your payment details.", action: "apple" };
  }
  if (source === "token_yearly" || source === "token_holding") {
    return { text: "Your plan is paid with $HermesOS, not a card.", action: null };
  }
  if (source === "workspace_cloud") {
    return { text: "Your plan is billed with Workspace Cloud.", action: null };
  }
  return {
    text: "Stripe keeps your card on file. Update your card, download invoices or cancel in the billing portal.",
    action: "portal",
  };
}

export function PaymentMethodsTab({
  c,
  onGoTo,
}: {
  c: BillingController;
  onGoTo: (tab: BillingTabId) => void;
}) {
  const { copy } = useLocale();
  const plan = c.data?.subscribed ? c.data.plan : null;
  const source = (plan?.source ?? null) as PlanSource | null;
  const card = cardStatus(plan ? { key: plan.key, source: plan.source } : null);
  const canPayYearWithToken = !hasPaidCardOrAppleSubscription({ planKey: plan?.key ?? null, source });
  // Same rule as the Plans tab: never a smaller $HermesOS year than the
  // plan the user already has (entitlement goes to the highest tier and
  // token payments are final).
  const offeredTiers = YEAR_TIERS.filter((tier) => tokenYearTierOffered(plan?.key, tier));
  const coveredTiers = YEAR_TIERS.filter((tier) => !offeredTiers.includes(tier));
  // Model-credit top-ups with $HermesOS are part of billing v2 and live in
  // Credits whatever the crypto flag says, so don't call crypto unavailable
  // while that button is there.
  const hermesCreditTopUpsOffered = c.flags.billingV2Enabled && Boolean(c.managedVeniceSummary);

  return (
    <div className={styles.stack}>
      <section className={styles.method} aria-labelledby="billing-method-card">
        <div className={styles.methodHead}>
          <span className={styles.methodIcon} aria-hidden="true">
            <CreditCard size={18} />
          </span>
          <div className={styles.methodBody}>
            <h2 className={styles.panelTitle} id="billing-method-card">Card</h2>
            <p className={styles.panelText}>{card.text}</p>
            {card.action === "portal" && c.subscriptionManagement.showStripePortalButton && (
              <div className={styles.panelActions}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.secondary}`}
                  onClick={() => void c.handlePortal()}
                  disabled={c.portalLoading}
                >
                  {c.portalLoading ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : null}
                  {c.portalLoading ? copy.dashboard.billing.activePlan.opening : "Open billing portal"}
                </button>
              </div>
            )}
            {card.action === "apple" && c.subscriptionManagement.showAppleManageLink && (
              <div className={styles.panelActions}>
                <a
                  href={c.subscriptionManagement.appleManageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${styles.button} ${styles.secondary}`}
                >
                  Manage in the App Store
                </a>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className={styles.method} aria-labelledby="billing-method-crypto">
        <div className={styles.methodHead}>
          <span className={styles.methodIcon} aria-hidden="true">
            <Coins size={18} />
          </span>
          <div className={styles.methodBody}>
            <h2 className={styles.panelTitle} id="billing-method-crypto">$HermesOS and USDC on Base</h2>
            {!c.flags.cryptoBillingEnabled ? (
              <p className={styles.panelText}>
                {hermesCreditTopUpsOffered
                  ? "Paying for your plan with $HermesOS or USDC isn't available right now. You can still top up model credits with $HermesOS in Credits."
                  : "Crypto payments aren't available right now. Card payments work as usual."}
              </p>
            ) : (
              <p className={styles.panelText}>
                Pay for a year, hold $HermesOS for ongoing access, or top up credits with USDC.
              </p>
            )}
          </div>
        </div>

        {!c.flags.cryptoBillingEnabled ? (
          <p className={styles.quietLine}>
            {hermesCreditTopUpsOffered && (
              <button
                type="button"
                className={`${styles.button} ${styles.secondary}`}
                onClick={() => onGoTo("credits")}
              >
                Go to Credits
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            )}
            <Link className={styles.link} href="/token">
              About $HermesOS access
              <ArrowRight size={13} aria-hidden="true" />
            </Link>
          </p>
        ) : (
          <>
            <div className={styles.methodBlocks}>
              <div className={styles.methodBlock}>
                <h3 className={styles.blockTitle}>Pay a year with $HermesOS</h3>
                <p className={styles.blockText}>
                  One payment covers 365 days. It doesn&apos;t renew automatically; paying again adds another year.
                </p>
                {canPayYearWithToken ? (
                  <>
                    {offeredTiers.length > 0 && (
                      <div className={styles.tierButtons}>
                        {offeredTiers.map((tier) => (
                          <button
                            key={tier}
                            type="button"
                            className={`${styles.button} ${styles.secondary}`}
                            onClick={() => void c.handleYearlyTokenPay(tier)}
                            disabled={c.yearly.loading}
                          >
                            {tokenYearButtonLabel(
                              tier,
                              isTokenYearRenewal({ currentPlanKey: plan?.key, source, tier })
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                    {coveredTiers.length > 0 && (
                      <p className={styles.blockText}>
                        Your current plan already covers {coveredTiers.map(tierName).join(" and ")}.
                      </p>
                    )}
                  </>
                ) : (
                  <p className={styles.blockText}>
                    This is for accounts without a card or App Store subscription.
                  </p>
                )}
              </div>

              <div className={styles.methodBlock}>
                <h3 className={styles.blockTitle}>Hold $HermesOS for ongoing access</h3>
                <p className={styles.blockText}>
                  Hold enough $HermesOS in a verified wallet and Pro or Power stays unlocked while you hold. The
                  amount for each plan is on the wallet page.
                </p>
                {source === "token_holding" && (
                  <p className={styles.blockStatus}>
                    <ShieldCheck size={14} aria-hidden="true" />
                    Your plan is active while you hold.
                  </p>
                )}
                <div className={styles.nested}>
                  <TokenHoldingPanel
                    embedded
                    tokenHolding={c.tokenHolding}
                    loading={c.tokenLoading}
                    refreshing={c.tokenRefreshing}
                    connectingWallet={c.walletConnecting}
                    error={c.tokenError}
                    onRefresh={c.handleRefreshTokenHolding}
                    onConnectWallet={c.handleConnectWallet}
                  />
                </div>
                <div className={styles.panelActions}>
                  <Link className={styles.link} href="/dashboard/wallet?from=billing">
                    See how much to hold
                    <ArrowRight size={13} aria-hidden="true" />
                  </Link>
                </div>
              </div>

              <div className={styles.methodBlock}>
                <h3 className={styles.blockTitle}>Top up credits with USDC on Base</h3>
                <p className={styles.blockText}>Buy account credits with USDC sent on the Base network.</p>
                <div className={styles.panelActions}>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.secondary}`}
                    onClick={() => onGoTo("credits")}
                  >
                    Go to Credits
                    <ArrowRight size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>

            <ul className={styles.rules} aria-label="Before you pay with crypto">
              {CRYPTO_PAYMENT_RULES.map((rule) => (
                <li key={rule}>
                  <Check size={13} aria-hidden="true" />
                  {rule}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
