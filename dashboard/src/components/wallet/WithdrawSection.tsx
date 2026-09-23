'use client';

import { useCallback, useState } from 'react';
import { ArrowUpFromLine, Loader2, ShieldCheck, X, Zap } from 'lucide-react';
import { BillingDialog, billingDialogStyles as dlg } from '@/components/billing/BillingDialog';
import { CopyButton, touchStyles } from '@/components/billing/TransferDetails';
import { shorten } from '@/lib/wallet/format';
import { displayTokenUnit } from '@/lib/billing/token-plan-prices';

/**
 * The wallet dashboard's withdraw lane: the destination card, the address form,
 * the withdraw section, the confirm dialog, the unlock prompt and the shared
 * action row. Extracted verbatim from wallet/page.tsx.
*/
export function ActionRow({
  icon,
  label,
  description,
  action,
  comingSoon = false,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  action?: React.ReactNode;
  comingSoon?: boolean;
}) {
  return (
    <div
      aria-disabled={comingSoon}
      style={{
        border: comingSoon ? '1px dashed var(--etched-border)' : '1px solid var(--etched-border)',
        padding: '1rem 1.25rem',
        opacity: comingSoon ? 0.55 : 1,
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        background: comingSoon ? 'transparent' : 'var(--bg-surface)',
      }}
    >
      <div style={{ flex: '0 0 auto', marginTop: 2 }}>{icon}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
        <span className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.16em', fontWeight: 700 }}>
          {label}
          {comingSoon && <span style={{ marginLeft: 8, opacity: 0.7 }}>(coming soon)</span>}
        </span>
        <span style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>{description}</span>
      </div>
      {action && <div style={{ flex: '0 0 auto', alignSelf: 'center' }}>{action}</div>}
    </div>
  );
}
export interface WithdrawSuccessPayload {
  txHash: string | null;
  amountDisplay: string;
  recipientAddress: string;
}
export function WithdrawDestinationCard({
  address,
  loading,
  onEdit,
}: {
  address: string | null;
  loading: boolean;
  onEdit: () => void;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--etched-border)',
        background: 'var(--bg-surface)',
        padding: '1rem 1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.18em', opacity: 0.55, fontWeight: 700 }}>
          Withdraw destination
        </span>
        <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.15em', opacity: 0.55 }}>
          Base network
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {loading ? (
          <span style={{ fontSize: 12, opacity: 0.6 }}>Loading…</span>
        ) : address ? (
          // The full destination, as text: the whole balance goes here, and
          // a title tooltip never shows on touch screens.
          <>
            <code
              className="mono notranslate"
              translate="no"
              style={{ fontSize: 12, lineHeight: 1.6, wordBreak: 'break-all', flex: '1 1 100%', minWidth: 0 }}
            >
              {address}
            </code>
            <div className={touchStyles.copyRow}>
              <CopyButton value={address} label="Copy address" ariaLabel="Copy withdraw destination" />
            </div>
          </>
        ) : (
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', flex: 1 }}>
            Not set yet. You must set a withdraw destination before you can withdraw.
          </span>
        )}
        <button
          type="button"
          onClick={onEdit}
          className={touchStyles.touchTarget}
          style={{
            padding: '6px 10px',
            border: '1px solid var(--etched-border)',
            background: 'transparent',
            cursor: 'pointer',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          {address ? 'Change' : 'Set address'}
        </button>
      </div>
    </div>
  );
}
export function WithdrawAddressForm({
  initialAddress,
  onCancel,
  onSaved,
}: {
  initialAddress: string | null;
  onCancel: () => void;
  onSaved: (address: string) => void;
}) {
  const [address, setAddress] = useState(initialAddress ?? '');
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isFormatValid = /^0x[a-fA-F0-9]{40}$/.test(address.trim());

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/billing/bankr/wallet/withdraw-address', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address.trim(), acknowledged }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.success) {
        setError(body?.error || `Save failed (${response.status})`);
        return;
      }
      onSaved(body.data?.address ?? address.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  }, [address, acknowledged, onSaved]);

  return (
    <ConfirmDialog
      title={initialAddress ? 'Change withdraw address' : 'Set withdraw address'}
      body={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
            All future withdraws will send your full $HERMESOS balance to the address below.
            You can change it any time.
          </p>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.16em', fontWeight: 700, opacity: 0.7 }}>
              Wallet address
            </span>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="0x..."
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              style={{
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 13,
                padding: '10px 12px',
                border: '1px solid var(--etched-border)',
                background: 'transparent',
                color: 'var(--text-primary)',
                outline: 'none',
              }}
            />
            {address.length > 0 && !isFormatValid && (
              <span style={{ fontSize: 11, color: '#dc2626' }}>
                Must be 0x followed by 40 hexadecimal characters.
              </span>
            )}
          </label>

          <div
            role="alert"
            style={{
              padding: '0.85rem 1rem',
              border: '1px solid #b3261e',
              color: '#b3261e',
              fontSize: 12.5,
              lineHeight: 1.55,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <strong>Read this carefully.</strong>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <li>This must be an EVM wallet address on the <strong>Base network</strong>.</li>
              <li>It must be an address <strong>you control directly</strong> — not a centralized exchange deposit, not a bundler, not a contract proxy.</li>
              <li>If you save the wrong address, or an address on a different network, your tokens may be lost permanently. <strong>Hivra is not responsible for incorrect addresses.</strong></li>
            </ul>
          </div>

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span style={{ lineHeight: 1.5 }}>
              I confirm this is a wallet I control on the Base network, and I accept full responsibility for the address I&apos;ve provided.
            </span>
          </label>

          {error && (
            <p style={{ margin: 0, fontSize: 12.5, color: '#dc2626' }}>{error}</p>
          )}
        </div>
      }
      confirmLabel={submitting ? 'Saving…' : 'Save withdraw address'}
      confirmDisabled={submitting || !isFormatValid || !acknowledged}
      onConfirm={handleSubmit}
      onCancel={() => {
        if (submitting) return;
        onCancel();
      }}
      // A backdrop tap must not throw away an address the user typed.
      dismissOnBackdrop={address.trim() === (initialAddress ?? '').trim()}
      closeDisabled={submitting}
    />
  );
}
export function WithdrawSection({
  tokenSymbol,
  balanceDisplay,
  withdrawAddress,
  onWithdrew,
  onRequestSetAddress,
}: {
  tokenSymbol: string;
  balanceDisplay: string;
  withdrawAddress: string | null;
  onWithdrew: () => void;
  onRequestSetAddress: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<WithdrawSuccessPayload | null>(null);

  const handleConfirm = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/billing/bankr/wallet/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.success) {
        setError(body?.error || `Withdraw failed (${response.status})`);
        return;
      }
      setSuccess({
        txHash: body.data?.txHash ?? null,
        amountDisplay: body.data?.amountDisplay ?? balanceDisplay,
        recipientAddress: body.data?.recipientAddress ?? '',
      });
      setConfirmOpen(false);
      // Tell the page to re-fetch balance + eligibility — the new
      // balance won't show until the next snapshot, but the optimistic
      // refresh keeps the UI honest about the in-flight state.
      onWithdrew();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Withdraw failed.');
    } finally {
      setSubmitting(false);
    }
  }, [balanceDisplay, onWithdrew]);

  if (success) {
    return (
      <div
        style={{
          border: '1px solid #16a34a',
          padding: '1rem 1.25rem',
          background: 'var(--bg-surface)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <span className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.16em', fontWeight: 700, color: '#16a34a' }}>
          Withdraw submitted
        </span>
        <p style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
          {success.amountDisplay} {displayTokenUnit(tokenSymbol)} sent to{' '}
          <code className="mono" style={{ fontSize: 12 }}>{shorten(success.recipientAddress)}</code>.
          Your tier eligibility stays active for 24 hours from the breach detection. After that, the tier ends and re-qualifying requires depositing at the current standard rate.
        </p>
        {success.txHash && (
          <a
            href={`https://basescan.org/tx/${success.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--gold-leaf, #ff2c2d)', textDecoration: 'underline', alignSelf: 'flex-start' }}
          >
            View transaction →
          </a>
        )}
      </div>
    );
  }

  const noBalance = balanceDisplay === '—' || balanceDisplay === '0';
  const hasAddress = Boolean(withdrawAddress);
  const buttonDisabled = submitting || noBalance || !hasAddress;

  return (
    <>
      <ActionRow
        icon={<ArrowUpFromLine size={14} />}
        label="Withdraw"
        description={
          hasAddress
            ? 'Withdraw your full $HERMESOS balance to your saved withdraw address. Your tier eligibility runs a 24-hour grace clock from breach detection before ending.'
            : 'Set a withdraw destination first — withdraws send your tokens there, and you cannot withdraw without one set.'
        }
        action={
          hasAddress ? (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setConfirmOpen(true);
              }}
              disabled={buttonDisabled}
              className={touchStyles.touchTarget}
              style={{
                padding: '8px 14px',
                border: '1px solid var(--etched-border)',
                background: 'transparent',
                cursor: buttonDisabled ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 10,
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                opacity: buttonDisabled ? 0.4 : 1,
              }}
            >
              {submitting ? 'Withdrawing…' : 'Withdraw all'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onRequestSetAddress}
              className={touchStyles.touchTarget}
              style={{
                padding: '8px 14px',
                border: '1px solid var(--etched-border)',
                background: 'transparent',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 10,
                fontWeight: 800,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              }}
            >
              Set address
            </button>
          )
        }
      />
      {confirmOpen && (
        <ConfirmDialog
          title="Withdraw all $HERMESOS"
          body={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, lineHeight: 1.55, fontSize: 14 }}>
                This will send <strong>{balanceDisplay} {displayTokenUnit(tokenSymbol)}</strong> from your platform deposit
                address to:
              </p>
              <code
                className="mono"
                style={{
                  fontSize: 12.5,
                  padding: '8px 10px',
                  background: 'var(--bg-elevated, var(--bg-surface))',
                  border: '1px solid var(--etched-border)',
                  wordBreak: 'break-all',
                }}
              >
                {withdrawAddress ?? '—'}
              </code>
              <div
                style={{
                  margin: 0,
                  padding: '10px 12px',
                  border: '1px solid rgba(255, 44, 45,0.45)',
                  background: 'rgba(255, 44, 45,0.08)',
                  borderLeft: '3px solid var(--gold-leaf, #ff2c2d)',
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  color: 'var(--text-primary, var(--ink-black))',
                }}
              >
                <p
                  className="mono"
                  style={{
                    margin: '0 0 6px',
                    fontSize: 9.5,
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    color: 'var(--gold-leaf, #ff2c2d)',
                  }}
                >
                  Network fee covered
                </p>
                <p style={{ margin: 0 }}>
                  Bankr gas sponsorship covers the Base network fee for this withdrawal. The server still re-checks
                  the live balance and records the withdrawal before submitting it.
                </p>
              </div>
              <p style={{ margin: 0, lineHeight: 1.55, fontSize: 13, color: 'var(--text-secondary)' }}>
                After the on-chain transfer confirms, your Pro/Power tier eligibility runs a
                24-hour grace clock. Once grace expires, the tier ends. To regain it, you&apos;ll
                need to deposit at the <strong>current standard rate</strong> (no longer the
                launch promo rate).
              </p>
              {error && (
                <p style={{ margin: 0, fontSize: 12, color: '#dc2626' }}>{error}</p>
              )}
            </div>
          }
          confirmLabel={submitting ? 'Withdrawing…' : 'Yes, withdraw everything'}
          confirmDisabled={submitting || !hasAddress}
          confirmTone="destructive"
          onConfirm={handleConfirm}
          onCancel={() => {
            if (submitting) return;
            setConfirmOpen(false);
            setError(null);
          }}
          closeDisabled={submitting}
        />
      )}
    </>
  );
}
/**
 * Confirmation dialog for the legacy $HERMESOS withdraw lane (set withdraw
 * address, withdraw all). Built on the billing dialog so it renders through
 * SafePortal above the dashboard header and phone bottom bar, fits the visible
 * viewport with a scrolling body, and keeps Cancel / Confirm pinned in a 44px
 * footer that stacks full-width on narrow screens. Props are unchanged, plus
 * `dismissOnBackdrop` (keep typed input) and `closeDisabled` (in flight).
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  confirmDisabled,
  confirmTone,
  onConfirm,
  onCancel,
  children,
  dismissOnBackdrop = true,
  closeDisabled = false,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  confirmDisabled?: boolean;
  confirmTone?: 'destructive' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
  /** A backdrop click cancels (default true). Pass false while a form holds typed input. */
  dismissOnBackdrop?: boolean;
  /** Locks Close, Escape, the backdrop and Cancel while a request is in flight. */
  closeDisabled?: boolean;
}) {
  const destructive = confirmTone === 'destructive';
  return (
    <BillingDialog
      title={title}
      size="sm"
      onClose={onCancel}
      dismissOnBackdrop={dismissOnBackdrop}
      closeDisabled={closeDisabled}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            disabled={closeDisabled}
            className={`${dlg.button} ${dlg.secondary}`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={`${dlg.button} ${destructive ? dlg.destructive : dlg.primary}`}
            data-tone={destructive ? 'destructive' : undefined}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {body}
      {children}
    </BillingDialog>
  );
}
export function UnlockPromptCard({
  mode,
  unlocking,
  onUnlock,
  onDismiss,
}: {
  mode: 'holding' | 'venice';
  unlocking: boolean;
  onUnlock: () => void;
  onDismiss: () => void;
}) {
  const venice = mode === 'venice';
  const gold = 'rgba(255, 44, 45,1)';
  return (
    <section
      aria-label={venice ? 'Venice compute boost' : 'Unlock a token tier'}
      className="boost-card"
      style={{
        position: 'relative',
        overflow: 'hidden',
        border: `1px solid ${venice ? 'rgba(255, 44, 45,0.6)' : 'var(--ink-black)'}`,
        background: venice
          ? 'linear-gradient(135deg, rgba(255, 44, 45,0.16), rgba(255, 44, 45,0.03))'
          : 'var(--bg-surface)',
        padding: 'clamp(1.25rem, 3.5vw, 1.9rem)',
        marginBottom: '1.5rem',
        boxShadow: venice
          ? '0 0 22px rgba(255, 44, 45,0.18), 6px 6px 0 var(--ink-black)'
          : '6px 6px 0 var(--ink-black)',
      }}
    >
      {/* Soft accent glow in the corner so the card reads as a highlight. */}
      <div
        aria-hidden
        className="boost-glow"
        style={{
          position: 'absolute',
          top: -50,
          right: -50,
          width: 160,
          height: 160,
          borderRadius: '50%',
          background: venice
            ? 'radial-gradient(circle, rgba(255, 44, 45,0.28), transparent 70%)'
            : 'radial-gradient(circle, rgba(255,255,255,0.05), transparent 70%)',
          pointerEvents: 'none',
        }}
      />
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Close"
        style={{
          position: 'absolute', top: 0, right: 0, width: 44, height: 44,
          display: 'grid', placeItems: 'center', padding: 0,
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--text-secondary)', lineHeight: 0, zIndex: 1,
        }}
      >
        <X size={16} aria-hidden="true" />
      </button>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', position: 'relative' }}>
        <div
          aria-hidden
          className={venice ? 'boost-iconwrap' : undefined}
          style={{
            flexShrink: 0,
            width: 42,
            height: 42,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `1px solid ${venice ? 'rgba(255, 44, 45,0.6)' : 'var(--etched-border)'}`,
            background: venice ? 'rgba(255, 44, 45,0.14)' : 'transparent',
          }}
        >
          {venice ? <Zap className="boost-zap" size={19} style={{ color: gold }} /> : <ShieldCheck size={19} />}
        </div>
        <div style={{ minWidth: 0 }}>
          <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.18em', opacity: 0.6, fontWeight: 700 }}>
            {venice ? 'Venice Compute Boost' : 'Token Tier'}
          </span>
          <h3
            className="serif"
            style={{ fontSize: 'clamp(1.35rem, 3vw, 1.6rem)', fontWeight: 700, margin: '4px 0 8px', letterSpacing: '-0.01em' }}
          >
            {venice ? 'Add +1 vCPU / +2 GB to every agent' : 'Unlock Pro / Power by holding $HERMESOS'}
          </h3>
          <p style={{ fontSize: 13.5, opacity: 0.82, marginBottom: 16, maxWidth: 560, lineHeight: 1.55 }}>
            {venice
              ? 'You’re on a paid tier — hold the VVV threshold in your verified wallet and every agent gets +1 vCPU / +2 GB. Press unlock and it applies right away, no waiting for the next sync.'
              : 'Hold $HERMESOS in your verified wallet to qualify for a Pro or Power compute tier. Connect, verify, and unlock instantly — no waiting for the next sync.'}
          </p>
          <button
            type="button"
            onClick={onUnlock}
            disabled={unlocking}
            className={touchStyles.touchTarget}
            style={{
              position: 'relative', overflow: 'hidden',
              display: 'inline-flex', alignItems: 'center', gap: 8,
              background: venice ? gold : 'var(--btn-bg)',
              color: venice ? 'var(--ink-black)' : 'var(--btn-text)',
              border: venice ? `1px solid ${gold}` : 'none',
              padding: '12px 22px', cursor: unlocking ? 'wait' : 'pointer',
              fontFamily: 'var(--font-mono), monospace', fontSize: 11, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.1em', opacity: unlocking ? 0.7 : 1,
              boxShadow: venice ? '3px 3px 0 var(--ink-black)' : undefined,
            }}
          >
            {unlocking ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <ShieldCheck size={13} />}
            {venice ? 'Verify VVV & unlock boost now' : 'Connect & unlock now'}
            {!unlocking && (
              <span
                aria-hidden
                className="boost-shine"
                style={{
                  position: 'absolute', top: 0, left: 0, width: '40%', height: '100%',
                  background: 'linear-gradient(100deg, transparent, rgba(255,255,255,0.5), transparent)',
                  pointerEvents: 'none',
                }}
              />
            )}
          </button>
        </div>
      </div>
    </section>
  );
}
