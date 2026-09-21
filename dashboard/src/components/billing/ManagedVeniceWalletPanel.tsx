import { ManagedVeniceSubsidyBanner, formatMicroUsd, type ManagedVeniceDiscountRate } from "./ManagedVeniceSubsidyBanner";
import type { ManagedVeniceWalletType } from "@/lib/venice/managed-credit-topup";

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
    <div style={{ minWidth: 220, flex: "1 1 240px" }}>
      <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.65 }}>
        {props.title}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 6 }}>{props.primary}</div>
      <div style={{ fontSize: 13, marginTop: 4, opacity: 0.78 }}>{props.secondary}</div>
      <div className="mono" style={{ fontSize: 11, marginTop: 8, opacity: 0.62 }}>
        {props.reserveText}
      </div>
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
  return (
    <section
      style={{
        border: "1px solid var(--ink-black)",
        background: "var(--bg-surface)",
        padding: "clamp(1.25rem, 3vw, 2rem)",
        marginBottom: "2rem",
        boxShadow: "4px 4px 0px var(--ink-black)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 18 }}>
        <div>
          <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", opacity: 0.58 }}>
            Managed Venice inference
          </div>
          <h3 className="serif" style={{ fontSize: 28, margin: "4px 0 0" }}>
            Model credits
          </h3>
        </div>
        {onDeposit && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              onClick={() => onDeposit("card")}
              style={{
                border: "1px solid var(--etched-border)",
                background: "var(--btn-bg)",
                color: "var(--btn-text)",
                padding: "9px 12px",
                cursor: "pointer",
                fontFamily: "var(--font-mono), monospace",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                fontWeight: 800,
              }}
            >
              Top up by card
            </button>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 18 }}>
        <BalanceBlock
          title="Card credits"
          primary={`${formatMicroUsd(summary.wallets.card.availableMicroUsd, 4)} available`}
          secondary="Managed Venice credits"
          reserveText={`${formatMicroUsd(summary.wallets.card.reservedMicroUsd, 4)} reserved`}
        />
        {(summary.wallets.hermesos.lockedValueMicroUsd > 0 || summary.wallets.hermesos.reservedMicroUsd > 0 || summary.wallets.hermesos.lots.length > 0) && <>
        <BalanceBlock
          title="$HermesOS wallet"
          primary={summary.wallets.hermesos.tokenDisplay}
          secondary={`${formatMicroUsd(summary.wallets.hermesos.lockedValueMicroUsd, 4)} Venice credit`}
          reserveText={`${formatMicroUsd(summary.wallets.hermesos.availableMicroUsd, 4)} available · ${formatMicroUsd(summary.wallets.hermesos.reservedMicroUsd, 4)} reserved`}
        />
        </>}
      </div>

      {tokenPaymentsEnabled && <details style={{ marginTop: 20 }}><summary style={{ cursor: "pointer" }}>Optional token top-ups</summary>
      <ManagedVeniceSubsidyBanner
        rate={summary.discount.rate}
        discountBps={summary.discount.discountBps}
        launchSubsidyUsedMicroUsd={summary.discount.launchSubsidyUsedMicroUsd}
        launchSubsidyCapMicroUsd={summary.discount.launchSubsidyCapMicroUsd}
        killSwitchActive={summary.killSwitch.active}
      />            {onDeposit && <button
              type="button"
              onClick={() => onDeposit("hermesos")}
              style={{
                border: "1px solid var(--gold-leaf)",
                background: "rgba(255, 44, 45,0.12)",
                color: "var(--ink-black)",
                padding: "9px 12px",
                cursor: "pointer",
                fontFamily: "var(--font-mono), monospace",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                fontWeight: 800,
              }}
            >
              Top up with $HermesOS
            </button>}
      </details>}

    </section>
  );
}
