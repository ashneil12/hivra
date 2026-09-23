'use client';

import type { CSSProperties, ReactNode } from "react";
import { Zap } from "lucide-react";
import type { BillingUsageData } from "../useBillingController";
import styles from "../Billing.module.css";

type Plan = NonNullable<BillingUsageData["plan"]>;
type Usage = NonNullable<BillingUsageData["usage"]>;

/** Largest slot count drawn as individual cells; above it the meter is a bar. */
export const MAX_SEGMENTED_SLOTS = 12;
const UNLIMITED = 999;

export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

const STATUS_LABELS: Record<string, { label: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  active: { label: "Active", tone: "good" },
  trialing: { label: "Trial", tone: "neutral" },
  past_due: { label: "Payment due", tone: "warn" },
  unpaid: { label: "Unpaid", tone: "bad" },
  canceled: { label: "Canceled", tone: "bad" },
  incomplete: { label: "Incomplete", tone: "warn" },
  pending: { label: "Pending", tone: "neutral" },
};

export function PlanStatusTag({ status }: { status: string }) {
  const known = STATUS_LABELS[status] ?? { label: status.replace(/_/g, " "), tone: "neutral" as const };
  const toneClass =
    known.tone === "good"
      ? styles.statusGood
      : known.tone === "warn"
        ? styles.statusWarn
        : known.tone === "bad"
          ? styles.statusBad
          : "";
  return (
    <span className={[styles.statusTag, toneClass].filter(Boolean).join(" ")}>
      <span className={styles.srOnly}>Status: </span>
      {known.label}
    </span>
  );
}

/**
 * Slots are discrete, so they are drawn as one square per slot: filled when
 * an agent or computer holds it, outlined when free. Very large or unlimited
 * pools fall back to a continuous bar.
 */
export function SlotMeter({ label, used, total }: { label: string; used: number; total: number }) {
  const unlimited = total >= UNLIMITED;
  const segmented = !unlimited && total > 0 && total <= MAX_SEGMENTED_SLOTS;
  const valueText = unlimited
    ? `${formatAmount(used)} in use`
    : `${formatAmount(used)} of ${formatAmount(total)} slots in use`;
  const over = !unlimited && used > total;

  return (
    <div className={styles.meter}>
      <div className={styles.meterHead}>
        <span className={styles.meterLabel} id="billing-meter-slots">{label}</span>
        <span className={[styles.meterValue, over ? styles.meterValueOver : ""].filter(Boolean).join(" ")}>
          {valueText}
        </span>
      </div>
      <div
        role="meter"
        aria-labelledby="billing-meter-slots"
        aria-valuemin={0}
        aria-valuemax={unlimited ? undefined : total}
        aria-valuenow={used}
        aria-valuetext={valueText}
      >
        {segmented ? (
          <ul
            className={styles.slots}
            aria-hidden="true"
            style={{ "--slot-count": total } as CSSProperties}
          >
            {Array.from({ length: total }, (_, index) => (
              <li
                key={index}
                data-used={index < used ? "true" : "false"}
                className={[styles.slot, index < used ? styles.slotUsed : ""].filter(Boolean).join(" ")}
              />
            ))}
          </ul>
        ) : (
          <div className={styles.bar} aria-hidden="true">
            <div
              className={styles.barFill}
              style={{ width: `${unlimited || total <= 0 ? 0 : Math.min(100, (used / total) * 100)}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function BarMeter({
  id,
  label,
  used,
  total,
  unit,
}: {
  id: string;
  label: string;
  used: number;
  total: number;
  unit: string;
}) {
  const unlimited = total >= UNLIMITED;
  const pct = unlimited || total <= 0 ? 0 : Math.min(100, (used / total) * 100);
  const valueText = unlimited
    ? `${formatAmount(used)} ${unit} allocated`
    : `${formatAmount(used)} of ${formatAmount(total)} ${unit} allocated`;
  const over = !unlimited && used > total;

  return (
    <div className={styles.meter}>
      <div className={styles.meterHead}>
        <span className={styles.meterLabel} id={id}>{label}</span>
        <span className={[styles.meterValue, over ? styles.meterValueOver : ""].filter(Boolean).join(" ")}>
          {valueText}
        </span>
      </div>
      <div
        role="meter"
        aria-labelledby={id}
        aria-valuemin={0}
        aria-valuemax={unlimited ? undefined : total}
        aria-valuenow={used}
        aria-valuetext={valueText}
        className={styles.bar}
      >
        <div className={styles.barFill} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * The current plan, drawn like the rating plate on a server chassis: the
 * plan name, how it is paid for, engraved spec cells, and meters for what is
 * in use. Every number comes from /api/billing/usage, which reads the same
 * entitlement the provisioning gate enforces.
 */
export interface PlateSpecLabels {
  slots: string;
  vcpu: string;
  memory: string;
  idlePolicy: string;
}

export function RatingPlate({
  plan,
  usage,
  eyebrow,
  priceLine,
  specLabels,
  idlePolicy,
  labels,
  actions,
}: {
  plan: Plan;
  usage: Usage;
  eyebrow: string;
  priceLine: string;
  /** Engraved spec cell labels. */
  specLabels: PlateSpecLabels;
  /** The enforced idle policy, already worded for the locale. */
  idlePolicy: string;
  /** Meter labels. */
  labels: { slots: string; cpu: string; memory: string };
  actions: ReactNode;
}) {
  const unlimitedSlots = usage.maxAgents >= UNLIMITED;
  const boost = plan.veniceBoost?.active ? plan.veniceBoost : null;

  return (
    <section className={styles.plate} aria-labelledby="billing-plate-name">
      <div className={styles.plateHead}>
        <div className={styles.plateIdentity}>
          <p className={styles.plateEyebrow}>{eyebrow}</p>
          <h2 className={styles.plateName} id="billing-plate-name">
            {plan.name}
            {boost && <span className={styles.plus}>Plus</span>}
          </h2>
          <p className={styles.plateLine}>{priceLine}</p>
          {boost && (
            <p className={styles.boost}>
              <Zap size={12} aria-hidden="true" />
              Venice boost · +{boost.cpuBonus} vCPU / +{boost.ramBonusMb / 1024} GB per agent
            </p>
          )}
        </div>
        <div className={styles.plateStatus}>
          <PlanStatusTag status={plan.status} />
        </div>
      </div>

      <dl className={styles.plateSpecs}>
        <div className={styles.plateSpec}>
          <dt>{specLabels.slots}</dt>
          <dd>{unlimitedSlots ? "Unlimited" : formatAmount(usage.maxAgents)}</dd>
        </div>
        <div className={styles.plateSpec}>
          <dt>{specLabels.vcpu}</dt>
          <dd>{formatAmount(usage.totalCpu)}</dd>
        </div>
        <div className={styles.plateSpec}>
          <dt>{specLabels.memory}</dt>
          <dd>
            {formatAmount(usage.totalRam / 1024)}
            <small>GB</small>
          </dd>
        </div>
        <div className={styles.plateSpec}>
          <dt>{specLabels.idlePolicy}</dt>
          <dd>{idlePolicy}</dd>
        </div>
      </dl>

      <div className={styles.plateMeters}>
        <SlotMeter label={labels.slots} used={usage.agentCount} total={usage.maxAgents} />
        <BarMeter id="billing-meter-cpu" label={labels.cpu} used={usage.usedCpu} total={usage.totalCpu} unit="vCPU" />
        <BarMeter
          id="billing-meter-memory"
          label={labels.memory}
          used={usage.usedRam / 1024}
          total={usage.totalRam / 1024}
          unit="GB"
        />
      </div>

      <div className={styles.plateActions}>{actions}</div>
    </section>
  );
}

/** The quiet plate for someone without a plan. */
export function EmptyPlate({
  eyebrow,
  title,
  text,
  action,
}: {
  eyebrow: string;
  title: string;
  text: string;
  action: ReactNode;
}) {
  return (
    <section className={[styles.plate, styles.plateEmpty].join(" ")} aria-labelledby="billing-plate-name">
      <div className={styles.plateHead}>
        <div className={styles.plateIdentity}>
          <p className={styles.plateEyebrow}>{eyebrow}</p>
          <h2 className={styles.plateName} id="billing-plate-name">{title}</h2>
          <p className={styles.plateLine}>{text}</p>
        </div>
      </div>
      <div className={styles.plateActions}>{action}</div>
    </section>
  );
}
