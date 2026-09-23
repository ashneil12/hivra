'use client';

import { useCallback, useId, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowUpFromLine, Info, ShieldCheck } from 'lucide-react';
import { BillingDialog, billingDialogStyles as dlg } from '@/components/billing/BillingDialog';
import { CopyButton, DepositAddressField, touchStyles } from '@/components/billing/TransferDetails';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { clientLog } from '@/lib/client/logger';
import {
  agentBaseEthBalance,
  agentWalletWithdrawableBalances,
  defaultWithdrawAmountForBalance,
  isEvmAddressInput,
  isNonZeroAmountDisplay,
  primaryAgentWalletRecipient,
  shorten,
  tokenBalanceKey,
  tokenDecimalsFor,
} from '@/lib/wallet/format';
import {
  AGENT_WITHDRAWAL_GAS_NOTICE,
  formatWalletAmountCompact,
  formatWalletAmountDisplay,
  isWalletAmountShortened,
} from '@/app/dashboard/wallet/agent-wallet-ui';
import {
  agentWalletApiBase,
  type AgentWalletBalance,
  type AgentWalletCardData,
  type AgentWalletRecipient,
  type AgentWalletsState,
  type InstanceBankrWalletPublicSummary,
} from '@/app/dashboard/wallet/agent-wallet-data';

/**
 * Agent-wallet cards and their deposit / withdrawal / management modals for the
 * wallet dashboard. Extracted verbatim from wallet/page.tsx.
 */
/**
 * Compact "Powered by Bankr" line at the bottom of wallet surfaces (agent
 * wallets, hold-to-qualify quote panel).
 *
 * On the holding-based path the user can withdraw their tokens any
 * time — pass `withdrawable` to surface that. Without it the line only names
 * the Base payment address and makes no custody claim: a deposit address
 * Hivra sweeps is not the user's wallet and must never be called
 * non-custodial.
 */
export function BankrTrustFooter({ withdrawable = false, note }: { withdrawable?: boolean; note?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginTop: 8,
        paddingTop: 10,
        borderTop: '1px solid var(--etched-border)',
      }}
    >
      <ShieldCheck size={11} style={{ opacity: 0.55, color: 'var(--ink-black)' }} />
      <span
        className="mono"
        style={{
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '0.16em',
          fontWeight: 700,
          opacity: 0.55,
          color: 'var(--ink-black)',
        }}
      >
        Powered by{' '}
        <a
          href="https://bankr.bot"
          target="_blank"
          rel="noopener noreferrer"
          // Vertical padding on an inline link grows its hit area to 44px
          // without changing the line's layout.
          style={{ color: 'var(--gold-leaf)', textDecoration: 'none', letterSpacing: '0.16em', padding: '16px 0.35rem' }}
        >
          Bankr
        </a>
        {' · '}
        {note ?? (withdrawable ? 'your wallet · withdraw any time' : 'payment address on Base')}
      </span>
    </div>
  );
}
export function AgentWalletCopyButton({ text, label = 'Copy' }: { text: string | null; label?: string }) {
  // Shared 44px-on-touch copy control (billing TransferDetails).
  return <CopyButton value={text} label={label} />;
}
/**
 * Shell for the agent-wallet modals, built on the billing dialog so it:
 * renders through SafePortal above the dashboard header and phone bottom bar;
 * fits the visible viewport (minus safe areas) with a scrolling body and the
 * action row pinned in `footer`, so "Yes, withdraw" is always reachable, even
 * with the keyboard up; and has Escape, a focus trap and a 44px Close.
 *
 * Pass `dismissOnBackdrop={false}` while a form holds typed input, and
 * `closeDisabled` while a request is in flight.
 */
export function AgentWalletModalFrame({
  title,
  description,
  children,
  footer,
  onClose,
  dismissOnBackdrop = true,
  closeDisabled = false,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  /** Pinned action row. */
  footer?: React.ReactNode;
  onClose: () => void;
  dismissOnBackdrop?: boolean;
  closeDisabled?: boolean;
}) {
  return (
    <BillingDialog
      eyebrow="Agent wallet"
      title={title}
      description={description}
      footer={footer}
      onClose={onClose}
      dismissOnBackdrop={dismissOnBackdrop}
      closeDisabled={closeDisabled}
    >
      {children}
    </BillingDialog>
  );
}
export function AgentDepositModal({
  card,
  onClose,
}: {
  card: AgentWalletCardData;
  onClose: () => void;
}) {
  const address = card.wallet?.evmAddress ?? '';

  return (
    <AgentWalletModalFrame
      title={<>Deposit to {card.instance.name} on Base.</>}
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose} className={`${dlg.button} ${dlg.primary}`}>
          Done
        </button>
      }
    >
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
        Send supported tokens on Base only. The agent will see the new balance within ~30 seconds.
      </p>
      <div
        style={{
          border: '1px solid color-mix(in srgb, var(--gold-leaf) 44%, var(--etched-border))',
          background: 'color-mix(in srgb, var(--gold-leaf) 8%, var(--bg-surface))',
          padding: '0.85rem',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          color: 'var(--ink-black)',
        }}
      >
        <AlertTriangle size={17} style={{ color: 'var(--gold-leaf)', flex: '0 0 auto', marginTop: 1 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 900 }}>
            Base network only
          </span>
          <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted)' }}>
            Do not send from Ethereum mainnet, Arbitrum, Optimism, Solana, or any other chain. Funds sent on the wrong network may be permanently lost, and Hivra is not responsible for recovery.
          </span>
        </div>
      </div>
      {/* Address first with its copy button; the QR sits beside it on
          desktop and behind "Show QR code" after it on phones. */}
      <DepositAddressField
        label="Base deposit address"
        address={address}
        qrLabel="Deposit address QR code"
        qrSize={148}
        copyLabel="Copy Base address"
      />
    </AgentWalletModalFrame>
  );
}
export function WithdrawalDestinationModal({
  card,
  onClose,
  onSaved,
}: {
  card: AgentWalletCardData;
  onClose: () => void;
  onSaved: (wallet: InstanceBankrWalletPublicSummary) => void;
}) {
  const [destination, setDestination] = useState(card.wallet?.withdrawalDestinationEvm ?? '');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = touched && destination.trim().length > 0 && !isEvmAddressInput(destination);

  const handleSave = useCallback(async () => {
    setTouched(true);
    if (!isEvmAddressInput(destination)) {
      setError('Enter a valid 0x EVM address.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Lane-aware: the Hermes route is PUT .../withdraw-destination with
      // { destination }; the Hivra route is POST .../set-destination with
      // { evmAddress }. Both return { wallet }.
      const isHivra = card.instance.lane === 'hivra';
      const trimmedDestination = destination.trim();
      const response = await fetch(
        `${agentWalletApiBase(card.instance)}/${isHivra ? 'set-destination' : 'withdraw-destination'}`,
        {
          method: isHivra ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            isHivra ? { evmAddress: trimmedDestination } : { destination: trimmedDestination },
          ),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.success) {
        setError(body?.error || `Save failed (${response.status})`);
        return;
      }
      const wallet = (body.data?.wallet ?? null) as InstanceBankrWalletPublicSummary | null;
      if (wallet) onSaved(wallet);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }, [card.instance.id, destination, onClose, onSaved]);

  // A backdrop tap must not throw away an address the user has typed.
  const destinationEdited = destination.trim() !== (card.wallet?.withdrawalDestinationEvm ?? '').trim();

  return (
    <AgentWalletModalFrame
      title="Set primary recipient."
      onClose={onClose}
      dismissOnBackdrop={!destinationEdited}
      closeDisabled={saving}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className={`${dlg.button} ${dlg.secondary}`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !isEvmAddressInput(destination)}
            aria-busy={saving || undefined}
            className={`${dlg.button} ${dlg.primary}`}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
        This address appears first in recent recipients and is prefilled for Base withdrawals. You can still choose a different recipient at withdrawal time. {AGENT_WITHDRAWAL_GAS_NOTICE}
      </p>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--text-muted)', fontWeight: 800 }}>
          Primary recipient
        </span>
        <input
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          onBlur={() => setTouched(true)}
          placeholder="0x..."
          className="mono"
          style={{
            border: `1px solid ${invalid ? 'var(--gold-leaf)' : 'var(--etched-border)'}`,
            background: 'var(--bg-surface)',
            color: 'var(--ink-black)',
            padding: '10px 12px',
            fontSize: 12,
            outline: 'none',
          }}
        />
      </label>
      {invalid && (
        <span style={{ fontSize: 12, color: 'var(--gold-leaf)' }}>
          Enter a valid 0x-prefixed 40-character EVM address.
        </span>
      )}
      {error && (
        <span role="alert" style={{ fontSize: 12, color: 'var(--gold-leaf)' }}>
          {error}
        </span>
      )}
    </AgentWalletModalFrame>
  );
}
export interface AgentWalletWithdrawSuccess {
  txHash: string | null;
  asset: string;
  amountDisplay: string | null;
  recipientAddress: string | null;
}
export function AgentWalletWithdrawModal({
  card,
  onClose,
  onSubmitted,
}: {
  card: AgentWalletCardData;
  onClose: () => void;
  onSubmitted: (wallet: InstanceBankrWalletPublicSummary | null) => void;
}) {
  const withdrawableBalances = agentWalletWithdrawableBalances(card);
  const initialBalance = withdrawableBalances[0] ?? card.balances[0] ?? null;
  const [selectedTokenKey, setSelectedTokenKey] = useState(() => initialBalance ? tokenBalanceKey(initialBalance) : '');
  const selectedBalance = withdrawableBalances.find((balance) => tokenBalanceKey(balance) === selectedTokenKey)
    ?? initialBalance;
  const primaryRecipient = primaryAgentWalletRecipient(card);
  const [submitting, setSubmitting] = useState(false);
  const [amount, setAmount] = useState(() => initialBalance ? defaultWithdrawAmountForBalance(initialBalance) : '');
  const [recipientAddress, setRecipientAddress] = useState(() => primaryRecipient ?? '');
  const [setPrimaryRecipient, setSetPrimaryRecipient] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<AgentWalletWithdrawSuccess | null>(null);
  const normalizedAmount = amount.replace(/,/g, '').trim();
  const normalizedRecipient = recipientAddress.trim();
  const canSubmit = Boolean(selectedBalance && isEvmAddressInput(normalizedRecipient) && isNonZeroAmountDisplay(normalizedAmount));
  const recentRecipients = (() => {
    const seen = new Set<string>();
    const recipients: AgentWalletRecipient[] = [];
    for (const recipient of card.withdrawalRecipients ?? []) {
      const normalized = recipient.normalizedAddress || recipient.address.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      recipients.push(recipient);
    }
    if (primaryRecipient && !seen.has(primaryRecipient.toLowerCase())) {
      recipients.unshift({
        id: 'primary',
        address: primaryRecipient,
        normalizedAddress: primaryRecipient.toLowerCase(),
        label: null,
        isPrimary: true,
        useCount: 0,
        lastUsedAt: '',
      });
    }
    return recipients;
  })();

  const handleWithdraw = useCallback(async () => {
    if (!selectedBalance) {
      setError('No Base token balance is available to withdraw.');
      return;
    }
    if (!isEvmAddressInput(normalizedRecipient)) {
      setError('Enter a valid 0x recipient address.');
      return;
    }
    if (!isNonZeroAmountDisplay(normalizedAmount)) {
      setError(`Enter a ${selectedBalance.tokenSymbol} amount greater than zero.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    const token = {
      symbol: selectedBalance.tokenSymbol,
      tokenAddress: selectedBalance.tokenAddress ?? null,
      decimals: tokenDecimalsFor(selectedBalance),
      chain: 'Base' as const,
    };
    try {
      // Lane-aware: both the Hermes (/api/instances/...) and Hivra
      // (/api/hivra/agents/...) withdraw routes accept the same body and return
      // the same { txHash, asset, amountDisplay, recipientAddress, wallet }.
      const response = await fetch(`${agentWalletApiBase(card.instance)}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: normalizedAmount,
          recipientAddress: normalizedRecipient,
          token,
          setPrimaryRecipient,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.success) {
        setError(body?.error || `Withdraw failed (${response.status})`);
        return;
      }
      const data = body.data ?? {};
      setSuccess({
        txHash: typeof data.txHash === 'string' ? data.txHash : null,
        asset: typeof data.asset === 'string' ? data.asset : selectedBalance.tokenSymbol,
        amountDisplay: typeof data.amountDisplay === 'string' ? data.amountDisplay : null,
        recipientAddress: typeof data.recipientAddress === 'string' ? data.recipientAddress : normalizedRecipient,
      });
      onSubmitted((data.wallet ?? null) as InstanceBankrWalletPublicSummary | null);
    } catch (err) {
      clientLog.error('agent wallet withdraw request failed', err, {
        source: 'wallet-page',
        route: '/dashboard/wallet',
        instanceId: card.instance.id,
        failureType: 'agent_wallet_withdraw_request_failed',
      });
      setError(err instanceof Error ? err.message : 'Withdraw failed.');
    } finally {
      setSubmitting(false);
    }
  }, [card.instance.id, normalizedAmount, normalizedRecipient, onSubmitted, selectedBalance, setPrimaryRecipient]);

  const handleTokenChange = useCallback((nextKey: string) => {
    setSelectedTokenKey(nextKey);
    const nextBalance = withdrawableBalances.find((balance) => tokenBalanceKey(balance) === nextKey);
    setAmount(nextBalance ? defaultWithdrawAmountForBalance(nextBalance) : '');
  }, [withdrawableBalances]);

  if (success) {
    return (
      <AgentWalletModalFrame
        title="Withdraw submitted."
        onClose={onClose}
        footer={
          <button type="button" onClick={onClose} className={`${dlg.button} ${dlg.primary}`}>
            Done
          </button>
        }
      >
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
          {success.amountDisplay ?? 'Your'} {success.asset} withdrawal was submitted to{' '}
          <code className="mono" style={{ fontSize: 12, color: 'var(--ink-black)', wordBreak: 'break-all' }}>
            {success.recipientAddress ?? normalizedRecipient}
          </code>
          .
        </p>
        {success.txHash && (
          <a
            href={`https://basescan.org/tx/${success.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--gold-leaf)', textDecoration: 'underline', alignSelf: 'flex-start' }}
          >
            View transaction →
          </a>
        )}
      </AgentWalletModalFrame>
    );
  }

  return (
    <AgentWalletModalFrame
      title="Withdraw on Base."
      onClose={onClose}
      // The amount is always prefilled, so a stray backdrop tap would throw
      // the form away; only Cancel, Close and Escape dismiss it.
      dismissOnBackdrop={false}
      closeDisabled={submitting}
      footer={
        <>
          {error && (
            <span role="alert" style={{ flex: '1 1 100%', fontSize: 12, lineHeight: 1.5, color: 'var(--gold-leaf)' }}>
              {error}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className={`${dlg.button} ${dlg.secondary}`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleWithdraw}
            disabled={submitting || !canSubmit}
            aria-busy={submitting || undefined}
            className={`${dlg.button} ${dlg.primary}`}
          >
            {submitting ? 'Withdrawing…' : 'Yes, withdraw'}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
        Base network only for now. Choose the token, amount, and recipient address for {card.instance.name}&apos;s agent wallet; the server re-reads the live Base balance before submitting.
      </p>
      <div
        style={{
          border: '1px solid var(--etched-border)',
          background: 'var(--bg-surface)',
          padding: '0.85rem',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--text-muted)', fontWeight: 800 }}>
          Base token
        </span>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--text-muted)', fontWeight: 800 }}>
            Token
          </span>
          <select
            className="mono"
            value={selectedTokenKey}
            onChange={(event) => handleTokenChange(event.target.value)}
            disabled={submitting || withdrawableBalances.length === 0}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid var(--etched-border)',
              background: 'var(--bg-canvas)',
              color: 'var(--ink-black)',
              padding: '10px 11px',
              fontSize: 13,
              outline: 'none',
            }}
          >
            {withdrawableBalances.map((balance) => (
              <option key={tokenBalanceKey(balance)} value={tokenBalanceKey(balance)}>
                {balance.tokenSymbol} · {formatWalletAmountDisplay(balance.balanceDisplay)}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--text-muted)', fontWeight: 800 }}>
            Amount to withdraw
          </span>
          <input
            className="mono"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            autoComplete="off"
            placeholder={selectedBalance?.balanceDisplay ?? '0'}
            disabled={submitting}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid var(--etched-border)',
              background: 'var(--bg-canvas)',
              color: 'var(--ink-black)',
              padding: '10px 11px',
              fontSize: 13,
              outline: 'none',
            }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--text-muted)', fontWeight: 800 }}>
            Recipient address
          </span>
          <input
            className="mono"
            value={recipientAddress}
            onChange={(event) => setRecipientAddress(event.target.value)}
            autoComplete="off"
            placeholder="0x..."
            disabled={submitting}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: `1px solid ${recipientAddress && !isEvmAddressInput(recipientAddress) ? 'var(--gold-leaf)' : 'var(--etched-border)'}`,
              background: 'var(--bg-canvas)',
              color: 'var(--ink-black)',
              padding: '10px 11px',
              fontSize: 13,
              outline: 'none',
            }}
          />
        </label>
        {recentRecipients.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--text-muted)', fontWeight: 800 }}>
              Recent recipients
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {recentRecipients.map((recipient) => (
                <button
                  key={recipient.id}
                  type="button"
                  onClick={() => setRecipientAddress(recipient.address)}
                  disabled={submitting}
                  style={{
                    border: '1px solid var(--etched-border)',
                    background: recipient.address.toLowerCase() === normalizedRecipient.toLowerCase() ? 'color-mix(in srgb, var(--gold-leaf) 9%, var(--bg-surface))' : 'transparent',
                    color: 'var(--ink-black)',
                    padding: '7px 9px',
                    cursor: submitting ? 'wait' : 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                    alignItems: 'center',
                    textAlign: 'left',
                  }}
                >
                  <code className="mono notranslate" translate="no" style={{ fontSize: 11, wordBreak: 'break-all' }}>{recipient.address}</code>
                  {recipient.isPrimary && (
                    <span className="mono" style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--gold-leaf)', fontWeight: 900 }}>
                      Primary
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
          <input
            type="checkbox"
            checked={setPrimaryRecipient}
            onChange={(event) => setSetPrimaryRecipient(event.target.checked)}
            disabled={submitting}
          />
          Set as primary
        </label>
      </div>
      <div
        style={{
          border: '1px solid color-mix(in srgb, var(--gold-leaf) 44%, var(--etched-border))',
          background: 'color-mix(in srgb, var(--gold-leaf) 8%, var(--bg-surface))',
          padding: '0.85rem',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          color: 'var(--ink-black)',
        }}
      >
        <AlertTriangle size={17} style={{ color: 'var(--gold-leaf)', flex: '0 0 auto', marginTop: 1 }} />
        <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted)' }}>
          {AGENT_WITHDRAWAL_GAS_NOTICE} This wallet is Base-only right now; do not send to another network.
        </span>
      </div>
    </AgentWalletModalFrame>
  );
}
function walletCustody(wallet: InstanceBankrWalletPublicSummary | null | undefined) {
  return wallet?.custody ?? 'hivra_provisioned';
}
function isUserConnected(wallet: InstanceBankrWalletPublicSummary | null | undefined): boolean {
  return wallet?.status === 'active' && walletCustody(wallet) === 'user_connected';
}
const BANKR_SECURITY_URL = 'https://bankr.bot';
const BANKR_API_KEYS_URL = 'https://bankr.bot/api-keys';
const modalText = { margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' } as const;
const modalNote = { fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted)' } as const;
const modalEyebrow = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  color: 'var(--text-muted)',
  fontWeight: 900,
} as const;
const externalLink = { color: 'var(--gold-leaf)', textDecoration: 'underline' } as const;
const secondaryActionStyle = {
  border: '1px solid var(--etched-border)',
  background: 'transparent',
  color: 'var(--ink-black)',
  padding: '9px 13px',
  fontFamily: 'var(--font-mono), monospace',
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  cursor: 'pointer',
} as const;

/**
 * Whether the connect/disconnect call reached the running agent. The Hermes
 * route reports `configSync`, the Hivra route `envSync`; "skipped" means the
 * runtime takes the change at its next update, "failed" that it couldn't be
 * reached.
 */
function runtimeSyncStatus(data: unknown): 'synced' | 'skipped' | 'failed' | null {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const value = record.envSync ?? record.configSync;
  return value === 'synced' || value === 'skipped' || value === 'failed' ? value : null;
}

function NoticeBox({ children, warn = false }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <div
      style={{
        border: warn
          ? '1px solid color-mix(in srgb, var(--gold-leaf) 44%, var(--etched-border))'
          : '1px solid var(--etched-border)',
        background: warn ? 'color-mix(in srgb, var(--gold-leaf) 8%, var(--bg-surface))' : 'var(--bg-surface)',
        padding: '0.85rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Who holds what, per wallet kind. Facts only: this copy is what the key
 * custody inventory (docs/security/KEY-CUSTODY-INVENTORY.md) says.
 */
export function AgentWalletManagementModal({
  card,
  onClose,
}: {
  card: AgentWalletCardData;
  onClose: () => void;
}) {
  const custody = card.wallet?.evmAddress ? walletCustody(card.wallet) : null;
  return (
    <AgentWalletModalFrame
      title="How this wallet is managed."
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose} className={`${dlg.button} ${dlg.primary}`}>
          Done
        </button>
      }
    >
      {custody === 'user_connected' ? (
        <>
          <p style={modalText}>
            {card.instance.name} uses your own Bankr account. Bankr holds the private keys. Hivra stores the API key you
            gave it, encrypted, and sends it to this agent&apos;s runtime so the agent can act on your Bankr wallet.
          </p>
          <NoticeBox>
            <span className="mono" style={modalEyebrow}>What you control at Bankr</span>
            <span style={modalNote}>
              The key&apos;s permissions and recipient allowlist, and your wallet&apos;s daily and per-transaction spending
              limits (an API key can&apos;t change those). Revoke the key at{' '}
              <a href={BANKR_API_KEYS_URL} target="_blank" rel="noopener noreferrer" style={externalLink}>bankr.bot/api-keys</a>{' '}
              any time. Hivra&apos;s Bankr partner account has no access to your account, and Hivra doesn&apos;t move your
              funds: you do that at bankr.bot.
            </span>
          </NoticeBox>
          <NoticeBox warn>
            <span style={modalNote}>
              Disconnect deletes Hivra&apos;s copy of the key and stops giving it to the agent. The key keeps working at
              Bankr, including any copy the agent already loaded, until you revoke it there.
            </span>
          </NoticeBox>
        </>
      ) : custody === 'hivra_provisioned' ? (
        <>
          <p style={modalText}>
            Hivra created {card.instance.name}&apos;s wallet through its Bankr partner account. Bankr holds the private
            keys. Hivra stores this wallet&apos;s API key, encrypted, and sends it to the agent runtime. Hivra can use that
            key, or its Bankr partner key, to move funds from this wallet, for example when you ask for a withdrawal.
          </p>
          <NoticeBox>
            <span className="mono" style={modalEyebrow}>What you can do here</span>
            <span style={modalNote}>
              Deposit on Base, copy the address, view balances and withdraw Base tokens to an address you choose. Bankr
              doesn&apos;t let anyone export this wallet&apos;s private key.
            </span>
          </NoticeBox>
          <NoticeBox warn>
            <span style={modalNote}>
              To hold the keys yourself, withdraw everything, then choose Switch to your Bankr account. Hivra then stops
              using this wallet and revokes its API keys at Bankr. Base only.
            </span>
          </NoticeBox>
        </>
      ) : (
        <>
          <p style={modalText}>
            Agent wallets connect to your own Bankr account. Hivra doesn&apos;t create wallets for agents.
          </p>
          <NoticeBox>
            <span className="mono" style={modalEyebrow}>How it works</span>
            <span style={modalNote}>
              You create an API key in your Bankr account and paste it here. Hivra stores it encrypted and sends it to this
              agent&apos;s runtime. You set what the key can do and the wallet&apos;s spending limits at Bankr, and you can
              revoke the key there or disconnect it here at any time.
            </span>
          </NoticeBox>
        </>
      )}
    </AgentWalletModalFrame>
  );
}

/**
 * Connect the user's own Bankr account to one agent, or (mode "replace")
 * switch an agent off the wallet Hivra created for it. The key is typed into
 * a password field, sent once over HTTPS, and never shown again: the server
 * returns only its preview.
 */
export function ConnectBankrModal({
  card,
  mode,
  onClose,
  onConnected,
}: {
  card: AgentWalletCardData;
  mode: 'connect' | 'replace';
  onClose: () => void;
  onConnected: (wallet: InstanceBankrWalletPublicSummary) => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [consent, setConsent] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const keyFieldId = useId();
  const replacing = mode === 'replace';
  const ready = apiKey.trim().length > 0 && consent && (!replacing || replaceConfirmed);

  const handleConnect = useCallback(async () => {
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`${agentWalletApiBase(card.instance)}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          consent: true,
          ...(replacing ? { replaceProvisionedWallet: true } : {}),
        }),
      });
      const body = await response.json().catch(() => ({}));
      const wallet = body?.data?.wallet as InstanceBankrWalletPublicSummary | undefined;
      if (!response.ok || !body?.success || !wallet) {
        setError(body?.error || `Connect failed (${response.status})`);
        return;
      }
      setApiKey('');
      onConnected(wallet);
      const runtime = runtimeSyncStatus(body?.data);
      if (runtime === 'failed') {
        setNotice('Connected, but Hivra couldn\'t reach the agent to give it the key. Connect again to retry.');
      } else if (runtime === 'skipped') {
        setNotice('Connected. The agent gets the key at its next update.');
      } else {
        onClose();
      }
    } catch (err) {
      // Never log the key: only the failure's class name leaves the browser.
      clientLog.warn('agent wallet connect request failed', {
        source: 'wallet-page',
        route: '/dashboard/wallet',
        instanceId: card.instance.id,
        failureType: 'agent_wallet_connect_request_failed',
        errorName: err instanceof Error ? err.name : typeof err,
      });
      setError('Connect failed. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }, [apiKey, card.instance, onClose, onConnected, ready, replacing]);

  return (
    <AgentWalletModalFrame
      title={replacing ? <>Switch {card.instance.name} to your Bankr account.</> : <>Connect your Bankr account to {card.instance.name}.</>}
      onClose={onClose}
      dismissOnBackdrop={apiKey.length === 0}
      closeDisabled={submitting}
      footer={
        notice ? (
          <button type="button" onClick={onClose} className={`${dlg.button} ${dlg.primary}`}>
            Done
          </button>
        ) : (
        <>
          <button type="button" onClick={onClose} disabled={submitting} className={`${dlg.button} ${dlg.secondary}`}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConnect}
            disabled={submitting || !ready}
            aria-busy={submitting || undefined}
            className={`${dlg.button} ${dlg.primary}`}
          >
            {submitting ? 'Checking key…' : replacing ? 'Switch wallet' : 'Connect'}
          </button>
        </>
        )
      }
    >
      {notice ? (
        <p role="status" style={modalText}>{notice}</p>
      ) : (
      <>
      <p style={modalText}>
        The agent uses a wallet in your own Bankr account. You decide what it may do there, and you can revoke it at any
        time.
      </p>
      <NoticeBox>
        <span className="mono" style={modalEyebrow}>At bankr.bot</span>
        <ol style={{ ...modalNote, margin: 0, paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <li>
            Sign in at{' '}
            <a href={BANKR_SECURITY_URL} target="_blank" rel="noopener noreferrer" style={externalLink}>bankr.bot</a>.
            Bankr suggests a separate account for each agent, funded with only what it needs.
          </li>
          <li>Under Security, set a daily spending limit and a per-transaction limit. An API key can&apos;t change them.</li>
          <li>
            At{' '}
            <a href={BANKR_API_KEYS_URL} target="_blank" rel="noopener noreferrer" style={externalLink}>bankr.bot/api-keys</a>,
            create a key for this agent. Turn on Wallet API only if the agent should transact (otherwise turn on
            read-only), leave Agent API and token launching off unless you need them, and add allowed recipients if you
            know them.
          </li>
        </ol>
      </NoticeBox>
      {replacing && (
        <NoticeBox warn>
          <span style={modalNote}>
            Withdraw everything from the wallet Hivra created first; Hivra checks it is empty (up to 0.0001 ETH of gas
            dust can stay). After the switch, Hivra stops using that wallet and revokes its API keys at Bankr.
          </span>
          <label style={{ ...modalNote, display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={replaceConfirmed}
              onChange={(event) => setReplaceConfirmed(event.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>Replace the wallet Hivra created for {card.instance.name}.</span>
          </label>
        </NoticeBox>
      )}
      <label htmlFor={keyFieldId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--text-muted)', fontWeight: 800 }}>
          Bankr API key
        </span>
        <input
          id={keyFieldId}
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="bk_…"
          autoComplete="off"
          spellCheck={false}
          className="mono"
          style={{
            border: '1px solid var(--etched-border)',
            background: 'var(--bg-surface)',
            color: 'var(--ink-black)',
            padding: '10px 12px',
            fontSize: 12,
            outline: 'none',
          }}
        />
      </label>
      <label style={{ ...modalNote, display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>
          I authorise Hivra to store this key encrypted and send it to {card.instance.name}&apos;s runtime, where the agent
          can use it on my Bankr wallet within the permissions and limits I set at Bankr. I can revoke it at
          bankr.bot/api-keys or disconnect it here at any time.
        </span>
      </label>
      {error && (
        <span role="alert" style={{ fontSize: 12, color: 'var(--gold-leaf)' }}>
          {error}
        </span>
      )}
      </>
      )}
    </AgentWalletModalFrame>
  );
}

export function DisconnectBankrModal({
  card,
  onClose,
  onDisconnected,
}: {
  card: AgentWalletCardData;
  onClose: () => void;
  onDisconnected: (wallet: InstanceBankrWalletPublicSummary) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleDisconnect = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`${agentWalletApiBase(card.instance)}/connect`, { method: 'DELETE' });
      const body = await response.json().catch(() => ({}));
      const wallet = body?.data?.wallet as InstanceBankrWalletPublicSummary | undefined;
      if (!response.ok || !body?.success || !wallet) {
        setError(body?.error || `Disconnect failed (${response.status})`);
        return;
      }
      onDisconnected(wallet);
      if (runtimeSyncStatus(body?.data) === 'synced') {
        onClose();
      } else {
        setNotice(
          'Hivra deleted its copy, but couldn\'t confirm the key was removed from the running agent. Revoke it at bankr.bot/api-keys to stop the agent using it.'
        );
      }
    } catch {
      setError('Disconnect failed. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }, [card.instance, onClose, onDisconnected]);

  return (
    <AgentWalletModalFrame
      title={<>Disconnect your Bankr account from {card.instance.name}?</>}
      onClose={onClose}
      closeDisabled={submitting}
      footer={
        notice ? (
          <button type="button" onClick={onClose} className={`${dlg.button} ${dlg.primary}`}>
            Done
          </button>
        ) : (
        <>
          <button type="button" onClick={onClose} disabled={submitting} className={`${dlg.button} ${dlg.secondary}`}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDisconnect}
            disabled={submitting}
            aria-busy={submitting || undefined}
            className={`${dlg.button} ${dlg.primary}`}
          >
            {submitting ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </>
        )
      }
    >
      {notice && (
        <p role="status" style={modalText}>{notice}</p>
      )}
      <p style={modalText}>
        Hivra deletes its copy of the key and stops giving it to the agent. Your funds stay in your Bankr account.
      </p>
      <NoticeBox warn>
        <span style={modalNote}>
          The key still works at Bankr, including any copy the agent already loaded, until you revoke it at{' '}
          <a href={BANKR_API_KEYS_URL} target="_blank" rel="noopener noreferrer" style={externalLink}>bankr.bot/api-keys</a>.
        </span>
      </NoticeBox>
      {error && (
        <span role="alert" style={{ fontSize: 12, color: 'var(--gold-leaf)' }}>
          {error}
        </span>
      )}
    </AgentWalletModalFrame>
  );
}
export function AgentWalletCard({
  card,
  onDeposit,
  onManage,
  onSetDestination,
  onWithdraw,
  onConnect,
  onDisconnect,
  onRefresh,
}: {
  card: AgentWalletCardData;
  onDeposit: (card: AgentWalletCardData) => void;
  onManage: (card: AgentWalletCardData) => void;
  onSetDestination: (card: AgentWalletCardData) => void;
  onWithdraw: (card: AgentWalletCardData) => void;
  /** "connect" for an agent with no wallet; "replace" to switch off a Hivra-created one. */
  onConnect: (card: AgentWalletCardData, mode: 'connect' | 'replace') => void;
  onDisconnect: (card: AgentWalletCardData) => void;
  onRefresh: () => void;
}) {
  const wallet = card.wallet;
  const address = wallet?.evmAddress;
  const primaryRecipient = primaryAgentWalletRecipient(card);
  const needsWallet = !address;
  const connected = isUserConnected(wallet);
  const hivraCreated = Boolean(address) && !connected;
  const ethBalance = agentBaseEthBalance(card);
  const hermesOsBalance = card.balances.find((balance) => balance.tokenSymbol === 'HERMESOS') ?? null;
  // Payouts exist only for wallets Hivra created (both lanes route by
  // agentWalletApiBase). A user's own Bankr account is managed at bankr.bot:
  // Hivra never initiates transfers from it, and its withdraw routes refuse.
  const payoutsSupported = hivraCreated;
  const canWithdraw = Boolean(address && agentWalletWithdrawableBalances(card).length > 0);
  const withdrawReasonId = useId();
  const headlineBalances = [
    ethBalance ? { key: 'ETH', label: 'Base ETH', balance: ethBalance } : null,
    hermesOsBalance ? { key: 'HERMESOS', label: 'Base HERMESOS', balance: hermesOsBalance } : null,
  ].filter((entry): entry is { key: string; label: string; balance: AgentWalletBalance } => Boolean(entry));

  return (
    <article
      style={{
        border: '1px solid var(--etched-border)',
        background: 'var(--bg-surface)',
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.18em', color: 'var(--text-muted)', fontWeight: 800 }}>
            AGENT
          </span>
          <span style={{ color: 'var(--ink-black)', fontSize: 14, wordBreak: 'break-word' }}>{card.instance.name}</span>
        </div>
        {needsWallet && (
          <span
            className="mono"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: '1px solid color-mix(in srgb, var(--gold-leaf) 34%, transparent)',
              color: 'var(--gold-leaf)',
              padding: '4px 7px',
              fontSize: 9,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              whiteSpace: 'nowrap',
              fontWeight: 800,
            }}
          >
            <span aria-hidden style={{ width: 6, height: 6, background: 'var(--gold-leaf)', display: 'inline-block' }} />
            Not connected
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
        {address && (
          <span
            className="mono"
            style={{
              border: '1px solid color-mix(in srgb, var(--gold-leaf) 34%, transparent)',
              color: 'var(--gold-leaf)',
              padding: '4px 7px',
              fontSize: 9,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              fontWeight: 800,
            }}
          >
            Base only
          </span>
        )}
        {address && (
          <span
            className="mono"
            data-testid="agent-wallet-custody"
            style={{
              border: '1px solid var(--etched-border)',
              color: 'var(--text-muted)',
              padding: '4px 7px',
              fontSize: 9,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              fontWeight: 800,
            }}
          >
            {connected ? 'Your Bankr account' : 'Created by Hivra'}
          </span>
        )}
        <code
          className="mono agent-wallet-address-full notranslate"
          translate="no"
          style={{ fontSize: 12, color: 'var(--ink-black)', wordBreak: 'break-all', flex: '1 1 220px', minWidth: 0 }}
        >
          {address ?? 'Connect your Bankr account to use a wallet'}
        </code>
        {address && (
          <code className="mono agent-wallet-address-short notranslate" translate="no" style={{ fontSize: 12, color: 'var(--ink-black)' }}>
            {shorten(address)}
          </code>
        )}
        <AgentWalletCopyButton text={address ?? null} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {headlineBalances.length > 0 ? (
          <div
            aria-label="Primary Base balances"
            className="notranslate"
            translate="no"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))',
              gap: 12,
            }}
          >
            {headlineBalances.map((entry) => {
              // 18-decimal token balances are one unbreakable digit run, so
              // the headline shows at most 6 fraction digits (cut, never
              // rounded up); the exact value stays in the title and on copy.
              const exact = formatWalletAmountDisplay(entry.balance.balanceDisplay);
              const shortened = isWalletAmountShortened(entry.balance.balanceDisplay);
              const compact = formatWalletAmountCompact(entry.balance.balanceDisplay);
              return (
                // A long balance takes the whole row instead of wrapping
                // mid-number in a half-width cell.
                <div key={entry.key} style={{ minWidth: 0, gridColumn: compact.length > 11 ? '1 / -1' : undefined }}>
                  <span
                    className="serif"
                    title={shortened ? exact : undefined}
                    data-testid={`agent-wallet-headline-${entry.key}`}
                    style={{
                      display: 'block',
                      fontSize: 'clamp(1.4rem, 7vw, 2rem)',
                      lineHeight: 1.05,
                      fontWeight: 400,
                      fontVariantNumeric: 'tabular-nums',
                      color: 'var(--ink-black)',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {compact}
                  </span>
                  <span className="mono" style={{ display: 'block', marginTop: 4, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.18em', color: 'var(--text-muted)', fontWeight: 800 }}>
                    {entry.label}
                  </span>
                  {shortened && (
                    <div className={touchStyles.copyRow} style={{ marginTop: 8 }}>
                      <CopyButton
                        value={entry.balance.balanceDisplay.replace(/,/g, '')}
                        label="Copy exact"
                        ariaLabel={`Copy exact ${entry.label} balance`}
                        title={exact}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div>
            <span className="serif" style={{ display: 'block', fontSize: '2rem', lineHeight: 1.05, fontWeight: 400, color: 'var(--ink-black)' }}>
              —
            </span>
            <span className="mono" style={{ display: 'block', marginTop: 4, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.18em', color: 'var(--text-muted)', fontWeight: 800 }}>
              {card.balanceFailed ? 'Balance unavailable' : 'Base balance'}
            </span>
          </div>
        )}
        {card.balanceFailed && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
            <button
              type="button"
              onClick={onRefresh}
              className={touchStyles.touchTarget}
              style={{
                border: 0,
                background: 'transparent',
                color: 'var(--gold-leaf)',
                cursor: 'pointer',
                font: 'inherit',
                padding: 0,
                textTransform: 'uppercase',
                letterSpacing: '0.18em',
              }}
            >
              Retry
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
              {card.balanceError?.message ?? 'Balance check failed. Your wallet address is still usable.'}
              {card.balanceError?.requestId ? ` Request ${card.balanceError.requestId}.` : ''}
            </span>
          </div>
        )}
        {card.balances.length > 0 && (
          <div
            aria-label="Base token balances"
            className="notranslate"
            translate="no"
            style={{
              marginTop: 8,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 120px), 1fr))',
              gap: 8,
            }}
          >
            {card.balances.map((balance) => (
              <div
                key={`${balance.tokenSymbol}-${balance.tokenAddress ?? 'native'}`}
                style={{
                  border: '1px solid var(--etched-border)',
                  background: 'color-mix(in srgb, var(--bg-surface) 82%, transparent)',
                  padding: '8px 9px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  minWidth: 0,
                }}
              >
                <span className="mono" style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 800 }}>
                  Base {balance.tokenSymbol}
                </span>
                <span
                  className="mono"
                  title={isWalletAmountShortened(balance.balanceDisplay) ? formatWalletAmountDisplay(balance.balanceDisplay) : undefined}
                  style={{ fontSize: 12, color: 'var(--ink-black)', overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatWalletAmountCompact(balance.balanceDisplay)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {payoutsSupported && (
      <div
        style={{
          borderTop: '1px solid var(--etched-border)',
          paddingTop: 12,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--text-muted)', fontWeight: 800 }}>
            Primary withdrawal recipient
          </span>
          {primaryRecipient ? (
            <>
              <code className="mono notranslate" translate="no" style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--ink-black)' }}>
                {primaryRecipient}
              </code>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                Recent recipients appear in the withdraw modal. {AGENT_WITHDRAWAL_GAS_NOTICE}
              </span>
            </>
          ) : (
            <>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No primary recipient set</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                You can enter a recipient during withdrawal and optionally make it primary. {AGENT_WITHDRAWAL_GAS_NOTICE}
              </span>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => onSetDestination(card)}
          disabled={!address}
          className={touchStyles.touchTarget}
          style={{
            border: '1px solid var(--etched-border)',
            background: 'transparent',
            color: 'var(--ink-black)',
            padding: '7px 10px',
            cursor: address ? 'pointer' : 'not-allowed',
            opacity: address ? 1 : 0.45,
            fontFamily: 'var(--font-mono), monospace',
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          {primaryRecipient ? 'Change' : 'Set primary'}
        </button>
      </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
        {address ? (
          <button
            type="button"
            onClick={() => onDeposit(card)}
            className={touchStyles.touchTarget}
            style={{
              border: '1px solid var(--ink-black)',
              background: 'var(--ink-black)',
              color: 'var(--bg-surface)',
              padding: '9px 13px',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            Deposit on Base
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onConnect(card, 'connect')}
            className={touchStyles.touchTarget}
            style={{
              border: '1px solid var(--ink-black)',
              background: 'var(--ink-black)',
              color: 'var(--bg-surface)',
              padding: '9px 13px',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            Connect Bankr account
          </button>
        )}
        {address && payoutsSupported && (
          <button
            type="button"
            onClick={() => onWithdraw(card)}
            disabled={!canWithdraw}
            aria-describedby={!canWithdraw ? withdrawReasonId : undefined}
            className={touchStyles.touchTarget}
            style={{
              border: '1px solid var(--etched-border)',
              background: 'transparent',
              color: 'var(--ink-black)',
              padding: '9px 13px',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              cursor: canWithdraw ? 'pointer' : 'not-allowed',
              opacity: canWithdraw ? 1 : 0.45,
            }}
          >
            Withdraw on Base
            <ArrowUpFromLine size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={() => onManage(card)}
          className={touchStyles.touchTarget}
          style={{
            border: '1px solid var(--etched-border)',
            background: 'transparent',
            color: 'var(--ink-black)',
            padding: '9px 13px',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
          }}
        >
          How management works
          <Info size={12} />
        </button>
        {connected && (
          <>
            <a
              href={BANKR_SECURITY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={touchStyles.touchTarget}
              style={{ ...secondaryActionStyle, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
            >
              Manage at bankr.bot
            </a>
            <button type="button" onClick={() => onDisconnect(card)} className={touchStyles.touchTarget} style={secondaryActionStyle}>
              Disconnect
            </button>
          </>
        )}
        {hivraCreated && (
          <button type="button" onClick={() => onConnect(card, 'replace')} className={touchStyles.touchTarget} style={secondaryActionStyle}>
            Switch to your Bankr account
          </button>
        )}
        {connected && wallet?.apiKeyPreview && (
          <span className="mono notranslate" translate="no" style={{ flexBasis: '100%', fontSize: 11, lineHeight: 1.45, color: 'var(--text-muted)' }}>
            Key {wallet.apiKeyPreview}
            {wallet.connectedAt ? ` · connected ${new Date(wallet.connectedAt).toLocaleDateString()}` : ''}
          </span>
        )}
        {address && payoutsSupported && !canWithdraw && (
          // The reason Withdraw is disabled, as text (a title tooltip never
          // shows on touch screens).
          <span
            id={withdrawReasonId}
            style={{ flexBasis: '100%', fontSize: 11, lineHeight: 1.45, color: 'var(--text-secondary)' }}
          >
            No Base token balance to withdraw
          </span>
        )}
      </div>

    </article>
  );
}
export function AgentWalletsSection({
  state,
  onRefresh,
  onWalletUpdated,
}: {
  state: AgentWalletsState;
  onRefresh: () => void;
  onWalletUpdated: (instanceId: string, wallet: InstanceBankrWalletPublicSummary) => void;
}) {
  const { copy } = useLocale();
  const agentWalletsCopy = copy.dashboard.wallet.agentWallets;
  const [depositCard, setDepositCard] = useState<AgentWalletCardData | null>(null);
  const [destinationCard, setDestinationCard] = useState<AgentWalletCardData | null>(null);
  const [withdrawRequest, setWithdrawRequest] = useState<AgentWalletCardData | null>(null);
  const [managementCard, setManagementCard] = useState<AgentWalletCardData | null>(null);
  const [connectRequest, setConnectRequest] = useState<{ card: AgentWalletCardData; mode: 'connect' | 'replace' } | null>(null);
  const [disconnectCard, setDisconnectCard] = useState<AgentWalletCardData | null>(null);

  return (
    <section aria-label={agentWalletsCopy.ariaLabel} style={{ margin: '1.5rem 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 className="serif" style={{ fontSize: '1.7rem', fontWeight: 400, margin: 0, color: 'var(--ink-black)' }}>
          {agentWalletsCopy.title}
        </h2>
        <span className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.18em', opacity: 0.5, color: 'var(--text-muted)', fontWeight: 800 }}>
          {agentWalletsCopy.subtitle}
        </span>
      </div>

      {state.totalAgents === 0 ? (
        <div
          style={{
            border: '1px solid var(--etched-border)',
            background: 'var(--bg-elevated)',
            padding: '1rem 1.25rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55 }}>
            {agentWalletsCopy.emptyNoAgents}
          </span>
          <Link
            href="/dashboard"
            style={{
              border: '1px solid var(--ink-black)',
              background: 'var(--ink-black)',
              color: 'var(--bg-surface)',
              padding: '9px 13px',
              textDecoration: 'none',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            {agentWalletsCopy.deployAgent}
          </Link>
        </div>
      ) : state.cards.length === 0 ? (
        <div
          style={{
            border: '1px solid var(--etched-border)',
            background: 'var(--bg-elevated)',
            padding: '1rem 1.25rem',
            color: 'var(--text-muted)',
            fontSize: 13,
          }}
        >
          {agentWalletsCopy.runningEmpty}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
            gap: '1rem',
          }}
        >
          {state.cards.map((card) => (
            <AgentWalletCard
              key={card.instance.id}
              card={card}
              onDeposit={setDepositCard}
              onManage={setManagementCard}
              onSetDestination={setDestinationCard}
              onWithdraw={setWithdrawRequest}
              onConnect={(target, mode) => setConnectRequest({ card: target, mode })}
              onDisconnect={setDisconnectCard}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}

      <BankrTrustFooter note="connect your own Bankr account" />

      {depositCard && <AgentDepositModal card={depositCard} onClose={() => setDepositCard(null)} />}
      {managementCard && <AgentWalletManagementModal card={managementCard} onClose={() => setManagementCard(null)} />}
      {connectRequest && (
        <ConnectBankrModal
          card={connectRequest.card}
          mode={connectRequest.mode}
          onClose={() => setConnectRequest(null)}
          onConnected={(wallet) => {
            onWalletUpdated(connectRequest.card.instance.id, wallet);
            onRefresh();
          }}
        />
      )}
      {disconnectCard && (
        <DisconnectBankrModal
          card={disconnectCard}
          onClose={() => setDisconnectCard(null)}
          onDisconnected={(wallet) => {
            onWalletUpdated(disconnectCard.instance.id, wallet);
            onRefresh();
          }}
        />
      )}
      {withdrawRequest && (
        <AgentWalletWithdrawModal
          card={withdrawRequest}
          onClose={() => setWithdrawRequest(null)}
          onSubmitted={(wallet) => {
            if (wallet) onWalletUpdated(withdrawRequest.instance.id, wallet);
            onRefresh();
          }}
        />
      )}
      {destinationCard && (
        <WithdrawalDestinationModal
          card={destinationCard}
          onClose={() => setDestinationCard(null)}
          onSaved={(wallet) => {
            onWalletUpdated(destinationCard.instance.id, wallet);
            onRefresh();
          }}
        />
      )}
    </section>
  );
}
