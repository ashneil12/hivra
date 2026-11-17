/**
 * Who may take a free place, who may wake, and whose turn runs next. Pure functions over counts the caller reads;
 * every limit comes from `FreeSandboxSettings`.
 */
import type { FreeSandboxSettings } from "./settings";

export interface ServerFreeState {
  /** Free people placed on this server, awake or stopped. Packed people hold no place. */
  freePlaced: number;
  /** The server still has room for `paidReserveComputers` more paid computers after this placement. */
  paidReserveIntact: boolean;
  /** A paid computer is waiting for room here: Free takes nobody new until it is placed. */
  paidWaiting: boolean;
}

export type PlacementDecision = { admit: true } | { admit: false; reason: "places_full" | "paid_reserve" | "paid_waiting" };

/** Whether one more free person may be placed on this server. Free never pushes paid out and never buys a server. */
export function freePlacementAdmission(server: ServerFreeState, settings: FreeSandboxSettings): PlacementDecision {
  if (server.paidWaiting) return { admit: false, reason: "paid_waiting" };
  if (!server.paidReserveIntact) return { admit: false, reason: "paid_reserve" };
  if (server.freePlaced >= settings.freePlacesPerServer) return { admit: false, reason: "places_full" };
  return { admit: true };
}

/** How many free sandboxes may be awake at once on a pool with `poolCpus` cores. */
export function freeRunningCap(poolCpus: number, settings: FreeSandboxSettings): number {
  if (!(poolCpus > 0)) return 0;
  return Math.floor((poolCpus * settings.cpuOvercommit) / settings.cpus);
}

export type WakeDecision = { admit: true } | { admit: false; reason: "running_cap" };

/** Whether a stopped free sandbox may start now, or waits in line. */
export function freeWakeAdmission(awakeFree: number, poolCpus: number, settings: FreeSandboxSettings): WakeDecision {
  return awakeFree < freeRunningCap(poolCpus, settings) ? { admit: true } : { admit: false, reason: "running_cap" };
}

export interface TurnRequest {
  id: string;
  paid: boolean;
  /** When the person asked (order within the same priority). */
  queuedAt: Date;
  /** Reply time the person already used today, in seconds. */
  replySecondsToday: number;
}

export interface TurnSelection {
  /** Turns that may start now, in order. */
  start: TurnRequest[];
  /** Free turns refused for today's reply-time cap (only when the cap is on). */
  overCap: TurnRequest[];
}

/**
 * The turn line on one pool: paid before free, then oldest first, up to `maxConcurrentTurns` running at once. A free
 * person past the daily reply-time cap (when it is set) is refused rather than queued.
 */
export function selectTurns(queue: TurnRequest[], running: number, settings: FreeSandboxSettings): TurnSelection {
  const cap = settings.dailyReplySecondsCap;
  const overCap = cap === null ? [] : queue.filter((t) => !t.paid && t.replySecondsToday >= cap);
  const eligible = queue
    .filter((t) => !overCap.includes(t))
    .sort((a, b) => Number(b.paid) - Number(a.paid) || a.queuedAt.getTime() - b.queuedAt.getTime());
  const room = Math.max(0, settings.maxConcurrentTurns - running);
  return { start: eligible.slice(0, room), overCap };
}
