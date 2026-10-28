"use client";

import Link from "next/link";
import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";

import { RollingNumber } from "@/components/ui/RollingNumber";
import { Sparkline } from "@/components/stats/Sparkline";
import { useLocale } from "@/components/i18n/LocaleProvider";
import type { TokenSurfaceView } from "@/lib/compliance/token-surface-view";
import { DEFAULT_LOCALE } from "@/lib/i18n";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import StatsEditorial from "./StatsEditorial.client";
import {
  StatCard,
  TokenOdometer,
  heroLabelStyle,
  heroNumberStyle,
  hasDeployedCount,
  heroPanelStyle,
  useStatsData,
  type StatsPageProps,
} from "./stats-parts.client";

type Props = StatsPageProps & {
  /** What the token surfaces may show this viewer; resolved on the server. */
  tokenView: TokenSurfaceView;
};

/**
 * /stats. The English page carries Ash's copy (StatsEditorial). A visitor browsing in
 * another language keeps the translated page below until the copy is translated.
 */
export default function StatsPageContent(props: Props) {
  const { locale } = useLocale();
  if (locale === DEFAULT_LOCALE) return <StatsEditorial {...props} />;
  return <TranslatedStats initial={props.initial} firstDeployIso={props.firstDeployIso} platform={props.platform} />;
}

function TranslatedStats({ initial, firstDeployIso, platform }: StatsPageProps) {
  const reduceMotion = useReducedMotion();
  const { copy, locale } = useLocale();
  const t = copy.stats.page;
  const data = useStatsData({ initial, firstDeployIso, platform }, locale);

  const { series, bumped, runningNow, tokensProcessed, models, providers } = data;
  // A failed lookup comes back as all zeros: show no figure rather than a false 0.
  const countAvailable = hasDeployedCount({
    total: data.total ?? Number.NaN,
    last24h: data.last24h ?? Number.NaN,
    last7d: data.last7d ?? Number.NaN,
  });
  const total = countAvailable ? data.total : null;
  const last24h = countAvailable ? data.last24h : null;
  const last7d = countAvailable ? data.last7d : null;

  const firstDeployFormatted = useMemo(() => {
    if (!firstDeployIso) return "-";
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

  return (
    <main
      id="main-content"
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
                -
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

          {/* Agents and computers running now */}
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
              Agents and computers running now
            </span>
            {runningNow === null ? (
              <span className="serif" style={{ ...heroNumberStyle, color: "var(--text-muted)" }}>
                -
              </span>
            ) : (
              <RollingNumber
                value={runningNow}
                locale={locale}
                ariaLabel={`${runningNow.toLocaleString(locale)} agents and computers running now`}
                className="serif"
                style={{ ...heroNumberStyle, color: "var(--gold-leaf)" }}
              />
            )}
          </div>
        </div>
      </motion.div>

      {/* Tokens processed: headline throughput, the third top-line stat */}
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
            prevVal={data.tokenAnchorPrev}
            prevAt={data.tokenAnchorPrevAt}
            currVal={data.tokenAnchorCurr}
            currAt={data.tokenAnchorCurrAt}
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
          subtext={data.firstDeployRelative}
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
              Cumulative: tap or hover a day for its count
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
