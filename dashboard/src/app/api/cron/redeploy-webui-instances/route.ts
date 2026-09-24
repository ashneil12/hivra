import { NextRequest } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import {
  FLEET_SYNC_SKIP_LIFECYCLE_IN_LIST,
  isAwaitingTeardown,
  isPausedLifecycleState,
} from "@/lib/instance-lifecycle";
import { extractGlobalHermesSettings } from "@/lib/instance-settings";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  describeInFlightDeferral,
  inFlightGateLogFields,
  type InFlightDeferralReason,
} from "@/lib/services/inflight-update-gate";
import {
  applyLiveUpdate,
  resolveInstanceIpv4,
  type InstanceRowForOrchestration,
} from "@/lib/services/instance-orchestrator";
import {
  OPERATOR_LIVE_UPDATE,
  systemLiveUpdate,
  type LiveUpdateInitiator,
} from "@/lib/services/live-update-initiator";
import { supabaseAdmin } from "@/lib/supabase";
import { isWebfreeBackend, WEBFREE_BACKENDS } from "@/lib/types/instance";

const SOURCE = "cron/redeploy-webui-instances";
const ROUTE = "/api/cron/redeploy-webui-instances";
const MAX_INSTANCE_IDS = 10;
const INSTANCE_SELECT = [
  "id",
  "user_id",
  "name",
  "status",
  "lifecycle_state",
  "backend",
  "provider",
  "subdomain",
  "hetzner_server_id",
  "gateway_url",
  "api_key_encrypted",
  "api_server_key_encrypted",
  "honcho_api_key_encrypted",
  "config",
  "host_id",
  "ipv4_address",
  "cpu_limit",
  "ram_limit",
  "infrastructure_provider",
  "proxmox_vmid",
].join(", ");

type RedeployInstanceRow = InstanceRowForOrchestration & {
  name?: string | null;
  status?: string | null;
  lifecycle_state?: string | null;
  infrastructure_provider?: string | null;
  proxmox_vmid?: number | null;
};

type RedeployResult = {
  id: string;
  name: string | null;
  success: boolean;
  status?: "redeploying";
  skipped?: boolean;
  /**
   * The scheduled sweep did not update the box because an agent turn is in
   * flight (error "deferred_busy") or the box could not confirm that none is
   * running (error "deferred_unverified"). Neither launched nor failed;
   * retried first on the next tick.
   */
  deferred?: boolean;
  /** Deferrals in the box's current streak (the gate proceeds at its cap). */
  deferrals?: number;
  error?: InFlightDeferralReason | string;
};

export const dynamic = "force-dynamic";

// Vercel's per-function ceiling on Pro. We need most of it for the scheduled
// fleet-wide sweep — each `applyLiveUpdate` pulls the new :stable, recreates
// the agent container, and waits for /health to come back. Typical per-VM is
// 30-90s; running 10 concurrent puts a 100-VM fleet inside this envelope.
export const maxDuration = 300;

// How many redeploys to fire concurrently per cron tick. Higher = faster
// turnaround for the whole fleet, but also higher peak load on the
// scheduled job's CPU + network + ghcr.io pull bandwidth. 10 has been
// safe in the manual ad-hoc runs we've shipped this session.
const CONCURRENT_REDEPLOYS = 10;

// Per-fleet-sync cap on how many VMs we'll attempt in a single cron run.
// At CONCURRENT_REDEPLOYS=10 and ~60s per redeploy, this caps a single run
// at ~5 minutes — matching the maxDuration above with headroom.
const FLEET_SYNC_BATCH_LIMIT = 50;

/**
 * Minimal structural view of the PostgREST filter builder — just the four
 * methods the eligibility predicate uses. Structural (not the concrete
 * PostgrestFilterBuilder) so the same helper composes onto both a row select
 * and a head/count select without fighting their divergent result generics.
 */
interface FleetSyncFilterable {
  in(column: string, values: readonly string[]): FleetSyncFilterable;
  or(filters: string): FleetSyncFilterable;
  not(column: string, operator: string, value: unknown): FleetSyncFilterable;
  neq(column: string, value: unknown): FleetSyncFilterable;
}

/**
 * The sweep's eligibility predicate. Applied to BOTH the batch query and the
 * eligibleTotal count — factored into one place because the two must describe
 * the same population or `eligibleTotal` stops being a coverage signal and
 * starts being a lie (the count would claim boxes the batch can never pick).
 *
 * See the GET handler for why the `.or` arm and the lifecycle deny-list are
 * each load-bearing. The `.neq` teardown term is documented inline below.
 */
function applyFleetSyncEligibility<T>(query: T): T {
  // The concrete PostgrestFilterBuilder generics are too deep to thread a
  // recursive `T extends Filterable<T>` through (TS2589). Every one of these
  // methods returns `this` at runtime, so narrowing to the structural view and
  // handing the caller's own T back is sound — and it keeps the divergent
  // result types (rows vs {count}) intact at both call sites.
  const filtered = (query as unknown as FleetSyncFilterable)
      .in("backend", WEBFREE_BACKENDS)
      .or("lifecycle_state.in.(active,failed),status.eq.running")
      .not("lifecycle_state", "in", FLEET_SYNC_SKIP_LIFECYCLE_IN_LIST)
      // Never sweep a row armed for teardown. The orphan sweep (Mon 09:00)
      // powers the VM off and sets this status with a 72h grace; this sweep ran
      // an hour later, SSHed the dead VM, failed, and rewrote `status` to
      // 'failed' — destroying the exact marker purge-expired selects on, so the
      // box leaked forever. The lifecycle deny-list could NOT catch it: the
      // orphan sweep only writes `status`, so lifecycle_state still reads
      // 'active'. Safe against the NULL trap — `status` is not-null (verified
      // on prod: 0 null rows), so `neq` cannot silently drop live boxes.
      // redeployOne guards this too, for the targeted POST path.
      .neq("status", "scheduled_for_deletion");
  return filtered as unknown as T;
}

/**
 * Stamp the fairness cursor for every row this tick selected, BEFORE any
 * redeploy runs. Up-front and batched on purpose:
 *
 *  - It must advance on failure and skip, not just success — that asymmetry is
 *    the whole bug (a box that always fails never moved and pinned the head of
 *    the queue).
 *  - Doing it up-front means the cursor still advances if the function is
 *    killed mid-sweep (Vercel's 300s ceiling) or a wave throws. A per-row bump
 *    after the work would leave a timed-out tick's rows unstamped and re-select
 *    the same head next tick — the same starvation with extra steps.
 *
 * Best-effort: a stamp failure degrades to the old re-roll-the-same-cohort
 * behaviour, which is bad but not worth abandoning a whole tick's redeploys
 * over. Logged at error so it is visible rather than silent.
 */
async function stampSyncAttempt(ids: string[]): Promise<void> {
  const { error } = await supabaseAdmin!
    .from("hermes_instances")
    .update({ last_sync_attempt_at: new Date().toISOString() })
    .in("id", ids);
  if (error) {
    log.error(
      "fleet-sync attempt-cursor stamp failed",
      new Error("fleet_sync_attempt_stamp_failed"),
      {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        failureType: "fleet_sync_attempt_stamp_failed",
        attempted: ids.length,
        errorName: error instanceof Error ? error.name : typeof error,
      },
    );
  }
}

function parseInstanceIds(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { instanceIds?: unknown; ids?: unknown }).instanceIds ??
    (body as { ids?: unknown }).ids;
  if (!Array.isArray(raw)) return null;

  const ids = Array.from(new Set(raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)));

  return ids.length > 0 ? ids : null;
}

async function loadGlobalSettings(userId: string): Promise<Record<string, unknown>> {
  try {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(userId);
    return extractGlobalHermesSettings(user.publicMetadata);
  } catch (err) {
    log.warn("clerk metadata unavailable for webui redeploy", {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      userId,
      failureType: "clerk_metadata_unavailable",
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return {};
  }
}

// Per-tick memoizer. A fleet redeploy commonly touches multiple VMs owned
// by the same user; without this we'd hit Clerk's `users.getUser` once per
// VM (~50 calls per tick for a 50-VM fleet of 10 users) when 10 would do.
// The map is created fresh inside each handler so values can't leak across
// requests, and identical concurrent calls share the same in-flight promise.
function createGlobalSettingsCache(): (userId: string) => Promise<Record<string, unknown>> {
  const cache = new Map<string, Promise<Record<string, unknown>>>();
  return (userId: string) => {
    const existing = cache.get(userId);
    if (existing) return existing;
    const promise = loadGlobalSettings(userId);
    cache.set(userId, promise);
    return promise;
  };
}

function skippedResult(
  id: string,
  name: string | null,
  error: string,
): RedeployResult {
  return { id, name, success: false, skipped: true, error };
}

async function redeployOne(
  instance: RedeployInstanceRow,
  getGlobalSettings: (userId: string) => Promise<Record<string, unknown>>,
  initiator: LiveUpdateInitiator,
): Promise<RedeployResult> {
  const name = instance.name ?? null;

  if (!isWebfreeBackend(instance.backend)) {
    return skippedResult(
      instance.id,
      name,
      "Only webfree instances can be redeployed by this endpoint",
    );
  }

  // Intentionally-paused boxes (idle/capacity/dormant/ram-cap parks) are powered
  // off via `qm shutdown`. applyLiveUpdate SSHes directly into the VM — it never
  // `qm start`s it — so a redeploy of a paused box always fails with "VM not
  // reachable over SSH" and raises an error-level ops event for a box that is
  // EXPECTED to be unreachable, burying real incidents. The scheduled GET fleet
  // sweep already excludes paused via its lifecycle allow-list; this guards the
  // targeted POST path (and any other caller) so passing a paused id yields a
  // benign skip, not a false-positive failure. Resuming the box redeploys it.
  if (isPausedLifecycleState(instance.lifecycle_state)) {
    return skippedResult(
      instance.id,
      name,
      "Instance is paused (idle-swept); resume it to redeploy",
    );
  }

  // Rows armed for teardown are powered OFF and waiting for purge-expired. A
  // redeploy of one is worse than useless: applyLiveUpdate rewrites `status`
  // on BOTH outcomes (-> 'failed' on the SSH failure this is guaranteed to
  // hit, -> 'redeploying' on success), and 'scheduled_for_deletion' IS the
  // intake purge-expired selects on. So an attempt silently disarms the
  // teardown and the VM leaks forever. The GET sweep also denies these at the
  // query level so they don't burn a batch slot; this guard is what protects
  // the targeted POST path — which is exactly how prod row fixturecase03 lost its
  // marker and sat a month past its deadline. See isAwaitingTeardown.
  if (isAwaitingTeardown(instance)) {
    return skippedResult(
      instance.id,
      name,
      "Instance is scheduled for deletion (owner orphaned); redeploy would disarm the purge",
    );
  }

  let ipv4 = "";
  try {
    ipv4 = await resolveInstanceIpv4(instance, supabaseAdmin!);
  } catch (err) {
    log.error("webui redeploy IP resolution failed", new Error("ip_resolution_failed"), {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      instanceId: instance.id,
      userId: instance.user_id,
      failureType: "webui_redeploy_ip_resolution_failed",
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return { id: instance.id, name, success: false, error: "Could not resolve instance IP" };
  }

  if (!ipv4) {
    log.warn("webui redeploy skipped because instance has no reachable IP", {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      instanceId: instance.id,
      userId: instance.user_id,
      failureType: "webui_redeploy_missing_ip",
    });
    return { id: instance.id, name, success: false, error: "Instance has no reachable IP" };
  }

  const globalSettings = await getGlobalSettings(instance.user_id);
  const update = await applyLiveUpdate(instance, ipv4, globalSettings, supabaseAdmin!, { initiator });
  if (update.deferred) {
    // Worded from the gate's verdict: an unverified deferral (the box could not
    // confirm it is idle) may be a failing gateway, not a running turn.
    const deferral = describeInFlightDeferral(update.inFlightGate);
    log.info(`webui redeploy deferred: ${deferral.summary}`, {
      source: SOURCE,
      route: ROUTE,
      instanceId: instance.id,
      userId: instance.user_id,
      failureType: `webui_redeploy_${deferral.reason}`,
      ...inFlightGateLogFields(update.inFlightGate),
    });
    return {
      id: instance.id,
      name,
      success: false,
      deferred: true,
      deferrals: update.inFlightGate.deferrals,
      error: deferral.reason,
    };
  }
  if (!update.applied) {
    log.error("webui redeploy launch failed", new Error("live_redeploy_launch_failed"), {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      instanceId: instance.id,
      userId: instance.user_id,
      failureType: "webui_redeploy_launch_failed",
      redactedMessage: redactSensitiveCommandOutput(update.error || "applyLiveUpdate returned not applied", 600),
    });
    return { id: instance.id, name, success: false, error: "Live redeploy launch failed" };
  }

  log.info("webui redeploy launched", {
    source: SOURCE,
    route: ROUTE,
    method: "POST",
    instanceId: instance.id,
    userId: instance.user_id,
    proxmoxVmid: instance.proxmox_vmid ?? null,
  });
  return { id: instance.id, name, success: true, status: "redeploying" };
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body", 400);
  }

  const instanceIds = parseInstanceIds(body);
  if (!instanceIds) {
    return apiError("Pass instanceIds as a non-empty array", 400);
  }
  if (instanceIds.length > MAX_INSTANCE_IDS) {
    return apiError(`At most ${MAX_INSTANCE_IDS} instances can be redeployed at once`, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select(INSTANCE_SELECT)
    .in("id", instanceIds);
  if (error) {
    log.error("failed to fetch instances for webui redeploy", new Error("supabase_query_failed"), {
      source: SOURCE,
      route: ROUTE,
      method: "POST",
      failureType: "webui_redeploy_instance_query_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return apiError("Failed to query instances", 500);
  }

  const rowsById = new Map(
    ((data || []) as unknown as RedeployInstanceRow[]).map((row) => [row.id, row]),
  );
  const getGlobalSettings = createGlobalSettingsCache();
  const results: RedeployResult[] = [];
  for (const id of instanceIds) {
    const row = rowsById.get(id);
    if (!row) {
      results.push(skippedResult(id, null, "Instance not found"));
      continue;
    }
    // Operator-initiated targeted rescue: recreate now, no in-flight deferral.
    results.push(await redeployOne(row, getGlobalSettings, OPERATOR_LIVE_UPDATE));
  }

  const launched = results.filter((result) => result.success).length;
  const skipped = results.filter((result) => result.skipped).length;
  const failed = results.filter((result) => !result.success && !result.skipped).length;

  return apiSuccess({
    requested: instanceIds.length,
    launched,
    failed,
    skipped,
    results,
  });
}

/**
 * Put deferred rows back at the head of the fair queue. The attempt cursor was
 * stamped for the whole batch before any work ran; left there, a deferred box
 * would wait a full fleet cycle (days) instead of being retried by the next
 * tick. Clearing it sorts the row first (NULLS FIRST). A box that stays busy
 * cannot camp the head: the in-flight gate defers a busy box on at most two
 * consecutive daily visits and updates it on the third
 * (SYSTEM_UPDATE_DEFERRAL_POLICY.fleet_sync in inflight-update-gate.ts).
 */
async function requeueDeferredRows(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabaseAdmin!
    .from("hermes_instances")
    .update({ last_sync_attempt_at: null })
    .in("id", ids);
  if (error) {
    log.error(
      "fleet-sync deferred-row requeue failed",
      new Error("fleet_sync_deferred_requeue_failed"),
      {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        failureType: "fleet_sync_deferred_requeue_failed",
        deferred: ids.length,
        errorName: error instanceof Error ? error.name : typeof error,
      },
    );
  }
}

/**
 * Scheduled fleet sweep. Hit by Vercel cron on the schedule defined in
 * vercel.json; processes ALL live WebUI instances in batches of
 * CONCURRENT_REDEPLOYS, capped at FLEET_SYNC_BATCH_LIMIT per tick to stay
 * inside the maxDuration envelope.
 *
 * Auth: Vercel cron passes `Authorization: Bearer ${CRON_SECRET}` so the
 * same verifyBearerHeader path POST already uses works here unchanged.
 *
 * Selection criteria:
 *   - backend in WEBFREE_BACKENDS ('webui' | 'gateway')
 *   - lifecycle_state in ('active', 'running', 'provisioned') OR status =
 *     'running' — the OR is load-bearing: a lifecycle_state-only filter
 *     permanently starves a healthy box whose lifecycle_state has drifted
 *     (see the comment on the query below)
 *   - minus rows armed for teardown (status='scheduled_for_deletion')
 *   - ordered by last_sync_attempt_at NULLS FIRST so the longest-unattempted
 *     VMs get picked up first; ties broken by id for determinism
 *
 * The response reports `eligibleTotal` alongside `launched` so under-delivery
 * is visible: launched < eligibleTotal means the fleet needs more ticks
 * (FLEET_SYNC_BATCH_LIMIT caps one run). Never infer coverage from
 * "failed=0" — that only counts boxes the query actually selected.
 *
 * TWO cursors, deliberately:
 *   - `last_synced_at` — bumped by applyLiveUpdate on launch SUCCESS only. The
 *     honest "this VM is on the latest :stable" signal; the ops fleet-live-
 *     update CLI filters staleness on it. NOT the sort key.
 *   - `last_sync_attempt_at` — stamped by this sweep for every row it selects,
 *     success or not. The sort key, and the ONLY thing that makes the queue
 *     fair.
 *
 * Ordering by the success cursor is what broke: a box that fails every
 * redeploy never bumped it, so it re-sorted to the front of every tick and
 * held a slot forever. Prod 2026-07-16: 5 such rows occupied the first 5 slots
 * of every run ahead of all 93 healthy boxes; at ~50 the batch would be fully
 * consumed and no healthy box would ever sync again. Ordering by attempt makes
 * this a round-robin — broken boxes are still retried every cycle (permanent
 * ejection is the bug #598 fixed and must not return), they just cannot camp
 * the head of the queue.
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  // Eligibility = (lifecycle_state is live) OR (the box is actually running),
  // MINUS a hard deny-list. Both halves are load-bearing:
  //
  //  * The OR rescues drift. The old filter was lifecycle-only and, worse, used
  //    STATUS vocabulary for it: `in ('active','running','provisioned')`. The
  //    column's CHECK constraint only allows
  //    pending|provisioning|active|paused|suspended|deleting|deleted|failed|
  //    archiving|cold_archived|restoring|pending_deletion — so 'running' and
  //    'provisioned' could never match and it silently reduced to
  //    lifecycle_state='active'. A healthy, running box whose lifecycle_state
  //    had drifted (e.g. to 'provisioning') was never SELECTED — and a row that
  //    is never selected cannot be counted as failed or skipped either, so the
  //    tick reported "launched=50 failed=0 skipped=0" while that box sat
  //    un-redeployed for days (2026-07-16: 3 ticks / 150 launches never touched
  //    inst fixturecase03; a targeted POST, which skips this filter, fixed it).
  //  * 'failed' is in the allow-list because a dispatch failure stamps
  //    lifecycle_state='failed' (instance-orchestrator). Without it one bad tick
  //    EJECTS a box from the sweep permanently — and the ops event below, which
  //    promises failed rows "re-sort to the front next run", was simply untrue.
  //  * The deny-list is what makes the status arm safe. `status` is explicitly
  //    NOT trustworthy on its own (see instance-lifecycle.ts): a destroyed
  //    (cold_archived), mid-deletion or billing-suspended row can carry a stale
  //    status, and redeploying those SSHes a VM that is gone or shouldn't run.
  //
  // Deliberately NOT admitting 'provisioning'/'pending': a genuinely
  // mid-provision box has status='provisioning', so it fails both arms and we
  // don't race the provisioner — while the drifted-but-actually-running case is
  // already covered by the status arm.
  const { data, error } = await applyFleetSyncEligibility(
    supabaseAdmin.from("hermes_instances").select(INSTANCE_SELECT),
  )
    // Order by ATTEMPT, not success. `last_synced_at` is only stamped when a
    // redeploy LAUNCHES, so ordering by it meant a box that fails every time
    // never advanced and re-sorted to the head of every tick, forever — the 50
    // slots go to boxes that cannot succeed while healthy boxes wait. Verified
    // on prod 2026-07-16: 5 permanently-failing rows held the first 5 slots of
    // every tick ahead of all 93 healthy boxes. Stamping the attempt below
    // makes this a fair round-robin: a broken box is retried once per fleet
    // cycle and costs its share, never more. See the migration for why we did
    // NOT just repurpose last_synced_at.
    .order("last_sync_attempt_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(FLEET_SYNC_BATCH_LIMIT);
  if (error) {
    log.error("fleet-sync instance query failed", new Error("supabase_query_failed"), {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "fleet_sync_instance_query_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return apiError("Failed to query instances", 500);
  }

  const rows = ((data || []) as unknown as RedeployInstanceRow[]);

  // How many boxes the sweep SHOULD eventually cover, independent of this
  // tick's FLEET_SYNC_BATCH_LIMIT. Reported so under-delivery is visible:
  // launched < eligibleTotal means the fleet needs more ticks. Without this the
  // only signals were launched/failed/skipped, all of which are computed from
  // the rows the query selected — so a fleet that never finishes looks
  // identical to one that did. Best-effort: a count failure must not fail the
  // sweep, so fall back to null rather than throwing.
  const { count: eligibleCount } = await applyFleetSyncEligibility(
    supabaseAdmin
      .from("hermes_instances")
      .select("id", { count: "exact", head: true }),
  );
  const eligibleTotal = typeof eligibleCount === "number" ? eligibleCount : null;
  if (eligibleTotal !== null && eligibleTotal > rows.length) {
    log.info("fleet-sync tick covers only part of the eligible fleet", {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      eligibleTotal,
      thisTick: rows.length,
      batchLimit: FLEET_SYNC_BATCH_LIMIT,
    });
  }
  if (rows.length === 0) {
    // A no-op fleet (nothing due) is still a successful scheduled run — stamp
    // the dead-man heartbeat so a quiet day doesn't look like the cron going
    // dark. redeploy-webui-instances is in CRON_REGISTRY but previously never
    // stamped one (false watchdog coverage). Best-effort.
    await recordCronHeartbeat("redeploy-webui-instances");
    return apiSuccess({
      mode: "fleet-sync",
      requested: 0,
      launched: 0,
      failed: 0,
      skipped: 0,
      deferred: 0,
      eligibleTotal: 0,
      results: [] as RedeployResult[],
    });
  }

  // Advance the fairness cursor for this whole batch before any redeploy runs.
  // Must happen here — after selection, before the work — so the queue rotates
  // even when every row in the batch fails. See stampSyncAttempt.
  await stampSyncAttempt(rows.map((row) => row.id));

  // Process in concurrent waves so a fleet of ~100 VMs lands inside the
  // 300s maxDuration ceiling. Sequential would be ~100 × 60s = far over.
  const getGlobalSettings = createGlobalSettingsCache();
  const results: RedeployResult[] = [];
  for (let i = 0; i < rows.length; i += CONCURRENT_REDEPLOYS) {
    const wave = rows.slice(i, i + CONCURRENT_REDEPLOYS);
    // allSettled, not all: redeployOne is defensive, but one unexpected throw
    // (a bad row, a Clerk hiccup) would reject the whole wave -> 500 the tick ->
    // skip every remaining wave AND the dead-man heartbeat below, so a crash
    // would also silence the watchdog that is supposed to notice the crash.
    // Turn a rejection into a normal failed result and keep sweeping.
    // Scheduled sweep = system-initiated: a box with an agent turn in flight,
    // or one that cannot confirm it is idle, is deferred (bounded by the
    // in-flight gate's cap) instead of recreated.
    const settled = await Promise.allSettled(
      wave.map((row) => redeployOne(row, getGlobalSettings, systemLiveUpdate("fleet_sync")))
    );
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
        return;
      }
      const row = wave[index];
      log.error("webui redeploy threw", new Error("redeploy_one_threw"), {
        source: SOURCE,
        route: ROUTE,
        method: "GET",
        instanceId: row.id,
        failureType: "webui_redeploy_unexpected_throw",
        errorName: outcome.reason instanceof Error ? outcome.reason.name : typeof outcome.reason,
      });
      results.push({
        id: row.id,
        name: row.name ?? null,
        success: false,
        error: "Redeploy threw unexpectedly",
      });
    });
  }

  const launched = results.filter((result) => result.success).length;
  const skipped = results.filter((result) => result.skipped).length;
  const deferredIds = results.filter((result) => result.deferred).map((result) => result.id);
  const deferred = deferredIds.length;
  const deferredUnverified = results.filter(
    (result) => result.deferred && result.error === "deferred_unverified",
  ).length;
  const failed = results.filter(
    (result) => !result.success && !result.skipped && !result.deferred,
  ).length;

  await requeueDeferredRows(deferredIds);

  log.info("fleet-sync completed", {
    source: SOURCE,
    route: ROUTE,
    method: "GET",
    requested: rows.length,
    launched,
    failed,
    skipped,
    deferred,
    deferredUnverified,
  });

  // Surface failures: previously a mostly-failed fleet sync returned HTTP 200
  // with a results array but no ops_event, so a broken redeploy path (ghcr down,
  // stuck /health, SSH/key churn) looked healthy. Emit a warn event when any
  // redeploy failed. Best-effort. (The FLEET_SYNC_BATCH_LIMIT=50/day cap is a
  // deliberate throttle and is untouched.)
  if (failed > 0) {
    await reportOpsEvent({
      source: "cron.redeploy_webui_fleet_sync_failed",
      severity: "warn",
      title: `redeploy-webui fleet-sync: ${failed} of ${rows.length} failed`,
      message:
        `redeploy-webui-instances fleet-sync launched ${launched}, skipped ${skipped}, deferred ${deferred} ` +
        `(${deferred - deferredUnverified} with an agent turn in flight, ${deferredUnverified} that could not ` +
        `confirm none was running), and FAILED ${failed} ` +
        `of ${rows.length} attempted VM(s). Failed rows keep their old last_synced_at (so they still read as ` +
        `stale) but DID bump last_sync_attempt_at, so they rotate to the back and are retried next cycle ` +
        `rather than camping the head of the queue. A row failing every cycle is a real broken box, not a ` +
        `queue problem: check ghcr.io + the failed instances' /health + SSH host health.`,
      route: ROUTE,
      metadata: {
        requested: rows.length,
        launched,
        failed,
        skipped,
        deferred,
        deferred_unverified: deferredUnverified,
        failed_instances: results
          .filter((r) => !r.success && !r.skipped && !r.deferred)
          .map((r) => ({ id: r.id, error: r.error })),
      },
    });
  }

  // Dead-man heartbeat: the sweep ran to completion (per-VM failures are in
  // `results`, not a route-level failure). Best-effort.
  await recordCronHeartbeat("redeploy-webui-instances");

  return apiSuccess({
    mode: "fleet-sync",
    requested: rows.length,
    launched,
    failed,
    skipped,
    // Boxes left untouched because an agent turn was running or the box could
    // not confirm none was (deferredUnverified of them); requeued first.
    deferred,
    deferredUnverified,
    // Total boxes the sweep should cover; launched < eligibleTotal => run more
    // ticks. Never read coverage off failed=0 alone.
    eligibleTotal,
    results,
  });
}
