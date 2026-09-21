// Archive-countdown decision logic for the free→paid preservation wall (Moment
// #3). Presentation + gating ONLY — this reads existing lifecycle columns off
// the instance row and derives "how many days until this agent is archived". It
// never mutates state and never touches the archival/lifecycle cron logic.
//
// The pipeline (see lib/recovery/*):
//   inactivity-sweep  → lifecycle_state='paused', paused_reason='inactivity',
//                        last_lifecycle_transition_at=now
//   dormant-reclaim   → archives (vzdump) + destroys the VM once
//                        last_lifecycle_transition_at < now - RECLAIM_AFTER_DAYS
//
// So the archive deadline for an inactivity-paused agent is
//   last_lifecycle_transition_at + RECLAIM_ARCHIVE_AFTER_DAYS.
//
// ★ SAFETY (billing-incident lesson): this is deliberately narrow. It returns a
// countdown ONLY for an agent that is lifecycle_state='paused' AND
// paused_reason='inactivity' — the one, genuine free-tier inactivity-archival
// state. capacity_pressure parks, ram_cap_hit, subscription-suspend, manual
// stops, dormant_reclaiming (already archived), and cold_archived all return
// null, so the wall never renders on a non-inactivity archival. The caller
// additionally gates on the user's real plan (isFreePlanInfo) so a paying
// customer never sees it.

import { isFreePlanInfo, type PlanInfo } from "@/lib/hivra/agent-api";

/**
 * Days after an inactivity pause before dormant-reclaim archives + destroys the
 * VM. Mirrors DEFAULT_RECLAIM_AFTER_DAYS / HERMES_DORMANT_RECLAIM_AFTER_DAYS in
 * lib/recovery/dormant-reclaim.ts. Presentation-only: an env override on the
 * cron would shift the true deadline, but the displayed countdown stays a good-
 * faith estimate and the wall itself is non-destructive.
 */
export const RECLAIM_ARCHIVE_AFTER_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The subset of an instance row this module needs. */
export interface ArchiveCountdownInstance {
  lifecycle_state?: string | null;
  paused_reason?: string | null;
  last_lifecycle_transition_at?: string | null;
}

/**
 * Whole days until an inactivity-paused agent is archived by dormant-reclaim, or
 * `null` when the agent is NOT in the genuine free-tier inactivity-archival
 * window (any other lifecycle_state / paused_reason, or a missing/invalid
 * transition timestamp). Never negative: an already-overdue row clamps to 0
 * ("archiving today / imminent").
 */
export function getArchiveCountdownDays(
  instance: ArchiveCountdownInstance | null | undefined,
  now: Date = new Date()
): number | null {
  if (!instance) return null;
  // Reason + state gate: the ONLY state that dormant-reclaim will archive for
  // inactivity. Everything else (capacity_pressure, ram_cap_hit, cold_archived,
  // dormant_reclaiming/reclaimed, subscription/manual) is out of scope.
  if (instance.lifecycle_state !== "paused") return null;
  if (instance.paused_reason !== "inactivity") return null;

  const ts = instance.last_lifecycle_transition_at;
  if (!ts) return null;
  const pausedAtMs = Date.parse(ts);
  if (!Number.isFinite(pausedAtMs)) return null;

  const deadlineMs = pausedAtMs + RECLAIM_ARCHIVE_AFTER_DAYS * DAY_MS;
  const daysLeft = Math.ceil((deadlineMs - now.getTime()) / DAY_MS);
  return daysLeft > 0 ? daysLeft : 0;
}

/**
 * The single gate the instance page renders on for Moment #3. True only when the
 * flag is on AND the user's plan resolves to FREE (isFreePlanInfo treats a
 * null/loading plan as NOT free) AND the agent is in the inactivity-archival
 * window. Any one false → no wall. This is the "never pitch a paying customer,
 * never on a non-inactivity archival" guarantee, expressed as one function so a
 * test can prove all the negative cases.
 */
export function shouldShowArchiveUpgradeWall(input: {
  enabled: boolean;
  plan: PlanInfo | null | undefined;
  instance: ArchiveCountdownInstance | null | undefined;
  now?: Date;
}): boolean {
  if (!input.enabled) return false;
  if (!isFreePlanInfo(input.plan)) return false;
  return getArchiveCountdownDays(input.instance, input.now) !== null;
}
