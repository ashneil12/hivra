'use client';

import { Info, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { displayTokenUnit } from '@/lib/billing/token-plan-prices';
import { touchStyles } from "@/components/billing/TransferDetails";
import { useLocale } from "@/components/i18n/LocaleProvider";
import {
  interpolateCopy,
  type EligibilityPayload,
  type EligibilityTierState,
} from "@/lib/wallet/format";

/**
 * Token-eligibility UI for the wallet dashboard: the holder's tier status,
 * the Venice compute-boost row, the live price line and the per-tier lock row.
 * Extracted verbatim from wallet/page.tsx.
 */
export function EligibilityPanel({
  eligibility,
  selfCustody,
  proLockedThreshold,
  powerLockedThreshold,
  onRefresh,
  refreshing,
  onUnlock,
  unlocking,
}: {
  eligibility: EligibilityPayload;
  selfCustody: boolean;
  /**
   * When the user has an active 20-min deposit-quote lock for a tier, we
   * display that quote's `tokensRequiredDisplay` here instead of the live
   * threshold so the two cards on the page agree on the number to send.
   * Once the lock expires the prop goes null and the live threshold
   * (auto-refreshed every 5 min) takes over again.
   */
  proLockedThreshold?: string | null;
  powerLockedThreshold?: string | null;
  onRefresh: () => void;
  refreshing: boolean;
  onUnlock: () => void;
  unlocking: boolean;
}) {
  const { copy } = useLocale();
  const eligibilityCopy = copy.dashboard.wallet.eligibility;
  const sym = displayTokenUnit(eligibility.tokenSymbol);
  const balanceDisplay = eligibility.balance?.balanceDisplay ?? '—';

  return (
    <section
      aria-label={eligibilityCopy.ariaLabel}
      style={{
        border: '1px solid var(--etched-border)',
        background: 'var(--bg-surface)',
        padding: 'clamp(1.25rem, 4vw, 1.75rem)',
        marginBottom: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <span className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.18em', opacity: 0.55, fontWeight: 700 }}>
            {eligibilityCopy.eyebrow}
          </span>
          <h2 className="serif" style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: 4, marginBottom: 0 }}>
            {eligibilityCopy.currentBalancePrefix} <code className="mono notranslate" translate="no" style={{ fontSize: '1.05rem', overflowWrap: 'anywhere' }}>{balanceDisplay} {sym}</code>
          </h2>
          <TokenPriceLine thresholds={eligibility.thresholds} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {eligibility.balance?.capturedAt && (
            <span className="mono" style={{ fontSize: 10, opacity: 0.5 }}>
              {eligibilityCopy.autoRefreshPrefix}{' '}
              {new Date(eligibility.balance.capturedAt).toLocaleString()}
            </span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label={eligibilityCopy.refreshBalanceLabel}
            className={touchStyles.touchTarget}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              border: '1px solid var(--etched-border)',
              background: 'transparent',
              cursor: refreshing ? 'wait' : 'pointer',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              fontWeight: 700,
              opacity: refreshing ? 0.6 : 1,
            }}
          >
            <RefreshCw size={12} style={{ animation: refreshing ? 'spin 1s linear infinite' : undefined }} />
            {eligibilityCopy.refresh}
          </button>
          <button
            type="button"
            onClick={onUnlock}
            disabled={unlocking}
            aria-label="Re-check holdings and unlock compute now"
            className={touchStyles.touchTarget}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              border: '1px solid var(--ink-black)',
              background: 'var(--btn-bg)',
              color: 'var(--btn-text)',
              cursor: unlocking ? 'wait' : 'pointer',
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              fontWeight: 700,
              opacity: unlocking ? 0.6 : 1,
            }}
          >
            {unlocking ? (
              <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
            ) : (
              <ShieldCheck size={12} />
            )}
            Unlock now
          </button>
        </div>
      </header>

      {!eligibility.thresholds.configured && (
        <div
          role="alert"
          style={{
            padding: '0.85rem 1rem',
            border: '1px solid #b3261e',
            color: '#b3261e',
            fontSize: 13,
          }}
        >
          {eligibilityCopy.thresholdsMissing}
        </div>
      )}

      <TierEligibilityRow
        tier="pro"
        state={eligibility.tiers.pro}
        symbol={sym}
        lockedThresholdDisplay={proLockedThreshold}
        selfCustody={selfCustody}
      />
      <TierEligibilityRow
        tier="power"
        state={eligibility.tiers.power}
        symbol={sym}
        lockedThresholdDisplay={powerLockedThreshold}
        selfCustody={selfCustody}
      />
      <VeniceBoostRow boost={eligibility.veniceBoost} onUnlock={onUnlock} unlocking={unlocking} />
    </section>
  );
}
export function VeniceBoostRow({
  boost,
  onUnlock,
  unlocking,
}: {
  boost: EligibilityPayload['veniceBoost'];
  onUnlock?: () => void;
  unlocking?: boolean;
}) {
  if (!boost) return null;
  const eligible = boost.currentlyEligible;
  const gbBonus = boost.ramBonusMb / 1024;
  const usd = boost.lastUsdValue ? Number(boost.lastUsdValue) : null;
  // "478 VVV (≈ $199)" when we have a live price; otherwise the dollar phrasing.
  const requiredLabel = boost.requiredVvvDisplay
    ? `${boost.requiredVvvDisplay} VVV (≈ $${boost.thresholdUsd})`
    : `$${boost.thresholdUsd} of VVV`;
  const badgeColor = eligible ? '#16a34a' : 'var(--etched-border)';

  return (
    <div
      style={{
        border: '1px solid var(--etched-border)',
        padding: '1rem 1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span className="serif" style={{ fontSize: '1.05rem', fontWeight: 700 }}>
          Venice compute boost
        </span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            fontWeight: 700,
            padding: '4px 8px',
            border: `1px solid ${badgeColor}`,
            color: eligible ? '#16a34a' : 'var(--text-muted, var(--text-secondary))',
          }}
        >
          {eligible ? 'Eligible' : 'Not yet eligible'}
        </span>
      </div>

      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55 }}>
        {eligible ? (
          <>
            You&apos;re holding enough VVV — every agent gets{' '}
            <strong>+{boost.cpuBonus} vCPU / +{gbBonus} GB</strong> on a paid (card or token) tier.
          </>
        ) : (
          <>
            Hold at least{' '}
            <strong>
              <code className="mono">{requiredLabel}</code>
            </strong>{' '}
            in your verified wallet to add +{boost.cpuBonus} vCPU / +{gbBonus} GB per instance on a paid (card or token) tier.
          </>
        )}
      </p>

      {!eligible && (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5, opacity: 0.85 }}>
          {boost.countsStakedVvv ? (
            <>
              Liquid <strong>and staked</strong> VVV in your verified wallet both count (including VVV staked
              for DIEM). VVV sitting in an unverified withdrawal-destination wallet isn&apos;t included — move
              it into the wallet you verify to qualify.
            </>
          ) : (
            <>
              Only liquid VVV in your <strong>verified</strong> wallet counts. VVV that&apos;s staked (e.g. for
              DIEM) or sitting in a withdrawal-destination wallet isn&apos;t included — move it into the wallet
              you verify to qualify.
            </>
          )}
        </p>
      )}

      {boost.vvvBalanceDisplay && (
        <p className="mono" style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>
          Holding {boost.vvvBalanceDisplay} VVV{boost.countsStakedVvv ? ' (incl. staked)' : ''}
          {usd != null ? ` (≈ $${usd.toFixed(2)})` : ''}
        </p>
      )}

      {onUnlock && (
        <button
          type="button"
          onClick={onUnlock}
          disabled={unlocking}
          className={touchStyles.touchTarget}
          style={{
            alignSelf: 'flex-start',
            marginTop: 2,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 10px',
            border: `1px solid ${eligible ? '#16a34a' : 'var(--etched-border)'}`,
            background: 'transparent',
            cursor: unlocking ? 'wait' : 'pointer',
            fontFamily: 'var(--font-mono), monospace',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontWeight: 700,
            opacity: unlocking ? 0.6 : 1,
          }}
        >
          {unlocking ? (
            <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
          ) : (
            <ShieldCheck size={11} />
          )}
          {eligible ? 'Re-check & unlock' : 'Verify VVV & unlock now'}
        </button>
      )}
    </div>
  );
}
export function TokenPriceLine({
  thresholds,
}: {
  thresholds: EligibilityPayload['thresholds'];
}) {
  if (!thresholds.priceUsd) return null;

  const tooltip =
    'Tier threshold = USD target ÷ live $HERMESOS price. ' +
    'Price is fetched from CoinGecko and refreshed up to every 5 minutes. ' +
    'Existing holders are grandfathered at their original qualifying quantity ' +
    'and are not affected when the price (and threshold) move.';

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        marginTop: 6,
        fontFamily: 'var(--font-mono), monospace',
        fontSize: 10,
        opacity: 0.7,
      }}
    >
      <span>$HERMESOS price ${thresholds.priceUsd}</span>
      <span
        role="img"
        aria-label={tooltip}
        title={tooltip}
        style={{ display: 'inline-flex', alignItems: 'center', cursor: 'help' }}
      >
        <Info size={12} />
      </span>
    </div>
  );
}
export function TierEligibilityRow({
  tier,
  state,
  symbol,
  lockedThresholdDisplay,
  selfCustody,
}: {
  tier: 'pro' | 'power';
  state: EligibilityTierState;
  symbol: string;
  /** Active deposit-quote token amount; takes precedence over the live threshold. */
  lockedThresholdDisplay?: string | null;
  selfCustody: boolean;
}) {
  const { copy } = useLocale();
  const eligibilityCopy = copy.dashboard.wallet.eligibility;
  const tierName = tier === 'pro' ? 'Pro' : 'Power';
  const tierLabel = tier === 'pro' ? eligibilityCopy.proTier : eligibilityCopy.powerTier;
  const eligible = state.currentlyEligible;
  const breached = !eligible && state.lastBreachAt !== null;
  const neverQualified = !eligible && state.lastBreachAt === null && state.qualifyingQuantity === null;
  // While a 20-min lock is in flight, prefer the quote's token amount so the
  // tier-eligibility row matches the lock card. Falls back to the live
  // threshold once the lock expires.
  const displayThreshold = lockedThresholdDisplay ?? state.currentThresholdDisplay;

  return (
    <div
      style={{
        border: '1px solid var(--etched-border)',
        padding: '1rem 1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span className="serif" style={{ fontSize: '1.05rem', fontWeight: 700 }}>
          {tierLabel}
        </span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            fontWeight: 700,
            padding: '4px 8px',
            border: `1px solid ${eligible ? '#16a34a' : breached ? '#b3261e' : 'var(--etched-border)'}`,
            color: eligible ? '#16a34a' : breached ? '#b3261e' : 'var(--text-muted, var(--text-secondary))',
          }}
        >
          {eligible ? eligibilityCopy.eligible : breached ? eligibilityCopy.breached : eligibilityCopy.notYetEligible}
        </span>
      </div>

      {eligible && state.qualifyingQuantityDisplay && (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55 }}>
          You&apos;ve locked in your qualifying quantity at{' '}
          <strong>
            <code className="mono">{state.qualifyingQuantityDisplay} {symbol}</code>
          </strong>
          . If your balance drops below this amount, your {tierName} tier eligibility ends after a grace period.
        </p>
      )}

      {breached && (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55 }}>
          Your balance dropped below your qualifying quantity of{' '}
          <strong>
            <code className="mono">{state.qualifyingQuantityDisplay} {symbol}</code>
          </strong>
          . To regain {tierName} tier, {selfCustody ? 'hold' : 'deposit back to'} the current threshold of{' '}
          <strong>
            <code className="mono">{state.currentThresholdDisplay ?? '—'} {symbol}</code>
          </strong>
          . (Re-qualifying uses the current threshold, not your original quantity.)
        </p>
      )}

      {neverQualified && displayThreshold && (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55 }}>
          {selfCustody ? eligibilityCopy.holdAtLeast : eligibilityCopy.depositAtLeast}{' '}
          <strong>
            <code className="mono">{displayThreshold} {symbol}</code>
          </strong>{' '}
          {selfCustody
            ? interpolateCopy(eligibilityCopy.selfCustodyQualifySuffix, { tier: tierName })
            : interpolateCopy(eligibilityCopy.custodyQualifySuffix, { tier: tierName })}
          {lockedThresholdDisplay && (
            <span style={{ display: 'block', marginTop: 4, fontSize: 11, opacity: 0.65 }}>
              {eligibilityCopy.lockedAtPrice}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
