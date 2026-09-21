'use client';

import { Children, useState, type ReactNode } from "react";
import { motion, type Variants } from "framer-motion";
import { ArrowRight, Bot, ChevronDown, Coins, Cpu, Loader2, ReceiptText } from "lucide-react";

import { useLocale } from "@/components/i18n/LocaleProvider";

export interface BillingActivityData {
  creditLedgerEntries: Array<{
    id: string;
    amountCredits: number;
    source: string;
    actor: string;
    reason: string;
    referenceId: string;
    createdAt: string | null;
  }>;
  paymentTransactions: Array<{
    id: string;
    provider: string;
    providerReferenceId: string;
    status: string;
    asset: string;
    amountMinor: number;
    packageCredits: number | null;
    createdAt: string | null;
  }>;
  computeUsageEvents: Array<{
    id: string;
    instanceId: string | null;
    creditsDelta: number;
    usageKind: string;
    referenceId: string;
    status: string;
    createdAt: string | null;
  }>;
  llmUsageEvents: Array<{
    id: string;
    provider: string;
    model: string;
    billingSource: string;
    creditsDelta: number;
    totalTokens: number | null;
    referenceId: string;
    status: string;
    createdAt: string | null;
  }>;
  managedVeniceUsageEvents?: Array<{
    id: string;
    walletType: string;
    endpoint: string;
    model: string;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    actualCostMicroUsd: number;
    chargedMicroUsd: number;
    discountMicroUsd: number;
    status: string;
    referenceId: string;
    createdAt: string | null;
  }>;
  managedVeniceFinancialEvents?: Array<{
    id: string;
    walletType: string | null;
    eventType: string;
    referenceId: string;
    amountMicroUsd: number;
    veniceCostMicroUsd: number;
    discountMicroUsd: number;
    createdAt: string | null;
  }>;
}

function formatCreditDelta(amount: number) {
  const prefix = amount > 0 ? "+" : "";
  return `${prefix}${amount.toLocaleString()} credits`;
}

function formatActivityLabel(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatActivityDate(value: string | null) {
  if (!value) return "Pending";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Pending";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPaymentAmount(amountMinor: number, asset: string) {
  const major = amountMinor / 100;
  const formatted = major.toLocaleString(undefined, {
    minimumFractionDigits: major % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${formatted} ${asset}`;
}

function formatMicroUsdAmount(amountMicroUsd: number, decimals = 4) {
  return `$${(amountMicroUsd / 1_000_000).toFixed(decimals)}`;
}

function formatLlmBillingSource(value: string) {
  if (value === "hermes_credits") return "Hivra credits";
  if (value === "bankr_llm_credits") return "Bankr LLM credits";
  if (value === "byo_key") return "BYO key";
  return formatActivityLabel(value);
}

function ActivitySection({
  title,
  icon,
  empty,
  children,
}: {
  title: string;
  icon: ReactNode;
  empty: string;
  children: ReactNode;
}) {
  const hasRows = Children.count(children) > 0;

  return (
    <div style={{ border: "1px solid var(--etched-border)", padding: "14px 16px", minHeight: 160 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        {icon}
        <span className="mono" style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>
          {title}
        </span>
      </div>
      {hasRows ? (
        <div style={{ display: "grid", gap: 10 }}>
          {children}
        </div>
      ) : (
        <p style={{ fontSize: 12, opacity: 0.45, margin: 0 }}>{empty}</p>
      )}
    </div>
  );
}

function ActivityRow({
  primary,
  secondary,
  amount,
  tone = "neutral",
}: {
  primary: string;
  secondary: string;
  amount?: string;
  tone?: "positive" | "negative" | "neutral";
}) {
  const color = tone === "positive" ? "#16a34a" : tone === "negative" ? "#dc2626" : "var(--ink-black)";

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>{primary}</span>
        {amount && (
          <span className="mono" style={{ fontSize: 10, fontWeight: 700, color, whiteSpace: "nowrap" }}>
            {amount}
          </span>
        )}
      </div>
      <span className="mono" style={{ fontSize: 9, opacity: 0.45 }}>
        {secondary}
      </span>
    </div>
  );
}

function ExpandableActivityRow({
  primary,
  secondary,
  amount,
  tone = "neutral",
  details,
}: {
  primary: string;
  secondary: string;
  amount?: string;
  tone?: "positive" | "negative" | "neutral";
  details: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = tone === "positive" ? "#16a34a" : tone === "negative" ? "#dc2626" : "var(--ink-black)";

  return (
    <div style={{ borderBottom: "1px dotted var(--etched-border)", paddingBottom: 8 }}>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          padding: 0,
          width: "100%",
          textAlign: "left",
          cursor: "pointer",
          display: "grid",
          gap: 4,
          color: "inherit",
          font: "inherit",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700 }}>
            <ChevronDown
              size={11}
              style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 120ms" }}
            />
            {primary}
          </span>
          {amount && (
            <span className="mono" style={{ fontSize: 10, fontWeight: 700, color, whiteSpace: "nowrap" }}>
              {amount}
            </span>
          )}
        </div>
        <span className="mono" style={{ fontSize: 9, opacity: 0.45, paddingLeft: 17 }}>
          {secondary}
        </span>
      </button>
      {expanded && (
        <div
          style={{
            marginTop: 10,
            marginLeft: 17,
            padding: "10px 12px",
            border: "1px dotted var(--etched-border)",
            background: "rgba(0,0,0,0.02)",
            fontSize: 11,
            display: "grid",
            gap: 6,
          }}
        >
          {details}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
      <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.55 }}>
        {label}
      </span>
      <span
        className={mono ? "mono" : undefined}
        style={{ fontSize: 11, fontWeight: 600, textAlign: "right", wordBreak: "break-all" }}
      >
        {value}
      </span>
    </div>
  );
}

function formatExactMicroUsd(micro: number) {
  const usd = micro / 1_000_000;
  return `$${usd.toFixed(6)}`;
}

function formatFullTimestamp(value: string | null | undefined) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function BillingActivityPanel({
  activity,
  loading,
  error,
  variants,
  managedVeniceBriefLimit = null,
}: {
  activity: BillingActivityData | null;
  loading: boolean;
  error: string | null;
  variants: Variants;
  managedVeniceBriefLimit?: number | null;
}) {
  const { copy } = useLocale();
  const activityCopy = copy.dashboard.billing.activity;
  const ledgerEntries = activity?.creditLedgerEntries ?? [];
  const paymentTransactions = activity?.paymentTransactions ?? [];
  const computeUsageEvents = activity?.computeUsageEvents ?? [];
  const llmUsageEvents = activity?.llmUsageEvents ?? [];
  const allManagedVeniceUsageEvents = activity?.managedVeniceUsageEvents ?? [];
  const allManagedVeniceFinancialEvents = (activity?.managedVeniceFinancialEvents ?? [])
    .filter((e) => e.eventType !== "usage_capture" && e.eventType !== "treasury_sweep");
  const managedVeniceUsageEvents = managedVeniceBriefLimit != null
    ? allManagedVeniceUsageEvents.slice(0, managedVeniceBriefLimit)
    : allManagedVeniceUsageEvents;
  const managedVeniceFinancialEvents = managedVeniceBriefLimit != null
    ? allManagedVeniceFinancialEvents.slice(0, managedVeniceBriefLimit)
    : allManagedVeniceFinancialEvents;
  const managedVeniceOverflowCount =
    Math.max(0, allManagedVeniceUsageEvents.length - managedVeniceUsageEvents.length) +
    Math.max(0, allManagedVeniceFinancialEvents.length - managedVeniceFinancialEvents.length);

  return (
    <motion.div variants={variants} style={{
      border: "1px solid var(--etched-border)", background: "var(--bg-surface)",
      padding: "clamp(1.5rem, 4vw, 2rem)", marginBottom: "2rem",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1.5rem", flexWrap: "wrap", marginBottom: "1.25rem" }}>
        <div>
          <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", opacity: 0.5, fontWeight: 700 }}>
            {activityCopy.eyebrow}
          </span>
          <h3 className="serif" style={{ fontSize: "1.5rem", fontWeight: 700, marginTop: 4 }}>
            {activityCopy.title}
          </h3>
        </div>
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
            <span className="mono" style={{ fontSize: 10, opacity: 0.5, fontWeight: 700 }}>{activityCopy.loading}</span>
          </div>
        )}
      </div>

      {error ? (
        <p style={{ fontSize: 12, color: "#dc2626", margin: 0 }}>{error}</p>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "0.75rem" }}>
            <ActivitySection
              title={activityCopy.ledger}
              icon={<Coins size={14} />}
              empty={loading ? activityCopy.ledgerLoading : activityCopy.ledgerEmpty}
            >
              {ledgerEntries.map((entry) => (
                <ActivityRow
                  key={entry.id}
                  primary={formatActivityLabel(entry.reason)}
                  secondary={`${formatActivityLabel(entry.source)} · ${formatActivityDate(entry.createdAt)}`}
                  amount={formatCreditDelta(entry.amountCredits)}
                  tone={entry.amountCredits > 0 ? "positive" : "negative"}
                />
              ))}
            </ActivitySection>

            <ActivitySection
              title={activityCopy.payments}
              icon={<ReceiptText size={14} />}
              empty={loading ? activityCopy.paymentsLoading : activityCopy.paymentsEmpty}
            >
              {paymentTransactions.map((transaction) => (
                <ActivityRow
                  key={transaction.id}
                  primary={formatActivityLabel(transaction.provider)}
                  secondary={`${formatActivityLabel(transaction.status)} · ${formatActivityDate(transaction.createdAt)}`}
                  amount={formatPaymentAmount(transaction.amountMinor, transaction.asset)}
                  tone={transaction.status === "succeeded" ? "positive" : "neutral"}
                />
              ))}
            </ActivitySection>

            <ActivitySection
              title={activityCopy.compute}
              icon={<Cpu size={14} />}
              empty={loading ? activityCopy.computeLoading : activityCopy.computeEmpty}
            >
              {computeUsageEvents.map((event) => (
                <ActivityRow
                  key={event.id}
                  primary={formatActivityLabel(event.usageKind)}
                  secondary={`${formatActivityLabel(event.status)} · ${formatActivityDate(event.createdAt)}`}
                  amount={formatCreditDelta(event.creditsDelta)}
                  tone={event.creditsDelta < 0 ? "negative" : "neutral"}
                />
              ))}
            </ActivitySection>

            <ActivitySection
              title={activityCopy.llm}
              icon={<Bot size={14} />}
              empty={loading ? activityCopy.llmLoading : activityCopy.llmEmpty}
            >
              {llmUsageEvents.map((event) => (
                <ActivityRow
                  key={event.id}
                  primary={`${formatActivityLabel(event.provider)} · ${event.model}`}
                  secondary={`${formatLlmBillingSource(event.billingSource)} · ${event.totalTokens?.toLocaleString() ?? 0} tokens`}
                  amount={event.creditsDelta === 0 ? undefined : formatCreditDelta(event.creditsDelta)}
                  tone={event.creditsDelta < 0 ? "negative" : "neutral"}
                />
              ))}
            </ActivitySection>
          </div>

          <div
            id="managed-venice"
            style={{
              scrollMarginTop: 80,
              border: "1px solid var(--etched-border)",
              padding: "16px 18px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <Bot size={14} />
              <span className="mono" style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>
                Managed Venice
              </span>
              <span className="mono" style={{ fontSize: 9, opacity: 0.45, fontWeight: 600 }}>
                · click any row for the full breakdown
              </span>
            </div>
            {allManagedVeniceUsageEvents.length === 0 && allManagedVeniceFinancialEvents.length === 0 ? (
              <p style={{ fontSize: 12, opacity: 0.45, margin: 0 }}>
                {loading ? "Loading managed Venice..." : "No managed Venice usage yet."}
              </p>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {managedVeniceUsageEvents.map((event) => {
                  const undercharged = event.chargedMicroUsd < event.actualCostMicroUsd;
                  const settledTone: "positive" | "negative" | "neutral" = undercharged ? "neutral" : "negative";
                  return (
                    <ExpandableActivityRow
                      key={event.id}
                      primary={`Venice · ${event.model}`}
                      secondary={[
                        formatActivityLabel(event.walletType),
                        `${event.totalTokens?.toLocaleString() ?? 0} tokens`,
                        formatActivityDate(event.createdAt),
                      ].join(" · ")}
                      amount={`-${formatMicroUsdAmount(event.chargedMicroUsd)}`}
                      tone={settledTone}
                      details={
                        <>
                          <DetailRow label="Endpoint" value={event.endpoint} />
                          <DetailRow label="Wallet" value={formatActivityLabel(event.walletType)} />
                          <DetailRow label="Status" value={formatActivityLabel(event.status)} />
                          <DetailRow label="Prompt tokens" value={event.promptTokens?.toLocaleString() ?? "—"} />
                          <DetailRow label="Completion tokens" value={event.completionTokens?.toLocaleString() ?? "—"} />
                          <DetailRow label="Total tokens" value={event.totalTokens?.toLocaleString() ?? "—"} />
                          <DetailRow label="Actual Venice cost" value={formatExactMicroUsd(event.actualCostMicroUsd)} />
                          <DetailRow label="Charged to wallet" value={formatExactMicroUsd(event.chargedMicroUsd)} />
                          {event.discountMicroUsd > 0 && (
                            <DetailRow label="Subsidy applied" value={formatExactMicroUsd(event.discountMicroUsd)} />
                          )}
                          <DetailRow label="Settled at" value={formatFullTimestamp(event.createdAt)} mono={false} />
                          <DetailRow label="Reference" value={event.referenceId} />
                        </>
                      }
                    />
                  );
                })}
                {managedVeniceFinancialEvents.map((event) => (
                  <ExpandableActivityRow
                    key={event.id}
                    primary={formatActivityLabel(event.eventType)}
                    secondary={`${event.walletType ? formatActivityLabel(event.walletType) : "System"} · ${formatActivityDate(event.createdAt)}`}
                    amount={
                      event.discountMicroUsd > 0
                        ? `${formatMicroUsdAmount(event.discountMicroUsd)} subsidy`
                        : event.amountMicroUsd > 0
                          ? formatMicroUsdAmount(event.amountMicroUsd)
                          : undefined
                    }
                    tone={
                      event.eventType === "token_deposit" ||
                      event.eventType === "card_topup" ||
                      event.eventType === "reconciliation_refund"
                        ? "positive"
                        : "neutral"
                    }
                    details={
                      <>
                        <DetailRow label="Event" value={formatActivityLabel(event.eventType)} />
                        <DetailRow
                          label="Wallet"
                          value={event.walletType ? formatActivityLabel(event.walletType) : "System"}
                        />
                        {event.amountMicroUsd > 0 && (
                          <DetailRow label="Amount" value={formatExactMicroUsd(event.amountMicroUsd)} />
                        )}
                        {event.discountMicroUsd > 0 && (
                          <DetailRow label="Discount / subsidy" value={formatExactMicroUsd(event.discountMicroUsd)} />
                        )}
                        {event.veniceCostMicroUsd > 0 && (
                          <DetailRow label="Venice cost" value={formatExactMicroUsd(event.veniceCostMicroUsd)} />
                        )}
                        <DetailRow label="Recorded at" value={formatFullTimestamp(event.createdAt)} mono={false} />
                        <DetailRow label="Reference" value={event.referenceId} />
                      </>
                    }
                  />
                ))}
                {managedVeniceOverflowCount > 0 && (
                  <a
                    href="/dashboard/billing/activity"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      marginTop: 8,
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: "var(--gold-leaf)",
                      textDecoration: "none",
                      fontFamily: "var(--font-mono), monospace",
                    }}
                  >
                    View all activity ({managedVeniceOverflowCount} more)
                    <ArrowRight size={12} />
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}
