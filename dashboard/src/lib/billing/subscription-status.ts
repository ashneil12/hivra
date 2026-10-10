const PLAN_ACCESS_STATUSES = new Set(["active", "trialing", "past_due"]);

export function hasPlanAccessStatus(status: string | null | undefined) {
  return typeof status === "string" && PLAN_ACCESS_STATUSES.has(status);
}

/**
 * A paid subscription row that still holds the account: not Free, and in a
 * status Stripe may yet collect (active, trialing or past_due). The account
 * can't switch to Free over it, so /api/billing/subscribe refuses a Free
 * activation (ACTIVE_SUBSCRIPTION) while it stands, even when the row no
 * longer entitles anything (dunning).
 */
export function holdsPaidPlan(row: { plan?: string | null; status?: string | null } | null | undefined): boolean {
  return Boolean(row && hasPlanAccessStatus(row.status) && row.plan !== "free");
}

export function isLiveStripeSubscriptionId(subscriptionId: string | null | undefined) {
  return typeof subscriptionId === "string" && subscriptionId.startsWith("sub_");
}

/**
 * Dark-by-default switch for the Pro-FEATURE half of dunning enforcement.
 *
 * Separate from `DUNNING_GRACE_ENFORCE_LIVE` (which owns the VM-shutdown half
 * in `lib/recovery/dunning-grace-enforce.ts`) so the two can be rolled
 * independently: revoking Pro *features* is reversible on the next request,
 * while stopping a VM is a fleet mutation. Flip this one first.
 *
 * OFF is byte-identical to the pre-flag behavior — `hasPlanAccessWithGrace`
 * degrades to a plain `hasPlanAccessStatus` call.
 */
export function isDunningFeatureCutoffLive(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.DUNNING_FEATURE_CUTOFF_LIVE === "true";
}

export interface PlanAccessGraceInput {
  status: string | null | undefined;
  grace_period_ends_at?: string | null;
}

/**
 * True when a `past_due` row has an EXPLICIT grace anchor that has already
 * elapsed — i.e. the 48h keep-alive from the first decline is over.
 *
 * FAIL-OPEN on a null/unparseable anchor: we only ever cut off on an explicit,
 * elapsed timestamp, so a `past_due` row missing its stamp keeps access rather
 * than locking out a customer who may well be paying. `handlePaymentFailed`
 * stamps the anchor from the first decline alongside Stripe's past_due
 * transition, so a real failed-payment row always carries one.
 *
 * Mirrors the `graceExpired` computation in `instance-entitlement.ts`
 * (shipped in #617) — same policy, applied to the feature-gate lane.
 */
export function isDunningGraceExpired(
  input: PlanAccessGraceInput,
  nowMs: number = Date.now()
): boolean {
  if (input.status !== "past_due") return false;
  const anchor = input.grace_period_ends_at;
  if (typeof anchor !== "string") return false;
  const anchorMs = Date.parse(anchor);
  if (!Number.isFinite(anchorMs)) return false;
  return anchorMs <= nowMs;
}

/**
 * Grace-aware plan-access predicate. Use this for ENTITLEMENT GRANTS — gates
 * that hand the user something they are paying for (Pro+ features, compute
 * tiers, provisioning).
 *
 * Do NOT swap the protective/fail-closed callers of `hasPlanAccessStatus` over
 * to this. Those deliberately treat `past_due` as "still a payer" so they
 * REFUSE a destructive or trapping action, and tightening them would invert
 * their intent:
 *   - `ops/instances/[id]/force-delete` + `cron/purge-expired` — a looser
 *     predicate here would let a grace-expired user's VM be destroyed on a
 *     stale anchor, which is exactly the billing-destruction incident class.
 *   - `billing/subscribe` — treats an existing paid row as "route to
 *     change-plan"; tightening would push a past_due user into a NEW Checkout
 *     and mint a second subscription.
 *   - `billing/change-plan` — the user's own recovery path; never trap them.
 *   - `cron/refresh-token-tiers` — tightening fights the grace reconciler with
 *     a credit_base resize.
 * `lib/abuse/gate.ts` needs no change: it already reads through
 * `resolveEffectiveSubscription`, which became grace-aware in #617.
 */
export function hasPlanAccessWithGrace(
  input: PlanAccessGraceInput,
  options: { now?: number; env?: NodeJS.ProcessEnv } = {}
): boolean {
  if (!hasPlanAccessStatus(input.status)) return false;
  if (!isDunningFeatureCutoffLive(options.env)) return true;
  return !isDunningGraceExpired(input, options.now ?? Date.now());
}
