"use client";

import { motion, useReducedMotion } from "framer-motion";

import { ActionLinks, type ActionLink } from "@/components/public-editorial/ActionLinks";
import { TokenSurfaceGate } from "@/components/public-editorial/TokenSurfaceGate";
import { Sparkline } from "@/components/stats/Sparkline";
import { RollingNumber } from "@/components/ui/RollingNumber";
import { useLocale } from "@/components/i18n/LocaleProvider";
import type { TokenSurfaceView } from "@/lib/compliance/token-surface-view";
import {
  StatCard,
  TokenOdometer,
  hasDeployedCount,
  useStatsData,
  type StatsPageProps,
} from "./stats-parts.client";
import styles from "./stats-editorial.module.css";

// The English page: Ash's copy for /stats (06-stats.md). Everything numeric is live.
// The visitor's own language keeps the translated page (StatsPageContent).
const DATE_LOCALE = "en-GB";

const LINKS: readonly ActionLink[] = [
  { label: "Explore agents", href: "/agents", kind: "primary" },
  { label: "See pricing", href: "/pricing", kind: "secondary" },
];

/** "20 October 2026 at 14:05 UTC", fixed to UTC so the server and the browser print the same text. */
function formatAsOf(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return `${new Intl.DateTimeFormat(DATE_LOCALE, { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(date)} UTC`;
  } catch {
    return null;
  }
}

/** "a, b and c": the parts of one sentence, in the order the page shows them. */
function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleDateString(DATE_LOCALE, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  } catch {
    return iso.slice(0, 10);
  }
}

export default function StatsEditorial({
  initial,
  firstDeployIso,
  platform,
  tokenView,
}: StatsPageProps & { tokenView: TokenSurfaceView }) {
  const reduceMotion = useReducedMotion();
  const { copy } = useLocale();
  const t = copy.stats.page;
  const data = useStatsData({ initial, firstDeployIso, platform }, DATE_LOCALE);

  const countAvailable = hasDeployedCount({
    total: data.total ?? Number.NaN,
    last24h: data.last24h ?? Number.NaN,
    last7d: data.last7d ?? Number.NaN,
  });
  const asOf = formatAsOf(data.generatedAt);
  const firstDeploy = formatDay(firstDeployIso);
  const showTokens = data.tokensProcessed !== null && data.tokensProcessed > 0;
  const hasSeries = Boolean(data.series && data.series.length > 0);
  const showLive = data.runningNow !== null;

  // The sentence names only the figures that are on the page right now.
  const shown: string[] = [];
  // The running count covers agents and computers, whichever way they are paid for.
  if (showLive) shown.push("how many agents and computers are running right now");
  if (countAvailable) shown.push("how many were launched in the last 24 hours and the last 7 days");
  if (firstDeploy) shown.push("the date of the first launch");
  if (hasSeries) shown.push("a 30-day chart of the running total");
  if (showTokens) shown.push("the tokens processed across the platform");

  return (
    <main id="main-content">
      <header className={styles.masthead}>
        <h1>Hivra in numbers.</h1>
        <p>
          It&rsquo;s useful to see what people are actually building and running. This page brings together the
          platform statistics we can measure, with enough context to understand what each number means.
        </p>
      </header>

      <section className={`${styles.section} ${styles.deployed}`} aria-labelledby="stats-deployed-heading">
        <h2 id="stats-deployed-heading">Agents and computers launched</h2>
        {countAvailable && data.total !== null ? (
          <motion.div
            className={styles.figure}
            animate={
              data.bumped && !reduceMotion
                ? { boxShadow: "0 0 0 1px rgba(255, 44, 45,0.5), 0 0 80px rgba(255, 44, 45,0.2)" }
                : { boxShadow: "0 0 0 1px rgba(0,0,0,0)" }
            }
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            <RollingNumber
              value={data.total}
              locale={DATE_LOCALE}
              ariaLabel={`${data.total.toLocaleString(DATE_LOCALE)} ${t.ariaTotal}`}
              className={`serif ${styles.number}`}
            />
            {asOf ? (
              <p className={styles.asOf}>
                As of <time dateTime={data.generatedAt ?? undefined}>{asOf}</time>
              </p>
            ) : null}
          </motion.div>
        ) : (
          <p className={styles.unavailable} role="status">
            The count could not be loaded just now.
          </p>
        )}
        <p className={styles.definition}>
          A launch is an agent or a computer that was created and came up successfully at least once, not
          necessarily a unique user, one currently online or a paying subscription. We keep those measures separate
          so the number isn&rsquo;t mistaken for something it doesn&rsquo;t represent.
        </p>
      </section>

      {shown.length > 0 ? (
        <section className={`${styles.section} ${styles.more}`} aria-labelledby="stats-more-heading">
          <h2 id="stats-more-heading">More ways to understand activity</h2>
          {/* Without the total there is nothing to be "alongside", so the sentence stands on its own. */}
          <p>{countAvailable ? "Alongside the total, this page shows" : "This page also shows"} {joinParts(shown)}.</p>

          <div className={styles.figures}>
            {showLive && data.runningNow !== null ? (
              <StatCard label="Agents and computers running now" valueText={data.runningNow.toLocaleString(DATE_LOCALE)} locale={DATE_LOCALE} accent />
            ) : null}
            {countAvailable ? (
              <>
                <StatCard label={t.cards.last24h} value={data.last24h} locale={DATE_LOCALE} accent />
                <StatCard label={t.cards.last7d} value={data.last7d} locale={DATE_LOCALE} accent />
              </>
            ) : null}
            {firstDeploy ? (
              <StatCard label={t.cards.firstDeploy} valueText={firstDeploy} subtext={data.firstDeployRelative} locale={DATE_LOCALE} />
            ) : null}
          </div>

          {showTokens && data.tokensProcessed !== null ? (
            <div className={styles.tokens}>
              <span className={styles.tokensLabel}>Tokens processed</span>
              <TokenOdometer
                prevVal={data.tokenAnchorPrev}
                prevAt={data.tokenAnchorPrevAt}
                currVal={data.tokenAnchorCurr}
                currAt={data.tokenAnchorCurrAt}
                fallback={data.tokensProcessed}
                locale={DATE_LOCALE}
                reduceMotion={!!reduceMotion}
              />
              {data.models > 0 || data.providers > 0 ? (
                <span className={styles.tokensNote}>
                  {data.models > 0 ? `across ${data.models} model${data.models === 1 ? "" : "s"}` : ""}
                  {data.models > 0 && data.providers > 0 ? " \u00b7 " : ""}
                  {data.providers > 0 ? `${data.providers} provider${data.providers === 1 ? "" : "s"}` : ""}
                </span>
              ) : null}
            </div>
          ) : null}

          {hasSeries && data.series ? (
            <section className={styles.chart} aria-labelledby="stats-chart-heading">
              <div className={styles.chartHead}>
                <h3 id="stats-chart-heading">Launches, last 30 days</h3>
                <p>Cumulative: tap or hover a day for its count</p>
              </div>
              <Sparkline
                data={data.series}
                variant="area"
                height={240}
                locale={DATE_LOCALE}
                labels={{ peak: t.sparkline.peak, total: t.sparkline.total, barLabel: t.sparkline.barLabel }}
              />
            </section>
          ) : null}

          <TokenSurfaceGate view={tokenView}>
            <p className={styles.tokenNote}>We won&rsquo;t treat token trading volume as evidence of actual product use.</p>
          </TokenSurfaceGate>
        </section>
      ) : null}

      <div className={styles.closing}>
        <ActionLinks items={LINKS} />
      </div>
    </main>
  );
}
