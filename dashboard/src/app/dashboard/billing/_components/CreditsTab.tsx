'use client';

import type { Variants } from "framer-motion";
import { CreditsPanel, CryptoTopUpPanel } from "@/components/billing/BillingPanels";
import { ManagedVeniceByokSwitchPanel } from "@/components/billing/ManagedVeniceByokSwitchPanel";
import { ManagedVeniceKeysPanel } from "@/components/billing/ManagedVeniceKeysPanel";
import { ManagedVeniceWalletPanel } from "@/components/billing/ManagedVeniceWalletPanel";
import type { BillingController } from "../useBillingController";
import styles from "../Billing.module.css";

/** DOM id deep links use to land on model credits (e.g. HermesDashboardPage). */
export const MANAGED_VENICE_ANCHOR_ID = "managed-venice";

export function CreditsTab({ c, variants }: { c: BillingController; variants: Variants }) {
  const { billingV2Enabled, cryptoBillingEnabled, creditTopUpsEnabled } = c.flags;
  const summary = c.managedVeniceSummary;

  return (
    <div className={styles.stack}>
      {billingV2Enabled && (
        <CreditsPanel
          balance={c.creditBalance}
          topUpsEnabled={creditTopUpsEnabled}
          toppingUp={c.toppingUp}
          variants={variants}
          onTopUp={c.handleCreditTopUp}
        />
      )}

      {billingV2Enabled && (
        <section
          id={MANAGED_VENICE_ANCHOR_ID}
          className={styles.stack}
          aria-label="Model credits"
          style={{ scrollMarginTop: 96 }}
        >
          {summary && (
            <>
              <ManagedVeniceWalletPanel
                summary={summary}
                tokenPaymentsEnabled={billingV2Enabled}
                onDeposit={(walletType) => c.openManagedVeniceDeposit(walletType)}
              />
              <ManagedVeniceKeysPanel keys={summary.keys} />
              <ManagedVeniceByokSwitchPanel />
            </>
          )}
        </section>
      )}

      {cryptoBillingEnabled && (
        <CryptoTopUpPanel
          intent={c.cryptoTopUpIntent}
          error={c.cryptoTopUpError}
          toppingUp={c.cryptoToppingUp}
          variants={variants}
          onTopUp={c.handleCryptoTopUp}
        />
      )}
    </div>
  );
}
