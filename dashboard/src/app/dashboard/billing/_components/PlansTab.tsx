'use client';

import { Check, Coins, CreditCard, Info, Loader2, Lock, ShieldCheck } from "lucide-react";
import { PLANS, getPlanDiff, type PlanKey } from "@/lib/subscription";
import { APPLE_MANAGE_SUBSCRIPTIONS_URL } from "@/lib/billing/subscription-management-copy";
import {
  bestYearlySavingsPercent,
  hasPaidCardOrAppleSubscription,
  planCardBadge,
  planCardCta,
  planCardEyebrow,
  planCardFeatures,
  planIdlePolicy,
  planPriceDisplay,
  planYearlyPriceCents,
  plansForLadder,
  plansSoldAtCheckout,
  tokenYearlySavingsPercent,
  type BillingCadence,
  type PlanCardCta,
  type PlanPaymentPath,
  type PlanSource,
  type TokenPlanMode,
} from "@/lib/billing/plan-display";
import { plannedHostedMachines } from "@/lib/subscription/hosted-ladder";
import type { BillingController } from "../useBillingController";
import { ChoiceGroup } from "./ChoiceGroup";
import styles from "../Billing.module.css";

export const PLANS_INTRO =
  "Every plan runs your agents and computers on Hivra's servers. Bring your own model key and we add nothing to what you spend.";

/**
 * When an in-place change is billed. The route swaps the subscription to the
 * plan's monthly price with Stripe proration: monthly subscribers get the
 * difference on their next invoice; a yearly subscription changes interval,
 * which Stripe invoices at once with credit for the unused time.
 */
export const IN_PLACE_CHANGE_NOTE =
  "Plan changes apply right away and move your subscription to monthly billing. On a monthly plan, the price difference for the rest of this billing period is added to your next invoice. A yearly plan is invoiced today instead, with credit for its unused time.";

function Delta({ value, unit = "" }: { value: number; unit?: string }) {
  if (!value) return null;
  const up = value > 0;
  return (
    <span className={`${styles.delta} ${up ? styles.deltaUp : styles.deltaDown}`}>
      {up ? "+" : "−"}
      {Math.abs(value)}
      {unit}
      <span className={styles.srOnly}> compared with your plan</span>
    </span>
  );
}

function CardAction({
  cta,
  planKey,
  emphasis,
  c,
}: {
  cta: PlanCardCta;
  planKey: PlanKey;
  emphasis: boolean;
  c: BillingController;
}) {
  const tone = emphasis ? styles.primary : styles.secondary;
  switch (cta.kind) {
    case "current":
      return (
        <div className={styles.currentMarker}>
          <Check size={14} aria-hidden="true" />
          {cta.label}
        </div>
      );
    case "start_free":
    case "subscribe": {
      const busy = c.subscribing === planKey;
      return (
        <button
          type="button"
          className={`${styles.button} ${cta.kind === "start_free" ? styles.secondary : tone} ${styles.block}`}
          onClick={() => void c.handleSubscribe(planKey)}
          disabled={!!c.subscribing}
        >
          {busy ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : null}
          {cta.label}
        </button>
      );
    }
    case "pay_yearly_token":
      return (
        <button
          type="button"
          className={`${styles.button} ${tone} ${styles.block}`}
          onClick={() => void c.handleYearlyTokenPay(cta.tier)}
          disabled={c.yearly.loading}
        >
          <Coins size={14} aria-hidden="true" />
          {cta.label}
        </button>
      );
    case "hold_token":
      return (
        <a href={cta.href} className={`${styles.button} ${styles.secondary} ${styles.block}`}>
          <Coins size={14} aria-hidden="true" />
          {cta.label}
        </a>
      );
    case "upgrade":
    case "downgrade": {
      const busy = c.changingPlan === planKey;
      // Wait out a usage refresh too: until it lands the ladder may still
      // show the plan the user just left as current.
      const blocked = !!c.changingPlan || c.status.loading;
      return (
        <button
          type="button"
          className={`${styles.button} ${cta.kind === "upgrade" ? styles.primary : styles.secondary} ${styles.block}`}
          onClick={() => c.setConfirmingPlan(planKey)}
          disabled={blocked}
        >
          {busy ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : null}
          {cta.label}
        </button>
      );
    }
    case "note":
      return (
        <p className={styles.cardNote}>
          <Lock size={13} aria-hidden="true" />
          {cta.note}
        </p>
      );
  }
}

export function MachineCard({
  planKey,
  currentPlanKey,
  path,
  tokenMode,
  cadence,
  cta,
  c,
}: {
  planKey: PlanKey;
  currentPlanKey: PlanKey | null;
  path: PlanPaymentPath;
  tokenMode: TokenPlanMode;
  cadence: BillingCadence;
  cta: PlanCardCta;
  c: BillingController;
}) {
  const plan = PLANS[planKey];
  const badge = planCardBadge(planKey, currentPlanKey);
  const price = planPriceDisplay(planKey, { path, cadence, tokenMode });
  const diff = currentPlanKey && currentPlanKey !== planKey ? getPlanDiff(currentPlanKey, planKey) : null;
  const isPopular = "popular" in plan && plan.popular === true;
  const isCurrent = planKey === currentPlanKey;
  const titleId = `billing-plan-${planKey}`;
  const emphasis = isPopular || cta.kind === "upgrade" || cta.kind === "pay_yearly_token";

  return (
    <article
      className={styles.machine}
      data-popular={isPopular ? "true" : "false"}
      data-current={isCurrent ? "true" : "false"}
      aria-labelledby={titleId}
    >
      <p className={styles.machineEyebrow}>{planCardEyebrow(planKey)}</p>
      <div className={styles.machineTop}>
        <h3 className={styles.machineName} id={titleId}>{plan.name}</h3>
        {badge && (
          <span className={`${styles.badge} ${badge.kind === "current" ? styles.badgeCurrent : ""}`}>
            {badge.label}
          </span>
        )}
      </div>

      <p className={styles.machinePrice}>
        <strong>{price.amount}</strong>
        {price.unit && <span>{price.unit}</span>}
      </p>
      <p className={styles.machineSub}>{price.subline ?? " "}</p>

      <dl className={styles.machineSpecs}>
        <div>
          <dt>vCPU</dt>
          <dd>
            {plan.totalCpu}
            {diff && <Delta value={diff.cpu} />}
          </dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd>
            {plan.totalRam / 1024} GB
            {diff && <Delta value={diff.ramGb} unit=" GB" />}
          </dd>
        </div>
        <div>
          <dt>Agents &amp; computers</dt>
          <dd>
            {plan.maxAgents >= 999 ? "Unlimited" : plan.maxAgents}
            {diff && <Delta value={diff.agents} />}
          </dd>
        </div>
        <div>
          <dt>Idle</dt>
          <dd>{planIdlePolicy(planKey)}</dd>
        </div>
      </dl>

      <ul className={styles.features}>
        {planCardFeatures(planKey).map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>

      <div className={styles.machineAction}>
        <CardAction cta={cta} planKey={planKey} emphasis={emphasis} c={c} />
      </div>
    </article>
  );
}

export function PlannedSizesStrip() {
  const machines = plannedHostedMachines();
  return (
    <section className={styles.planned} aria-labelledby="billing-planned-title">
      <div className={styles.plannedHead}>
        <h3 className={styles.plannedTitle} id="billing-planned-title">Bigger machines are planned</h3>
        <span className={styles.statusTag}>Planned — not available to buy yet</span>
      </div>
      <ul className={styles.plannedList}>
        {machines.map((machine) => (
          <li key={machine.name} className={styles.plannedItem}>
            <span className={styles.plannedName}>{machine.name}</span>
            <span className={styles.plannedSpec}>
              {machine.cpu} vCPU · {machine.ram} · {machine.price}/mo
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PlansTab({ c, heading }: { c: BillingController; heading: string }) {
  const plan = c.data?.subscribed ? c.data.plan : null;
  const source = (plan?.source ?? null) as PlanSource | null;
  const currentPlanKey = (plan?.key ?? null) as PlanKey | null;
  const isApple = source === "apple_iap";

  // $HermesOS plan payment is offered only to people who don't already pay
  // for a plan by card or through Apple.
  const canPayWithToken =
    c.flags.cryptoBillingEnabled &&
    !hasPaidCardOrAppleSubscription({ planKey: currentPlanKey, source });
  const path: PlanPaymentPath = canPayWithToken && c.paidPath === "crypto" ? "token" : "card";
  const tokenMode: TokenPlanMode = c.cryptoMode === "permanent" ? "hold" : "yearly";
  const ladder = plansForLadder({ currentPlanKey, path });
  const ctaFor = (planKey: PlanKey, cadence: BillingCadence) =>
    planCardCta({
      planKey,
      currentPlanKey,
      source,
      path,
      tokenMode,
      cadence,
      selfServeDowngradeEnabled: c.flags.selfServeDowngradeEnabled,
      changePlanRequiresCheckout: c.changePlanRequiresCheckout,
    });

  // Cadence only matters when a card goes through checkout: in-place plan
  // changes always move to the monthly price, and Apple plans change in the
  // App Store. The choice (and its savings chip) shows only when some card
  // on the ladder actually starts a checkout for a plan with a yearly price.
  const checkoutWillBeUsed = !currentPlanKey || c.changePlanRequiresCheckout;
  const checkoutPlans =
    path === "card" && checkoutWillBeUsed && !isApple
      ? plansSoldAtCheckout(ladder.map((planKey) => ({ planKey, cta: ctaFor(planKey, "monthly") })))
      : [];
  const showCadence = checkoutPlans.some((planKey) => planYearlyPriceCents(planKey) !== null);
  // Without the choice every card shows the monthly price that will be
  // charged, even when a link asked for ?cadence=yearly.
  const effectiveCadence: BillingCadence = showCadence ? c.cadence : "monthly";
  const cardSaving = bestYearlySavingsPercent(checkoutPlans);
  const tokenSaving = Math.max(
    tokenYearlySavingsPercent("pro") ?? 0,
    tokenYearlySavingsPercent("power") ?? 0
  );
  const inPlaceCardChanges = Boolean(currentPlanKey) && !c.changePlanRequiresCheckout && !isApple && path === "card";

  return (
    <div>
      <h2 className={styles.sectionHeading}>{currentPlanKey ? heading : "Choose a plan"}</h2>
      <p className={styles.intro}>{PLANS_INTRO}</p>

      {(canPayWithToken || showCadence || path === "token") && (
        <div className={styles.controls}>
          {canPayWithToken && (
            <div className={styles.control}>
              <span className={styles.controlLabel}>Pay with</span>
              <ChoiceGroup
                label="Payment method"
                value={path === "token" ? "crypto" : "card"}
                onChange={(next) => c.setPaidPath(next)}
                options={[
                  { value: "card", label: "Card", icon: <CreditCard size={14} aria-hidden="true" /> },
                  { value: "crypto", label: "$HermesOS", icon: <Coins size={14} aria-hidden="true" /> },
                ]}
              />
            </div>
          )}

          {showCadence && (
            <div className={styles.control}>
              <span className={styles.controlLabel}>Billing</span>
              <div className={styles.controlRow}>
                <ChoiceGroup
                  label="Billing cadence"
                  value={c.cadence}
                  onChange={(next) => c.setCadence(next)}
                  options={[
                    { value: "monthly", label: "Monthly" },
                    { value: "yearly", label: "Yearly" },
                  ]}
                />
                {cardSaving !== null && <span className={styles.saveChip}>Save up to {cardSaving}% yearly</span>}
              </div>
            </div>
          )}

          {path === "token" && (
            <div className={styles.control}>
              <span className={styles.controlLabel}>$HermesOS option</span>
              <div className={styles.controlRow}>
                <ChoiceGroup
                  label="$HermesOS option"
                  value={c.cryptoMode}
                  onChange={(next) => c.setCryptoMode(next)}
                  options={[
                    { value: "yearly", label: "Pay for a year" },
                    { value: "permanent", label: "Hold to qualify" },
                  ]}
                />
                {tokenMode === "yearly" && tokenSaving > 0 && (
                  <span className={styles.saveChip}>Up to {tokenSaving}% less than a card year</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {isApple && (
        <p className={styles.changeNote}>
          <Info size={14} aria-hidden="true" />
          <span>
            You subscribe through the App Store, so plan changes happen there.{" "}
            <a className={styles.link} href={APPLE_MANAGE_SUBSCRIPTIONS_URL} target="_blank" rel="noopener noreferrer">
              Manage in the App Store
            </a>
          </span>
        </p>
      )}

      {inPlaceCardChanges && (
        <p className={styles.changeNote}>
          <Info size={14} aria-hidden="true" />
          <span>{IN_PLACE_CHANGE_NOTE}</span>
        </p>
      )}

      <div className={styles.ladder}>
        {ladder.map((key) => (
          <MachineCard
            key={key}
            planKey={key}
            currentPlanKey={currentPlanKey}
            path={path}
            tokenMode={tokenMode}
            cadence={effectiveCadence}
            c={c}
            cta={ctaFor(key, effectiveCadence)}
          />
        ))}
      </div>

      {currentPlanKey !== "command" && <PlannedSizesStrip />}

      <ul className={styles.footnotes}>
        <li>
          <ShieldCheck size={13} aria-hidden="true" />
          Card payments: 48-hour refund.
        </li>
        {path === "token" && (
          <li>
            <Coins size={13} aria-hidden="true" />
            Token payments are final, except where the law gives you a right to cancel.
          </li>
        )}
      </ul>
    </div>
  );
}
