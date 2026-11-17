'use client';

// The plan ladder on the billing page. Shown only when the server says the
// ladder is on (GET /api/billing/plan-ladder). Every name, price and number
// here comes from that answer, never from code.

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import type { PublicPlanLadder } from "@/lib/subscription/plan-ladder";
import type { BillingController } from "../useBillingController";
import { ChoiceGroup } from "./ChoiceGroup";
import styles from "../Billing.module.css";

export interface PlanLadderAnswer {
  enabled: boolean;
  ladder?: PublicPlanLadder;
  offered?: boolean;
  current?: {
    plan: string | null;
    alwaysOnLimit: number | null;
    alwaysOnExtra: number;
    alwaysOnInUse: number | null;
    aiAllowanceCents: number;
  } | null;
}

async function fetchPlanLadder(): Promise<PlanLadderAnswer> {
  try {
    const res = await fetch("/api/billing/plan-ladder", { cache: "no-store" });
    const json = await res.json().catch(() => null);
    return res.ok && json?.success ? (json.data as PlanLadderAnswer) : { enabled: false };
  } catch {
    return { enabled: false };
  }
}

export function usePlanLadder() {
  const [answer, setAnswer] = useState<PlanLadderAnswer | null>(null);
  useEffect(() => {
    let live = true;
    fetchPlanLadder().then((next) => {
      if (live) setAnswer(next);
    });
    return () => {
      live = false;
    };
  }, []);
  const reload = useCallback(async () => {
    setAnswer(await fetchPlanLadder());
  }, []);
  return { answer, reload };
}

function dollars(cents: number): string {
  return Number.isInteger(cents / 100) ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function LadderPlans({
  c,
  answer,
  reload,
}: {
  c: BillingController;
  answer: PlanLadderAnswer;
  reload: () => Promise<void>;
}) {
  const ladder = answer.ladder;
  const [changing, setChanging] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [extras, setExtras] = useState<number>(answer.current?.alwaysOnExtra ?? 0);
  const [savingExtras, setSavingExtras] = useState(false);
  if (!ladder) return null;

  const currentKey = answer.current?.plan ?? null;
  const hasYearly = ladder.plans.some((plan) => plan.yearlyCents !== null);
  const cadence = hasYearly && !currentKey ? c.cadence : "monthly";

  const changePlan = async (planKey: string) => {
    setChanging(planKey);
    setMessage(null);
    try {
      const res = await fetch("/api/billing/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPlan: planKey }),
      });
      const json = await res.json().catch(() => null);
      setMessage(json?.data?.message ?? json?.error ?? (res.ok ? "Plan changed." : "Could not change your plan."));
      await Promise.all([reload(), c.fetchUsage()]);
    } finally {
      setChanging(null);
      setConfirming(null);
    }
  };

  const saveExtras = async () => {
    setSavingExtras(true);
    setMessage(null);
    try {
      const res = await fetch("/api/billing/always-on-extra", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity: extras }),
      });
      const json = await res.json().catch(() => null);
      setMessage(res.ok ? "Saved. Your next invoice includes the change." : json?.error ?? "Could not save.");
      await reload();
    } finally {
      setSavingExtras(false);
    }
  };

  const rank = (key: string | null) => ladder.plans.findIndex((plan) => plan.key === key);

  return (
    <section aria-labelledby="ladder-plans-title">
      <h2 className={styles.sectionHeading} id="ladder-plans-title">{currentKey ? "Your plan" : "Choose a plan"}</h2>

      {hasYearly && !currentKey && (
        <div className={styles.controls}>
          <div className={styles.control}>
            <span className={styles.controlLabel}>Billing</span>
            <ChoiceGroup
              label="Billing cadence"
              value={c.cadence}
              onChange={(next) => c.setCadence(next)}
              options={[
                { value: "monthly", label: "Monthly" },
                { value: "yearly", label: "Yearly" },
              ]}
            />
          </div>
        </div>
      )}

      {message && <p className={styles.changeNote}>{message}</p>}

      <div className={styles.ladder}>
        {ladder.plans.map((plan) => {
          const isCurrent = plan.key === currentKey;
          const yearly = cadence === "yearly" && plan.yearlyCents !== null;
          const titleId = `ladder-plan-${plan.key}`;
          const busy = changing === plan.key || c.subscribing === plan.key;
          const isUpgrade = currentKey ? rank(plan.key) > rank(currentKey) : true;
          return (
            <article
              key={plan.key}
              className={styles.machine}
              data-popular={plan.popular ? "true" : "false"}
              data-current={isCurrent ? "true" : "false"}
              aria-labelledby={titleId}
            >
              <div className={styles.machineTop}>
                <h3 className={styles.machineName} id={titleId}>{plan.name}</h3>
                {isCurrent && <span className={`${styles.badge} ${styles.badgeCurrent}`}>Current</span>}
              </div>
              <p className={styles.machinePrice}>
                <strong>{dollars(yearly ? plan.yearlyCents! : plan.monthlyCents)}</strong>
                <span>{yearly ? "/yr" : "/mo"}</span>
              </p>
              <p className={styles.machineSub}>
                {plan.aiAllowanceCents > 0 ? `${dollars(plan.aiAllowanceCents)} of AI included every month` : "Bring your own AI key"}
              </p>
              <dl className={styles.machineSpecs}>
                <div>
                  <dt>Agents</dt>
                  <dd>{plan.agents}</dd>
                </div>
                <div>
                  <dt>Kept awake</dt>
                  <dd>{plan.alwaysOn > 0 ? plan.alwaysOn : "Sleep when idle"}</dd>
                </div>
                <div>
                  <dt>Computer</dt>
                  <dd>{plan.agentCpu} vCPU · {plan.agentRamGb} GB</dd>
                </div>
              </dl>
              {plan.features.length > 0 && (
                <ul className={styles.features}>
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
              )}
              <div className={styles.machineAction}>
                {isCurrent ? (
                  <div className={styles.currentMarker}>
                    <Check size={14} aria-hidden="true" />
                    Your plan
                  </div>
                ) : currentKey ? (
                  confirming === plan.key ? (
                    <button
                      type="button"
                      className={`${styles.button} ${styles.primary} ${styles.block}`}
                      onClick={() => void changePlan(plan.key)}
                      disabled={!!changing}
                    >
                      {busy ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : null}
                      Confirm: {isUpgrade ? "upgrade" : "move"} to {plan.name}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={`${styles.button} ${isUpgrade ? styles.primary : styles.secondary} ${styles.block}`}
                      onClick={() => setConfirming(plan.key)}
                      disabled={!!changing}
                    >
                      {isUpgrade ? `Upgrade to ${plan.name}` : `Move to ${plan.name}`}
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    className={`${styles.button} ${plan.popular ? styles.primary : styles.secondary} ${styles.block}`}
                    onClick={() => void c.handleSubscribe(plan.key)}
                    disabled={!!c.subscribing}
                  >
                    {busy ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : null}
                    Choose {plan.name}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {answer.current && ladder.alwaysOnExtra && (
        <div className={styles.controls}>
          <div className={styles.control}>
            <span className={styles.controlLabel}>
              Keep more agents awake ({dollars(ladder.alwaysOnExtra.monthlyCents)}/mo each)
            </span>
            <div className={styles.controlRow}>
              <input
                type="number"
                min={0}
                max={ladder.alwaysOnExtra.maxPerAccount}
                value={extras}
                onChange={(event) => setExtras(Math.max(0, Math.min(ladder.alwaysOnExtra!.maxPerAccount, Number(event.target.value) || 0)))}
                aria-label="Extra agents kept awake"
                style={{ width: 72, padding: "6px 8px" }}
              />
              <button
                type="button"
                className={`${styles.button} ${styles.secondary}`}
                onClick={() => void saveExtras()}
                disabled={savingExtras || extras === answer.current.alwaysOnExtra}
              >
                {savingExtras ? <Loader2 size={14} className={styles.spin} aria-hidden="true" /> : null}
                Save
              </button>
            </div>
            <p className={styles.machineSub}>
              {answer.current.alwaysOnInUse ?? 0} of {count(answer.current.alwaysOnLimit ?? 0, "agent", "agents")} kept awake.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
