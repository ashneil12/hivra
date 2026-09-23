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
export function BankrTrustFooter({ withdrawable = false }: { withdrawable?: boolean }) {
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
        {withdrawable ? 'your wallet · withdraw any time' : 'payment address on Base'}
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
export function AgentWalletManagementModal({
  card,
  onClose,
}: {
  card: AgentWalletCardData;
  onClose: () => void;
}) {
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
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
        {card.instance.name}&apos;s wallet is created through Bankr for this one agent. Bankr custodies the private keys; Hivra stores only this agent wallet&apos;s API key and sends it to the agent runtime.
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
        <span className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--text-muted)', fontWeight: 900 }}>
          What you can do in V1
        </span>
        <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted)' }}>
          Deposit on Base, copy the wallet address, view balances here, and withdraw Base tokens to a chosen recipient. Direct Bankr-side management or private-key export is not available in this version.
        </span>
      </div>
      <div
        style={{
          border: '1px solid color-mix(in srgb, var(--gold-leaf) 44%, var(--etched-border))',
          background: 'color-mix(in srgb, var(--gold-leaf) 8%, var(--bg-surface))',
          padding: '0.85rem',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
        }}
      >
        <AlertTriangle size={17} style={{ color: 'var(--gold-leaf)', flex: '0 0 auto', marginTop: 1 }} />
        <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted)' }}>
          This V1 wallet is Base-only. Multi-chain deposits are not supported yet.
        </span>
      </div>
    </AgentWalletModalFrame>
  );
}
export function AgentWalletCard({
  card,
  onDeposit,
  onManage,
  onSetDestination,
  onWithdraw,
  onCreateWallet,
  creatingWallet,
  onRefresh,
}: {
  card: AgentWalletCardData;
  onDeposit: (card: AgentWalletCardData) => void;
  onManage: (card: AgentWalletCardData) => void;
  onSetDestination: (card: AgentWalletCardData) => void;
  onWithdraw: (card: AgentWalletCardData) => void;
  onCreateWallet: (card: AgentWalletCardData) => void;
  creatingWallet: boolean;
  onRefresh: () => void;
}) {
  const wallet = card.wallet;
  const address = wallet?.evmAddress;
  const primaryRecipient = primaryAgentWalletRecipient(card);
  const pending = wallet?.status === 'pending';
  const needsWallet = !address;
  const ethBalance = agentBaseEthBalance(card);
  const hermesOsBalance = card.balances.find((balance) => balance.tokenSymbol === 'HERMESOS') ?? null;
  // Both lanes now have working payout routes: Hermes at
  // /api/instances/[id]/bankr-wallet/{withdraw,withdraw-destination} and Hivra
  // at /api/hivra/agents/[id]/bankr-wallet/{withdraw,set-destination}. The
  // modals route by lane (see agentWalletApiBase), so payouts are supported for
  // every agent that has a wallet.
  const payoutsSupported = true;
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
            {pending ? 'Provisioning…' : 'Not created'}
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
        <code
          className="mono agent-wallet-address-full notranslate"
          translate="no"
          style={{ fontSize: 12, color: 'var(--ink-black)', wordBreak: 'break-all', flex: '1 1 220px', minWidth: 0 }}
        >
          {address ?? 'Create wallet to receive address'}
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
            onClick={() => onCreateWallet(card)}
            disabled={creatingWallet}
            className={touchStyles.touchTarget}
            style={{
              border: '1px solid var(--ink-black)',
              background: 'var(--ink-black)',
              color: 'var(--bg-surface)',
              padding: '9px 13px',
              cursor: creatingWallet ? 'wait' : 'pointer',
              opacity: creatingWallet ? 0.7 : 1,
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            {creatingWallet ? 'Creating…' : 'Create wallet'}
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
  const [creatingWalletIds, setCreatingWalletIds] = useState<Set<string>>(() => new Set());

  const handleCreateWallet = useCallback(async (card: AgentWalletCardData) => {
    const instanceId = card.instance.id;
    setCreatingWalletIds((prev) => new Set(prev).add(instanceId));
    try {
      const response = await fetch(agentWalletApiBase(card.instance), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = await response.json().catch(() => ({}));
      const wallet = body?.data?.wallet as InstanceBankrWalletPublicSummary | undefined;
      if (response.ok && wallet) {
        onWalletUpdated(instanceId, wallet);
        return;
      }
      onRefresh();
    } finally {
      setCreatingWalletIds((prev) => {
        const next = new Set(prev);
        next.delete(instanceId);
        return next;
      });
    }
  }, [onRefresh, onWalletUpdated]);

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
              onCreateWallet={handleCreateWallet}
              creatingWallet={creatingWalletIds.has(card.instance.id)}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}

      <BankrTrustFooter withdrawable />

      {depositCard && <AgentDepositModal card={depositCard} onClose={() => setDepositCard(null)} />}
      {managementCard && <AgentWalletManagementModal card={managementCard} onClose={() => setManagementCard(null)} />}
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
