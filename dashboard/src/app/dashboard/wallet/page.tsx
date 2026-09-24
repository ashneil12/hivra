'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { CheckCircle2, Copy, AlertTriangle, ArrowDownToLine, ExternalLink } from 'lucide-react';
import touch from '@/components/tools/touch.module.css';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { TokenGeoNotice } from '@/components/token/TokenGeoNotice';
import { useTokenGeoAccess } from '@/hooks/useTokenGeoAccess';
import { copyTextToClipboard } from '@/lib/client/clipboard';
import { readJsonWithDiagnostics } from '@/lib/client/json-response-diagnostics';
import { LAUNCH_ROUTE } from '@/lib/hivra/launch-navigation';
import { planReturnParams, withReturnParams } from '@/lib/safe-return-path';
import {
  describeMissingWalletEnvironment,
  describeWalletProviderError,
  detectInAppBrowser,
  requestWalletProvider,
  type BrowserWalletProvider,
} from '@/lib/client/wallet-provider-errors';
import {
  loadAgentWalletsFromApi,
  type AgentWalletsState,
  type InstanceBankrWalletPublicSummary,
} from './agent-wallet-data';
// Pure formatters, validators and payload readers live in
// "@/lib/wallet/format" so they can be tested without a DOM.
import {
  activeQuoteForTier,
  apiPayloadError,
  apiSuccessData,
  highestEligibleTier,
  isDepositQuotePayload,
  isRecord,
  lockedQuantityForTier,
  lockedThresholdFor,
  nextSelfCustodyLockTier,
  readChallengeData,
  readWalletAccounts,
  shorten,
  tierName,
  walletAddressFromEligibility,
} from "@/lib/wallet/format";
import type {
  EligibilityPayload,
  QuotesResponse,
} from "@/lib/wallet/format";
// The eligibility cluster (panel + boost row + price line + tier row) lives in
// "@/components/wallet/EligibilitySection".
import { EligibilityPanel } from "@/components/wallet/EligibilitySection";
// Agent-wallet cards, their deposit / withdrawal / management modals and the
// trust footer live in "@/components/wallet/AgentWalletCards".
import { AgentWalletsSection } from "@/components/wallet/AgentWalletCards";
// The withdraw lane (destination card, address form, withdraw section, confirm
// dialog, unlock prompt and the shared action row) lives in
// "@/components/wallet/WithdrawSection".
import {
  ActionRow,
  UnlockPromptCard,
  WithdrawAddressForm,
  WithdrawDestinationCard,
  WithdrawSection,
} from "@/components/wallet/WithdrawSection";
// The buy-token card, self-custody verification panel and deposit-quote
// card/panel live in "@/components/wallet/QuoteSection".
import {
  BuyTokenCard,
  QuotePanel,
  SelfCustodyVerificationPanel,
} from "@/components/wallet/QuoteSection";



interface BankrLinkedWalletResponse {
  id: string;
  userId: string;
  address: string;
  normalizedAddress: string;
  chainId: number | null;
  isPrimary: boolean;
  verifiedAt: string | null;
  bankrWalletId: string | null;
}

interface BankrDepositWalletSummary {
  custodyModel: string;
  address: string | null;
  normalizedAddress: string | null;
  bankrWalletId: string | null;
  sweepReady: boolean;
  allowedRecipientEvm: string | null;
}

interface WalletApiPayload {
  status?: 'existing' | 'self_custody_required';
  custodyMode?: 'legacy_custody' | 'self_custody';
  wallet: BankrLinkedWalletResponse | null;
  depositWallet: BankrDepositWalletSummary | null;
  creditDepositWallet: BankrDepositWalletSummary | null;
  tokenLockWallet: BankrDepositWalletSummary | null;
}


type WalletStatus = 'loading' | 'ready' | 'unprovisioned' | 'unavailable' | 'error';


function getBrowserWalletProvider(): BrowserWalletProvider | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { ethereum?: BrowserWalletProvider }).ethereum ?? null;
}


async function readApiPayload(response: Response): Promise<Record<string, unknown> | null> {
  const payload = await readJsonWithDiagnostics(response, {
    source: "wallet-page",
    route: "/dashboard/wallet",
  });
  return isRecord(payload) ? payload : null;
}


interface WithdrawAddressPayload {
  address: string | null;
  normalizedAddress?: string | null;
  setAt?: string;
  updatedAt?: string;
}


function hasCoarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

/** Wallet-app deep links that reopen this page inside the wallet's own browser. */
function walletAppLinks(href: string): { metamask: string; coinbase: string } | null {
  try {
    const url = new URL(href);
    return {
      metamask: `https://metamask.app.link/dapp/${url.host}${url.pathname}${url.search}`,
      coinbase: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url.href)}`,
    };
  } catch {
    return null;
  }
}

const walletLinkButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  minHeight: 44,
  padding: '10px 14px',
  border: '1px solid var(--ink-black)',
  background: 'var(--ink-black)',
  color: 'var(--bg-surface)',
  textDecoration: 'none',
  fontFamily: 'var(--font-mono), monospace',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
};

/**
 * Always-mounted wallet-environment notice. Solves two failure modes that
 * previously left the verify/unlock buttons feeling inert:
 *  - In an in-app browser (Discord etc.) there is no injected wallet, so the
 *    flow can't work — we proactively explain that and offer wallet-app deep
 *    links plus a copyable link. Plain mobile browsers get the same notice only
 *    when a visible action needs a wallet: self-custody verification, or Unlock
 *    now before any wallet is verified. Legacy custody otherwise locks by deposit.
 *  - walletConnectError used to render ONLY inside SelfCustodyVerificationPanel,
 *    so legacy-custody users (who never see that panel) got no feedback at all.
 *    We surface connect error/success here whenever that panel isn't shown.
 */
function WalletEnvironmentNotice({
  inApp,
  hasProvider,
  coarsePointer,
  walletAction,
  pageHref,
  connectError,
  connectSuccess,
  showConnectMessages,
  onCopyLink,
  linkCopied,
}: {
  inApp: { isInApp: boolean; appName: string | null };
  hasProvider: boolean;
  /** Touch devices: plain mobile Safari/Chrome have no injected wallet either. */
  coarsePointer: boolean;
  /** 'verify': self-custody Connect/Verify/Unlock; 'unlock': only Unlock now needs a wallet. */
  walletAction: 'verify' | 'unlock' | null;
  pageHref: string | null;
  connectError: string | null;
  connectSuccess: string | null;
  showConnectMessages: boolean;
  onCopyLink: () => void;
  linkCopied: boolean;
}) {
  const showInAppBanner = !hasProvider && (inApp.isInApp || (coarsePointer && walletAction !== null));
  const deepLinks = pageHref ? walletAppLinks(pageHref) : null;
  const showError = showConnectMessages && Boolean(connectError);
  const showSuccess = showConnectMessages && Boolean(connectSuccess) && !showError;
  if (!showInAppBanner && !showError && !showSuccess) return null;

  const appLabel = inApp.appName === 'an in-app' ? 'an in-app' : inApp.appName;
  const copyButton = (
    <button
      type="button"
      onClick={onCopyLink}
      className={touch.touchButton}
      style={{
        alignSelf: 'flex-start',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        border: '1px solid var(--ink-black)',
        background: 'transparent',
        color: 'var(--ink-black)',
        cursor: 'pointer',
        fontFamily: 'var(--font-mono), monospace',
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
      }}
    >
      {linkCopied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
      {linkCopied ? 'Link copied' : 'Copy dashboard link'}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: '1.5rem' }}>
      {showInAppBanner && (
        <div
          role="status"
          style={{
            border: '1px solid color-mix(in srgb, var(--gold-leaf) 35%, transparent)',
            background: 'color-mix(in srgb, var(--gold-leaf) 6%, transparent)',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
          }}
        >
          <AlertTriangle size={15} style={{ color: 'var(--gold-leaf)', flexShrink: 0, marginTop: 2 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            {inApp.isInApp ? (
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--ink-black)' }}>
                You&apos;re viewing this in {appLabel ? `${appLabel} browser` : 'an in-app browser'}, which
                can&apos;t connect a crypto wallet — so the verify buttons won&apos;t do anything here. Open
                the dashboard in your wallet app&apos;s built-in browser, or in Chrome/Safari with a
                Base-compatible wallet, then verify again. Refreshing this page won&apos;t help.
              </p>
            ) : walletAction === 'unlock' ? (
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--ink-black)' }}>
                This browser has no crypto wallet, so Unlock now can&apos;t verify your holdings here.
                Locking a tier by deposit still works. To unlock, open this page in your wallet app&apos;s
                built-in browser.
              </p>
            ) : (
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--ink-black)' }}>
                This browser has no crypto wallet, so Connect, Verify and Unlock can&apos;t work here. Open
                this page in your wallet app&apos;s built-in browser, then verify again.
              </p>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 8 }}>
              {deepLinks && (
                <>
                  <a href={deepLinks.metamask} rel="noopener noreferrer" style={walletLinkButtonStyle}>
                    Open in MetaMask <ExternalLink size={12} aria-hidden="true" />
                  </a>
                  <a href={deepLinks.coinbase} rel="noopener noreferrer" style={walletLinkButtonStyle}>
                    Open in Coinbase Wallet <ExternalLink size={12} aria-hidden="true" />
                  </a>
                </>
              )}
              {copyButton}
            </div>
          </div>
        </div>
      )}
      {showError && (
        <div
          role="alert"
          style={{
            border: '1px solid #dc2626',
            background: 'color-mix(in srgb, #dc2626 5%, transparent)',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
          }}
        >
          <AlertTriangle size={15} style={{ color: '#dc2626', flexShrink: 0, marginTop: 2 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: '#dc2626' }}>{connectError}</p>
            {!hasProvider && copyButton}
          </div>
        </div>
      )}
      {showSuccess && (
        <p role="status" style={{ fontSize: 12.5, color: '#16a34a', margin: 0, lineHeight: 1.5 }}>
          {connectSuccess}
        </p>
      )}
    </div>
  );
}

export default function WalletPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { copy } = useLocale();
  const walletCopy = copy.dashboard.wallet;
  // Token geo-policy: "allowed" at once while the policy is dormant.
  const tokenGeo = useTokenGeoAccess();
  const fromWelcome = searchParams?.get('from') === 'welcome';
  const welcomeRedirectFiredRef = useRef(false);
  const [data, setData] = useState<WalletApiPayload | null>(null);
  const [eligibility, setEligibility] = useState<EligibilityPayload | null>(null);
  const [priceUnavailable, setPriceUnavailable] = useState(false);
  const [status, setStatus] = useState<WalletStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [walletLockingPrice, setWalletLockingPrice] = useState(false);
  const [verifiedWalletAddress, setVerifiedWalletAddress] = useState<string | null>(null);
  const [walletConnectError, setWalletConnectError] = useState<string | null>(null);
  const [walletConnectSuccess, setWalletConnectSuccess] = useState<string | null>(null);
  const [withdrawAddress, setWithdrawAddress] = useState<string | null>(null);
  const [withdrawAddressLoading, setWithdrawAddressLoading] = useState(true);
  const [withdrawAddressFormOpen, setWithdrawAddressFormOpen] = useState(false);
  const [quotes, setQuotes] = useState<QuotesResponse>({ pro: null, power: null });
  const [mintingTier, setMintingTier] = useState<'pro' | 'power' | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [agentWallets, setAgentWallets] = useState<AgentWalletsState>({ totalAgents: 0, cards: [] });
  const [unlocking, setUnlocking] = useState(false);
  const [unlockMsg, setUnlockMsg] = useState<string | null>(null);
  const [promptDismissed, setPromptDismissed] = useState<{ holding: boolean; venice: boolean }>({
    holding: false,
    venice: false,
  });
  // Resolved on the client after mount (avoids SSR/hydration mismatch): does
  // this browser expose a wallet, and is it an in-app webview that can't?
  const [walletEnv, setWalletEnv] = useState<{
    hasProvider: boolean;
    inApp: { isInApp: boolean; appName: string | null };
    coarsePointer: boolean;
    pageHref: string;
  } | null>(null);
  const [dashboardLinkCopied, setDashboardLinkCopied] = useState(false);

  const loadQuotes = useCallback(async () => {
    try {
      const response = await fetch('/api/billing/wallet/quote', { method: 'GET' });
      if (!response.ok) {
        // 404 → billing v2 disabled; 401 → not signed in. Treat as no quotes.
        setQuotes({ pro: null, power: null });
        return;
      }
      const body = await response.json().catch(() => ({}));
      const data = body?.data as QuotesResponse | undefined;
      setQuotes({ pro: data?.pro ?? null, power: data?.power ?? null });
    } catch {
      setQuotes({ pro: null, power: null });
    }
  }, []);

  const handleMintQuote = useCallback(
    async (tier: 'pro' | 'power') => {
      setMintingTier(tier);
      setQuoteError(null);
      try {
        const response = await fetch('/api/billing/wallet/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body?.success) {
          setQuoteError(body?.error || `Quote failed (${response.status})`);
          return;
        }
        if (!isDepositQuotePayload(body.data) || body.data.tier !== tier) {
          setQuoteError('Quote response was malformed.');
          return;
        }
        setQuotes((prev) => ({
          ...prev,
          [tier]: body.data,
        }));
      } catch (err) {
        setQuoteError(err instanceof Error ? err.message : 'Quote failed.');
      } finally {
        setMintingTier(null);
      }
    },
    []
  );

  const loadWithdrawAddress = useCallback(async () => {
    try {
      const response = await fetch('/api/billing/bankr/wallet/withdraw-address', { method: 'GET' });
      if (!response.ok) {
        // 404 → billing v2 disabled; 401 → not signed in. Treat as "no
        // address set" and let the rest of the page render.
        setWithdrawAddress(null);
        return;
      }
      const body = await response.json().catch(() => ({}));
      const addr = (body?.data as WithdrawAddressPayload | undefined)?.address ?? null;
      setWithdrawAddress(addr);
    } catch {
      setWithdrawAddress(null);
    } finally {
      setWithdrawAddressLoading(false);
    }
  }, []);

  const load = useCallback(async ({ silent }: { silent?: boolean } = {}) => {
    if (!silent) {
      setStatus('loading');
      setError(null);
    } else {
      setRefreshing(true);
    }

    try {
      const [walletResponse, eligibilityResponse, agentWalletsResult] = await Promise.all([
        fetch('/api/billing/bankr/wallet', { method: 'GET' }),
        fetch('/api/billing/wallet/eligibility', { method: 'GET' }),
        loadAgentWalletsFromApi(),
      ]);
      setAgentWallets(agentWalletsResult);

      if (walletResponse.status === 404) {
        setData(null);
        setStatus('unavailable');
        setError('Wallet provisioning is not available yet. Check back soon.');
        return;
      }

      if (!walletResponse.ok) {
        const body = await walletResponse.json().catch(() => ({}));
        setError(body?.error || `Wallet request failed (${walletResponse.status})`);
        setStatus('error');
        return;
      }

      const body = await walletResponse.json();
      const payload = body?.data as WalletApiPayload | undefined;
      if (!payload) {
        setStatus('error');
        setError('Wallet response was malformed.');
        return;
      }

      setData(payload);
      const ready = Boolean(
        payload.custodyMode === 'self_custody' ||
        payload.tokenLockWallet ||
        payload.creditDepositWallet ||
        payload.wallet
      );
      setStatus(ready ? 'ready' : 'unprovisioned');
      setError(null);

      // Eligibility is best-effort — failure here doesn't break the wallet
      // page. The user still sees their addresses. A 503 from the price-
      // feed branch surfaces as a small "try again later" notice; other
      // failures stay silent.
      if (eligibilityResponse.ok) {
        try {
          const eligBody = await eligibilityResponse.json();
          if (eligBody?.success && eligBody?.data) {
            const nextEligibility = eligBody.data as EligibilityPayload;
            setEligibility(nextEligibility);
            const nextWalletAddress = walletAddressFromEligibility(nextEligibility);
            if (nextWalletAddress) setVerifiedWalletAddress(nextWalletAddress);
            setPriceUnavailable(false);
          }
        } catch {
          // ignore — eligibility section just won't render
        }
      } else if (eligibilityResponse.status === 503) {
        setEligibility(null);
        setPriceUnavailable(true);
      }
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Unable to load wallet.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Manual "Refresh" button on the wallet header. The 5-min auto-poll
  // and the auto-load on mount only re-read the cached snapshot — they
  // do NOT pull a fresh chain balance. The cron that writes new
  // snapshots only runs every 6 hours, so without this manual chain
  // read a freshly-deposited balance can be invisible to the UI for
  // hours after the user already sees it on the explorer.
  //
  // POST /api/billing/wallet/refresh does a Base RPC read against the
  // user's hermesos_lock wallet and writes a fresh snapshot row, then
  // load({silent}) reflects it into the page state.
  const refreshOnChain = useCallback(async () => {
    setRefreshing(true);
    try {
      // Best-effort — a 404 here means no lock wallet provisioned yet,
      // which is fine: load() below will still re-read whatever state
      // does exist. Other failures are also non-fatal; we just fall
      // through to the snapshot read.
      await fetch('/api/billing/wallet/refresh', { method: 'POST' }).catch(() => null);
    } finally {
      // load() flips refreshing back to false in its own finally block.
      await load({ silent: true });
    }
  }, [load]);

  const handleConnectWallet = useCallback(async () => {
    setWalletConnecting(true);
    setWalletConnectError(null);
    setWalletConnectSuccess(null);

    try {
      const provider = getBrowserWalletProvider();
      if (!provider) {
        setWalletConnectError(describeMissingWalletEnvironment());
        return;
      }

      const accounts = readWalletAccounts(await requestWalletProvider(
        provider,
        { method: 'eth_requestAccounts' },
        { source: 'wallet-page', route: '/dashboard/wallet' }
      ));
      const address = accounts[0];
      if (!address) {
        setWalletConnectError('No wallet account was selected.');
        return;
      }

      const challengeResponse = await fetch('/api/billing/wallet/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, chainId: 8453 }),
      });
      const challengePayload = await readApiPayload(challengeResponse);
      const challenge = readChallengeData(apiSuccessData(challengePayload));
      if (!challenge) {
        setWalletConnectError(apiPayloadError(challengePayload, 'Could not start wallet verification.'));
        return;
      }

      const signature = await requestWalletProvider(
        provider,
        {
          method: 'personal_sign',
          params: [challenge.message, address],
        },
        { source: 'wallet-page', route: '/dashboard/wallet' }
      );
      if (typeof signature !== 'string' || signature.trim().length === 0) {
        setWalletConnectError('Wallet did not return a signature.');
        return;
      }

      const verifyResponse = await fetch('/api/billing/wallet/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          signature,
        }),
      });
      const verifyPayload = await readApiPayload(verifyResponse);
      const verifyData = apiSuccessData(verifyPayload);
      if (!verifyData) {
        setWalletConnectError(apiPayloadError(verifyPayload, 'Wallet verification failed.'));
        return;
      }

      const movedFromAnotherAccount = verifyData.movedFromAnotherAccount === true;
      setWalletConnectSuccess(
        `${shorten(address)} ${walletCopy.verification.verifiedSuffix}${
          movedFromAnotherAccount
            ? ' This wallet was verified on another account — it now counts toward this account only.'
            : ''
        }`
      );
      setVerifiedWalletAddress(address);
      await fetch('/api/billing/wallet/refresh', { method: 'POST' }).catch(() => null);
      await load({ silent: true });
    } catch (err) {
      setWalletConnectError(describeWalletProviderError(
        err,
        'Wallet verification was not completed. Please try again.'
      ));
    } finally {
      setWalletConnecting(false);
    }
  }, [load, walletCopy.verification.verifiedSuffix]);

  const handleLockPrice = useCallback(async () => {
    setWalletLockingPrice(true);
    setWalletConnectError(null);
    setWalletConnectSuccess(null);

    try {
      const targetTier = nextSelfCustodyLockTier(eligibility);
      const targetTierName = tierName(targetTier);

      if (targetTier) {
        const quoteResponse = await fetch('/api/billing/wallet/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier: targetTier }),
        });
        const quotePayload = await readApiPayload(quoteResponse);
        const quoteData = apiSuccessData(quotePayload);
        if (!quoteResponse.ok || !quoteData) {
          setWalletConnectError(apiPayloadError(quotePayload, `Could not lock ${targetTierName ?? 'tier'} price (${quoteResponse.status}).`));
          return;
        }
        if (!isDepositQuotePayload(quoteData) || quoteData.tier !== targetTier) {
          setWalletConnectError('Price lock response was malformed.');
          return;
        }

        setQuotes((prev) => ({
          ...prev,
          [targetTier]: quoteData,
        }));
      }

      const response = await fetch('/api/billing/wallet/refresh', { method: 'POST' });
      const payload = await readApiPayload(response);
      if (!response.ok || !apiSuccessData(payload)) {
        const fallback =
          response.status === 404
            ? 'Connect a wallet before locking in a price.'
            : `Could not lock in price (${response.status}).`;
        setWalletConnectError(apiPayloadError(payload, fallback));
        return;
      }

      await load({ silent: true });
      if (targetTier) await loadQuotes();
      setWalletConnectSuccess(
        targetTierName
          ? `${targetTierName} price locked for 20 minutes. Balance checked below.`
          : 'Balance checked. Your tier updates below.'
      );
    } catch {
      setWalletConnectError('Could not lock in price. Please try again.');
    } finally {
      setWalletLockingPrice(false);
    }
  }, [eligibility, load, loadQuotes]);

  // One-press "unlock my compute now": connect/verify if needed, then hit
  // /unlock (refresh holdings → re-evaluate $HERMESOS tier + Venice boost →
  // live-apply compute). Removes the up-to-6h wait for the cron.
  const handleUnlockNow = useCallback(async () => {
    setUnlocking(true);
    setUnlockMsg(null);
    try {
      if (!verifiedWalletAddress) {
        // We must connect + verify a wallet before unlock can do anything. If
        // this browser has no injected wallet (e.g. Discord's in-app browser),
        // that's impossible here — say so plainly instead of silently no-opping
        // and then reporting a misleading "already up to date" from /unlock.
        if (!getBrowserWalletProvider()) {
          setUnlockMsg(describeMissingWalletEnvironment());
          return;
        }
        await handleConnectWallet();
      }
      const res = await fetch('/api/billing/wallet/unlock', { method: 'POST' }).catch(() => null);
      const body = res ? await res.json().catch(() => null) : null;
      if (res?.ok && body?.success) {
        if (body.data?.throttled) {
          setUnlockMsg('Already up to date — compute reflects your latest holdings.');
        } else if (body.data?.veniceBoostActive) {
          setUnlockMsg('Unlocked — Venice boost (+1 vCPU / +2 GB per agent) is now applied.');
        } else {
          setUnlockMsg('Holdings re-checked and compute applied.');
        }
      } else if (res?.status === 404) {
        setUnlockMsg('Connect and verify a wallet first, then press unlock.');
      } else {
        setUnlockMsg((body?.error as string) || 'Unlock failed — please try again.');
      }
    } finally {
      await load({ silent: true });
      setUnlocking(false);
    }
  }, [verifiedWalletAddress, handleConnectWallet, load]);

  const dismissPrompt = useCallback((mode: 'holding' | 'venice') => {
    setPromptDismissed((prev) => ({ ...prev, [mode]: true }));
    try {
      window.localStorage.setItem(`hermes_unlock_prompt_${mode}_dismissed`, '1');
    } catch {
      // localStorage unavailable — dismissal is best-effort.
    }
  }, []);

  useEffect(() => {
    try {
      setPromptDismissed({
        holding: window.localStorage.getItem('hermes_unlock_prompt_holding_dismissed') === '1',
        venice: window.localStorage.getItem('hermes_unlock_prompt_venice_dismissed') === '1',
      });
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    setWalletEnv({
      hasProvider: Boolean(getBrowserWalletProvider()),
      inApp: detectInAppBrowser(),
      coarsePointer: hasCoarsePointer(),
      pageHref: window.location.href,
    });
  }, []);

  const handleCopyDashboardLink = useCallback(async () => {
    if (typeof window === 'undefined') return;
    try {
      await copyTextToClipboard(window.location.href);
      setDashboardLinkCopied(true);
      window.setTimeout(() => setDashboardLinkCopied(false), 2000);
    } catch {
      // Clipboard unavailable — best-effort; the URL is still in the address bar.
    }
  }, []);

  const tokenLockAddress = data?.tokenLockWallet?.normalizedAddress || data?.tokenLockWallet?.address || null;
  const isLegacyCustody = Boolean(data?.custodyMode === 'legacy_custody' || data?.tokenLockWallet);
  const isSelfCustody = Boolean(data?.custodyMode === 'self_custody' || (status === 'ready' && !isLegacyCustody));
  const snapshotWalletAddress = walletAddressFromEligibility(eligibility);
  const connectedSelfCustodyAddress = verifiedWalletAddress ?? snapshotWalletAddress;
  const eligibleTier = highestEligibleTier(eligibility);
  const lockedAmountDisplay = lockedQuantityForTier(eligibility, eligibleTier);
  const selfCustodyLockTier = nextSelfCustodyLockTier(eligibility);
  const selfCustodyLockQuote = activeQuoteForTier(quotes, selfCustodyLockTier);
  // Unlock now must connect and verify a wallet first while none is verified.
  const walletAction: 'verify' | 'unlock' | null = isSelfCustody
    ? 'verify'
    : eligibility && !verifiedWalletAddress ? 'unlock' : null;

  // Which (if any) prominent unlock prompt to surface. Venice prompt shows
  // once you're on a $HERMESOS tier but don't yet hold the VVV; the holding
  // prompt shows when you're not on a tier at all. Either is dismissible.
  const unlockPromptMode: 'holding' | 'venice' | null = (() => {
    if (!eligibility) return null;
    const onTier = Boolean(
      eligibility.tiers.pro.currentlyEligible || eligibility.tiers.power.currentlyEligible
    );
    const boostHeld = Boolean(eligibility.veniceBoost?.currentlyEligible);
    if (onTier && !boostHeld && !promptDismissed.venice) return 'venice';
    if (!onTier && !promptDismissed.holding) return 'holding';
    return null;
  })();

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (isLegacyCustody) {
      setWithdrawAddressLoading(true);
      void loadWithdrawAddress();
      void loadQuotes();
      return;
    }

    setWithdrawAddress(null);
    setWithdrawAddressLoading(false);
    setWithdrawAddressFormOpen(false);
    setQuoteError(null);

    if (isSelfCustody && connectedSelfCustodyAddress) {
      void loadQuotes();
      return;
    }

    setQuotes({ pro: null, power: null });
  }, [connectedSelfCustodyAddress, isLegacyCustody, isSelfCustody, loadWithdrawAddress, loadQuotes]);

  // Auto-refresh eligibility + quotes on a 5-min cadence so the live-priced
  // threshold and the lock countdown stay current without a manual refresh
  // click. Matches the backend price cache TTL exactly — most polls are
  // served from cache, only one in twelve actually hits CoinGecko.
  useEffect(() => {
    const intervalMs = 5 * 60 * 1000;
    const handle = window.setInterval(() => {
      void load({ silent: true });
      if (isLegacyCustody || connectedSelfCustodyAddress) void loadQuotes();
    }, intervalMs);
    return () => window.clearInterval(handle);
  }, [connectedSelfCustodyAddress, isLegacyCustody, load, loadQuotes]);

  // An older first-run link sent the owner here to qualify for a plan by
  // holding tokens (?from=welcome). Once a qualifying balance is detected,
  // Launch opens and says whether the plan shows yet. The ref guards
  // against double-firing if the wallet is later refetched on this page.
  useEffect(() => {
    if (!fromWelcome || welcomeRedirectFiredRef.current || !eligibility) return;
    const proOk = Boolean(eligibility.tiers?.pro?.currentlyEligible);
    const powerOk = Boolean(eligibility.tiers?.power?.currentlyEligible);
    if (proOk || powerOk) {
      welcomeRedirectFiredRef.current = true;
      router.replace(withReturnParams(LAUNCH_ROUTE, planReturnParams(null)));
    }
  }, [eligibility, fromWelcome, router]);

  const isLoading = status === 'loading';
  const isReady = status === 'ready';
  const handleAgentWalletUpdated = useCallback((instanceId: string, wallet: InstanceBankrWalletPublicSummary) => {
    setAgentWallets((prev) => ({
      ...prev,
      cards: prev.cards.map((card) => (
        card.instance.id === instanceId
          ? { ...card, wallet }
          : card
      )),
    }));
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      style={{
        maxWidth: 'min(960px, 100%)',
        margin: '1rem auto 5rem',
        padding: 'clamp(1.5rem, 5vw, 3rem)',
        paddingTop: 'calc(var(--dashboard-page-safe-top, env(safe-area-inset-top, 0px)) + clamp(1.5rem, 5vw, 3rem))',
      }}
    >
      <header style={{ marginBottom: '2.25rem' }}>
        <span
          className="mono"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 12px',
            border: '1px solid color-mix(in srgb, var(--gold-leaf) 30%, transparent)',
            background: 'color-mix(in srgb, var(--gold-leaf) 5%, transparent)',
            fontSize: 9,
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            color: 'var(--gold-leaf)',
            fontWeight: 700,
            marginBottom: '0.85rem',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 5,
              height: 5,
              background: 'var(--gold-leaf)',
              display: 'inline-block',
              boxShadow: '0 0 10px var(--gold-leaf)',
            }}
          />
          {isLegacyCustody ? walletCopy.eyebrowLegacy : walletCopy.eyebrowSelfCustody}
        </span>
        <h1
          className="serif"
          style={{
            fontSize: 'clamp(1.85rem, 4vw, 2.4rem)',
            fontWeight: 400,
            marginTop: 4,
            lineHeight: 1.12,
            letterSpacing: '-0.01em',
          }}
        >
          {walletCopy.titlePrefix}{walletCopy.titleSeparator}<em>{walletCopy.titleEmphasis}</em>{walletCopy.titleSuffix}
        </h1>
        <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginTop: 10, lineHeight: 1.6, maxWidth: 580 }}>
          {isLegacyCustody ? (
            <>
              <strong>{walletCopy.legacyIntroStrong}</strong> — {walletCopy.legacyIntroBody}
            </>
          ) : (
            <>
              <strong>{walletCopy.selfCustodyIntroStrong}</strong> — {walletCopy.selfCustodyIntroBody}
            </>
          )}
        </p>
      </header>

      {isLegacyCustody && (
        <div
          style={{
            border: '1px solid color-mix(in srgb, var(--gold-leaf) 35%, transparent)',
            background: 'color-mix(in srgb, var(--gold-leaf) 5%, transparent)',
            padding: '12px 16px',
            marginBottom: '1.5rem',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
          }}
        >
          <CheckCircle2 size={14} style={{ color: 'var(--gold-leaf)', flexShrink: 0, marginTop: 2 }} />
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--ink-black)' }}>
            You don&apos;t need to connect an external wallet. Below, select <strong>Lock</strong> on
            your chosen tier to mint a quote — that gives you the exact $HERMESOS amount and the
            deposit address to send it to.
          </p>
        </div>
      )}

      {/* Token geo-policy: no buy-token card for a viewer it blocks (or while
          it is still checking); a blocked viewer sees the notice instead.
          Existing holdings, withdrawals and tiers below are unchanged. */}
      {tokenGeo.status === 'allowed' ? <BuyTokenCard /> : null}
      {tokenGeo.notice ? <TokenGeoNotice notice={tokenGeo.notice} /> : null}

      {walletEnv && (
        <WalletEnvironmentNotice
          inApp={walletEnv.inApp}
          hasProvider={walletEnv.hasProvider}
          coarsePointer={walletEnv.coarsePointer}
          walletAction={walletAction}
          pageHref={walletEnv.pageHref}
          connectError={walletConnectError}
          connectSuccess={walletConnectSuccess}
          showConnectMessages={!isSelfCustody}
          onCopyLink={handleCopyDashboardLink}
          linkCopied={dashboardLinkCopied}
        />
      )}

      {isSelfCustody && (
        <SelfCustodyVerificationPanel
          connecting={walletConnecting}
          locking={walletLockingPrice}
          connectedAddress={connectedSelfCustodyAddress}
          balanceDisplay={eligibility?.balance?.balanceDisplay ?? null}
          checkedAt={eligibility?.balance?.capturedAt ?? null}
          eligibleTier={eligibleTier}
          lockTier={selfCustodyLockTier}
          lockQuote={selfCustodyLockQuote}
          lockedAmountDisplay={lockedAmountDisplay}
          tokenSymbol={eligibility?.tokenSymbol ?? 'HERMESOS'}
          veniceBoostEligible={Boolean(eligibility?.veniceBoost?.currentlyEligible)}
          error={walletConnectError}
          success={walletConnectSuccess}
          onConnect={handleConnectWallet}
          onLockPrice={handleLockPrice}
        />
      )}

      {isReady && isLegacyCustody && (
        <QuotePanel
          proQuote={quotes.pro}
          powerQuote={quotes.power}
          proEligible={Boolean(eligibility?.tiers.pro.currentlyEligible)}
          powerEligible={Boolean(eligibility?.tiers.power.currentlyEligible)}
          launchEpoch={eligibility?.thresholds?.epoch === 'launch'}
          mintingTier={mintingTier}
          depositAddress={tokenLockAddress}
          onMint={handleMintQuote}
        />
      )}

      {quoteError && (
        <p style={{ fontSize: 12, color: '#dc2626', marginTop: '-0.5rem', marginBottom: '1rem' }}>
          {quoteError}
        </p>
      )}

      {!eligibility && priceUnavailable && (
        <div
          role="status"
          aria-live="polite"
          style={{
            border: '1px solid var(--etched-border)',
            background: 'var(--bg-surface)',
            padding: '1rem 1.25rem',
            marginBottom: '1.5rem',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 13,
            color: 'var(--text-secondary)',
          }}
        >
          <AlertTriangle size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
          <span>{walletCopy.priceUnavailable}</span>
        </div>
      )}

      {unlockPromptMode && (
        <UnlockPromptCard
          mode={unlockPromptMode}
          unlocking={unlocking}
          onUnlock={() => void handleUnlockNow()}
          onDismiss={() => dismissPrompt(unlockPromptMode)}
        />
      )}

      {unlockMsg && (
        <p
          role="status"
          aria-live="polite"
          style={{ fontSize: 12, opacity: 0.8, marginTop: '-0.75rem', marginBottom: '1.25rem' }}
        >
          {unlockMsg}
        </p>
      )}

      {eligibility && (
        <EligibilityPanel
          eligibility={eligibility}
          selfCustody={!isLegacyCustody}
          proLockedThreshold={lockedThresholdFor(quotes.pro)}
          powerLockedThreshold={lockedThresholdFor(quotes.power)}
          onRefresh={() => void refreshOnChain()}
          refreshing={refreshing || isLoading}
          onUnlock={() => void handleUnlockNow()}
          unlocking={unlocking}
        />
      )}

      <AgentWalletsSection
        state={agentWallets}
        onRefresh={() => void load({ silent: true })}
        onWalletUpdated={handleAgentWalletUpdated}
      />

      {error && (
        <p style={{ fontSize: 12, color: '#dc2626', margin: '0 0 1rem' }}>{error}</p>
      )}

      {isLegacyCustody && (
        <section aria-label="Wallet actions" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: '1.5rem' }}>
          <WithdrawDestinationCard
            address={withdrawAddress}
            loading={withdrawAddressLoading}
            onEdit={() => setWithdrawAddressFormOpen(true)}
          />
          <ActionRow
            icon={<ArrowDownToLine size={14} />}
            label="Deposit"
            description="Mint a deposit quote for the tier you want above — that locks today's $HERMESOS price for 20 minutes and shows you the exact amount and address. Eligibility updates within minutes of confirmation."
          />
          <WithdrawSection
            tokenSymbol={eligibility?.tokenSymbol ?? 'HERMESOS'}
            balanceDisplay={eligibility?.balance?.balanceDisplay ?? '—'}
            withdrawAddress={withdrawAddress}
            onRequestSetAddress={() => setWithdrawAddressFormOpen(true)}
            onWithdrew={() => {
              // Refresh once now (the post-withdraw eligibility re-check
              // already wrote a fresh snapshot) and again 60s later — by
              // which time Base has definitely confirmed the tx and the
              // chain read is authoritative.
              void load({ silent: true });
              window.setTimeout(() => {
                void load({ silent: true });
              }, 60_000);
            }}
          />
        </section>
      )}

      {isLegacyCustody && withdrawAddressFormOpen && (
        <WithdrawAddressForm
          initialAddress={withdrawAddress}
          onCancel={() => setWithdrawAddressFormOpen(false)}
          onSaved={(addr) => {
            setWithdrawAddress(addr);
            setWithdrawAddressFormOpen(false);
          }}
        />
      )}
    </motion.div>
  );
}


