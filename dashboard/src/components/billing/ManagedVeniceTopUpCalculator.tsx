import { Sparkles } from "lucide-react";

import {
  MANAGED_VENICE_MAX_SLIDER_TOP_UP_USD,
  MANAGED_VENICE_MIN_TOP_UP_USD,
  formatManagedVeniceUsd,
  getManagedVeniceTopUpQuote,
  normalizeManagedVeniceTopUpAmount,
  type ManagedVeniceWalletType,
} from "@/lib/venice/managed-credit-topup";
import styles from "./ManagedVeniceTopUpCalculator.module.css";

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

  return (
    <div className={styles.calculator} data-bonus={hasBonus ? "true" : undefined}>
      <div className={styles.head}>
        <label className={styles.label} htmlFor={id}>
          Top-up amount
        </label>
        <div className={styles.amountInput}>
          <span className={styles.currency} aria-hidden="true">$</span>
          <input
            id={id}
            aria-label="Managed Venice top-up amount"
            type="number"
            inputMode="decimal"
            enterKeyHint="done"
            min={MANAGED_VENICE_MIN_TOP_UP_USD}
            step="10"
            value={normalizedAmount}
            onChange={(event) => onAmountChange(normalizeManagedVeniceTopUpAmount(Number(event.target.value)))}
          />
        </div>
      </div>

      <div className={styles.sliderWrap}>
        <div aria-hidden className={styles.track} />
        <div aria-hidden className={styles.fill} style={{ width: `${progress}%` }} />
        <input
          className={styles.slider}
          type="range"
          aria-label="Managed Venice top-up slider"
          min={MANAGED_VENICE_MIN_TOP_UP_USD}
          max={MANAGED_VENICE_MAX_SLIDER_TOP_UP_USD}
          step="10"
          value={sliderValue}
          onChange={(event) => onAmountChange(normalizeManagedVeniceTopUpAmount(Number(event.target.value)))}
        />
        <div className={styles.scale} aria-hidden="true">
          <span>{formatManagedVeniceUsd(MANAGED_VENICE_MIN_TOP_UP_USD)}</span>
          <span>{formatManagedVeniceUsd(MANAGED_VENICE_MAX_SLIDER_TOP_UP_USD)}</span>
        </div>
      </div>

      <div className={styles.metrics} data-wallet={isCard ? "card" : "hermesos"}>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>You pay</span>
          <strong className={styles.metricValue}>{formatManagedVeniceUsd(quote.paidUsd)}</strong>
        </div>
        {!isCard && (
          <div className={styles.metric} data-bonus={hasBonus ? "true" : undefined}>
            {hasBonus && (
              <span aria-hidden className={styles.extra}>
                Extra
              </span>
            )}
            <span className={styles.metricLabel}>
              {hasBonus && <Sparkles size={12} aria-hidden="true" />}
              Bonus
            </span>
            <strong className={styles.metricValue}>+{formatManagedVeniceUsd(quote.bonusUsd)}</strong>
            {hasBonus && <span className={styles.metricNote}>bonus credits</span>}
          </div>
        )}
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Credits added</span>
          <strong className={styles.metricValue}>{formatManagedVeniceUsd(quote.totalCreditsUsd)}</strong>
        </div>
      </div>
    </div>
  );
}
