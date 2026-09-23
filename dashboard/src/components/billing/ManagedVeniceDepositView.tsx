'use client';

// Shared presentation for the two managed Venice top-up dialogs: the
// self-contained one in the welcome flow (ManagedVeniceDepositModal.tsx) and
// the billing page's controlled one (YearlyTokenPanels.tsx). Each keeps its
// own state, requests and wallet rules; this only draws them the same way.

import type { ReactNode } from 'react';
import { ArrowRight, CreditCard, Loader2, Wallet } from 'lucide-react';

import { BillingDialog, billingDialogStyles as dialog } from '@/components/billing/BillingDialog';
import { ManagedVeniceTokenQuotePanel } from '@/components/billing/ManagedVeniceTokenQuotePanel';
import { ManagedVeniceTopUpCalculator } from '@/components/billing/ManagedVeniceTopUpCalculator';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import type { ManagedVeniceTokenQuotePayload } from '@/lib/billing/managed-venice-client';
import {
  formatManagedVeniceUsd,
  getManagedVeniceTopUpQuote,
  type ManagedVeniceWalletType,
} from '@/lib/venice/managed-credit-topup';
import styles from './ManagedVeniceDepositView.module.css';

const WALLET_OPTIONS: Record<ManagedVeniceWalletType, { label: string; description: string; icon: ReactNode }> = {
  hermesos: {
    label: 'Pay with $HermesOS',
    description: 'Up to 20% more credits during the launch wave, then the 10% standard bonus.',
    icon: <Wallet size={15} aria-hidden="true" />,
  },
  card: {
    label: 'Pay by card',
    description: 'Stripe checkout. No Venice markup; card credits stay at straight provider-rate value.',
    icon: <CreditCard size={15} aria-hidden="true" />,
  },
};

export function ManagedVeniceDepositView({
  title,
  description,
  walletOptions,
  walletType,
  onWalletTypeChange,
  calculatorId,
  amountUsd,
  onAmountChange,
  error,
  notice,
  quote,
  onQuoteUpdate,
  onQuoteSettled,
  quoteInFlight,
  quoteSettled,
  loading,
  onStart,
  refreshingWallet,
  walletRefreshStatus,
  onRefreshWallet,
  onClose,
}: {
  title: string;
  description: string;
  /** Payment options to offer, in order. */
  walletOptions: ManagedVeniceWalletType[];
  walletType: ManagedVeniceWalletType;
  onWalletTypeChange: (walletType: ManagedVeniceWalletType) => void;
  calculatorId: string;
  amountUsd: number;
  onAmountChange: (amountUsd: number) => void;
  error: string | null;
  notice?: string | null;
  quote: ManagedVeniceTokenQuotePayload | null;
  onQuoteUpdate: (quote: ManagedVeniceTokenQuotePayload) => void;
  onQuoteSettled: () => void;
  /** A $HermesOS quote is open: the Start button gives way to "verify above". */
  quoteInFlight: boolean;
  quoteSettled: boolean;
  loading: boolean;
  onStart: () => void;
  refreshingWallet: boolean;
  walletRefreshStatus: 'idle' | 'refreshed' | 'failed';
  onRefreshWallet: () => void;
  onClose: () => void;
}) {
  const topUpQuote = getManagedVeniceTopUpQuote(amountUsd, walletType);
  const hermes = walletType === 'hermesos';

  return (
    <BillingDialog
      ariaLabel="Top up managed Venice credits"
      eyebrow="Managed Venice LLM credits"
      title={title}
      description={description}
      size="lg"
      onClose={onClose}
      footerSpread
      footer={
        <>
          <div className={styles.refreshGroup}>
            <button
              type="button"
              onClick={onRefreshWallet}
              disabled={refreshingWallet}
              aria-busy={refreshingWallet}
              className={`${dialog.button} ${dialog.secondary}`}
            >
              {refreshingWallet && <Loader2 size={13} className={dialog.spin} aria-hidden="true" />}
              {refreshingWallet ? 'Refreshing...' : 'Refresh wallet'}
            </button>
            {!refreshingWallet && walletRefreshStatus !== 'idle' && (
              <span
                role="status"
                className={`mono ${dialog.statusText}`}
                data-tone={walletRefreshStatus === 'refreshed' ? 'success' : 'danger'}
              >
                {walletRefreshStatus === 'refreshed' ? 'Wallet refreshed' : 'Refresh failed. Try again.'}
              </span>
            )}
          </div>
          {hermes && (quoteInFlight || quoteSettled) ? (
            <span className={styles.badge} data-tone={quoteSettled ? 'success' : undefined}>
              {quoteSettled ? 'Credits confirmed' : 'Use verify payment above'}
            </span>
          ) : (
            <button
              type="button"
              onClick={onStart}
              disabled={loading}
              aria-busy={loading || undefined}
              className={`${dialog.button} ${dialog.primary}`}
            >
              {loading ? (
                <Loader2 size={14} className={dialog.spin} aria-hidden="true" />
              ) : hermes ? (
                <Wallet size={14} aria-hidden="true" />
              ) : (
                <CreditCard size={14} aria-hidden="true" />
              )}
              {loading ? 'Starting...' : hermes ? 'Start $HermesOS top-up' : 'Start card checkout'}
              {!loading && !hermes && <ArrowRight size={14} aria-hidden="true" />}
            </button>
          )}
        </>
      }
    >
      <div className={styles.choices} role="group" aria-label="Payment method">
        {walletOptions.map((value) => {
          const option = WALLET_OPTIONS[value];
          return (
            <button
              key={value}
              type="button"
              className={styles.choice}
              aria-pressed={walletType === value}
              onClick={() => onWalletTypeChange(value)}
            >
              <span className={styles.choiceHead}>
                {option.icon}
                {option.label}
              </span>
              <span className={styles.choiceBody}>{option.description}</span>
            </button>
          );
        })}
      </div>

      <ManagedVeniceTopUpCalculator
        id={calculatorId}
        amountUsd={amountUsd}
        walletType={walletType}
        onAmountChange={onAmountChange}
      />

      <div className={dialog.callout}>
        <p style={{ margin: 0 }}>
          {hermes ? (
            <>
              <strong>$250 lifetime launch bonus cap.</strong>{' '}
              That is about $1,250 of $HermesOS top-ups at the full 20% launch bonus. After that, $HermesOS top-ups continue at the 10% standard bonus.
            </>
          ) : (
            <>
              <strong>Card terms: zero markup.</strong>{' '}
              {formatManagedVeniceUsd(topUpQuote.paidUsd)} adds {formatManagedVeniceUsd(topUpQuote.totalCreditsUsd)} of managed Venice credits.
            </>
          )}
        </p>
      </div>

      {error && (
        <ErrorBanner
          error={error}
          context={{
            source: 'client.diagnostic',
            route: hermes ? '/api/billing/managed-venice/hermesos/quote' : '/api/billing/managed-venice/card/top-up',
            metadata: { surface: 'ManagedVeniceDepositModal' },
          }}
        />
      )}

      {notice && (
        <div role="status" className={dialog.callout} data-tone="warning">
          <p style={{ margin: 0 }}>{notice}</p>
        </div>
      )}

      {quote && hermes && (
        <ManagedVeniceTokenQuotePanel quote={quote} onQuoteUpdate={onQuoteUpdate} onSettled={onQuoteSettled} />
      )}
    </BillingDialog>
  );
}
