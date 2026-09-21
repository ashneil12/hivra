export const INSTANCE_LIFECYCLE_STATES = [
  "pending",
  "provisioning",
  "active",
  "paused",
  "suspended",
  "deleting",
  "deleted",
  "failed",
] as const;

export type InstanceLifecycleState = (typeof INSTANCE_LIFECYCLE_STATES)[number];

// Lifecycle states in which an instance no longer occupies a "live" slot:
// a deleted instance is gone, and a cold_archived one has had its VM destroyed
// (data lives on a Storage Box, recoverable only via an explicit restore). The
// `status` column is NOT a reliable signal here — deleted/cold_archived rows are
// frequently left at status='stopped' (status isn't always synced when the
// lifecycle transitions), so any guard keyed only on `status != 'deleted'`
// counts genuinely-gone instances and wrongly reports the slot/compute as taken.
// Exclude these lifecycle states everywhere a row is counted as "occupies a slot"
// (creation guards, agent-count/plan limits, compute-budget, and the meters that
// mirror them). Note `cold_archived` is intentionally NOT in
// INSTANCE_LIFECYCLE_STATES above — it is a cold-storage marker, not a
// transition target — which is exactly why a status-only filter misses it.
//
// `pending_deletion` belongs here for the same reason as `cold_archived`, and its
// omission was strictly worse than a miscount: the state is reachable ONLY from
// `cold_archived` (both writers CAS on `.eq("lifecycle_state","cold_archived")` —
// cold-retention-sweep's free and paid passes), so the VM is ALREADY destroyed by
// the time a row gets here. Leaving it out meant a row's slot was FREE while
// cold_archived and then flipped back to TAKEN when the retention sweep armed it
// for deletion — the user lost entitlement as their agent moved FURTHER toward
// being gone, and got it back only once purge-expired finally set 'deleted'.
// Measured on prod 2026-07-16: 129 rows across 129 distinct users, each holding a
// slot open for a VM that no longer exists, against creation guards, plan limits,
// compute budget, /api/billing/usage and /api/billing/entitlements alike.
// The rest of the codebase already treats the two as one class (see the
// `cold_archived || pending_deletion` pairs in the dashboard pages, restore-batch,
// and cold-storage-service, and NON_SLOT_LIFECYCLE in reservations/promote-next);
// this list was the odd one out.
//
// `failed` deliberately stays OUT, even though promote-next's NON_SLOT_LIFECYCLE
// includes it: a failed row can still own a live VM (prod has failed rows carrying
// real vmids), so freeing its slot would oversubscribe the host.
export const SLOT_FREEING_LIFECYCLE_STATES = [
  "deleted",
  "cold_archived",
  "pending_deletion",
] as const;

// PostgREST `not.in` list literal for the states above, e.g.
// `("deleted","cold_archived","pending_deletion")`. Pass to
// `.not("lifecycle_state", "in", …)`.
export const SLOT_FREEING_LIFECYCLE_IN_LIST = `("${SLOT_FREEING_LIFECYCLE_STATES.join(
  '","'
)}")`;

// Lifecycle states a fleet-wide redeploy sweep must NEVER touch, whatever the
// `status` column says. This is the deny-half of the sweep's eligibility rule:
// the sweep also admits rows on `status='running'` (to rescue a healthy box
// whose lifecycle_state drifted), and per the note above `status` is NOT
// trustworthy on its own — a destroyed or mid-deletion row can sit at a stale
// status. Without this list that rescue arm would happily redeploy:
//   - deleted / cold_archived / pending_deletion — the VM is GONE (cold_archived
//     data lives on a Storage Box); SSHing it just produces a failure storm of
//     ops events. All three arrive via the SLOT_FREEING spread below.
//   - archiving / restoring   — a cold-storage move is IN FLIGHT; racing it is
//     how you get stuck restoring_* rows and orphaned VMs.
//   - deleting — mid-deletion; do not resurrect.
//   - suspended — billing-suspended; redeploying re-arms a box we cut off.
//   - paused — idle-swept and powered OFF, so SSH always fails. redeployOne()
//     also guards this (isPausedLifecycleState) as a visible skip, but denying
//     it here means a paused box doesn't burn one of the batch's 50 slots.
const FLEET_SYNC_SKIP_LIFECYCLE_STATES = [
  ...SLOT_FREEING_LIFECYCLE_STATES,
  "archiving",
  "restoring",
  "deleting",
  "suspended",
  "paused",
] as const;

// PostgREST `not.in` literal for the states above. Safe against the NULL trap
// (`NOT IN` over NULL yields NULL → row filtered → silent starvation): the
// column is `not null` with default 'provisioning' since the lifecycle
// foundation migration.
export const FLEET_SYNC_SKIP_LIFECYCLE_IN_LIST = `("${FLEET_SYNC_SKIP_LIFECYCLE_STATES.join(
  '","'
)}")`;

const LEGACY_STATUS_TO_LIFECYCLE: Record<string, InstanceLifecycleState> = {
  provisioning: "provisioning",
  redeploying: "provisioning",
  running: "active",
  stopped: "paused",
  error: "failed",
  failed: "failed",
  deleted: "deleted",
};

const ALLOWED_TRANSITIONS: Record<InstanceLifecycleState, InstanceLifecycleState[]> = {
  pending: ["provisioning", "failed", "deleting", "deleted"],
  provisioning: ["active", "failed", "deleting", "deleted"],
  active: ["provisioning", "paused", "suspended", "failed", "deleting", "deleted"],
  paused: ["provisioning", "active", "suspended", "failed", "deleting", "deleted"],
  suspended: ["provisioning", "active", "paused", "failed", "deleting", "deleted"],
  deleting: ["deleted", "failed"],
  deleted: [],
  failed: ["provisioning", "deleting", "deleted"],
};

export interface ProvisioningKillSwitchState {
  disabled: boolean;
  reason: string | null;
}

export function isInstanceLifecycleState(value: unknown): value is InstanceLifecycleState {
  return (
    typeof value === "string" &&
    INSTANCE_LIFECYCLE_STATES.includes(value as InstanceLifecycleState)
  );
}

/**
 * True when an instance is intentionally powered off via a lifecycle PAUSE.
 * The inactivity sweep, capacity-pressure parking, dormant-reclaim, and the
 * resource-watchdog RAM-cap park all land the row in lifecycle_state='paused'
 * (tagged with a paused_reason) after `qm shutdown` powers the VM down.
 *
 * Such a box is EXPECTED to be unreachable, so any caller that only ever wants
 * to touch boxes that are supposed to be up — the synthetic gateway/egress
 * health probes and the live-redeploy rescue endpoint — must skip it. Probing
 * or SSH-redeploying a paused box always fails (gateway-down / "VM not
 * reachable over SSH"), and those benign failures bury real incidents in
 * /dashboard/ops. The recover-unhealthy-active cron gates on the inverse
 * (lifecycle_state='active') for exactly this reason.
 *
 * `status` is NOT a reliable substitute here: a paused row's `status` can drift
 * back to 'running' (the column the probes filter on) while lifecycle_state
 * stays 'paused', which is precisely how paused boxes leaked into the probe set
 * and generated thousands of false positives. lifecycle_state='paused' is the
 * authoritative marker.
 *
 * NULL/unknown lifecycle_state is treated as NOT paused (i.e. live), so legacy
 * rows that predate lifecycle_state are still probed — matching the
 * status='running' gate those callers already apply.
 */
export function isPausedLifecycleState(lifecycleState: string | null | undefined): boolean {
  return lifecycleState === "paused";
}

/**
 * True when a row has been armed for teardown and is only waiting for
 * `purge-expired` to run. Two independent markers, either of which is enough:
 *
 *  - `status='scheduled_for_deletion'` — the intake `purge-expired` selects on
 *    (`.eq("status","scheduled_for_deletion")`). Written by the orphan sweep
 *    (deleted Clerk owner) and the stale-suspended sweep.
 *  - `config.owner_orphaned` — the orphan sweep's durable jsonb flag. Checked
 *    SEPARATELY because `status` is a single mutable field that any redeploy
 *    overwrites, while this one survives.
 *
 * Why any redeploy path must skip these rows — this is not a tidiness rule, it
 * is a data-integrity one. The orphan sweep (Mon 09:00) powers the VM OFF and
 * sets `status='scheduled_for_deletion'` + a 72h grace. The fleet-sync sweep
 * (daily 10:00) then selected the row one hour later — the sweep's deny-list is
 * keyed on `lifecycle_state`, which the orphan sweep never touches, so the row
 * still looked 'active' — SSHed the powered-off VM, failed, and stamped
 * `buildInstanceLifecyclePatch("failed")`. That patch rewrites `status`, so
 * 'scheduled_for_deletion' became 'failed' and purge-expired's intake could
 * never match the row again: the VM leaks forever and the 72h grace silently
 * becomes never. Verified on prod 2026-07-16 — 4 rows past due, all
 * owner_orphaned, one (fixturecase03) a month overdue after a *successful* targeted
 * redeploy clobbered it to 'running'. Both outcomes clobber, so the guard must
 * be on the ATTEMPT, not the failure path.
 */
export function isAwaitingTeardown(row: {
  status?: string | null;
  config?: Record<string, unknown> | null;
}): boolean {
  if (row.status === "scheduled_for_deletion") return true;
  return (row.config as { owner_orphaned?: boolean } | null)?.owner_orphaned === true;
}

export function getLifecycleStateForStatus(status: string | null | undefined): InstanceLifecycleState {
  const normalized = status?.trim().toLowerCase() || "";
  return LEGACY_STATUS_TO_LIFECYCLE[normalized] ?? "failed";
}

export function canTransitionInstanceLifecycle(
  from: InstanceLifecycleState,
  to: InstanceLifecycleState
): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function buildInstanceLifecyclePatch(
  status: string,
  options: { now?: string | Date } = {}
) {
  const now =
    options.now instanceof Date
      ? options.now.toISOString()
      : options.now || new Date().toISOString();
  const lifecycleState = getLifecycleStateForStatus(status);

  // When a suspended row gets resumed (active again), clear any pending
  // auto-deletion schedule. The stale-suspended-sweep cron sets
  // scheduled_deletion_at + status='scheduled_for_deletion' on rows that have
  // been suspended for too long; resuming the agent is the explicit signal
  // that the user wants to keep it. Without this clear, a user who reactivates
  // would still get nuked by purge-expired at the original deadline.
  return {
    status,
    lifecycle_state: lifecycleState,
    ...(lifecycleState === "deleted" ? { deleted_at: now } : {}),
    ...(lifecycleState === "active" ? { scheduled_deletion_at: null } : {}),
    // Any explicit lifecycle change (start/stop/reboot/redeploy) is the
    // user/system saying "this transition is intentional," which means
    // any sticky pause reason from the inactivity-sweep cron is now
    // stale. The cron writes paused_reason via its own UPDATE outside
    // this patch, so it's safe to unconditionally null it here.
    paused_reason: null,
    last_lifecycle_transition_at: now,
    updated_at: now,
  };
}

/**
 * Clear the cold-storage pointer fields once a restore is CONFIRMED live.
 *
 * `archive_uri` (and its sibling metadata) is written only alongside
 * lifecycle_state='cold_archived'. Every reader of it — cold-retention-sweep,
 * cold-storage-audit, cold-storage-notifications, purgeInstanceArchive, and the
 * cold branch of the instance start action — filters on lifecycle_state IN
 * ('cold_archived', 'pending_deletion'). A row that has been RESTORED (VM live
 * again) and later re-paused by the inactivity sweep therefore carries a
 * pointer that is true of a past life and false of its present one, and the
 * archive cron's `.is("archive_uri", null)` candidate filter can never select
 * it again: the instance is permanently un-archivable while still holding a
 * full thin-pool disk allocation. 25 rows had accumulated this way by
 * 2026-09-17, which is what tipped one production host's thin pool to 82%.
 *
 * Clearing on success (never on the failure/revert paths, which must keep the
 * pointer so the archive is still restorable and purgeable) makes
 * "archive_uri IS NOT NULL" mean exactly what every reader already assumes:
 * this row's data currently lives in cold storage.
 *
 * `archive_count` is deliberately NOT cleared — it counts archives over the
 * instance's lifetime, and the archive write increments it.
 */
export function buildClearedArchivePointerPatch() {
  return {
    archive_uri: null,
    archive_sha256: null,
    archive_size_bytes: null,
    archived_at: null,
  };
}

export function isInstanceProvisioningDisabled(
  env: Record<string, string | undefined> = process.env
): ProvisioningKillSwitchState {
  const raw = env.HERMES_PROVISIONING_DISABLED?.trim().toLowerCase();
  const disabled = raw === "1" || raw === "true" || raw === "yes";
  const reason = env.HERMES_PROVISIONING_DISABLED_REASON?.trim() || null;

  return { disabled, reason };
}
