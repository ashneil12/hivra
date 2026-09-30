"use client";

// Claude Code Plan Calculator (/tools/claude-code-plan-calculator).
//
// Turns a weekly coding schedule into an estimated API list-price bill and a fit
// rating per Anthropic plan. The rules live in lib/tools/claude-plan-calc.ts and
// every external fact in lib/tools/claude-plan-facts.ts (prices, multiples, API
// rates, Anthropic's cost averages, each with its source and the date it was
// read). This file only renders them.
//
// Anthropic does not publish fixed hour or message caps, a weekly multiple for
// Max, or Pro's absolute allowance, only that Max 5x and Max 20x give five and
// twenty times Pro's usage per five-hour session. So the fit rating is
// calibrated from the one number the visitor knows: how far into a window Pro's
// limit stops them today. The published multiples scale that to Max. The weekly
// limit is never rated, and the page says so. The dollar figure is an estimate
// and is labelled as one.

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import styles from "@/app/tools/tools.module.css";
import { CLAUDE_PLAN_FACTS } from "@/lib/tools/claude-plan-facts";
import {
  FIT_LABELS,
  PLAN_DEFAULTS,
  PRO_HIT_OPTIONS,
  PRO_WEEKLY_OPTIONS,
  computePlanResult,
  formatUsd,
  type FitLevel,
  type ProHit,
  type ProWeekly,
} from "@/lib/tools/claude-plan-calc";
import { TOOLS_CTA } from "@/lib/tools/tool-catalog";

const F = CLAUDE_PLAN_FACTS;

const FIT_TONE: Record<FitLevel, string | undefined> = {
  headroom: styles.toneGood,
  tight: styles.toneWarn,
  over: styles.toneBad,
};

export default function PlanCalculatorTool() {
  const [daysPerWeek, setDaysPerWeek] = useState(PLAN_DEFAULTS.daysPerWeek);
  const [hoursPerDay, setHoursPerDay] = useState(PLAN_DEFAULTS.hoursPerDay);
  const [opusPct, setOpusPct] = useState(PLAN_DEFAULTS.opusPct);
  const [heavyUse, setHeavyUse] = useState(PLAN_DEFAULTS.heavyUse);
  const [proHit, setProHit] = useState<ProHit>(PLAN_DEFAULTS.proHit);
  const [proWeekly, setProWeekly] = useState<ProWeekly>(PLAN_DEFAULTS.proWeekly);

  const result = computePlanResult({ daysPerWeek, hoursPerDay, opusPct, heavyUse, proHit, proWeekly });
  const normalOutputK = Math.round(F.estimate.outputMPerHour.normal * 1000);
  const heavyOutputK = Math.round(F.estimate.outputMPerHour.heavy * 1000);

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
            Model mix: {opusPct}% {F.api.opus.label} / {100 - opusPct}% {F.api.sonnet.label}
          </label>
          <input id="pc-opus" className={styles.range} type="range" min={0} max={100} step={5} value={opusPct} onChange={(e) => setOpusPct(Number(e.target.value))} />
          <p className={styles.hint}>
            {F.defaultModel.label} has been Claude Code&apos;s default model on Pro and Max since {F.defaultModel.since}, so 100% Opus is what you get if you never run /model.
          </p>
        </div>
        <div>
          <label className={styles.label} htmlFor="pc-pro-hit">
            On Pro, the five-hour limit stops me
          </label>
          <select id="pc-pro-hit" className={styles.field} value={proHit} onChange={(e) => setProHit(e.target.value as ProHit)}>
            {PRO_HIT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className={styles.hint}>
            Anthropic publishes no figure for where Pro stops you, so this is your own reading, and until you choose one the plans are not rated. Use a reading from after {F.limitChanges.fiveHourRaised}, when Anthropic raised five-hour limits.
          </p>
        </div>
        <div>
          <label className={styles.label} htmlFor="pc-pro-weekly">
            On Pro, the weekly limit
          </label>
          <select id="pc-pro-weekly" className={styles.field} value={proWeekly} onChange={(e) => setProWeekly(e.target.value as ProWeekly)}>
            {PRO_WEEKLY_OPTIONS.map((option) => (
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
          <span className={styles.statLabel}>API list price, estimated</span>
          <span className={styles.statValue}>{formatUsd(result.apiCostPerMonth)}/mo</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>
            Anthropic&apos;s enterprise average (${F.anthropicCost.perActiveDayUsd} per active day)
          </span>
          <span className={styles.statValue}>{formatUsd(result.anthropicAveragePerMonth)}/mo</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Active hours / week</span>
          <span className={styles.statValue}>{result.weeklyHours}h</span>
        </div>
      </div>

      <div className={styles.list}>
        {result.planFits.map((plan) => (
          <div key={plan.key} className={styles.listRow}>
            <div>
              <span className={styles.listName}>{plan.label}</span>
              <span className={styles.listPrice}>{formatUsd(plan.priceUsd)}/mo</span>
            </div>
            <div className={styles.listDetail}>
              <span>{plan.detail}</span>
              {plan.fit ? <span className={[styles.badge, FIT_TONE[plan.fit]].filter(Boolean).join(" ")}>{FIT_LABELS[plan.fit]}</span> : null}
            </div>
          </div>
        ))}
      </div>

      <p className={styles.verdict} data-testid="pc-verdict">{result.verdict}</p>

      <p className={styles.note}>
        Every number here is an estimate, not a quote. Anthropic states Max 5x and Max 20x as five and twenty times Pro&apos;s
        usage per five-hour session and publishes no caps, no weekly multiple and no size for Pro&apos;s allowance, so the
        ratings scale your own Pro reading by those multiples and never rate the weekly limit. The API figure is list price
        for your schedule, built from Anthropic&apos;s published rates and two assumptions of ours: about {normalOutputK}K
        output tokens in a normal hour ({heavyOutputK}K in a heavy one), and {Math.round(F.estimate.cacheReadShare * 100)}%
        of input read from the prompt cache. Method, sources and worked examples are below. Prices and plan facts last
        verified {F.lastVerified} on Anthropic&apos;s own pages.
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
