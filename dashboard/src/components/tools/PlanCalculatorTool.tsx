"use client";

// Claude Code Plan Calculator (/tools/claude-code-plan-calculator).
//
// Turns a weekly coding schedule into an estimated monthly token count, an
// API-equivalent dollar figure, and a fit rating per Anthropic plan.
//
// Anthropic does not publish fixed hour or message caps, only that Max 5x and
// Max 20x give five and twenty times Pro's usage per five-hour session. So the
// fit rating is calibrated from the one number the visitor knows: how far into
// a session Pro's limit stops them today. The published multipliers scale that
// to Max. The 2025 hour ranges the retired version used were for Sonnet 4 and
// Opus 4 and are not on Anthropic's current plan pages, so they are gone.
//
// Every external fact lives in the RATES table with a lastVerified date that the
// page renders.

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import styles from "@/app/tools/tools.module.css";
import { TOOLS_CTA } from "@/lib/tools/tool-catalog";

// External facts, checked on 2026-09-24 against claude.com/pricing,
// support.claude.com (Pro and Max plan articles) and
// platform.claude.com/docs/en/about-claude/pricing. Update lastVerified only
// when every value here is re-checked on the vendor's own page.
const RATES = {
  lastVerified: "2026-09-24",
  windowHours: 5,
  plans: {
    pro: { label: "Pro", priceUsd: 20, multiplier: 1 },
    max5x: { label: "Max 5x", priceUsd: 100, multiplier: 5 },
    max20x: { label: "Max 20x", priceUsd: 200, multiplier: 20 },
  },
  // USD per million tokens at list price, no prompt caching.
  api: {
    sonnet: { label: "Sonnet 5", input: 2, output: 10 },
    opus: { label: "Opus 5.5", input: 4, output: 20 },
  },
} as const;

// Assumed token throughput per active hour. Hivra's own estimate, stated on
// the page.
const TOKENS_PER_HOUR = {
  normal: { inputM: 0.5, outputM: 0.05 },
  heavy: { inputM: 2, outputM: 0.2 },
} as const;

const WEEKS_PER_MONTH = 4.33;

type PlanKey = keyof typeof RATES.plans;
type FitLevel = "headroom" | "tight" | "over";

// Where Pro's session limit stops the visitor today, in hours of work into a
// five-hour window. "never" means Pro has not stopped them; "unknown" means
// they have not used Pro.
const PRO_HIT_OPTIONS = [
  { value: "0.5", label: "About 30 minutes in" },
  { value: "1", label: "About 1 hour in" },
  { value: "2", label: "About 2 hours in" },
  { value: "3", label: "About 3 hours in" },
  { value: "4", label: "About 4 hours in" },
  { value: "never", label: "Pro never stops me" },
  { value: "unknown", label: "I have not used Pro" },
] as const;

type ProHit = (typeof PRO_HIT_OPTIONS)[number]["value"];

interface PlanFit {
  key: PlanKey;
  label: string;
  priceUsd: number;
  fit: FitLevel | null;
  detail: string;
}

const FIT_COPY: Record<FitLevel, { label: string; tone: string | undefined }> = {
  headroom: { label: "Fits with headroom", tone: styles.toneGood },
  tight: { label: "Tight", tone: styles.toneWarn },
  over: { label: "Would hit limits", tone: styles.toneBad },
};

function formatUsd(value: number): string {
  if (value >= 100) return `$${Math.round(value)}`;
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

function formatTokens(millions: number): string {
  if (millions >= 1000) return `${(millions / 1000).toFixed(1)}B`;
  return `${Math.round(millions)}M`;
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

export default function PlanCalculatorTool() {
  const [daysPerWeek, setDaysPerWeek] = useState(5);
  const [hoursPerDay, setHoursPerDay] = useState(3);
  const [opusPct, setOpusPct] = useState(20);
  const [heavyUse, setHeavyUse] = useState(false);
  const [proHit, setProHit] = useState<ProHit>("2");

  const weeklyHours = daysPerWeek * hoursPerDay;
  const monthlyHours = weeklyHours * WEEKS_PER_MONTH;
  const throughput = heavyUse ? TOKENS_PER_HOUR.heavy : TOKENS_PER_HOUR.normal;

  const opusFrac = opusPct / 100;
  const sonnetFrac = 1 - opusFrac;

  const monthlyInputM = monthlyHours * throughput.inputM;
  const monthlyOutputM = monthlyHours * throughput.outputM;
  const monthlyTokensM = monthlyInputM + monthlyOutputM;

  const apiCostPerMonth =
    sonnetFrac * (monthlyInputM * RATES.api.sonnet.input + monthlyOutputM * RATES.api.sonnet.output) +
    opusFrac * (monthlyInputM * RATES.api.opus.input + monthlyOutputM * RATES.api.opus.output);

  // Hours of work in the busiest five-hour window of a day.
  const peakWindowHours = Math.min(hoursPerDay, RATES.windowHours);
  const proCapacityHours = proHit === "never" || proHit === "unknown" ? null : Number(proHit);

  const planFits: PlanFit[] = (Object.keys(RATES.plans) as PlanKey[]).map((key) => {
    const plan = RATES.plans[key];
    if (proHit === "unknown") {
      return { key, label: plan.label, priceUsd: plan.priceUsd, fit: null, detail: `${plan.multiplier}x Pro's usage per session` };
    }
    if (proHit === "never") {
      return { key, label: plan.label, priceUsd: plan.priceUsd, fit: "headroom", detail: "Pro already covers your sessions" };
    }
    const capacity = (proCapacityHours as number) * plan.multiplier;
    const ratio = peakWindowHours / capacity;
    const fit: FitLevel = ratio <= 0.6 ? "headroom" : ratio <= 1 ? "tight" : "over";
    const capacityLabel = capacity >= RATES.windowHours ? `the full ${RATES.windowHours}h window` : `~${formatHours(capacity)}`;
    return {
      key,
      label: plan.label,
      priceUsd: plan.priceUsd,
      fit,
      detail: `${formatHours(peakWindowHours)} of work per window vs ${capacityLabel} estimated`,
    };
  });

  const cheapestFit = planFits.find((p) => p.fit !== null && p.fit !== "over");
  let verdict: string;
  if (proHit === "unknown") {
    verdict = `Anthropic does not publish Pro's cap, so tell the calculator where Pro stops you to rate each plan. At API rates this schedule costs about ${formatUsd(apiCostPerMonth)}/month.`;
  } else if (!cheapestFit) {
    verdict = `Your sessions need more than Max 20x gives. At API rates this usage runs about ${formatUsd(apiCostPerMonth)}/month; Max 20x plus usage credits at API rates is the realistic setup.`;
  } else if (apiCostPerMonth < cheapestFit.priceUsd) {
    verdict = `${cheapestFit.label} at ${formatUsd(cheapestFit.priceUsd)}/month is the cheapest plan that fits, but at this volume plain API billing is cheaper: about ${formatUsd(apiCostPerMonth)}/month.`;
  } else {
    verdict = `${cheapestFit.label} at ${formatUsd(cheapestFit.priceUsd)}/month is the cheapest plan that fits. The same usage at API rates: about ${formatUsd(apiCostPerMonth)}/month.`;
  }

  return (
    <div className={styles.tool}>
      <div className={styles.inputs}>
        <div>
          <label className={styles.label} htmlFor="pc-days">
            Days per week: {daysPerWeek}
          </label>
          <input id="pc-days" className={styles.range} type="range" min={1} max={7} step={1} value={daysPerWeek} onChange={(e) => setDaysPerWeek(Number(e.target.value))} />
        </div>
        <div>
          <label className={styles.label} htmlFor="pc-hours">
            Hours per day: {hoursPerDay}
          </label>
          <input id="pc-hours" className={styles.range} type="range" min={1} max={12} step={1} value={hoursPerDay} onChange={(e) => setHoursPerDay(Number(e.target.value))} />
        </div>
        <div>
          <label className={styles.label} htmlFor="pc-opus">
            Model mix: {opusPct}% Opus / {100 - opusPct}% Sonnet
          </label>
          <input id="pc-opus" className={styles.range} type="range" min={0} max={100} step={5} value={opusPct} onChange={(e) => setOpusPct(Number(e.target.value))} />
        </div>
        <div>
          <label className={styles.label} htmlFor="pc-pro-hit">
            On Pro today, the session limit stops me
          </label>
          <select id="pc-pro-hit" className={styles.field} value={proHit} onChange={(e) => setProHit(e.target.value as ProHit)}>
            {PRO_HIT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className={styles.label}>Usage style</span>
          <label className={styles.check}>
            <input type="checkbox" checked={heavyUse} onChange={(e) => setHeavyUse(e.target.checked)} />
            Heavy agentic use (long autonomous runs, big repos)
          </label>
        </div>
      </div>

      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Est. tokens / month</span>
          <span className={styles.statValue}>{formatTokens(monthlyTokensM)}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>API-equivalent cost</span>
          <span className={styles.statValue}>{formatUsd(apiCostPerMonth)}/mo</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Active hours / week</span>
          <span className={styles.statValue}>{weeklyHours}h</span>
        </div>
      </div>

      <div className={styles.list}>
        {planFits.map((plan) => (
          <div key={plan.key} className={styles.listRow}>
            <div>
              <span className={styles.listName}>{plan.label}</span>
              <span className={styles.listPrice}>{formatUsd(plan.priceUsd)}/mo</span>
            </div>
            <div className={styles.listDetail}>
              <span>{plan.detail}</span>
              {plan.fit ? <span className={[styles.badge, FIT_COPY[plan.fit].tone].filter(Boolean).join(" ")}>{FIT_COPY[plan.fit].label}</span> : null}
            </div>
          </div>
        ))}
      </div>

      <p className={styles.verdict} data-testid="pc-verdict">{verdict}</p>

      <p className={styles.note}>
        How this works: Anthropic says Max 5x gives five times Pro&apos;s usage per five-hour session and Max 20x
        gives twenty times, and publishes no fixed caps. The fit rating takes the point where Pro stops you, scales it
        by those multiples, and compares it with the hours you work inside your busiest five-hour window. Weekly limits
        sit on top and are not published either, so a plan that covers each session can still run out for the week
        if you work most days. The API figure assumes a normal active hour uses about {TOKENS_PER_HOUR.normal.inputM}M
        input and {Math.round(TOKENS_PER_HOUR.normal.outputM * 1000)}K output tokens, and a heavy agentic hour about{" "}
        {TOKENS_PER_HOUR.heavy.inputM}M input and {Math.round(TOKENS_PER_HOUR.heavy.outputM * 1000)}K output, priced at{" "}
        {RATES.api.sonnet.label} (${RATES.api.sonnet.input} in, ${RATES.api.sonnet.output} out per million tokens) and{" "}
        {RATES.api.opus.label} (${RATES.api.opus.input} in, ${RATES.api.opus.output} out). It prices every input
        token at the full rate; Claude Code caches most of its context and cache reads cost a tenth of that or less,
        so a real API bill is usually lower. Treat every number as an estimate, not a quote. Prices and plan facts
        last verified {RATES.lastVerified} on Anthropic&apos;s own pages.
      </p>

      <div className={styles.bridge}>
        <p>
          Whichever plan you pick, it only pays off while the agent is running. Put the same Claude login on an
          always-on computer, start long runs inside tmux or from Telegram, and the hours you pay for keep working
          after you close the laptop.
        </p>
        <Link href={TOOLS_CTA.claudeCodeHref} className={styles.bridgeLink}>
          Run Claude Code on Hivra
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
