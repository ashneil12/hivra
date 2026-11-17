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

export type PlacementDecision =
  { admit: true } | { admit: false; reason: "places_full" | "paid_reserve" | "paid_waiting" | "free_ai_refusing" };

/** A server's free replies today: answered, refused by the free AI's limit, and failed another way (counted apart). */
export interface FreeAiDay {
  answered: number;
  refused: number;
  failed: number;
}

/** The share of today's replies the free AI refused on a server; null until it has enough replies to say. */
export function refusedShare(day: FreeAiDay, settings: FreeSandboxSettings): number | null {
  const replies = day.answered + day.refused;
  if (replies === 0 || replies < settings.refusedShareMinReplies) return null;
  return day.refused / replies;
}

/** Whether one more free person may be placed on this server. Free never pushes paid out and never buys a server. */
export function freePlacementAdmission(
  server: ServerFreeState,
  settings: FreeSandboxSettings,
  today?: FreeAiDay,
): PlacementDecision {
  if (server.paidWaiting) return { admit: false, reason: "paid_waiting" };
  if (!server.paidReserveIntact) return { admit: false, reason: "paid_reserve" };
  if (server.freePlaced >= openPlaces(settings)) return { admit: false, reason: "places_full" };
  const share = today ? refusedShare(today, settings) : null;
  if (share !== null && share > settings.refusedShareStop) return { admit: false, reason: "free_ai_refusing" };
  return { admit: true };
}

/** Places open on one server now: the step Free has opened to, never past the ceiling. */
export const openPlaces = (settings: FreeSandboxSettings) =>
  Math.min(settings.placesOpenPerServer, settings.freePlacesPerServer);

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
