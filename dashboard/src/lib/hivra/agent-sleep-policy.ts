/**
 * Agent sleep policy: pure decisions, no IO.
 *
 * Step 1 of the sleep/wake design. Given what is known about an agent, say
 * whether it WOULD be napped or hibernated. Nothing here acts on the answer.
 *
 * The one rule that shapes everything: fail toward awake. A signal that is
 * missing, unknown or stale counts as busy, never as idle.
 */

export type SleepMode = "off" | "observe" | "canary" | "on";
export type AgentSleepPolicy = "off" | "t1" | "t3" | "full";
export type SleepVerdict = "awake" | "would_nap" | "would_hibernate" | "ineligible";

const SLEEP_MODES: readonly SleepMode[] = ["off", "observe", "canary", "on"];

/** Anything unset or unrecognised is `off`: sleeping is never on by accident. */
export function parseSleepMode(env: string | undefined | null): SleepMode {
  const value = env?.trim().toLowerCase();
  return SLEEP_MODES.find((mode) => mode === value) ?? "off";
}

// Defaults from the design. All durations are seconds.
export const DEFAULT_NAP_AFTER_SECONDS = 4 * 60;
/**
 * Time spent in the nap tier before hibernating (design: 10-15 min in T1).
 * Measured from the moment the nap window ends, so total idle is the nap window
 * plus this: 16 minutes by default, inside the design's 13-20 minute range.
 */
export const DEFAULT_HIBERNATE_AFTER_NAP_SECONDS = 12 * 60;
/** Total idle before hibernate is the default nap window plus the time in nap. */
export const DEFAULT_HIBERNATE_AFTER_SECONDS =
  DEFAULT_NAP_AFTER_SECONDS + DEFAULT_HIBERNATE_AFTER_NAP_SECONDS;
/** Allowed gap between a collector's clock and ours before a sample counts as future-dated. */
export const SIGNAL_CLOCK_SKEW_SECONDS = 60;
/** A scheduled job this close keeps the agent awake. */
export const SCHEDULED_JOB_WINDOW_SECONDS = 15 * 60;
/** Signals older than this are treated as unknown. */
export const DEFAULT_MAX_SIGNAL_AGE_SECONDS = 5 * 60;
/** CPU use (percent of one core, averaged over the window) above this is busy. */
export const DEFAULT_CPU_BUSY_PERCENT = 3;
/** A pre-woken agent with no real request after this long goes back to sleep. */
export const GHOST_TIMER_SECONDS = 2 * 60;
export const THRASH_WINDOW_SECONDS = 30 * 60;
export const THRASH_WAKE_THRESHOLD = 3;
export const THRASH_MAX_IDLE_SECONDS = 2 * 60 * 60;

/**
 * A sleep or wake lease older than this has outlived any legitimate hold (a hibernate
 * script is allowed 280 s, plus its probe) and is settled from the host.
 */
export const STALE_SLEEP_LEASE_MS = 6 * 60_000;

/** Kinds that run their own loops, so "idle" cannot be read from outside. */
export const AUTONOMOUS_KINDS: readonly string[] = ["aeon"];
/** Kinds with a live display: a paused guest would freeze it, so hibernate only. */
export const DESKTOP_KINDS: readonly string[] = ["linux-desktop"];
/** Channels held open by a live socket, which a sleeping guest would drop. */
export const SOCKET_CHANNELS: readonly string[] = ["discord", "whatsapp", "slack"];

/**
 * The idle probe's live channel tags as plain channel names, for
 * `SleepSignals.socketChannels`: "hermes:discord" and "hermes:discord:down"
 * both become "discord", "openclaw:slack" becomes "slack", and the Hivra
 * Telegram bridge ("telegram:bux-tg") becomes "telegram". Undefined in, undefined
 * out: a missing probe stays unknown and never reads as "no channels".
 */
export function socketChannelsFromProbe(liveChannels: readonly string[] | null | undefined): string[] | undefined {
  if (!Array.isArray(liveChannels)) return undefined;
  const names = new Set<string>();
  for (const tag of liveChannels) {
    if (typeof tag !== "string") continue;
    const parts = tag.split(":");
    const name = parts[0] === "hermes" || parts[0] === "openclaw" ? parts[1] : parts[0];
    if (name) names.add(name.toLowerCase());
  }
  return [...names].sort();
}

/**
 * Everything known about one agent. Every field may be undefined, meaning
 * unknown. `null` on `lastActivityAt` / `nextScheduledJobAt` means known to be
 * "never" / "nothing scheduled".
 */
export interface SleepSignals {
  agentType?: string;
  /** When these signals were sampled (epoch ms). */
  sampledAt?: number;
  /** Last user or run activity (epoch ms). */
  lastActivityAt?: number | null;
  activeRun?: boolean;
  /** A lifecycle operation (start, stop, resize...) holds the agent. */
  operationInFlight?: boolean;
  openConnections?: number;
  terminalAttached?: boolean;
  desktopAttached?: boolean;
  /** Percent of one core over the sampling window. */
  cpuPercent?: number;
  nextScheduledJobAt?: number | null;
  /** Live socket channels in use, e.g. ["discord"]. Empty means none. */
  socketChannels?: readonly string[];
  telegramLongPoll?: boolean;
}

export interface SleepPolicyInput {
  /** The agent's own switch. Defaults to `off`. */
  sleepPolicy?: AgentSleepPolicy;
  alwaysOn?: boolean;
  /** The owner opted in to the Telegram peek, so long-poll no longer blocks sleep. */
  telegramOptIn?: boolean;
  napAfterSeconds?: number;
  /** Seconds spent napping before hibernate; total idle is napAfterSeconds plus this. */
  hibernateAfterNapSeconds?: number;
  maxSignalAgeSeconds?: number;
  cpuBusyPercent?: number;
  /** Epoch ms of recent wakes, for thrash backoff. */
  recentWakes?: readonly number[];
}

export interface SleepDecision {
  verdict: SleepVerdict;
  reasons: string[];
  /** Best known idle time. null when it cannot be worked out. */
  idleSeconds: number | null;
}

/** A usable number: finite and not negative. Anything else is a broken reading. */
function isValidNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function toMs(now: Date | number): number {
  return typeof now === "number" ? now : now.getTime();
}

/**
 * Thrash backoff: from the third wake within 30 minutes, the idle window
 * doubles for each extra wake, capped at 2 hours. A window already longer than
 * the cap is left alone.
 */
export function applyThrashBackoff(
  baseIdleSeconds: number,
  recentWakes: readonly number[] | undefined,
  now: Date | number,
): number {
  const nowMs = toMs(now);
  const wakes = (recentWakes ?? []).filter(
    (at) => Number.isFinite(at) && at <= nowMs && nowMs - at <= THRASH_WINDOW_SECONDS * 1000,
  ).length;
  if (wakes < THRASH_WAKE_THRESHOLD) return baseIdleSeconds;
  const doubled = baseIdleSeconds * 2 ** (wakes - THRASH_WAKE_THRESHOLD + 1);
  return Math.max(baseIdleSeconds, Math.min(doubled, THRASH_MAX_IDLE_SECONDS));
}

/** True once a pre-woken agent has waited long enough with no real request. */
export function isGhostWake(preWokeAt: number, now: Date | number): boolean {
  return toMs(now) - preWokeAt >= GHOST_TIMER_SECONDS * 1000;
}

function allowsNap(policy: AgentSleepPolicy): boolean {
  return policy === "t1" || policy === "full";
}

function allowsHibernate(policy: AgentSleepPolicy): boolean {
  return policy === "t3" || policy === "full";
}

/** Reasons the agent can never sleep, from the facts we do have. */
function ineligibleReasons(signals: SleepSignals, input: SleepPolicyInput): string[] {
  const reasons: string[] = [];
  if (input.alwaysOn) reasons.push("always_on");
  if ((input.sleepPolicy ?? "off") === "off") reasons.push("policy_off");
  if (signals.agentType && AUTONOMOUS_KINDS.includes(signals.agentType)) {
    reasons.push(`autonomous_kind:${signals.agentType}`);
  }
  for (const channel of signals.socketChannels ?? []) {
    if (SOCKET_CHANNELS.includes(channel)) reasons.push(`socket_channel:${channel}`);
  }
  if (signals.telegramLongPoll && !input.telegramOptIn) reasons.push("telegram_long_poll");
  return reasons;
}

/** Reasons the agent is, or may be, busy right now. Unknown counts as busy. */
function awakeReasons(signals: SleepSignals, input: SleepPolicyInput, nowMs: number): string[] {
  const reasons: string[] = [];
  const unknown = (name: string) => reasons.push(`unknown_signal:${name}`);

  if (!isValidNumber(signals.sampledAt)) unknown("sampledAt");
  else {
    const maxAgeMs = (input.maxSignalAgeSeconds ?? DEFAULT_MAX_SIGNAL_AGE_SECONDS) * 1000;
    const skewMs = SIGNAL_CLOCK_SKEW_SECONDS * 1000;
    // Too old, or dated in the future beyond clock skew: either way not trustworthy.
    if (nowMs - signals.sampledAt > maxAgeMs || signals.sampledAt - nowMs > skewMs) {
      reasons.push("stale_signals");
    }
  }

  if (signals.lastActivityAt === undefined || (signals.lastActivityAt !== null && !isValidNumber(signals.lastActivityAt))) {
    unknown("lastActivityAt");
  }
  if (signals.activeRun === undefined) unknown("activeRun");
  else if (signals.activeRun) reasons.push("active_run");
  if (signals.operationInFlight === undefined) unknown("operationInFlight");
  else if (signals.operationInFlight) reasons.push("operation_in_flight");

  if (!isValidNumber(signals.openConnections)) unknown("openConnections");
  else if (signals.openConnections > 0) reasons.push("open_connections");

  if (signals.terminalAttached === undefined) unknown("terminalAttached");
  else if (signals.terminalAttached) reasons.push("terminal_attached");

  if (signals.desktopAttached === undefined) unknown("desktopAttached");
  else if (signals.desktopAttached) reasons.push("desktop_attached");

  if (!isValidNumber(signals.cpuPercent)) unknown("cpuPercent");
  else if (signals.cpuPercent > (input.cpuBusyPercent ?? DEFAULT_CPU_BUSY_PERCENT)) {
    reasons.push("cpu_busy");
  }

  if (signals.nextScheduledJobAt === undefined || (signals.nextScheduledJobAt !== null && !isValidNumber(signals.nextScheduledJobAt))) {
    unknown("nextScheduledJobAt");
  } else if (
    signals.nextScheduledJobAt !== null &&
    signals.nextScheduledJobAt - nowMs <= SCHEDULED_JOB_WINDOW_SECONDS * 1000
  ) {
    reasons.push("scheduled_job_soon");
  }

  if (signals.socketChannels === undefined) unknown("socketChannels");
  if (signals.telegramLongPoll === undefined) unknown("telegramLongPoll");
  return reasons;
}

export function decideSleep(
  signals: SleepSignals,
  input: SleepPolicyInput,
  now: Date | number,
): SleepDecision {
  const nowMs = toMs(now);
  const idleSeconds =
    isValidNumber(signals.lastActivityAt)
      ? Math.max(0, Math.floor((nowMs - signals.lastActivityAt) / 1000))
      : null;

  const never = ineligibleReasons(signals, input);
  if (never.length > 0) return { verdict: "ineligible", reasons: never, idleSeconds };

  const busy = awakeReasons(signals, input, nowMs);
  if (busy.length > 0) return { verdict: "awake", reasons: busy, idleSeconds };
  // lastActivityAt === null (never active) is not idle time we can measure.
  if (idleSeconds === null) return { verdict: "awake", reasons: ["no_activity_baseline"], idleSeconds };

  const policy = input.sleepPolicy ?? "off";
  const napAfter = applyThrashBackoff(
    input.napAfterSeconds ?? DEFAULT_NAP_AFTER_SECONDS,
    input.recentWakes,
    nowMs,
  );
  // Hibernate comes after a stretch spent napping, so it is always later than the nap.
  const hibernateAfter =
    napAfter +
    applyThrashBackoff(
      input.hibernateAfterNapSeconds ?? DEFAULT_HIBERNATE_AFTER_NAP_SECONDS,
      input.recentWakes,
      nowMs,
    );
  const desktop = !!signals.agentType && DESKTOP_KINDS.includes(signals.agentType);

  if (idleSeconds >= hibernateAfter && allowsHibernate(policy)) {
    return { verdict: "would_hibernate", reasons: ["idle_past_hibernate_window"], idleSeconds };
  }
  if (idleSeconds >= napAfter) {
    if (desktop) {
      return { verdict: "awake", reasons: ["desktop_kind_hibernate_only"], idleSeconds };
    }
    if (allowsNap(policy)) {
      return { verdict: "would_nap", reasons: ["idle_past_nap_window"], idleSeconds };
    }
    return { verdict: "awake", reasons: ["policy_tier_not_allowed"], idleSeconds };
  }
  return { verdict: "awake", reasons: ["recently_active"], idleSeconds };
}
