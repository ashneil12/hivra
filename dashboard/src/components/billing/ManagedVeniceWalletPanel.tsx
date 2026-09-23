import { ManagedVeniceSubsidyBanner, formatMicroUsd, type ManagedVeniceDiscountRate } from "./ManagedVeniceSubsidyBanner";
import type { ManagedVeniceWalletType } from "@/lib/venice/managed-credit-topup";
import styles from "./BillingPanels.module.css";

export interface ManagedVeniceWalletSummary {
  wallets: {
    hermesos: {
      tokenDisplay: string;
      lockedValueMicroUsd: number;
      availableMicroUsd: number;
      reservedMicroUsd: number;
      lots: unknown[];
    };
    card: {
      balanceMicroUsd: number;
      availableMicroUsd: number;
      reservedMicroUsd: number;
    };
  };
  discount: {
    rate: ManagedVeniceDiscountRate;
    discountBps: number;
    launchSubsidyUsedMicroUsd: number;
    launchSubsidyCapMicroUsd: number;
  };
  killSwitch: {
    active: boolean;
    weeklySubsidyUsedMicroUsd: number;
    thresholdMicroUsd: number;
  };
}

function BalanceBlock(props: {
  title: string;
  primary: string;
  secondary: string;
  reserveText: string;
}) {
  return (
    <div className={styles.balance}>
      <div className={styles.balanceTitle}>{props.title}</div>
      <div className={styles.balancePrimary}>{props.primary}</div>
      <div className={styles.balanceSecondary}>{props.secondary}</div>
      <div className={styles.balanceReserve}>{props.reserveText}</div>
    </div>
  );
}

export function ManagedVeniceWalletPanel({
  summary,
  onDeposit,
  tokenPaymentsEnabled = false,
}: {
  summary: ManagedVeniceWalletSummary;
  tokenPaymentsEnabled?: boolean;
  onDeposit?: (walletType: ManagedVeniceWalletType) => void;
}) {
  const hermesos = summary.wallets.hermesos;
  const showHermesWallet =
    hermesos.lockedValueMicroUsd > 0 || hermesos.reservedMicroUsd > 0 || hermesos.lots.length > 0;

  return (
    <section className={styles.panel} aria-labelledby="managed-venice-wallet-title">
      <div className={styles.head}>
        <div>
          <p className={styles.eyebrow}>Managed Venice inference</p>
          <h3 className={styles.title} id="managed-venice-wallet-title">Model credits</h3>
          <p className={styles.lede}>
            Prepaid balance for models you run through Hivra&apos;s managed Venice access.
          </p>
        </div>
        {onDeposit && (
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            onClick={() => onDeposit("card")}
          >
            Top up by card
          </button>
        )}
      </div>

      <div className={styles.balances}>
        <BalanceBlock
          title="Card credits"
          primary={`${formatMicroUsd(summary.wallets.card.availableMicroUsd, 4)} available`}
          secondary="Managed Venice credits"
          reserveText={`${formatMicroUsd(summary.wallets.card.reservedMicroUsd, 4)} reserved`}
        />
        {showHermesWallet && (
          <BalanceBlock
            title="$HermesOS wallet"
            primary={hermesos.tokenDisplay}
            secondary={`${formatMicroUsd(hermesos.lockedValueMicroUsd, 4)} Venice credit`}
            reserveText={`${formatMicroUsd(hermesos.availableMicroUsd, 4)} available · ${formatMicroUsd(hermesos.reservedMicroUsd, 4)} reserved`}
          />
        )}
      </div>

      {tokenPaymentsEnabled && (
        <details className={styles.disclosure}>
          <summary>Optional token top-ups</summary>
          <div className={styles.disclosureBody}>
            <ManagedVeniceSubsidyBanner
              rate={summary.discount.rate}
              discountBps={summary.discount.discountBps}
              launchSubsidyUsedMicroUsd={summary.discount.launchSubsidyUsedMicroUsd}
              launchSubsidyCapMicroUsd={summary.discount.launchSubsidyCapMicroUsd}
              killSwitchActive={summary.killSwitch.active}
            />
            {onDeposit && (
              <button
                type="button"
                className={styles.button}
                onClick={() => onDeposit("hermesos")}
              >
                Top up with $HermesOS
              </button>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
