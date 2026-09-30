"use client";

import Link from "next/link";
import { pollWhenVisible } from "@/lib/poll-when-visible";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { motion, useReducedMotion } from "framer-motion";

import { RollingNumber } from "@/components/ui/RollingNumber";
import { Sparkline } from "@/components/stats/Sparkline";
import { useAgentsDeployedPolling } from "@/hooks/useAgentsDeployedPolling";
import { useLocale } from "@/components/i18n/LocaleProvider";
import type { PublicStats } from "@/lib/public-stats";
import { PUBLIC_START_HREF } from "@/lib/public-start";

interface Stats {
  total: number;
  last24h: number;
  last7d: number;
  series?: { date: string; count: number }[];
  generatedAt?: string;
}

interface Props {
  initial: Stats | null;
  firstDeployIso: string | null;
  platform: PublicStats | null;
}

const heroPanelStyle: CSSProperties = {
  padding: "clamp(2.5rem, 6vw, 4.5rem) clamp(1rem, 4vw, 3rem)",
  textAlign: "center",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
};

const heroLabelStyle: CSSProperties = {
  display: "block",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.22em",
  fontWeight: 700,
  marginBottom: "1.25rem",
};

const heroNumberStyle: CSSProperties = {
  fontSize: "clamp(2.75rem, 11vw, 7rem)",
  fontWeight: 300,
  lineHeight: 1,
  letterSpacing: "-0.02em",
  display: "inline-block",
};

// Deterministic odometer value: linearly play prev→curr over the wall-clock
// span between the two checkpoints. Same inputs ⇒ same output for every viewer.
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
 * cumulative-token checkpoints, it linearly plays the older→newer delta over a
 * full wall-clock hour — so it climbs at the last hour's real token velocity,
 * ~1h behind reality, identical for every viewer — and re-anchors when fresh
 * checkpoints poll in. The accurate base only counts toward an already-measured
 * value (never runs ahead of reality) and holds steady if a checkpoint is late;
 * a small ±low-digit flicker is layered on purely for "alive" motion, and every
 * other beat lands exactly back on the real figure.
 */
function TokenOdometer({
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
  // Stable first paint (no Date.now ⇒ no hydration mismatch); the effect's
  // first (async) tick swaps in the live value on mount.
  const [value, setValue] = useState<number>(() => prevVal ?? currVal ?? fallback);

  useEffect(() => {
    // Alternate, on a calm randomized cadence (~0.35–0.65s), between the EXACT
    // accurate total and that total + a small random low-digit offset. The
    // number visibly churns ("random") but lands back on the real figure every
    // other beat — and re-anchors to fresh checkpoints on each 15s poll.
    let exact = true;
    let timer = setTimeout(function tick() {
      const base = computeTokenDisplay(prevVal, prevAt, currVal, currAt, fallback);
      setValue(exact || reduceMotion ? base : base + Math.floor(Math.random() * 1000));
      exact = !exact;
      timer = setTimeout(tick, reduceMotion ? 2000 : 350 + Math.random() * 300);
    }, 0);
    return () => clearTimeout(timer);
  }, [prevVal, prevAt, currVal, currAt, fallback, reduceMotion]);

  return (
    <span
      className="serif"
      aria-label="Tokens processed, counting live"
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

export default function StatsPageContent({ initial, firstDeployIso, platform }: Props) {
  const reduceMotion = useReducedMotion();
  const { copy, locale } = useLocale();
  const t = copy.stats.page;
  const { stats, bumped } = useAgentsDeployedPolling({ initial, includeSeries: true });

  // Live refresh of the platform counters — 30s cadence, edge-cacheable (the
  // route returns `public, s-maxage`), so viewers ride Vercel's edge cache
  // instead of each tick hitting the Fluid function. runningNow is a live
  // count; harvested/synced aggregates move on their crons.
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

  const total = stats?.total ?? null;
  const last24h = stats?.last24h ?? null;
  const last7d = stats?.last7d ?? null;
  const series = stats?.series ?? null;

  const runningNow = platformStats?.runningNow ?? null;
  const tokensProcessed = platformStats?.tokensProcessed ?? null;
  const tokenAnchorPrev = platformStats?.tokensAnchorPrev ?? null;
  const tokenAnchorPrevAt = platformStats?.tokensAnchorPrevAt ?? null;
  const tokenAnchorCurr = platformStats?.tokensAnchorCurr ?? null;
  const tokenAnchorCurrAt = platformStats?.tokensAnchorCurrAt ?? null;
  const models = platformStats?.models ?? 0;
  const providers = platformStats?.providers ?? 0;

  const rtf = useMemo(() => {
    try {
      return new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    } catch {
      return null;
    }
  }, [locale]);

  const firstDeployFormatted = useMemo(() => {
    if (!firstDeployIso) return "—";
    try {
      return new Date(firstDeployIso).toLocaleDateString(locale, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch {
      return firstDeployIso.slice(0, 10);
    }
  }, [firstDeployIso, locale]);

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

  return (
    <main
      style={{
        maxWidth: 1000,
        margin: "0 auto",
        padding: "clamp(3rem, 8vw, 6rem) 2rem 6rem",
      }}
    >
      <div style={{ textAlign: "center", marginBottom: "3rem" }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 14px",
            border: "1px solid var(--gold-leaf)",
            background: "rgba(255, 44, 45, 0.06)",
            marginBottom: "2rem",
          }}
        >
          <motion.span
            aria-hidden="true"
            animate={reduceMotion ? undefined : { opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
            style={{
              width: 5,
              height: 5,
              background: "var(--gold-leaf)",
              display: "inline-block",
              boxShadow: "0 0 8px var(--gold-leaf)",
              borderRadius: 1,
            }}
          />
          <span
            className="mono"
            style={{
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              color: "var(--gold-leaf)",
              fontWeight: 700,
            }}
          >
            {t.eyebrow}
          </span>
        </div>

        <h1
          className="serif"
          style={{
            fontSize: "clamp(2rem, 5vw, 3.5rem)",
            lineHeight: 1.15,
            fontWeight: 300,
            marginBottom: "1rem",
            color: "var(--ink-black)",
          }}
        >
          {t.headlinePrefix}{" "}
          <span style={{ fontStyle: "italic" }}>{t.headlineEmphasis}</span>{" "}
          {t.headlineSuffix}
        </h1>

        <p
          style={{
            fontSize: "1.05rem",
            lineHeight: 1.6,
            maxWidth: 560,
            margin: "0 auto",
            color: "var(--text-secondary)",
          }}
        >
          {t.body}
        </p>
      </div>

      <motion.div
        animate={
          bumped && !reduceMotion
            ? { boxShadow: "0 0 0 1px rgba(255, 44, 45,0.5), 0 0 80px rgba(255, 44, 45,0.2)" }
            : { boxShadow: "0 0 0 1px rgba(0,0,0,0)" }
        }
        transition={{ duration: 0.6, ease: "easeOut" }}
        style={{
          position: "relative",
          borderTop: "1px solid var(--etched-border)",
          borderBottom: "1px solid var(--etched-border)",
          background:
            "radial-gradient(ellipse at center top, rgba(255, 44, 45,0.06), transparent 70%)",
          marginBottom: "4rem",
        }}
      >
        {/* One column on phones so long totals never push the page sideways. */}
        <div className="grid grid-cols-1 sm:grid-cols-2">
          {/* All-time deploys */}
          <div className="min-w-0" style={heroPanelStyle}>
            <span className="mono" style={{ ...heroLabelStyle, color: "var(--text-secondary)" }}>
              {t.allTimeLabel}
            </span>
            {total === null ? (
              <span className="serif" style={{ ...heroNumberStyle, color: "var(--text-muted)" }}>
                —
              </span>
            ) : (
              <RollingNumber
                value={total}
                locale={locale}
                ariaLabel={`${total.toLocaleString(locale)} ${t.ariaTotal}`}
                className="serif"
                style={{ ...heroNumberStyle, color: "var(--ink-black)" }}
              />
            )}
          </div>

          {/* Agents live now */}
          <div
            className="min-w-0 border-t border-[var(--etched-border)] sm:border-t-0 sm:border-l"
            style={heroPanelStyle}
          >
            <span
              className="mono"
              style={{
                ...heroLabelStyle,
                color: "var(--gold-leaf)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
              }}
            >
              <motion.span
                aria-hidden="true"
                animate={reduceMotion ? undefined : { opacity: [0.35, 1, 0.35] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--gold-leaf)",
                  boxShadow: "0 0 8px var(--gold-leaf)",
                  display: "inline-block",
                }}
              />
              Agents live now
            </span>
            {runningNow === null ? (
              <span className="serif" style={{ ...heroNumberStyle, color: "var(--text-muted)" }}>
                —
              </span>
            ) : (
              <RollingNumber
                value={runningNow}
                locale={locale}
                ariaLabel={`${runningNow.toLocaleString(locale)} agents live now`}
                className="serif"
                style={{ ...heroNumberStyle, color: "var(--gold-leaf)" }}
              />
            )}
          </div>
        </div>
      </motion.div>

      {/* Tokens processed — headline throughput, the third top-line stat */}
      {tokensProcessed !== null && tokensProcessed > 0 && (
        <div
          style={{
            borderTop: "1px solid var(--gold-leaf)",
            borderBottom: "1px solid var(--gold-leaf)",
            background: "linear-gradient(180deg, rgba(255, 44, 45,0.12), rgba(255, 44, 45,0.02))",
            padding: "clamp(2rem, 5vw, 3rem) 2rem",
            textAlign: "center",
            marginBottom: "4rem",
          }}
        >
          <span
            className="mono"
            style={{ ...heroLabelStyle, color: "var(--gold-leaf)", marginBottom: "0.85rem" }}
          >
            Tokens processed
          </span>
          <TokenOdometer
            prevVal={tokenAnchorPrev}
            prevAt={tokenAnchorPrevAt}
            currVal={tokenAnchorCurr}
            currAt={tokenAnchorCurrAt}
            fallback={tokensProcessed}
            locale={locale}
            reduceMotion={!!reduceMotion}
          />
          {(models > 0 || providers > 0) && (
            <span
              className="mono"
              style={{
                display: "block",
                marginTop: "0.95rem",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                color: "var(--text-secondary)",
                fontWeight: 600,
              }}
            >
              {models > 0 ? `across ${models} model${models === 1 ? "" : "s"}` : ""}
              {models > 0 && providers > 0 ? " · " : ""}
              {providers > 0 ? `${providers} provider${providers === 1 ? "" : "s"}` : ""}
            </span>
          )}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "1.5rem",
          marginBottom: "4rem",
        }}
      >
        <StatCard label={t.cards.last24h} value={last24h} locale={locale} accent />
        <StatCard label={t.cards.last7d} value={last7d} locale={locale} accent />
        <StatCard
          label={t.cards.firstDeploy}
          valueText={firstDeployFormatted}
          subtext={firstDeployRelative}
          locale={locale}
        />
      </div>

      {series && series.length > 0 && (
        <section style={{ marginBottom: "4rem" }}>
          <header style={{ marginBottom: "1.5rem", textAlign: "center" }}>
            <h2
              className="serif"
              style={{
                fontSize: "1.5rem",
                fontWeight: 400,
                color: "var(--ink-black)",
                marginBottom: "0.5rem",
              }}
            >
              Deploys,{" "}
              <span style={{ fontStyle: "italic" }}>last 30 days</span>
            </h2>
            <p
              className="mono"
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                color: "var(--text-muted)",
                fontWeight: 600,
              }}
            >
              Cumulative — tap or hover a day for its count
            </p>
          </header>
          <Sparkline
            data={series}
            variant="area"
            height={240}
            locale={locale}
            labels={{
              peak: t.sparkline.peak,
              total: t.sparkline.total,
              barLabel: t.sparkline.barLabel,
            }}
          />
        </section>
      )}

      <div
        style={{
          textAlign: "center",
          paddingTop: "2rem",
          borderTop: "1px solid var(--etched-border)",
        }}
      >
        <Link
          href={PUBLIC_START_HREF}
          className="action-button"
          style={{
            padding: "16px 36px",
            fontSize: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            textDecoration: "none",
            letterSpacing: "0.12em",
          }}
        >
          {t.cta.button}
        </Link>
        <p
          className="mono"
          style={{
            marginTop: "1rem",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.18em",
            color: "var(--text-muted)",
            fontWeight: 600,
          }}
        >
          {t.cta.subtitle}
        </p>
      </div>
    </main>
  );
}

function StatCard({
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
    (value === null || value === undefined ? "—" : `+${value.toLocaleString(locale)}`);
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
