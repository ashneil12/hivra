import { CreditCard, Sparkles, WalletCards, X } from "lucide-react";

import { formatMicroUsd } from "@/components/billing/ManagedVeniceSubsidyBanner";
import type { ManagedVeniceWalletSummaryPayload } from "@/lib/billing/managed-venice-client";

function balanceOrZero(value: number | undefined) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function percentUsed(used: number, threshold: number) {
  if (!Number.isFinite(used) || !Number.isFinite(threshold) || threshold <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((used / threshold) * 100)));
}

export function ManagedVeniceCreditsPocket({
  summary,
  error = null,
  onTopUp,
  onManage,
  onHide,
}: {
  summary: ManagedVeniceWalletSummaryPayload | null;
  loading?: boolean;
  error?: string | null;
  onTopUp?: () => void;
  onManage?: () => void;
  /** When set, the header carries a "Hide credits" control. */
  onHide?: () => void;
}) {
  const hermesAvailable = balanceOrZero(summary?.wallets.hermesos.availableMicroUsd);
  const cardAvailable = balanceOrZero(summary?.wallets.card.availableMicroUsd);
  const totalAvailable = hermesAvailable + cardAvailable;
  const launchBonusUsed = balanceOrZero(summary?.discount?.launchSubsidyUsedMicroUsd);
  const launchBonusCap = balanceOrZero(summary?.discount?.launchSubsidyCapMicroUsd);
  const weeklyAllocationPercent = percentUsed(
    balanceOrZero(summary?.killSwitch?.weeklySubsidyUsedMicroUsd),
    balanceOrZero(summary?.killSwitch?.thresholdMicroUsd)
  );
  const emptyWallet = totalAvailable <= 0;
  const visibleError = error && !/not found/i.test(error) ? error : null;

  return (
    <section
      data-testid="managed-venice-credits-pocket"
      style={{
        border: "1px solid var(--etched-border)",
        background: "rgba(255,255,255,0.035)",
        padding: "clamp(1rem, 3vw, 1.4rem)",
        display: "grid",
        gap: 14,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
        <div>
          <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.16em", opacity: 0.64 }}>
            Credits
          </div>
          <strong style={{ display: "block", marginTop: 8, fontSize: 30, lineHeight: 1 }}>
            {formatMicroUsd(totalAvailable, 4)} available
          </strong>
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <WalletCards size={22} style={{ color: "var(--gold-leaf)" }} />
          {onHide ? (
            <button
              type="button"
              onClick={onHide}
              aria-label="Hide credits"
              title="Hide credits"
              style={{
                width: 44,
                height: 44,
                margin: "-10px -10px 0 0",
                border: "none",
                background: "transparent",
                color: "var(--text-muted)",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
              }}
            >
              <X size={14} />
            </button>
          ) : null}
        </span>
      </div>

      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)" }}>
        {visibleError
          ? "Credits could not refresh. Try again in a moment."
          : emptyWallet
            ? "Top up LLM credits before your next managed Venice request."
            : "No Venice markup. Top up with card at provider rates, or use $HermesOS to receive bonus LLM credits."}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        <div style={{ border: "1px solid rgba(255, 44, 45,0.36)", padding: "12px" }}>
          <div className="mono" style={{ fontSize: 10, opacity: 0.62, textTransform: "uppercase", marginBottom: 8 }}>LLM Credits</div>
          <strong style={{ display: "block", marginBottom: 8 }}>{formatMicroUsd(totalAvailable, 4)}</strong>
          <span style={{ color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5 }}>
            One dollar balance for managed Venice usage. Payment method only matters when topping up.
          </span>
        </div>
        <div style={{ border: "1px solid var(--etched-border)", padding: "12px", display: "grid", alignContent: "space-between", gap: 10 }}>
          <div>
            <div className="mono" style={{ fontSize: 10, opacity: 0.62, textTransform: "uppercase", marginBottom: 8 }}>General Credits</div>
            <strong>Coming soon</strong>
          </div>
          <span style={{ color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5 }}>
            Reserved for non-LLM platform usage later.
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {summary?.discount ? (
          <div
            style={{
              border: "1px solid rgba(255, 44, 45,0.4)",
              padding: "9px 10px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              minWidth: 0,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 800 }}>
              <Sparkles size={14} style={{ color: "var(--gold-leaf)" }} />
              Launch bonus
            </span>
            <span style={{ fontSize: 12, color: "var(--text-secondary)", textAlign: "right" }}>
              {formatMicroUsd(launchBonusUsed, 2)} of {formatMicroUsd(launchBonusCap, 2)} used
            </span>
          </div>
        ) : null}

        {summary?.killSwitch ? (
          <div
            style={{
              border: "1px solid var(--etched-border)",
              padding: "9px 10px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              minWidth: 0,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 800 }}>Launch allocation</span>
            <span style={{ fontSize: 12, color: "var(--text-secondary)", textAlign: "right" }}>
              {summary.killSwitch.active
                ? "Weekly launch allocation stepped down to standard rate"
                : `${weeklyAllocationPercent}% of weekly launch allocation used`}
            </span>
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          onClick={onTopUp}
          disabled={!onTopUp}
          className="max-md:flex-auto pointer-coarse:min-h-[44px]"
          style={{
            justifyContent: "center",
            border: "1px solid var(--ink-black)",
            background: "var(--ink-black)",
            color: "var(--bg-surface)",
            padding: "9px 12px",
            cursor: onTopUp ? "pointer" : "not-allowed",
            fontFamily: "var(--font-mono), monospace",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 800,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <CreditCard size={13} /> Top Up LLM Credits
        </button>
        <button
          type="button"
          onClick={onManage}
          disabled={!onManage}
          className="pointer-coarse:min-h-[44px]"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--etched-border)",
            background: "transparent",
            color: "var(--ink-black)",
            padding: "9px 12px",
            cursor: onManage ? "pointer" : "not-allowed",
            fontFamily: "var(--font-mono), monospace",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 800,
          }}
        >
          Manage
        </button>
      </div>
    </section>
  );
}
