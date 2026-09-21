import { Sparkles } from "lucide-react";
import type { CSSProperties } from "react";

import {
  MANAGED_VENICE_MAX_SLIDER_TOP_UP_USD,
  MANAGED_VENICE_MIN_TOP_UP_USD,
  formatManagedVeniceUsd,
  getManagedVeniceTopUpQuote,
  normalizeManagedVeniceTopUpAmount,
  type ManagedVeniceWalletType,
} from "@/lib/venice/managed-credit-topup";

export function ManagedVeniceTopUpCalculator({
  id,
  amountUsd,
  walletType,
  onAmountChange,
}: {
  id: string;
  amountUsd: number;
  walletType: ManagedVeniceWalletType;
  onAmountChange: (amountUsd: number) => void;
}) {
  const normalizedAmount = normalizeManagedVeniceTopUpAmount(amountUsd);
  const quote = getManagedVeniceTopUpQuote(normalizedAmount, walletType);
  const sliderValue = Math.min(normalizedAmount, MANAGED_VENICE_MAX_SLIDER_TOP_UP_USD);
  const progress =
    ((sliderValue - MANAGED_VENICE_MIN_TOP_UP_USD) /
      (MANAGED_VENICE_MAX_SLIDER_TOP_UP_USD - MANAGED_VENICE_MIN_TOP_UP_USD)) *
    100;
  const hasBonus = quote.bonusUsd > 0;
  const isCard = walletType === "card";

  const metricStyle: CSSProperties = {
    border: "1px solid var(--etched-border)",
    background: "rgba(255,255,255,0.03)",
    padding: "12px 14px",
    minHeight: 78,
  };

  return (
    <div
      style={{
        padding: "1rem",
        border: `1px solid ${hasBonus ? "rgba(255, 44, 45,0.55)" : "var(--etched-border)"}`,
        background: "var(--bg-elevated)",
        boxShadow: hasBonus ? "inset 0 1px 0 rgba(255,255,255,0.05)" : "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", marginBottom: "0.9rem", flexWrap: "wrap" }}>
        <label
          className="mono"
          htmlFor={id}
          style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 800, opacity: 0.68 }}
        >
          Top-up amount
        </label>
        <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--etched-border)", background: "var(--bg-surface)" }}>
          <span className="mono" style={{ paddingLeft: 10, fontSize: 12, opacity: 0.55 }}>$</span>
          <input
            id={id}
            aria-label="Managed Venice top-up amount"
            type="number"
            min={MANAGED_VENICE_MIN_TOP_UP_USD}
            step="10"
            value={normalizedAmount}
            onChange={(event) => onAmountChange(normalizeManagedVeniceTopUpAmount(Number(event.target.value)))}
            style={{
              width: 108,
              border: "none",
              background: "transparent",
              padding: "8px 10px 8px 4px",
              fontFamily: "var(--font-mono), monospace",
              fontSize: 12,
              outline: "none",
            }}
          />
        </div>
      </div>

      <div style={{ position: "relative", padding: "10px 0 17px" }}>
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 18,
            height: 10,
            border: "1px solid rgba(255, 44, 45,0.45)",
            background: "rgba(0,0,0,0.18)",
            boxShadow: "inset 0 1px 4px rgba(0,0,0,0.22)",
          }}
        />
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            top: 18,
            height: 10,
            width: `${progress}%`,
            background: "linear-gradient(90deg, var(--gold-leaf), #f5d889)",
            boxShadow: hasBonus ? "0 0 20px rgba(255, 44, 45,0.38)" : "none",
          }}
        />
        <input
          className="managed-venice-slider"
          type="range"
          aria-label="Managed Venice top-up slider"
          min={MANAGED_VENICE_MIN_TOP_UP_USD}
          max={MANAGED_VENICE_MAX_SLIDER_TOP_UP_USD}
          step="10"
          value={sliderValue}
          onChange={(event) => onAmountChange(normalizeManagedVeniceTopUpAmount(Number(event.target.value)))}
          style={{
            position: "relative",
            width: "100%",
            margin: 0,
            accentColor: "var(--gold-leaf)",
            background: "transparent",
            cursor: "pointer",
            appearance: "none",
            height: 28,
          }}
        />
        <div className="mono" style={{ display: "flex", justifyContent: "space-between", marginTop: 7, fontSize: 9, opacity: 0.42 }}>
          <span>{formatManagedVeniceUsd(MANAGED_VENICE_MIN_TOP_UP_USD)}</span>
          <span>{formatManagedVeniceUsd(MANAGED_VENICE_MAX_SLIDER_TOP_UP_USD)}</span>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isCard
            ? "repeat(auto-fit, minmax(150px, 1fr))"
            : "repeat(auto-fit, minmax(118px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <div style={metricStyle}>
          <div className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.45, marginBottom: 5 }}>
            You pay
          </div>
          <strong style={{ fontSize: 16 }}>{formatManagedVeniceUsd(quote.paidUsd)}</strong>
        </div>
        {!isCard && (
          <div
            style={{
              ...metricStyle,
              border: hasBonus ? "1px solid var(--gold-leaf)" : metricStyle.border,
              background: hasBonus ? "rgba(255, 44, 45,0.17)" : metricStyle.background,
              boxShadow: hasBonus ? "0 0 0 4px rgba(255, 44, 45,0.1), 0 16px 30px rgba(0,0,0,0.18)" : "none",
              position: "relative",
              overflow: "hidden",
            }}
          >
            {hasBonus && (
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  top: 9,
                  right: 10,
                  border: "1px solid rgba(255, 44, 45,0.55)",
                  color: "var(--gold-leaf)",
                  padding: "3px 6px",
                  fontSize: 8,
                  fontWeight: 900,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                Extra
              </span>
            )}
            <div className="mono" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", color: hasBonus ? "var(--gold-leaf)" : "inherit", opacity: hasBonus ? 1 : 0.45, marginBottom: 5 }}>
              {hasBonus && <Sparkles size={11} />}
              Bonus
            </div>
            <strong style={{ display: "block", fontSize: hasBonus ? 28 : 16, lineHeight: 1, color: hasBonus ? "var(--gold-leaf)" : "inherit" }}>
              +{formatManagedVeniceUsd(quote.bonusUsd)}
            </strong>
            {hasBonus && (
              <div className="mono" style={{ marginTop: 7, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--gold-leaf)", opacity: 0.88 }}>
                bonus credits
              </div>
            )}
          </div>
        )}
        <div style={metricStyle}>
          <div className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.45, marginBottom: 5 }}>
            Credits added
          </div>
          <strong style={{ fontSize: 16 }}>{formatManagedVeniceUsd(quote.totalCreditsUsd)}</strong>
        </div>
      </div>
      <style>{`
        .managed-venice-slider::-webkit-slider-runnable-track {
          height: 28px;
          background: transparent;
        }

        .managed-venice-slider::-webkit-slider-thumb {
          appearance: none;
          width: 22px;
          height: 22px;
          margin-top: 3px;
          border: 2px solid var(--ink-black);
          background: var(--gold-leaf);
          box-shadow: 0 0 0 4px rgba(255, 44, 45,0.16), 0 6px 16px rgba(0,0,0,0.28);
        }

        .managed-venice-slider::-moz-range-track {
          height: 10px;
          background: transparent;
          border: none;
        }

        .managed-venice-slider::-moz-range-thumb {
          width: 22px;
          height: 22px;
          border: 2px solid var(--ink-black);
          border-radius: 0;
          background: var(--gold-leaf);
          box-shadow: 0 0 0 4px rgba(255, 44, 45,0.16), 0 6px 16px rgba(0,0,0,0.28);
        }
      `}</style>
    </div>
  );
}
