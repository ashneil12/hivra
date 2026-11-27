/**
 * Per-computer seat funding, and the runtime sleep controls that follow from it.
 *
 * `hivra_agents.seat_funding` is authoritative and is written by admission or
 * provisioning after the server has decided which entitlement funds that one
 * computer. It is never read from client input and never inferred from the
 * owner's wallet or subscription: a paid seat stays paid when the owner also
 * holds tokens, and a token-funded seat stays on the holder terms.
 */

import {
  DEFAULT_HIBERNATE_AFTER_NAP_SECONDS,
  DEFAULT_NAP_AFTER_SECONDS,
  type AgentSleepPolicy,
} from "./agent-sleep-policy";

export type SeatFunding = "paid" | "holder";

export interface SeatFundingRow {
  seat_funding?: unknown;
  always_on?: unknown;
  sleep_policy?: unknown;
}

export function seatFundingOf(row: SeatFundingRow | null | undefined): SeatFunding | null {
  const value = row?.seat_funding;
  return value === "paid" || value === "holder" ? value : null;
}

export function isHolderFundedSeat(row: SeatFundingRow | null | undefined): boolean {
  return seatFundingOf(row) === "holder";
}

/** The holder terms: the existing 4-minute nap, then 12 minutes in nap before save-to-disk (16 minutes total). */
export const HOLDER_SEAT_NAP_AFTER_SECONDS = DEFAULT_NAP_AFTER_SECONDS;
export const HOLDER_SEAT_HIBERNATE_AFTER_NAP_SECONDS = DEFAULT_HIBERNATE_AFTER_NAP_SECONDS;
export const HOLDER_SEAT_HIBERNATE_TOTAL_SECONDS =
  HOLDER_SEAT_NAP_AFTER_SECONDS + HOLDER_SEAT_HIBERNATE_AFTER_NAP_SECONDS;

function validPolicy(value: unknown): AgentSleepPolicy {
  return value === "t1" || value === "t3" || value === "full" || value === "off" ? value : "off";
}

/** Effective Keep awake. A stale stored override never counts on a holder-funded seat. */
export function effectiveAlwaysOn(row: SeatFundingRow | null | undefined): boolean {
  return isHolderFundedSeat(row) ? false : row?.always_on === true;
}

/** Effective Sleep-when-idle policy. A stale stored override never counts on a holder-funded seat. */
export function effectiveSleepPolicy(row: SeatFundingRow | null | undefined): AgentSleepPolicy {
  return isHolderFundedSeat(row) ? "full" : validPolicy(row?.sleep_policy);
}

/**
 * Why a holder-funded hibernate may not start yet. Holder seats move through
 * the nap tier first: 4 minutes idle to nap, then 12 minutes napping before
 * memory is saved to disk. Null means the boundary does not block the action.
 */
export function holderHibernateBoundaryReason(params: {
  row: SeatFundingRow & { sleep_tier_changed_at?: unknown };
  tier: "nap" | "hibernate";
  state: string;
  nowMs: number;
  hibernateAfterNapSeconds?: number;
}): "hibernate_before_nap" | "hibernate_window_unknown" | "hibernate_window_open" | null {
  if (!isHolderFundedSeat(params.row) || params.tier !== "hibernate") return null;
  if (params.state === "awake") return "hibernate_before_nap";
  if (params.state !== "napping") return null;
  const changedAt = typeof params.row.sleep_tier_changed_at === "string" || typeof params.row.sleep_tier_changed_at === "number"
    ? Date.parse(String(params.row.sleep_tier_changed_at))
    : Number.NaN;
  if (!Number.isFinite(changedAt)) return "hibernate_window_unknown";
  const waitSeconds = params.hibernateAfterNapSeconds ?? HOLDER_SEAT_HIBERNATE_AFTER_NAP_SECONDS;
  return params.nowMs - changedAt >= waitSeconds * 1000 ? null : "hibernate_window_open";
}

/** PostgREST OR body for rows that are not in the authoritative holder cohort. */
export const NOT_HOLDER_SEAT_FILTER = "seat_funding.is.null,seat_funding.neq.holder";

export const HOLDER_SLEEP_REQUIRED_MESSAGE =
  "This computer is funded by holding tokens. Holder computers sleep when idle and cannot be kept awake; use a paid seat for always-on control.";
