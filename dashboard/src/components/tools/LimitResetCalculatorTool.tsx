"use client";

// Claude Code Limit Reset Calculator (/tools/claude-code-limit-reset-calculator).
//
// Answers one question: you hit "session limit", so when can you work again.
// Anthropic describes the session limit as a rolling five-hour window. It does
// not document what opens the window; the widely reported behavior, which this
// tool assumes and says so on the page, is that the first message of a session
// opens it. The weekly limit is a separate limit that resets at a fixed time each
// week assigned to the account, and waiting out the five-hour window does not
// clear it. That distinction is the thing people get wrong, so it gets its own
// panel rather than a footnote.
//
// Every external fact lives in the LIMITS table with a lastVerified date that
// the page renders. All state is client side, all times are the user's own
// local clock, nothing is sent anywhere.

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import styles from "@/app/tools/tools.module.css";
import { TOOLS_CTA } from "@/lib/tools/tool-catalog";

// External facts, checked on 2026-09-24 against claude.com/pricing (rolling
// five-hour session window, weekly limits on paid plans, one pool across web,
// desktop, mobile and Claude Code), support.claude.com (weekly limits reset at a
// fixed time assigned to the account), code.claude.com/docs (limit messages,
// /usage, automatic continue) and anthropic.com/news/higher-limits-spacex.
const LIMITS = {
  lastVerified: "2026-09-24",
  windowHours: 5,
  sharedPool: "Claude on the web, desktop and mobile, and Claude Code",
  // Published 2026-05-06: Claude Code's five-hour limits doubled for Pro, Max,
  // Team and seat-based Enterprise, and the peak-hours limit reduction was
  // removed on Claude Code for Pro and Max.
  doubledOn: "2026-05-06",
} as const;

const WINDOW_MINUTES = LIMITS.windowHours * 60;
const MINUTES_PER_DAY = 1440;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "HH:MM" to minutes since local midnight. Returns null on anything unparseable. */
function parseTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Minutes since midnight to "14:00". Accepts values past 1440 and wraps them. */
function formatClock(totalMinutes: number): string {
  const wrapped = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The same minute in 12 hour form, for people who read clocks that way. */
function formatClock12(totalMinutes: number): string {
  const wrapped = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours24 = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  const suffix = hours24 < 12 ? "am" : "pm";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

/** "3h 12m", "45m", "2 days 4h". Always positive; callers handle the sign. */
function formatDuration(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes));
  const days = Math.floor(mins / MINUTES_PER_DAY);
  const hours = Math.floor((mins % MINUTES_PER_DAY) / 60);
  const minutes = mins % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

interface WindowResult {
  /** Minutes since midnight on the day the first prompt was sent. */
  startAbs: number;
  /** startAbs + 5 hours. May exceed 1440, meaning it closes after midnight. */
  closeAbs: number;
  crossesMidnight: boolean;
}

function computeWindow(startMinutes: number): WindowResult {
  const closeAbs = startMinutes + WINDOW_MINUTES;
  return { startAbs: startMinutes, closeAbs, crossesMidnight: closeAbs >= MINUTES_PER_DAY };
}

/**
 * Minutes from `nowMinutes` until the window closes. A first-prompt time later
 * in the day than the current clock is read as yesterday evening, which is the
 * common case for someone checking at 8am after a late session.
 */
function minutesUntilClose(startMinutes: number, nowMinutes: number): number {
  const startAbs = startMinutes > nowMinutes ? startMinutes - MINUTES_PER_DAY : startMinutes;
  return startAbs + WINDOW_MINUTES - nowMinutes;
}

// The wall clock, modelled as an external store so the component can read it
// without seeding state inside an effect. The snapshot has to be stable
// between reads, so it is cached here and refreshed by the ticker rather than
// recomputed on every render. 0 means the clock has not started, which is what
// the static server render sees.
let clockSnapshot = 0;

function getClockSnapshot(): number {
  return clockSnapshot;
}

function getServerClockSnapshot(): number {
  return 0;
}

function subscribeToClock(onChange: () => void): () => void {
  clockSnapshot = Date.now();
  const timer = setInterval(() => {
    clockSnapshot = Date.now();
    onChange();
  }, 30_000);
  return () => clearInterval(timer);
}

/** Minutes from now until the next weekly reset at `day` and `time`. */
function minutesUntilWeeklyReset(now: Date, day: number, resetMinutes: number): number {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const dayDelta = (day - now.getDay() + 7) % 7;
  let delta = dayDelta * MINUTES_PER_DAY + resetMinutes - nowMinutes;
  if (delta <= 0) delta += 7 * MINUTES_PER_DAY;
  return delta;
}

export default function LimitResetCalculatorTool() {
  const [firstPrompt, setFirstPrompt] = useState("09:00");
  const [weeklyDay, setWeeklyDay] = useState<string>("unknown");
  const [weeklyTime, setWeeklyTime] = useState("09:00");
  // The wall clock is an external store, read through useSyncExternalStore
  // rather than seeded in an effect. This page is statically generated, so the
  // server snapshot has to be a value the client can hydrate against: 0 means
  // "no clock yet", and every clock-dependent block below is gated on it.
  const nowMs = useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);
  const now = nowMs === 0 ? null : new Date(nowMs);

  const startMinutes = parseTime(firstPrompt);
  const result = startMinutes === null ? null : computeWindow(startMinutes);

  const nowMinutes = now ? now.getHours() * 60 + now.getMinutes() : null;
  const remaining = startMinutes === null || nowMinutes === null ? null : minutesUntilClose(startMinutes, nowMinutes);
  const windowClosed = remaining !== null && remaining <= 0;

  const weeklyDayNum = weeklyDay === "unknown" ? null : Number(weeklyDay);
  const weeklyResetMinutes = parseTime(weeklyTime);
  const weeklyRemaining =
    now === null || weeklyDayNum === null || weeklyResetMinutes === null
      ? null
      : minutesUntilWeeklyReset(now, weeklyDayNum, weeklyResetMinutes);

  // The next three windows if you start a fresh one the moment the last closes.
  const schedule =
    result === null
      ? []
      : [0, 1, 2].map((i) => {
          const opens = result.startAbs + i * WINDOW_MINUTES;
          return { index: i + 1, opens, closes: opens + WINDOW_MINUTES, dayOffset: Math.floor(opens / MINUTES_PER_DAY) };
        });

  function setToNow() {
    const current = new Date();
    setFirstPrompt(`${String(current.getHours()).padStart(2, "0")}:${String(current.getMinutes()).padStart(2, "0")}`);
  }

  return (
    <div className={styles.tool}>
      <div className={styles.inputs}>
        <div>
          <label className={styles.label} htmlFor="lr-first-prompt">
            First prompt of this session
          </label>
          <input id="lr-first-prompt" className={styles.field} type="time" value={firstPrompt} onChange={(e) => setFirstPrompt(e.target.value)} />
          <button type="button" onClick={setToNow} className={styles.smallButton}>
            Use the time now
          </button>
        </div>
        <div>
          <label className={styles.label} htmlFor="lr-weekly-day">
            Weekly reset day (optional)
          </label>
          <select id="lr-weekly-day" className={styles.field} value={weeklyDay} onChange={(e) => setWeeklyDay(e.target.value)}>
            <option value="unknown">I do not know it yet</option>
            {DAY_NAMES.map((name, i) => (
              <option key={name} value={String(i)}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={styles.label} htmlFor="lr-weekly-time">
            Weekly reset time (optional)
          </label>
          <input
            id="lr-weekly-time"
            className={styles.field}
            type="time"
            value={weeklyTime}
            onChange={(e) => setWeeklyTime(e.target.value)}
            disabled={weeklyDay === "unknown"}
          />
        </div>
      </div>

      <div className={styles.panel}>
        <span className={styles.panelTitle}>Your {LIMITS.windowHours} hour window</span>
        {result === null ? (
          <p style={{ margin: 0 }}>Enter the time you sent the first prompt of this session.</p>
        ) : (
          <>
            <p className={styles.big}>
              Closes at <strong data-testid="lr-close-time">{formatClock(result.closeAbs)}</strong>
            </p>
            <p style={{ margin: "0 0 10px", fontSize: 15, lineHeight: 1.7 }}>
              That is {formatClock12(result.closeAbs)}
              {result.crossesMidnight ? " the next day" : " on the same day"}, on your own local clock. On the first
              message model, the window opened at {formatClock(result.startAbs)} and runs for {LIMITS.windowHours}{" "}
              hours from that moment.
            </p>
            {remaining !== null && (
              <p data-testid="lr-countdown" className={[styles.countdown, windowClosed ? styles.toneGood : styles.toneBad].filter(Boolean).join(" ")}>
                {windowClosed
                  ? "That window has already closed. Your next prompt opens a fresh one."
                  : `${formatDuration(remaining)} left in this window.`}
              </p>
            )}
          </>
        )}
      </div>

      <div className={styles.panel}>
        <span className={styles.panelTitle}>The weekly limit is a different clock</span>
        {weeklyRemaining === null ? (
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.75 }}>
            Waiting out the {LIMITS.windowHours} hour window does nothing for the weekly limit. They are two separate
            limits, and the weekly one resets at a fixed time each week that Anthropic assigns to your account. If
            Claude Code says you are out for the week, the clock above is not the one that matters. Check the reset
            time with the /usage command in Claude Code or under Settings, then Usage, on your Claude account, and
            enter it above to see the countdown.
          </p>
        ) : (
          <>
            <p className={styles.big} style={{ fontSize: "clamp(24px,3vw,32px)" }}>
              Weekly limit resets in <strong>{formatDuration(weeklyRemaining)}</strong>
            </p>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.75 }}>
              Next reset lands on {DAY_NAMES[weeklyDayNum as number]} at {formatClock(weeklyResetMinutes as number)}.
              This limit is separate from the {LIMITS.windowHours} hour window, so waiting out the window above does
              not restore weekly capacity.
            </p>
          </>
        )}
      </div>

      {schedule.length > 0 && (
        <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="The next three windows">
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Window</th>
                <th scope="col">Opens</th>
                <th scope="col">Closes</th>
                <th scope="col">Day</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map((row) => (
                <tr key={row.index}>
                  <td>{row.index === 1 ? "Current" : `Window ${row.index}`}</td>
                  <td>{formatClock(row.opens)}</td>
                  <td>{formatClock(row.closes)}</td>
                  <td>{row.dayOffset === 0 ? "Same day" : row.dayOffset === 1 ? "Next day" : `${row.dayOffset} days later`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.note}>
        How this works. Anthropic describes the session limit as a rolling {LIMITS.windowHours} hour window and does
        not document what opens it. This calculator assumes the widely reported behavior: the first message of a
        session opens the window, and it closes {LIMITS.windowHours} hours later whether you keep working or step
        away. The reset time in Claude Code&apos;s limit message and in /usage is the authority; trust it over this
        page. Weekly limits sit on top and reset at a fixed time each week assigned to your account. Your allowance
        is one pool shared by {LIMITS.sharedPool}, so heavy chat use eats into what Claude Code has left. Anthropic
        does not publish exact prompt or token caps per plan, so this tool does no capacity guessing: it answers the
        timing question only. On {LIMITS.doubledOn} Anthropic doubled Claude Code&apos;s {LIMITS.windowHours} hour
        limits for Pro, Max, Team and seat-based Enterprise plans and removed the peak-hours limit reduction on
        Claude Code for Pro and Max. All times use your own local clock. Nothing you enter leaves your browser. Facts
        last verified {LIMITS.lastVerified} on Anthropic&apos;s own pages.
      </p>

      {/* Hosting does not raise or reset Anthropic limits. The honest bridge is
          availability during the window, not extra quota. The copy promises only
          what holds on every Hivra computer (lib/blog/runtime-facts.ts): a session
          inside tmux in the Terminal tab outlives the tab. Browser chat and
          session-tab runs depend on the computer's runtime version, so the copy
          makes no claim about them either way. */}
      <div className={styles.bridge}>
        <p>
          Hosting does not change your limits. The quota follows your Anthropic account, so it is the same on a
          laptop or a server. What a server changes is whether the window gets used: Claude Code can pick a task back
          up after a reset only while its session stays open. Hivra runs Claude Code on its own computer with your
          own Anthropic login, and paid plans are not paused for inactivity. A session you start inside tmux in its
          Terminal tab stays open after you close the laptop, so it is still there when the window resets. See{" "}
          <Link href={TOOLS_CTA.secondaryHref}>the pricing page</Link> for plans.
        </p>
        <Link href={TOOLS_CTA.claudeCodeHref} className={styles.bridgeLink}>
          Run Claude Code on Hivra
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
