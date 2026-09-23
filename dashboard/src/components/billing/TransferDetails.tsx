'use client';

// Payment-detail building blocks shared by every crypto deposit surface
// (yearly $HermesOS payments, managed Venice top-ups, wallet deposit quotes
// and agent-wallet deposits).
//
// On a phone the QR code is the least useful thing on screen (the phone
// cannot scan itself), and the copy buttons are the real path into a wallet
// app. So on compact screens (under 768px, or any touch pointer) copy
// buttons grow to 44px on a full-width row under the value, and the QR code
// moves after the address inside a closed "Show QR code" disclosure. On a
// desktop the QR code stays beside the address for scanning with a phone.

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronDown, Copy, QrCode, Wallet } from 'lucide-react';

import { LocalAddressQr } from '@/components/billing/LocalAddressQr';
import { exactRawAmount } from '@/lib/billing/eip681';
import { HERMESOS_TOKEN, platformTokenByAddress } from '@/lib/billing/token-registry';
import { displayTokenUnit } from '@/lib/billing/token-plan-prices';
import { copyTextToClipboard } from '@/lib/client/clipboard';
import styles from './touch.module.css';

export { styles as touchStyles };

export const COMPACT_PAYMENT_QUERY = '(max-width: 767px), (pointer: coarse)';

/**
 * Finality disclosure for every $HermesOS payment surface (the yearly plan
 * payment and managed Venice top-ups). Same wording as the Plans footnote.
 */
export const TOKEN_PAYMENT_FINALITY = "Token payments are final, except where the law gives you a right to cancel.";

function subscribeCompact(onChange: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const query = window.matchMedia(COMPACT_PAYMENT_QUERY);
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }
  // Safari < 14.
  query.addListener(onChange);
  return () => query.removeListener(onChange);
}

function compactSnapshot() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(COMPACT_PAYMENT_QUERY).matches
  );
}

/** True on phone-width screens and touch devices. False during SSR. */
export function useCompactPaymentLayout(): boolean {
  return useSyncExternalStore(subscribeCompact, compactSnapshot, () => false);
}

function cx(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(' ');
}

export function CopyButton({
  value,
  label,
  copiedLabel = 'Copied',
  ariaLabel,
  title,
  block = false,
  className,
}: {
  /** Exact text put on the clipboard. Null disables the button. */
  value: string | null | undefined;
  label: string;
  copiedLabel?: string;
  ariaLabel?: string;
  title?: string;
  /** Full width on every screen size (compact screens always stretch). */
  block?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, []);

  async function handleCopy() {
    if (!value) return;
    const ok = await copyTextToClipboard(value);
    if (!ok) return;
    setCopied(true);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button
      type="button"
      className={cx(styles.copyButton, className)}
      data-copied={copied ? 'true' : undefined}
      data-block={block ? 'true' : undefined}
      onClick={() => void handleCopy()}
      disabled={!value}
      aria-label={ariaLabel}
      title={title}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </button>
  );
}

/** "Send exactly" block: the amount large, a copy button under it, then a note. */
export function TransferAmountField({
  label,
  amount,
  unit,
  copyValue,
  copyLabel = 'Copy amount',
  copyTitle,
  children,
}: {
  label: ReactNode;
  /** Display form of the amount (may include thousands separators). */
  amount: ReactNode;
  unit?: ReactNode;
  /** What the copy button puts on the clipboard (plain digits for wallets). */
  copyValue: string | null | undefined;
  copyLabel?: string;
  copyTitle?: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <span className={`mono ${styles.fieldLabel}`}>{label}</span>
      <p className={`serif notranslate ${styles.amount}`} translate="no">
        {amount}
        {unit ? <span className={styles.amountUnit}>{unit}</span> : null}
      </p>
      <div className={styles.copyRow}>
        <CopyButton value={copyValue} label={copyLabel} title={copyTitle} />
      </div>
      {children ? <p className={styles.fieldNote}>{children}</p> : null}
    </div>
  );
}

/**
 * Which token to send, with its contract: shown under every "Send exactly"
 * amount so a user can check the token in their wallet before sending. Only
 * that token is credited; another token sent to the address is not.
 * Renders nothing when the token can't be named (an unknown asset).
 */
export function TokenContractLine({
  tokenAddress,
  tokenSymbol,
}: {
  tokenAddress?: string | null;
  tokenSymbol?: string | null;
}) {
  const token =
    platformTokenByAddress(tokenAddress) ??
    (!tokenAddress && displayTokenUnit(tokenSymbol) === HERMESOS_TOKEN.displayUnit ? HERMESOS_TOKEN : null);
  if (!token) return null;
  return (
    <div className={styles.field} data-testid="token-contract-line">
      <span className={`mono ${styles.fieldLabel}`}>Token · {token.displayUnit} on Base</span>
      <code className={`mono notranslate ${styles.address}`} translate="no" style={{ overflowWrap: 'anywhere' }}>
        {token.publishedAddress}
      </code>
      <div className={styles.copyRow}>
        <CopyButton value={token.publishedAddress} label="Copy contract" />
      </div>
      <p className={styles.fieldNote}>
        Send only {token.displayUnit} from this contract. Any other token sent here is not credited. Check the contract
        against <a href="/token">the token page</a>.
      </p>
    </div>
  );
}

/**
 * Address block: the full address as visible text, a copy button under it,
 * and the QR code beside it (desktop) or after it in a disclosure (compact).
 */
export function DepositAddressField({
  label,
  address,
  qrLabel,
  qrSize = 124,
  copyLabel = 'Copy address',
  copyAriaLabel,
  emptyText = '—',
  children,
}: {
  label: ReactNode;
  address: string | null | undefined;
  /** Accessible name of the QR image. */
  qrLabel: string;
  qrSize?: number;
  copyLabel?: string;
  copyAriaLabel?: string;
  emptyText?: string;
  children?: ReactNode;
}) {
  const compact = useCompactPaymentLayout();
  const hasAddress = Boolean(address);

  return (
    <div className={styles.field}>
      <span className={`mono ${styles.fieldLabel}`}>{label}</span>
      <div className={styles.addressLayout}>
        {hasAddress && !compact ? (
          <LocalAddressQr address={address as string} size={qrSize} label={qrLabel} />
        ) : null}
        <div className={styles.addressMain}>
          <code
            className={`mono notranslate ${styles.address}`}
            translate="no"
            data-empty={hasAddress ? undefined : 'true'}
          >
            {hasAddress ? address : emptyText}
          </code>
          <div className={styles.copyRow}>
            <CopyButton value={address} label={copyLabel} ariaLabel={copyAriaLabel} />
          </div>
        </div>
      </div>
      {children ? <p className={styles.fieldNote}>{children}</p> : null}
      {hasAddress && compact ? (
        <details className={styles.qrDetails}>
          <summary>
            <QrCode size={15} aria-hidden="true" />
            Show QR code
            <ChevronDown size={15} aria-hidden="true" className={styles.qrChevron} />
          </summary>
          <div className={styles.qrBody}>
            <LocalAddressQr address={address as string} size={qrSize} label={qrLabel} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The exact raw amount for a whole-token quote's wallet link, but only when it
 * is the same amount the screen tells the user to send. $HermesOS quotes are
 * minted as a whole-token count (raw = display × 10^decimals); if the two ever
 * disagree the link is dropped rather than risk a different amount.
 */
export function wholeTokenQuoteRawAmount(quote: {
  tokensRequiredDisplay: string;
  tokensRequiredRaw?: string | null;
  tokenDecimals?: number | null;
}): string | null {
  const raw = exactRawAmount(quote.tokensRequiredRaw);
  const display = exactRawAmount(quote.tokensRequiredDisplay);
  const decimals = quote.tokenDecimals;
  if (!raw || !display || typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0) {
    return null;
  }
  return BigInt(display) * 10n ** BigInt(decimals) === BigInt(raw) ? raw : null;
}

/**
 * 44px EIP-681 link that opens a wallet app with the transfer filled in.
 * Render it only with a link from lib/billing/eip681 (null means "not every
 * part of the transfer is known", so there is nothing to render).
 */
export function OpenInWalletLink({ href }: { href: string | null | undefined }) {
  if (!href) return null;
  return (
    <div className={styles.walletBlock}>
      <a href={href} className={styles.walletLink}>
        <Wallet size={15} aria-hidden="true" />
        Open in wallet
        <ArrowUpRight size={15} aria-hidden="true" />
      </a>
      <p className={styles.walletHint}>
        Opens your wallet app with the token, exact amount and Base address filled in. Check all three before you send.
      </p>
    </div>
  );
}
