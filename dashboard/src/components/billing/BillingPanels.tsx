'use client';

import { motion, type Variants } from 'framer-motion';
import { displayTokenUnit } from '@/lib/billing/token-plan-prices';
import { CheckCircle, CreditCard, Loader2, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { CopyButton, DepositAddressField, OpenInWalletLink, TransferAmountField } from '@/components/billing/TransferDetails';
import { buildBaseErc20TransferUri } from '@/lib/billing/eip681';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { useLocale } from '@/components/i18n/LocaleProvider';
import {
  CREDIT_TOP_UP_PACKAGES,
  interpolateCopy,
  type CreditTopUpPackageCredits,
  type CryptoTopUpIntentData,
  type TokenHoldingData,
} from '@/lib/billing/format';
import styles from './BillingPanels.module.css';

/**
 * Billing panels rendered inside the billing page's tabs: account credits
 * (card top-ups), USDC-on-Base credit top-ups and the verified $HermesOS
 * wallet.
 *
 * The old cadence / payment-path / crypto-mode toggles lived here too; they
 * put role="tab" on plain choices and are replaced by the page's radiogroup
 * ChoiceGroup. The plan meters moved into the page's rating plate.
 */

export function CreditsPanel({
  balance,
  topUpsEnabled,
  toppingUp,
  variants,
  onTopUp,
}: {
  balance: number;
  topUpsEnabled: boolean;
  toppingUp: CreditTopUpPackageCredits | null;
  variants?: Variants;
  onTopUp: (packageCredits: CreditTopUpPackageCredits) => void;
}) {
  const { copy } = useLocale();
  const creditsCopy = copy.dashboard.billing.credits;

  return (
    <motion.section variants={variants} className={styles.panel} aria-labelledby="billing-credits-title">
      <p className={styles.eyebrow} id="billing-credits-title">{creditsCopy.title}</p>
      <p className={styles.amount}>
        <strong>{balance.toLocaleString()}</strong>
        <span>{creditsCopy.available}</span>
      </p>
      <p className={styles.lede}>{creditsCopy.description}</p>

      {topUpsEnabled && (
        <div className={styles.packages}>
          {CREDIT_TOP_UP_PACKAGES.map((pkg) => (
            <button
              key={pkg.credits}
              type="button"
              className={styles.package}
              onClick={() => onTopUp(pkg.credits)}
              disabled={toppingUp !== null}
              data-dimmed={toppingUp !== null && toppingUp !== pkg.credits ? "true" : "false"}
            >
              <span className={styles.packageLead}>
                {toppingUp === pkg.credits ? (
                  <Loader2 size={14} className={styles.spin} aria-hidden="true" />
                ) : (
                  <CreditCard size={14} aria-hidden="true" />
                )}
                ${pkg.usd}
              </span>
              <span className={styles.packageMeta}>{pkg.credits.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
    </motion.section>
  );
}

export function CryptoTopUpPanel({
  intent,
  error,
  toppingUp,
  variants,
  onTopUp,
}: {
  intent: CryptoTopUpIntentData | null;
  error: string | null;
  toppingUp: CreditTopUpPackageCredits | null;
  variants?: Variants;
  onTopUp: (packageCredits: CreditTopUpPackageCredits) => void;
}) {
  const { copy } = useLocale();
  const cryptoCopy = copy.dashboard.billing.cryptoCredits;

  return (
    <motion.section variants={variants} className={styles.panel} aria-labelledby="billing-usdc-title">
      <p className={styles.eyebrow}>{cryptoCopy.eyebrow}</p>
      <h3 className={styles.title} id="billing-usdc-title">USDC on Base</h3>
      <p className={styles.lede}>{cryptoCopy.description}</p>

      <div className={styles.packages}>
        {CREDIT_TOP_UP_PACKAGES.map((pkg) => (
          <button
            key={pkg.credits}
            type="button"
            className={styles.package}
            aria-label={interpolateCopy(cryptoCopy.createTopUpLabel, { credits: pkg.credits.toString() })}
            onClick={() => onTopUp(pkg.credits)}
            disabled={toppingUp !== null}
            data-dimmed={toppingUp !== null && toppingUp !== pkg.credits ? "true" : "false"}
          >
            <span className={styles.packageLead}>
              {toppingUp === pkg.credits ? (
                <Loader2 size={14} className={styles.spin} aria-hidden="true" />
              ) : (
                <Wallet size={14} aria-hidden="true" />
              )}
              {pkg.usd} USDC
            </span>
            <span className={styles.packageMeta}>{pkg.credits.toLocaleString()}</span>
          </button>
        ))}
      </div>

      {intent && (
        <div className={styles.intent}>
          <div className={styles.intentHead}>
            <CheckCircle size={14} aria-hidden="true" />
            {cryptoCopy.pendingDeposit}
          </div>
          {/* Same pattern as every other crypto payment: the exact amount and
              the address as text with copy buttons (44px on phones); the QR
              code beside the address on desktop, and behind "Show QR code" on
              phones, where it can't be scanned. amountDisplay is plain digits,
              safe to paste into a wallet. */}
          <div className={styles.intentFields}>
            <TransferAmountField
              label={cryptoCopy.sendPrefix}
              amount={intent.amountDisplay}
              unit={`${intent.asset.symbol} ${cryptoCopy.onNetwork} ${intent.asset.network}`}
              copyValue={intent.amountDisplay}
            >
              Send this exact amount in one transfer on the {intent.asset.network} network.
            </TransferAmountField>
            <DepositAddressField
              label="Deposit address"
              address={intent.depositAddress}
              qrLabel="Credit deposit address QR code"
              qrSize={116}
            />
          </div>
          <OpenInWalletLink
            href={buildBaseErc20TransferUri({
              tokenAddress: intent.asset.tokenAddress,
              chainId: intent.asset.chainId,
              recipient: intent.depositAddress,
              amountRaw: intent.amountRaw,
            })}
          />
          <div className={styles.reference}>
            {cryptoCopy.reference} {intent.referenceId}
          </div>
        </div>
      )}

      {error && (
        <div className={styles.errorSlot}>
          <ErrorBanner
            error={error}
            context={{
              source: "client.diagnostic",
              route: "/api/billing/crypto/top-up",
              metadata: { surface: "BillingCryptoTopUpPanel" },
            }}
          />
        </div>
      )}
    </motion.section>
  );
}

/**
 * The verified $HermesOS wallet: its full address (with a copy button), its
 * last checked balance, and the actions to verify or refresh it.
 *
 * Wallet state only. The 1-token base-tier minimum and "qualified" verdict
 * the token-holding API also returns are NOT plan requirements (Pro and
 * Power hold amounts are resolved on the server and shown on the wallet
 * page), so this panel never shows them next to plan-holding copy.
 */
export function TokenHoldingPanel({
  tokenHolding,
  loading,
  refreshing,
  connectingWallet,
  error,
  variants,
  embedded = false,
  onRefresh,
  onConnectWallet,
}: {
  tokenHolding: TokenHoldingData | null;
  loading: boolean;
  refreshing: boolean;
  connectingWallet: boolean;
  error: string | null;
  variants?: Variants;
  /** Render without its own frame and title, inside another section. */
  embedded?: boolean;
  onRefresh: () => void;
  onConnectWallet: () => void;
}) {
  const { copy } = useLocale();
  const tokenCopy = copy.dashboard.billing.tokenAccess;
  const token = tokenHolding?.token ?? null;
  const wallet = tokenHolding?.wallet ?? null;
  const snapshot = tokenHolding?.snapshot ?? null;
  const busy = loading || refreshing || connectingWallet;
  const statusLabel = loading
    ? tokenCopy.checking
    : error
      ? tokenCopy.unavailable
      : wallet
        ? "Wallet verified"
        : tokenCopy.noWallet;
  const statusClass = !loading && !error && wallet ? styles.statusGood : error ? styles.statusBad : "";

  return (
    <motion.div variants={variants} className={embedded ? styles.embedded : styles.panel}>
      {!embedded && <h3 className={styles.title}>{tokenCopy.title}</h3>}

      <div className={styles.walletSummary}>
        <div className={styles.walletSummaryHead}>
          <span className={styles.walletLabel}>{tokenCopy.wallet}</span>
          <span className={[styles.statusLine, statusClass].filter(Boolean).join(" ")}>
            {loading ? (
              <Loader2 size={13} className={styles.spin} aria-hidden="true" />
            ) : wallet && !error ? (
              <ShieldCheck size={13} aria-hidden="true" />
            ) : (
              <Wallet size={13} aria-hidden="true" />
            )}
            {statusLabel}
          </span>
        </div>

        {wallet ? (
          <>
            <code className={`mono notranslate ${styles.walletAddress}`} translate="no">
              {wallet.address}
            </code>
            <div className={styles.walletCopy}>
              <CopyButton value={wallet.address} label="Copy address" />
            </div>
            <dl className={styles.walletFacts}>
              <div className={styles.walletFact}>
                <dt>{tokenCopy.balance}</dt>
                <dd>{snapshot ? `${snapshot.balanceDisplay} ${displayTokenUnit(token?.tokenSymbol)}` : tokenCopy.noSnapshot}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className={styles.walletEmpty}>{tokenCopy.notVerified}</p>
        )}
      </div>

      {error && (
        <div className={styles.errorSlot}>
          <ErrorBanner
            error={error}
            context={{
              source: "client.diagnostic",
              route: "/api/billing/wallet/verify",
              metadata: { surface: "BillingWalletConnectSection" },
            }}
          />
        </div>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          onClick={() => onConnectWallet()}
          disabled={busy}
        >
          {connectingWallet ? (
            <Loader2 size={14} className={styles.spin} aria-hidden="true" />
          ) : (
            <Wallet size={14} aria-hidden="true" />
          )}
          {connectingWallet ? tokenCopy.connecting : wallet ? tokenCopy.verifyDifferent : tokenCopy.connectWallet}
        </button>
        <button type="button" className={styles.button} onClick={() => onRefresh()} disabled={busy}>
          {refreshing ? (
            <Loader2 size={14} className={styles.spin} aria-hidden="true" />
          ) : (
            <RefreshCw size={14} aria-hidden="true" />
          )}
          {refreshing ? tokenCopy.refreshing : tokenCopy.refresh}
        </button>
      </div>
    </motion.div>
  );
}
