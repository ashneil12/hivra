/**
 * Free sandbox settings. Every number comes from the plan ladder config (`HIVRA_PLAN_LADDER_CONFIG`, owned by the
 * plans work): nothing here has a default, so a missing or malformed setting turns the feature off rather than
 * guessing. Plan names and counts stay out of code.
 */

/** What a free sandbox may use and when it changes state. */
export interface FreeSandboxSettings {
  /** Stop an awake sandbox after this many minutes with no person activity. */
  sleepAfterIdleMinutes: number;
  /** Pack a sandbox into storage after this many hours with no person activity. */
  storeAfterIdleHours: number;
  memoryMb: number;
  cpus: number;
  /** The workspace's file quota. */
  storageMb: number;
  /** Places on one server: people placed there (awake or stopped). Packed people hold none. */
  freePlacesPerServer: number;
  /** A second class of place for heavier free agents, counted apart; missing means none. */
  hermesPlacesPerServer: number;
  /** The models Free thinks with, in order of preference: the first is pinned, the rest are fallbacks. */
  freeModels: string[];
  /** Room kept on every server for this many more paid computers before Free takes any. */
  paidReserveComputers: number;
  /** CPU promised to awake free sandboxes, as a multiple of the pool's cores (idle sandboxes use almost none). */
  cpuOvercommit: number;
  /** Replies running at once on one pool server (its turn gate); the rest wait in line. 0: no limit. */
  maxConcurrentTurns: number;
  /** A person's reply time per day, in seconds; null (the key left out, or 0) turns the cap off. */
  dailyReplySecondsCap: number | null;
  /** Agents a free workspace may have. */
  agents: number;
  /** Scheduled jobs a free workspace may have, and the least hours between one job's runs. */
  scheduledJobs: number;
  scheduledJobMinHours: number;
  /** Places opened per server so far: Free opens in steps, up to `freePlacesPerServer`; 0 places nobody new. */
  placesOpenPerServer: number;
  /** Above this share of a server's free replies today refused by the free AI's limit, nobody new is placed there. */
  refusedShareStop: number;
  /** Replies a server needs today before its refused share counts (a few early refusals say little). */
  refusedShareMinReplies: number;
  /**
   * `opencode_failed` from this many workspaces of one server within `failedBurstMinutes` counts as a refusal. Either
   * left out (or 0): the burst rule is off.
   */
  failedBurstWorkspaces: number;
  failedBurstMinutes: number;
}

/** The two clocks every plan has. */
export interface LifecycleSettings {
  sleepAfterIdleMinutes: number;
  storeAfterIdleHours: number;
}

type Ladder = Record<string, unknown>;

/** The plan ladder config as JSON, or null when it is unset or unreadable. */
export function readPlanLadder(env: Record<string, string | undefined> = process.env): Ladder | null {
  const raw = env.HIVRA_PLAN_LADDER_CONFIG;
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Ladder) : null;
  } catch {
    return null;
  }
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const wholePositive = (value: unknown): value is number => positive(value) && Number.isInteger(value);
const wholeOrZero = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
/** A provider-qualified model id such as `provider/model`, nothing a shell or config could misread. */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const modelList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((m) => typeof m === "string" && MODEL_ID.test(m));

function section(ladder: Ladder | null, key: string): Record<string, unknown> | null {
  const value = ladder?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The clocks of one plan's section (the free section, or a paid plan's), or null when either is missing. */
export function lifecycleSettings(ladder: Ladder | null, plan: string): LifecycleSettings | null {
  const s = section(ladder, plan);
  if (!s || !positive(s.sleepAfterIdleMinutes) || !positive(s.storeAfterIdleHours)) return null;
  return {
    sleepAfterIdleMinutes: s.sleepAfterIdleMinutes,
    storeAfterIdleHours: s.storeAfterIdleHours,
  };
}

/** The free section, checked whole; null when any setting is missing or out of shape. */
export function freeSandboxSettings(ladder: Ladder | null, freeKey = "free"): FreeSandboxSettings | null {
  const s = section(ladder, freeKey);
  const clocks = lifecycleSettings(ladder, freeKey);
  if (!s || !clocks) return null;
  // The ladder's schema takes the cap as a number or leaves it out (it refuses null): left out means the cap is off,
  // never that the feature is off. A second class of place left out means none.
  const cap = s.dailyReplySecondsCap;
  const hermesPlaces = s.hermesPlacesPerServer ?? 0;
  if (
    !wholePositive(s.memoryMb) ||
    !positive(s.cpus) ||
    !wholePositive(s.storageMb) ||
    !wholePositive(s.freePlacesPerServer) ||
    !wholeOrZero(hermesPlaces) ||
    !modelList(s.freeModels) ||
    !wholePositive(s.agents) ||
    !wholeOrZero(s.scheduledJobs) ||
    !positive(s.scheduledJobMinHours) ||
    !wholeOrZero(s.placesOpenPerServer) ||
    !(typeof s.refusedShareStop === "number" && s.refusedShareStop >= 0 && s.refusedShareStop <= 1) ||
    !wholeOrZero(s.refusedShareMinReplies) ||
    !wholeOrZero(s.failedBurstWorkspaces ?? 0) ||
    !wholeOrZero(s.failedBurstMinutes ?? 0) ||
    !wholeOrZero(s.paidReserveComputers) ||
    !positive(s.cpuOvercommit) ||
    !wholeOrZero(s.maxConcurrentTurns) ||
    !(cap === null || cap === undefined || wholeOrZero(cap))
  ) {
    return null;
  }
  return {
    ...clocks,
    memoryMb: s.memoryMb,
    cpus: s.cpus,
    storageMb: s.storageMb,
    freePlacesPerServer: s.freePlacesPerServer,
    hermesPlacesPerServer: hermesPlaces,
    freeModels: [...s.freeModels],
    paidReserveComputers: s.paidReserveComputers,
    cpuOvercommit: s.cpuOvercommit,
    maxConcurrentTurns: s.maxConcurrentTurns,
    dailyReplySecondsCap: cap ? cap : null,
    agents: s.agents,
    scheduledJobs: s.scheduledJobs,
    scheduledJobMinHours: s.scheduledJobMinHours,
    placesOpenPerServer: s.placesOpenPerServer,
    refusedShareStop: s.refusedShareStop,
    refusedShareMinReplies: s.refusedShareMinReplies,
    failedBurstWorkspaces: (s.failedBurstWorkspaces as number | undefined) ?? 0,
    failedBurstMinutes: (s.failedBurstMinutes as number | undefined) ?? 0,
  };
}

/** The feature's one switch, off unless set to exactly "true". */
export function freeSandboxEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FREE_SANDBOX_ENABLED === "true";
}
