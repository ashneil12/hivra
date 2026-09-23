'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, ShieldCheck, Zap } from 'lucide-react';
import {
  CopyButton,
  DepositAddressField,
  OpenInWalletLink,
  touchStyles,
  wholeTokenQuoteRawAmount,
} from '@/components/billing/TransferDetails';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { BankrTrustFooter } from '@/components/wallet/AgentWalletCards';
import { hermesosTransferUri } from '@/lib/billing/eip681';
import { displayTokenUnit } from '@/lib/billing/token-plan-prices';
import { HERMESOS_TOKEN } from '@/lib/billing/token-registry';
import {
  LAUNCH_PROMO_END,
  STANDARD_USD_CENTS,
  formatCountdown,
  formatDaysRemaining,
  formatTokensWithCommas,
  formatUsdFromCents,
  interpolateCopy,
  shorten,
  tierLabel,
  tierName,
  type DepositQuotePayload,
} from '@/lib/wallet/format';

/**
 * The wallet dashboard's buy-token card, self-custody verification panel and
 * the deposit-quote card/panel, plus their shared copy-address helpers.
 * Extracted verbatim from wallet/page.tsx.
 */
// The official $HermesOS contract address, from the platform token registry
// that balance reads, price feeds and deposit destinations use too. If this
// matches what's on hivra.cloud/token, you're looking at the real token.
export const HERMESOS_TOKEN_ADDRESS = HERMESOS_TOKEN.publishedAddress;
/**
 * Returns a wall-clock timestamp that ticks every `intervalMs` so
 * countdown copy refreshes without making render impure (React's
 * no-impure-render lint rejects raw Date.now() in JSX).
 */
export function useNowMs(intervalMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(handle);
  }, [intervalMs]);
  return nowMs;
}
/**
 * The deposit address with its copy button under it and its QR code beside it
 * (desktop) or behind a "Show QR code" disclosure after it (phones and touch).
 */
export function InlineCopyAddress({ label, address }: { label: string; address: string | null }) {
  return (
    <DepositAddressField
      label={label}
      address={address}
      qrLabel={`${label} QR code`}
      copyLabel="Copy address"
      copyAriaLabel={`Copy ${label}`}
    />
  );
}
/**
 * Anti-scam helper for users who don't already hold $HermesOS. One
 * obvious card: an outbound link to the official Uniswap pool on Base
 * with the contract pre-filled, plus a copyable contract address so the
 * user can paste it into any wallet without trusting screenshots or DMs.
 *
 * The contract address is the SAME constant used everywhere else on the
 * platform — balance reads, price quotes, deposit destinations — so if
 * what you see here matches hivra.cloud/token, you're safe.
 */
export function BuyTokenCard() {
  const { copy } = useLocale();
  const buyCopy = copy.dashboard.wallet.buyToken;
  const contract = HERMESOS_TOKEN_ADDRESS;
  const uniswapUrl = `https://app.uniswap.org/swap?chain=base&outputCurrency=${contract}`;

  return (
    <section
      aria-label={buyCopy.ariaLabel}
      style={{
        border: '1px solid var(--etched-border)',
        background: 'var(--bg-surface)',
        padding: 'clamp(1.25rem, 4vw, 1.75rem)',
        marginBottom: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.18em', opacity: 0.55, fontWeight: 700 }}>
            {buyCopy.eyebrow}
          </span>
          <h2 className="serif" style={{ fontSize: '1.15rem', fontWeight: 700, marginTop: 4, marginBottom: 0 }}>
            {buyCopy.title}
          </h2>
        </div>
        <a
          href={uniswapUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={touchStyles.touchTarget}
          style={{
            padding: '8px 14px',
            border: '1px solid var(--ink-black)',
            background: 'var(--ink-black)',
            color: 'var(--bg-surface)',
            textDecoration: 'none',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: 10,
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {buyCopy.action}
        </a>
      </div>

      <div
        style={{
          border: '1px solid var(--etched-border)',
          padding: '0.65rem 0.85rem',
          background: 'var(--bg-elevated, transparent)',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.16em', opacity: 0.55, fontWeight: 700 }}>
          {buyCopy.contractLabel}
        </span>
        <code
          className="mono notranslate"
          translate="no"
          style={{
            fontSize: 12.5,
            wordBreak: 'break-all',
            minWidth: 0,
            color: 'var(--ink-black)',
          }}
          title={contract}
        >
          {contract}
        </code>
        <div className={touchStyles.copyRow} style={{ marginTop: 6 }}>
          <CopyButton
            value={contract}
            label={buyCopy.copy}
            copiedLabel={buyCopy.copied}
            ariaLabel={buyCopy.copyContractLabel}
          />
        </div>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted, var(--text-secondary))', margin: 0, lineHeight: 1.55 }}>
        {buyCopy.warningPrefix}{' '}
        <Link href="/token" style={{ color: 'inherit', textDecoration: 'underline' }}>
          {buyCopy.warningLink}
        </Link>{' '}
        {buyCopy.warningSuffix}
      </p>
    </section>
  );
}
export function SelfCustodyVerificationPanel({
  connecting,
  locking,
  connectedAddress,
  balanceDisplay,
  checkedAt,
  eligibleTier,
  lockTier,
  lockQuote,
  lockedAmountDisplay,
  tokenSymbol,
  veniceBoostEligible,
  error,
  success,
  onConnect,
  onLockPrice,
}: {
  connecting: boolean;
  locking: boolean;
  connectedAddress: string | null;
  balanceDisplay: string | null;
  checkedAt: string | null;
  eligibleTier: 'pro' | 'power' | null;
  lockTier: 'pro' | 'power' | null;
  lockQuote: DepositQuotePayload | null;
  lockedAmountDisplay: string | null;
  tokenSymbol: string;
  veniceBoostEligible: boolean;
  error: string | null;
  success: string | null;
  onConnect: () => void;
  onLockPrice: () => void;
}) {
  const { copy } = useLocale();
  const verificationCopy = copy.dashboard.wallet.verification;
  const connected = Boolean(connectedAddress);
  const eligibleTierName = tierName(eligibleTier);
  const lockTierName = tierName(lockTier);
  const quoteAmountDisplay = lockQuote ? formatTokensWithCommas(lockQuote.tokensRequiredDisplay) : null;
  const lockButtonLabel = lockTierName
    ? lockQuote
      ? interpolateCopy(verificationCopy.checkLock, { tier: lockTierName })
      : interpolateCopy(verificationCopy.lockPrice, { tier: lockTierName })
    : verificationCopy.refreshBalance;

  return (
    <section
      aria-label={verificationCopy.ariaLabel}
      style={{
        border: '1px solid var(--etched-border)',
        background: 'var(--bg-surface)',
        padding: 'clamp(1.25rem, 4vw, 1.75rem)',
        marginBottom: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.18em', opacity: 0.55, fontWeight: 700 }}>
            {verificationCopy.eyebrow}
          </span>
          <h2 className="serif" style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: 4, marginBottom: 0 }}>
            {connected ? verificationCopy.connectedTitle : verificationCopy.disconnectedTitle}
          </h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {connected ? (
            <>
              <button
                type="button"
                onClick={onLockPrice}
                disabled={locking}
                className={touchStyles.touchTarget}
                style={{
                  padding: '9px 14px',
                  border: '1px solid var(--ink-black)',
                  background: 'var(--ink-black)',
                  color: 'var(--bg-surface)',
                  cursor: locking ? 'wait' : 'pointer',
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: 10,
                  fontWeight: 800,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  opacity: locking ? 0.7 : 1,
                }}
              >
                {locking ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Zap size={12} />}
                {locking ? verificationCopy.checking : lockButtonLabel}
              </button>
              <button
                type="button"
                onClick={onConnect}
                disabled={connecting || locking}
                className={touchStyles.touchTarget}
                style={{
                  padding: '9px 12px',
                  border: '1px solid var(--etched-border)',
                  background: 'transparent',
                  color: 'var(--ink-black)',
                  cursor: connecting || locking ? 'wait' : 'pointer',
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: 10,
                  fontWeight: 800,
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  opacity: connecting || locking ? 0.7 : 1,
                }}
              >
                {connecting ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <ShieldCheck size={12} />}
                {connecting ? verificationCopy.connecting : verificationCopy.changeWallet}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onConnect}
              disabled={connecting}
              className={touchStyles.touchTarget}
              style={{
                padding: '9px 14px',
                border: '1px solid var(--ink-black)',
                background: 'var(--ink-black)',
                color: 'var(--bg-surface)',
                cursor: connecting ? 'wait' : 'pointer',
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 10,
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                opacity: connecting ? 0.7 : 1,
              }}
            >
              {connecting ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <ShieldCheck size={12} />}
              {connecting ? verificationCopy.connecting : verificationCopy.connectWallet}
            </button>
          )}
        </div>
      </div>
      {connected ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.6, fontWeight: 700 }}>
              {verificationCopy.activeWallet}
            </span>
            <code
              className="mono"
              title={connectedAddress ?? undefined}
              style={{
                border: '1px solid var(--etched-border)',
                padding: '4px 8px',
                fontSize: 11,
              }}
            >
              {shorten(connectedAddress)}
            </code>
            {checkedAt && (
              <span className="mono" style={{ fontSize: 10, opacity: 0.48 }}>
                {verificationCopy.lastCheckedPrefix} {new Date(checkedAt).toLocaleString()}
              </span>
            )}
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55 }}>
            {/* Each branch is a single keyed <span> (not a bare fragment) so a
                lock/refresh state change swaps ONE element node. Third-party DOM
                mutators (Google Translate, some extensions) replace loose text
                nodes with <font> wrappers; when React then removes/inserts loose
                text siblings it throws NotFoundError (removeChild/insertBefore)
                and trips the dashboard error boundary. The token amounts are
                marked notranslate so translators never rewrite live numbers. */}
            {lockTierName && quoteAmountDisplay ? (
              <span key="quote-locked">
                {interpolateCopy(verificationCopy.lockedFor20, { tier: lockTierName })}{' '}
                <strong>
                  <code className="mono notranslate" translate="no">{quoteAmountDisplay} {displayTokenUnit(tokenSymbol)}</code>
                </strong>
                . {verificationCopy.holdAtLeastThatAmount}
              </span>
            ) : eligibleTierName && lockedAmountDisplay ? (
              <span key="rate-locked">
                {interpolateCopy(verificationCopy.yourRateLockedAt, { tier: eligibleTierName })}{' '}
                <strong>
                  <code className="mono notranslate" translate="no">{lockedAmountDisplay} {displayTokenUnit(tokenSymbol)}</code>
                </strong>
                . {lockTierName ? interpolateCopy(verificationCopy.lockNext, { tier: lockTierName }) : verificationCopy.keepEligible}
              </span>
            ) : balanceDisplay ? (
              <span key="balance-detected">
                {verificationCopy.detected}{' '}
                <strong>
                  <code className="mono notranslate" translate="no">{balanceDisplay} {displayTokenUnit(tokenSymbol)}</code>
                </strong>
                . {lockTierName ? interpolateCopy(verificationCopy.snapshotInstruction, { tier: lockTierName }) : verificationCopy.refreshInstruction}
              </span>
            ) : (
              <span key="instruction">{lockTierName ? interpolateCopy(verificationCopy.snapshotInstruction, { tier: lockTierName }) : verificationCopy.refreshInstruction}</span>
            )}
          </p>
          {veniceBoostEligible && (
            <p style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#16a34a', margin: 0, lineHeight: 1.5, fontWeight: 600 }}>
              <CheckCircle2 size={13} style={{ flexShrink: 0 }} />
              Eligible — you&apos;re holding enough VVV for the Venice compute boost (+1 vCPU / +2 GB per agent).
            </p>
          )}
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5, opacity: 0.82 }}>
            {verificationCopy.connectedFootnote}
          </p>
        </div>
      ) : (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55 }}>
          {verificationCopy.disconnectedBody}
        </p>
      )}
      {success && (
        <p role="status" style={{ fontSize: 12.5, color: '#16a34a', margin: 0, lineHeight: 1.5 }}>
          {success}
        </p>
      )}
      {error && (
        <p role="alert" style={{ fontSize: 12.5, color: '#dc2626', margin: 0, lineHeight: 1.5 }}>
          {error}
        </p>
      )}
    </section>
  );
}
/**
 * Copies the raw token amount (no commas, no symbol) so the user can paste
 * straight into a wallet's amount field. Wallets reject formatted strings
 * like "46,046,512 Hivra" — they want plain digits.
 */
export function CopyAmountButton({ amount }: { amount: string }) {
  return (
    <CopyButton
      value={amount}
      label="Copy amount"
      title="Copy raw amount (no commas) for pasting into your wallet"
    />
  );
}
export function QuoteCard({
  tier,
  quote,
  alreadyEligible,
  launchEpoch,
  minting,
  depositAddress,
  onMint,
}: {
  tier: 'pro' | 'power';
  quote: DepositQuotePayload | null;
  alreadyEligible: boolean;
  /** Server-resolved epoch: true while the launch ("founders") rate applies. */
  launchEpoch: boolean;
  minting: boolean;
  depositAddress: string | null;
  onMint: () => void;
}) {
  // Lazy initial state: lint disallows calling Date.now() inline as
  // the initial value because it makes render impure. The function
  // form runs only on first mount.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!quote) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [quote]);

  const expired = quote ? Date.parse(quote.expiresAt) <= now : false;
  const remainingMs = quote ? Math.max(0, Date.parse(quote.expiresAt) - now) : 0;
  // One-tap wallet link only for a live quote whose token, exact raw amount
  // (matching the amount shown) and deposit address are all known.
  const walletHref =
    quote && !expired
      ? hermesosTransferUri({
          tokenSymbol: quote.tokenSymbol,
          tokenDecimals: quote.tokenDecimals,
          depositAddress,
          amountRaw: wholeTokenQuoteRawAmount(quote),
        })
      : null;

  if (alreadyEligible) {
    return (
      <div
        style={{
          border: '1px solid #16a34a',
          padding: '1rem 1.25rem',
          background: 'var(--bg-surface)',
        }}
      >
        <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.18em', fontWeight: 700, color: '#16a34a' }}>
          {tierLabel(tier)} tier · eligible
        </span>
        <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
          You&apos;re already qualified for this tier — no quote needed.
        </p>
      </div>
    );
  }

  // Launch-rate framing: $99 Pro / $199 Power vs $149 / $299 standard
  // (~34% off Pro launch, 33% off Power launch). The savings badge + "lock
  // the launch rate" copy only show while the server says we're in the
  // launch epoch — after the global promo window closes (and for users not
  // on the founders allowlist) we drop to plain standard-rate framing.
  const launchUsdCents = tier === 'pro' ? 9900 : 19900;
  const standardUsdCents = STANDARD_USD_CENTS[tier];
  const savingsCents = standardUsdCents - launchUsdCents;
  const savingsPctOff = Math.round((savingsCents / standardUsdCents) * 100);
  // USD target the user actually pays right now (epoch-dependent).
  const activeUsdCents = launchEpoch ? launchUsdCents : standardUsdCents;

  return (
    <div
      style={{
        border: '1px solid var(--etched-border)',
        padding: '1rem 1.25rem',
        background: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.18em', fontWeight: 700 }}>
          {tierLabel(tier)} tier
          {quote && (
            <span style={{ marginLeft: 8, opacity: 0.6 }}>
              · {quote.epoch === 'launch' ? 'launch rate' : 'standard rate'}
            </span>
          )}
        </span>
        {launchEpoch && (
          <span
            className="mono"
            style={{
              fontSize: 10,
              padding: '3px 7px',
              border: '1px solid #ff2c2d',
              color: '#ff2c2d',
              fontWeight: 700,
              letterSpacing: '0.1em',
            }}
          >
            Save {formatUsdFromCents(savingsCents)} · {savingsPctOff}% off
          </span>
        )}
      </div>

      {!quote && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {launchEpoch ? (
              <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                Pay <strong>{formatUsdFromCents(launchUsdCents)}</strong> in $HERMESOS now to lock the launch rate.{' '}
                The standard rate ({formatUsdFromCents(standardUsdCents)}) applies once the launch
                window closes.
              </span>
            ) : (
              <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                Pay <strong>{formatUsdFromCents(standardUsdCents)}</strong> in $HERMESOS to qualify
                for {tierLabel(tier)}. Lock today&apos;s $HERMESOS price for 20 minutes.
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onMint}
            disabled={minting}
            className={touchStyles.touchTarget}
            style={{
              alignSelf: 'flex-start',
              padding: '10px 18px',
              border: '1px solid var(--ink-black)',
              background: 'var(--ink-black)',
              color: 'var(--bg-surface)',
              cursor: minting ? 'wait' : 'pointer',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 11,
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              opacity: minting ? 0.7 : 1,
            }}
          >
            {minting
              ? 'Locking…'
              : `Lock ${formatUsdFromCents(activeUsdCents)} · ${launchEpoch ? 'launch rate' : `${tierLabel(tier)} tier`}`}
          </button>
        </>
      )}

      {quote && !expired && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.16em', opacity: 0.55, fontWeight: 700 }}>
              Step 1 · Send exactly
            </span>
            <span className="serif notranslate" translate="no" style={{ fontSize: '1.65rem', fontWeight: 700, lineHeight: 1.1, overflowWrap: 'anywhere' }}>
              {formatTokensWithCommas(quote.tokensRequiredDisplay)}{' '}
              <span style={{ fontSize: '0.95rem', opacity: 0.7 }}>{displayTokenUnit(quote.tokenSymbol)}</span>
            </span>
            <div className={touchStyles.copyRow} style={{ margin: '4px 0 2px' }}>
              <CopyAmountButton amount={quote.tokensRequiredDisplay} />
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {formatUsdFromCents(quote.usdTargetCents)} worth at <code className="mono">${quote.priceUsdAtQuote}</code> per token. Send the
              full amount in a single transfer.
            </span>
          </div>

          <InlineCopyAddress
            label="Step 2 · To this address (Base network)"
            address={depositAddress}
          />

          <OpenInWalletLink href={walletHref} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {/* Ticks every second — keep translators away from the live text
                node or React's 1s updates race their <font> rewrites. */}
            <span className="mono notranslate" translate="no" style={{ fontSize: 11, color: '#16a34a' }}>
              Expires in {formatCountdown(remainingMs)}
            </span>
            <span className="mono" style={{ fontSize: 9, opacity: 0.55, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              Quote locked
            </span>
          </div>

          <BankrTrustFooter withdrawable />
        </>
      )}

      {quote && expired && (
        <>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
            This quote expired. Get a fresh one at the current price — the token amount may differ
            from the previous quote.
          </p>
          <button
            type="button"
            onClick={onMint}
            disabled={minting}
            className={touchStyles.touchTarget}
            style={{
              alignSelf: 'flex-start',
              padding: '8px 14px',
              border: '1px solid var(--ink-black)',
              background: 'var(--ink-black)',
              color: 'var(--bg-surface)',
              cursor: minting ? 'wait' : 'pointer',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              opacity: minting ? 0.7 : 1,
            }}
          >
            {minting ? 'Refreshing…' : 'Get new quote'}
          </button>
        </>
      )}
    </div>
  );
}
export function QuotePanel({
  proQuote,
  powerQuote,
  proEligible,
  powerEligible,
  launchEpoch,
  mintingTier,
  depositAddress,
  onMint,
}: {
  proQuote: DepositQuotePayload | null;
  powerQuote: DepositQuotePayload | null;
  proEligible: boolean;
  powerEligible: boolean;
  /** Server-resolved epoch: true while the launch ("founders") rate applies. */
  launchEpoch: boolean;
  mintingTier: 'pro' | 'power' | null;
  depositAddress: string | null;
  onMint: (tier: 'pro' | 'power') => void;
}) {
  const panelNowMs = useNowMs(60_000);
  // The global promo window — drives the live countdown. A founders-rate
  // user keeps launchEpoch=true past this without a (now meaningless)
  // countdown.
  const launchWindowOpen = panelNowMs < LAUNCH_PROMO_END.getTime();
  return (
    <section
      aria-label="Deposit quotes"
      style={{
        position: 'relative',
        border: '1px solid var(--etched-border)',
        background: 'var(--bg-surface)',
        padding: 'clamp(1.5rem, 4vw, 2.25rem)',
        marginBottom: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        boxShadow: '0 18px 40px -18px rgba(0,0,0,0.18)',
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 4,
          background: 'var(--gold-leaf)',
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <span
            className="mono"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 9,
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontWeight: 700,
              color: 'var(--gold-leaf)',
              padding: '4px 10px',
              border: '1px solid color-mix(in srgb, var(--gold-leaf) 35%, transparent)',
              background: 'color-mix(in srgb, var(--gold-leaf) 5%, transparent)',
            }}
          >
            <Zap size={10} fill="currentColor" />
            Step 02 · {launchEpoch ? 'Lock launch rate' : 'Lock your tier'}
          </span>
          <h2
            className="serif"
            style={{
              fontSize: 'clamp(1.5rem, 3.2vw, 2rem)',
              fontWeight: 700,
              marginTop: 10,
              marginBottom: 0,
              lineHeight: 1.1,
              letterSpacing: '-0.01em',
            }}
          >
            Lock today&apos;s rate.
          </h2>
          {launchEpoch ? (
            <p style={{ margin: '8px 0 0', fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              Pro and Power are roughly <strong>33% off</strong> during the launch window — $99 / $199
              instead of $149 / $299. Click a tier to lock today&apos;s $HERMESOS price for 20
              minutes; send the quoted amount and you&apos;re qualified at that rate, even if the
              price moves.
            </p>
          ) : (
            <p style={{ margin: '8px 0 0', fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              Pro is <strong>$149</strong> and Power is <strong>$299</strong> in $HERMESOS. Click a
              tier to lock today&apos;s $HERMESOS price for 20 minutes; send the quoted amount and
              you&apos;re qualified at that rate, even if the price moves.
            </p>
          )}
        </div>
        {launchWindowOpen ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
              border: '2px solid #ff2c2d',
              padding: '14px 20px',
              minWidth: 160,
              background: 'rgba(255, 44, 45, 0.06)',
              position: 'relative',
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 9,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                color: '#ff2c2d',
                fontWeight: 800,
              }}
            >
              Launch ends in
            </span>
            <span
              className="serif"
              style={{
                fontSize: '1.85rem',
                fontWeight: 700,
                color: '#ff2c2d',
                lineHeight: 1.05,
                letterSpacing: '-0.01em',
              }}
            >
              {formatDaysRemaining(LAUNCH_PROMO_END, panelNowMs)}
            </span>
            <span
              className="mono"
              style={{
                fontSize: 8,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                opacity: 0.55,
                fontWeight: 700,
              }}
            >
              {LAUNCH_PROMO_END.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} cutoff
            </span>
          </div>
        ) : launchEpoch ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
              border: '2px solid #ff2c2d',
              padding: '14px 20px',
              minWidth: 160,
              background: 'rgba(255, 44, 45, 0.06)',
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 9,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                color: '#ff2c2d',
                fontWeight: 800,
              }}
            >
              Founder rate
            </span>
            <span
              className="serif"
              style={{
                fontSize: '1.35rem',
                fontWeight: 700,
                color: '#ff2c2d',
                lineHeight: 1.1,
                letterSpacing: '-0.01em',
                textAlign: 'center',
              }}
            >
              Locked in for you
            </span>
          </div>
        ) : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 10 }}>
        <QuoteCard
          tier="pro"
          quote={proQuote}
          alreadyEligible={proEligible}
          launchEpoch={launchEpoch}
          minting={mintingTier === 'pro'}
          depositAddress={depositAddress}
          onMint={() => onMint('pro')}
        />
        <QuoteCard
          tier="power"
          quote={powerQuote}
          alreadyEligible={powerEligible}
          launchEpoch={launchEpoch}
          minting={mintingTier === 'power'}
          depositAddress={depositAddress}
          onMint={() => onMint('power')}
        />
      </div>
    </section>
  );
}
