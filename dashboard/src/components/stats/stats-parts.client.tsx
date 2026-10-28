"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { useAgentsDeployedPolling } from "@/hooks/useAgentsDeployedPolling";
import { pollWhenVisible } from "@/lib/poll-when-visible";
import type { PublicStats } from "@/lib/public-stats";

/*
 * The live-data wiring and the small figure components that /stats shares between
 * its two layouts: the English page (StatsEditorial) and the translated page
 * (StatsPageContent). Nothing here changes what is fetched, how often, or what a
 * figure means.
 */

export interface Stats {
  total: number;
  last24h: number;
  last7d: number;
  series?: { date: string; count: number }[];
  generatedAt?: string;
}

export interface StatsPageProps {
  initial: Stats | null;
  firstDeployIso: string | null;
  platform: PublicStats | null;
}

export const heroPanelStyle: CSSProperties = {
  padding: "clamp(2.5rem, 6vw, 4.5rem) clamp(1rem, 4vw, 3rem)",
  textAlign: "center",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
};

export const heroLabelStyle: CSSProperties = {
  display: "block",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.22em",
  fontWeight: 700,
  marginBottom: "1.25rem",
};

export const heroNumberStyle: CSSProperties = {
  fontSize: "clamp(2.75rem, 11vw, 7rem)",
  fontWeight: 300,
  lineHeight: 1,
  letterSpacing: "-0.02em",
  display: "inline-block",
};

/**
 * getAgentsDeployedStats() answers a failed lookup with an all-zero object instead
 * of throwing, so a total of zero with no activity at all is read as "the lookup
 * failed", never as a real count. The number is then hidden rather than shown as 0.
 */
export function hasDeployedCount(stats: Pick<Stats, "total" | "last24h" | "last7d"> | null): boolean {
  if (!stats) return false;
  const { total, last24h, last7d } = stats;
  if (![total, last24h, last7d].every((n) => Number.isFinite(n))) return false;
  return total > 0 || last24h > 0 || last7d > 0;
}

// Deterministic odometer value: linearly play the older checkpoint to the newer one
// over the wall-clock span between the two. Same inputs give the same output for every viewer.
function computeTokenDisplay(
  prevVal: number | null,
  prevAt: string | null,
  currVal: number | null,
  currAt: string | null,
  fallback: number
): number {
  if (prevVal == null || currVal == null || !prevAt || !currAt) return fallback;
  const p = Date.parse(prevAt);
  const c = Date.parse(currAt);
  const span = c - p;
  if (!Number.isFinite(span) || span <= 0 || currVal < prevVal) return currVal;
  const frac = Math.min(Math.max((Date.now() - c) / span, 0), 1);
  return Math.round(prevVal + (currVal - prevVal) * frac);
}

/**
 * Smooth, deterministic "tokens processed" odometer. Given two hourly
 * cumulative-token checkpoints, it linearly plays the older-to-newer delta over a
 * full wall-clock hour, so it climbs at the last hour's real token velocity,
 * about an hour behind reality, identical for every viewer, and re-anchors when
 * fresh checkpoints poll in. The accurate base only counts toward an already
 * measured value (never runs ahead of reality) and holds steady if a checkpoint is
 * late. Nothing else is layered on top: the digits move only because the figure
 * moves (there used to be a random low-digit flicker for "alive" motion, removed
 * because it showed numbers no measurement backed).
 */
export function TokenOdometer({
  prevVal,
  prevAt,
  currVal,
  currAt,
  fallback,
  locale,
  reduceMotion,
}: {
  prevVal: number | null;
  prevAt: string | null;
  currVal: number | null;
  currAt: string | null;
  fallback: number;
  locale: string;
  reduceMotion: boolean;
}) {
  // Stable first paint (no Date.now, so no hydration mismatch); the effect's
  // first (async) tick swaps in the live value on mount.
  const [value, setValue] = useState<number>(() => prevVal ?? currVal ?? fallback);

  useEffect(() => {
    // Recompute the figure from the checkpoints and the clock, once a second (every two
    // seconds for a visitor who prefers reduced motion). Every tick is the same pure
    // function, with no random offset, so the number changes only as the real figure does,
    // and it re-anchors to fresh checkpoints on each poll.
    const tick = () => setValue(computeTokenDisplay(prevVal, prevAt, currVal, currAt, fallback));
    const first = setTimeout(tick, 0);
    const every = setInterval(pollWhenVisible(tick), reduceMotion ? 2000 : 1000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [prevVal, prevAt, currVal, currAt, fallback, reduceMotion]);

  return (
    <span
      className="serif"
      aria-label="Tokens processed"
      style={{
        display: "block",
        fontSize: "clamp(1.75rem, 6vw, 4.5rem)",
        fontWeight: 300,
        color: "var(--ink-black)",
        lineHeight: 1,
        letterSpacing: "-0.02em",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {value.toLocaleString(locale)}
    </span>
  );
}

export function StatCard({
  label,
  value,
  valueText,
  subtext,
  accent,
  locale,
}: {
  label: string;
  value?: number | null;
  valueText?: string;
  subtext?: string | null;
  accent?: boolean;
  locale: string;
}) {
  const display =
    valueText ??
    (value === null || value === undefined ? "-" : `+${value.toLocaleString(locale)}`);
  return (
    <div
      style={{
        border: "1px solid var(--etched-border)",
        background: "rgba(255, 44, 45, 0.025)",
        padding: "1.75rem 1.5rem",
        textAlign: "center",
      }}
    >
      <span
        className="mono"
        style={{
          display: "block",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.18em",
          color: "var(--text-muted)",
          fontWeight: 600,
          marginBottom: "0.85rem",
        }}
      >
        {label}
      </span>
      <span
        className="serif"
        style={{
          display: "block",
          fontSize: "clamp(1.5rem, 3.5vw, 2.25rem)",
          fontWeight: 300,
          color: accent ? "var(--gold-leaf)" : "var(--ink-black)",
          lineHeight: 1.1,
        }}
      >
        {display}
      </span>
      {subtext && (
        <span
          className="mono"
          style={{
            display: "block",
            marginTop: "0.5rem",
            fontSize: 9,
            textTransform: "uppercase",
            letterSpacing: "0.16em",
            color: "var(--text-muted)",
            fontWeight: 600,
          }}
        >
          {subtext}
        </span>
      )}
    </div>
  );
}

/**
 * The live data behind /stats. The deployed counter polls /api/stats/agents-deployed
 * (60s, edge-cached) and the platform counters poll /api/stats/public (30s, edge-cached):
 * viewers ride Vercel's edge cache instead of each tick hitting the function. runningNow
 * is a live count; harvested/synced aggregates move on their crons.
 */
export function useStatsData({ initial, firstDeployIso, platform }: StatsPageProps, locale: string) {
  const { stats, bumped } = useAgentsDeployedPolling({ initial, includeSeries: true });

  const [platformStats, setPlatformStats] = useState<PublicStats | null>(platform);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/stats/public");
        if (res.ok && alive) setPlatformStats((await res.json()) as PublicStats);
      } catch {
        /* keep last good values */
      }
    };
    tick();
    const id = setInterval(pollWhenVisible(tick), 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const rtf = useMemo(() => {
    try {
      return new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    } catch {
      return null;
    }
  }, [locale]);

  const [mountedAtMs] = useState(() => Date.now());

  const firstDeployRelative = useMemo(() => {
    if (!firstDeployIso || !rtf) return null;
    const ms = mountedAtMs - new Date(firstDeployIso).getTime();
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    if (days <= 0) return rtf.format(0, "day");
    if (days < 30) return rtf.format(-days, "day");
    const months = Math.floor(days / 30);
    return rtf.format(-months, "month");
  }, [firstDeployIso, rtf, mountedAtMs]);

  return {
    total: stats?.total ?? null,
    last24h: stats?.last24h ?? null,
    last7d: stats?.last7d ?? null,
    series: stats?.series ?? null,
    generatedAt: stats?.generatedAt ?? null,
    bumped,
    firstDeployRelative,
    runningNow: platformStats?.runningNow ?? null,
    tokensProcessed: platformStats?.tokensProcessed ?? null,
    tokenAnchorPrev: platformStats?.tokensAnchorPrev ?? null,
    tokenAnchorPrevAt: platformStats?.tokensAnchorPrevAt ?? null,
    tokenAnchorCurr: platformStats?.tokensAnchorCurr ?? null,
    tokenAnchorCurrAt: platformStats?.tokensAnchorCurrAt ?? null,
    models: platformStats?.models ?? 0,
    providers: platformStats?.providers ?? 0,
  };
}
