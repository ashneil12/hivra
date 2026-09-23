'use client';

import { YearlyPaymentProgress } from "@/components/billing/YearlyTokenPanels";
import type {
  YearlyTokenQuotePayload,
  YearlyTokenSubscriptionPayload,
} from "@/lib/billing/format";
import styles from "../Billing.module.css";

type PerTier<T> = { pro: T | null; power: T | null };

type BannerCandidate = {
  quote: YearlyTokenQuotePayload | null;
  sub: YearlyTokenSubscriptionPayload | null;
  tier: "pro" | "power";
};

/**
 * Which yearly payment the banner shows, if any. Moved verbatim from the
 * page. Across tiers: a quote that can still be paid wins over one under
 * review or watching for a late payment, which wins over a subscription that
 * just activated (paid in the last five minutes) or is still sweeping.
 */
export function selectYearlyBannerCandidate(
  state: {
    activeQuotes: PerTier<YearlyTokenQuotePayload>;
    pendingQuotes: PerTier<YearlyTokenQuotePayload>;
    recentSubs: PerTier<YearlyTokenSubscriptionPayload>;
  },
  now: number = Date.now()
): BannerCandidate | null {
  const { activeQuotes, pendingQuotes, recentSubs } = state;
  const candidates: BannerCandidate[] = [
    {
      quote: activeQuotes.pro ?? pendingQuotes.pro,
      sub: recentSubs.pro,
      tier: "pro" as const,
    },
    {
      quote: activeQuotes.power ?? pendingQuotes.power,
      sub: recentSubs.power,
      tier: "power" as const,
    },
  ];
  const payable = (tier: "pro" | "power") => (tier === "pro" ? activeQuotes.pro : activeQuotes.power);
  let chosen = candidates.find((c) => payable(c.tier)) ?? candidates.find((c) => c.quote);
  if (!chosen) {
    const fiveMinAgo = now - 5 * 60_000;
    chosen = candidates.find(
      (c) => c.sub && (c.sub.sweepStatus === "pending" || Date.parse(c.sub.paidAt) > fiveMinAgo),
    );
  }
  if (!chosen || (!chosen.quote && !chosen.sub)) return null;
  return chosen;
}

/**
 * The yearly $HermesOS payment in flight. Rendered above the tabs for every
 * user and ungated by the crypto flag, exactly as before: it is what stops a
 * user paying twice. Shown to subscribed users too (a renewal is paid while
 * the current year is still live).
 */
export function YearlyPaymentBanner({
  activeQuotes,
  pendingQuotes,
  recentSubs,
  checkingNow,
  onResume,
  onCheckNow,
}: {
  activeQuotes: PerTier<YearlyTokenQuotePayload>;
  pendingQuotes: PerTier<YearlyTokenQuotePayload>;
  recentSubs: PerTier<YearlyTokenSubscriptionPayload>;
  checkingNow: boolean;
  onResume: (tier: "pro" | "power") => void;
  onCheckNow: () => void;
}) {
  const chosen = selectYearlyBannerCandidate({ activeQuotes, pendingQuotes, recentSubs });
  if (!chosen) return null;
  const chosenTier = chosen.tier;
  return (
    <div className={styles.yearlyBanner}>
      <YearlyPaymentProgress
        tier={chosenTier}
        quote={chosen.quote ?? null}
        subscription={chosen.sub ?? null}
        onResume={() => onResume(chosenTier)}
        onCheckNow={onCheckNow}
        checkingNow={checkingNow}
      />
    </div>
  );
}
