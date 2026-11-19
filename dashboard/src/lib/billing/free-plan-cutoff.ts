// HIVRA_FREE_PLAN_CLOSED_AT only, with no server imports, so public copy shared with
// client components can read it.

/** The cut-off, or null when the Free plan is open. An invalid value is null. */
export function freePlanClosedAt(env: Record<string, string | undefined> = process.env): Date | null {
  const raw = env.HIVRA_FREE_PLAN_CLOSED_AT?.trim();
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** True once the cut-off has passed: public pages stop offering the Free plan. */
export function isFreePlanClosed(env: Record<string, string | undefined> = process.env, now: Date = new Date()): boolean {
  const at = freePlanClosedAt(env);
  return at !== null && at.getTime() <= now.getTime();
}
