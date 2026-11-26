/**
 * Cron: refresh $HERMES wallet snapshots → update resource_tier per user.
 *
 * What it does, every run:
 *   1. Refreshes holdings via refreshVerifiedHermesTokenHoldings() on its own
 *      lane (pulls live balances from Base RPC, writes token_holding_snapshots;
 *      an account with no verification wallet gets zero-balance snapshots).
 *      Every account with Pro/Power, Venice boost or lock-wallet standing is
 *      read on every run, first; plain verified wallets get the capacity left,
 *      least recently read first.
 *   2. For each funding cohort, derive its compute tier. Account-funded
 *      seats use Stripe, Apple, then yearly access. Holder seats use the
 *      lower of the admission and countable Pro/Power qualification (including
 *      breach grace). Seats without their funding source fall to credit_base.
 *   3. Calls applyTierChange() to push the new tier through the same path
 *      Stripe webhooks use (DB write + live Proxmox resize).
 *
 * Trigger this from Vercel Cron, GitHub Actions, or any scheduled job:
 *   POST https://<dashboard>/api/cron/refresh-token-tiers
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Env:
 *   CRON_SECRET                 Required for authorization (returns 401 otherwise).
 *
 * Why a separate route from billing/credits cron: tier changes touch live VM
 * resources (the Proxmox `qm set` path). Keeping it isolated means the
 * billing cron stays cheap and a misbehaving live-resize call can't blow up
 * the credit ledger pipeline.
 */

import { NextRequest } from "next/server";
import { proxmoxPlacementPolicy } from "@/lib/proxmox/placement-policy";
import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { hasPlanAccessStatus } from "@/lib/billing/subscription-status";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import { refreshVerifiedHermesTokenHoldings } from "@/lib/billing/token-holdings";
import { resolveTokenAccessForUsers, tierRowTokenCounts } from "@/lib/billing/token-access";
import type { PlatformTokenKey } from "@/lib/billing/token-registry";
import { REQUALIFICATION_GRACE_HOURS } from "@/lib/billing/tier-thresholds";
import { normalizeProxmoxTargetId, resolveProxmoxTargetConfiguration, resolveProxmoxVmDiskGb } from "@/lib/services/proxmox-instance-service";
import { applyTierChange } from "@/lib/services/tier-change-service";
import {
  resolveTierSpec,
  applyComputeBoost,
  isPaidTier,
  tierFromPlanKey,
  type TierKey,
} from "@/lib/services/tier-specs";
import { fetchVeniceBoostEligibleUsers } from "@/lib/billing/venice-compute-boost";
import { APPLE_ACCESS_STATUSES } from "@/lib/billing/apple-products";
import {
  YEARLY_LIVE_STATUSES,
  pickEntitledYearlySubscription,
  yearlyTierPlanKey,
  type YearlyEntitlementRow,
} from "@/lib/billing/yearly-entitlement";

// SCRIPTURE_ANCHOR: cron-season | Ecclesiastes 3:1 | Verse: For everything there is a season, and a time for every purpose under heaven.
// The refresh stops starting reads after its budget, leaving the rest of
// maxDuration for the tier scan and any live resizes below.
export const maxDuration = 300;
const REFRESH_TIME_BUDGET_MS = 150_000;

// Vercel Cron uses GET by default. POST is also accepted for manual
// triggering with curl/test scripts. Both require the CRON_SECRET bearer.
async function handle(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return apiError("CRON_SECRET not configured", 500);
  }
  if (!verifyBearerHeader(request, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  try {
    return await runRefreshTokenTiersCron(supabaseAdmin);
  } catch (error) {
    return apiError(
      "refresh-token-tiers cron failed",
      500,
      undefined,
      undefined,
      {
        failureType: "refresh_token_tiers_failed",
        cause: error,
      },
    );
  }
}

// PostgREST caps one response at ~1000 rows and silently truncates past it. A
// truncated read here would drop users from the sweep, or read a missing
// entitlement as "none" and downgrade a paid user. So every scan pages by id
// or runs in user-id chunks (short URLs too), and a chunk that reaches the cap
// fails the run before any tier changes.
const POSTGREST_ROW_CAP = 1000;
const USER_ID_CHUNK = 100;

type ScanResult<T> = { rows: T[]; error: string | null };

interface SweepInstance {
  id: string;
  user_id: string;
  resource_tier: string | null;
  cpu_limit: number | null;
  ram_limit: number | null;
  seat_funding: string | null;
}

/** Every live instance, keyset-paged by id (one row per instance). */
async function listLiveInstanceOwners(
  db: NonNullable<typeof supabaseAdmin>,
): Promise<ScanResult<SweepInstance>> {
  const rows: SweepInstance[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = db
      .from("hermes_instances")
      .select("id, user_id, resource_tier, cpu_limit, ram_limit, seat_funding")
      .not("status", "in", '("deleted","scheduled_for_deletion")');
    if (cursor) {
      query = query.gt("id", cursor);
    }
    query = query.order("id", { ascending: true }).limit(POSTGREST_ROW_CAP);
    const { data, error } = await query;
    if (error) return { rows, error: error.message };
    const page = (data || []) as typeof rows;
    rows.push(...page);
    if (page.length < POSTGREST_ROW_CAP) break;
    cursor = page[page.length - 1].id;
  }
  return { rows, error: null };
}

/** Runs one user-id-filtered read per chunk of userIds and joins the rows. */
async function scanByUserIds<T>(
  userIds: string[],
  scan: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<ScanResult<T>> {
  const rows: T[] = [];
  for (let i = 0; i < userIds.length; i += USER_ID_CHUNK) {
    const { data, error } = await scan(userIds.slice(i, i + USER_ID_CHUNK));
    if (error) return { rows, error: error.message };
    const page = (data || []) as T[];
    if (page.length >= POSTGREST_ROW_CAP) {
      return { rows, error: `a user-id chunk returned ${POSTGREST_ROW_CAP}+ rows (row cap reached)` };
    }
    rows.push(...page);
  }
  return { rows, error: null };
}

/** The exact declared rotation placement uses; null means the registry is unrestricted. */
function declaredProxmoxTargetIds(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const declared = env.HERMES_PROXMOX_TARGETS?.trim() || env.PROXMOX_TARGETS?.trim() || "";
  const ids = [...new Set(
    declared
      .split(/[,\s]+/)
      .map((id) => normalizeProxmoxTargetId(id))
      .filter((id): id is string => Boolean(id)),
  )];
  return ids.length > 0 ? ids : null;
}


// Pass only capacity settings to SQL. Undeclared rotations still honor
// per-host disk overrides for registry hosts, using placement's precedence.
function placementDiskSizes(env: NodeJS.ProcessEnv): Record<string, number> {
  const sizes: Record<string, number> = { defaultDiskGb: resolveProxmoxVmDiskGb(env) };
  for (const key of Object.keys(env)) {
    const match = /^(?:PROXMOX_HOST_(.+)|PROXMOX_(.+)|(.+)_PROXMOX)_VM_DISK_GB$/.exec(key);
    const id = normalizeProxmoxTargetId(match?.[1] ?? match?.[2] ?? match?.[3]);
    if (id) sizes[id] = resolveProxmoxVmDiskGb(resolveProxmoxTargetConfiguration(env, id).env);
  }
  return sizes;
}

async function runRefreshTokenTiersCron(db: NonNullable<typeof supabaseAdmin>) {
  // 1. Refresh balances on this cron's lane (writes to token_holding_snapshots):
  //    every account with standing, then plain verified wallets with the
  //    budget left. A failed read is not recorded as judged, so the next run
  //    reads it ahead of every account judged since.
  const refreshResult = await refreshVerifiedHermesTokenHoldings({
    lane: "token_tiers",
    db,
    fetchImpl: globalThis.fetch,
    timeBudgetMs: REFRESH_TIME_BUDGET_MS,
  });

  // Advance holder admissions on this existing periodic qualification lane.
  // The RPC is one serialized database transaction: it materializes newly
  // qualified users as waitlisted, reads the qualifications persisted by the holdings evaluator, and admits only seats that fit both the global holder
  // ceiling and a single placement-eligible host. A transient failure is
  // reported and left for the next tick; it must not stop tier maintenance for
  // users who already have seats.
  let holderAdmission: unknown = null;
  let holderAdmissionError: string | null = null;
  try {
    const advancement = await db.rpc("advance_holder_admissions", {
      p_target_host_ids: declaredProxmoxTargetIds(),
      p_cpu_overcommit_ratio: proxmoxPlacementPolicy(process.env).cpuOvercommitRatio,
      p_skip_sleep: proxmoxPlacementPolicy(process.env).skipDeepSleep,
      p_disk_sizes: placementDiskSizes(process.env),
    });
    if (advancement.error) {
      holderAdmissionError = advancement.error.message;
    } else {
      holderAdmission = advancement.data;
    }
  } catch (error) {
    holderAdmissionError = error instanceof Error ? error.message : String(error);
  }
  if (holderAdmissionError) {
    await reportOpsEvent({
      source: "cron.refresh-token-tiers",
      severity: "warn",
      title: "holder admission advancement failed",
      message:
        "The periodic holder admission advancement RPC failed. Qualified waiters remain waitlisted and existing admitted holders are unchanged; the next cron tick retries the same idempotent transaction.",
      route: "/api/cron/refresh-token-tiers",
      metadata: {
        failureType: "holder_admission_advance_failed",
        error: holderAdmissionError.slice(0, 500),
      },
    });
  }

  // 2. For each user, decide the new tier from the strongest entitlement
  //    (see the header); with none, credit_base.
  //
  // The previous query joined hermes_instances → token_holding_snapshots
  // (inner) → hermes_subscriptions with no `.limit()`. Snapshots accumulate
  // every 6h (refresh-token-holdings cron), so the row count grew linearly
  // with time — at N users × M instances × S snapshots × T subscriptions,
  // payload was a cartesian explosion just to make N decisions. The cron
  // would steadily slow as the snapshot table grew.
  //
  // New shape: 3 small bounded queries.
  //   (a) distinct (user_id, resource_tier) from hermes_instances
  //   (b) token access per user
  //   (c) subscriptions for the same user set
  // Then build the decision in JS. No joins, no cartesian.
  const instScan = await listLiveInstanceOwners(db);
  if (instScan.error) return apiError(`User scan failed: ${instScan.error}`, 500);

  // A paid and a holder-funded seat can have different tiers for one owner.
  const cohorts = new Map<string, SweepInstance[]>();
  for (const row of instScan.rows) {
    const key = JSON.stringify([row.user_id, row.seat_funding === "holder"]);
    const rows = cohorts.get(key);
    if (rows) rows.push(row);
    else cohorts.set(key, [row]);
  }
  const userIds = [...new Set(instScan.rows.map((row) => row.user_id))];

  // (b) Token access per user: before $HIVRA is active everyone is
  //     $HermesOS-only and this reads nothing. After, it decides which tokens'
  //     tier rows count.
  const accessByUser = await resolveTokenAccessForUsers(userIds, { db });

  // (c) Subscriptions for the same user set.
  const subByUser = new Map<string, { status: string; plan: string }>();
  const subScan = await scanByUserIds<{ user_id: string; status: string; plan: string }>(userIds, (chunk) =>
    db.from("hermes_subscriptions").select("user_id, status, plan").in("user_id", chunk),
  );
  if (subScan.error) return apiError(`Subscription scan failed: ${subScan.error}`, 500);
  for (const s of subScan.rows) {
    subByUser.set(s.user_id, { status: s.status, plan: s.plan });
  }

  // Count qualifications including breach grace. A qualification and a
  // reservation are both required before a holder seat can gain compute.
  const qualByUser = new Map<string, "operator" | "fleet">();
  const graceStart = new Date(
    Date.now() - REQUALIFICATION_GRACE_HOURS * 60 * 60 * 1000
  ).toISOString();
  const qualScan = await scanByUserIds<{
    user_id: string;
    tier: "pro" | "power";
    token_key: PlatformTokenKey | null;
    currently_eligible: boolean;
  }>(userIds, (chunk) =>
    db
      .from("token_tier_qualifications")
      .select("user_id, tier, token_key, currently_eligible")
      .in("user_id", chunk)
      .or(`currently_eligible.eq.true,and(last_suspend_at.is.null,last_breach_at.gt.${graceStart})`),
  );
  if (qualScan.error) return apiError(`Qualification scan failed: ${qualScan.error}`, 500);
  for (const q of qualScan.rows) {
    // A tier row counts only in a token that still counts for the user.
    const access = accessByUser.get(q.user_id);
    if (access && !tierRowTokenCounts(access, q.token_key ?? "hermesos")) continue;
    const mapped: "operator" | "fleet" = q.tier === "power" ? "fleet" : "operator";
    const existing = qualByUser.get(q.user_id);
    // Power outranks Pro when both are present.
    if (existing === "fleet") continue;
    qualByUser.set(q.user_id, mapped);
  }

  // (d2) Durable holder admissions. Qualification only joins the FIFO queue;
  // it never upgrades an existing seat by itself. Use the admission row's
  // reconciled tier (not the live qualification maximum) so a Pro admission
  // cannot become Power merely because a larger paid plan or qualification
  // exists elsewhere in the account.
  const admissionByUser = new Map<string, "pro" | "power">();
  const admissionScan = await scanByUserIds<{
    user_id: string;
    state: string;
    tier: "pro" | "power";
  }>(userIds, (chunk) =>
    db
      .from("holder_admissions")
      .select("user_id, state, tier")
      .in("user_id", chunk)
      .eq("state", "admitted"),
  );
  if (admissionScan.error) return apiError(`Holder admission scan failed: ${admissionScan.error}`, 500);
  for (const row of admissionScan.rows) {
    if (row.state === "admitted") admissionByUser.set(row.user_id, row.tier);
  }

  // (e) Apple IAP subscriptions. The App Store lane keeps its own table and
  //     never writes hermes_subscriptions, so without this read an Apple-only
  //     subscriber looked like a lapsed holder here and was live-resized down
  //     to credit_base every tick, undoing the tier the Apple webhook applied.
  //     Only access-granting statuses count, as in resolveEffectiveSubscription;
  //     'past_due' (retry with no grace), 'expired' and 'revoked' fall through.
  const applePlanByUser = new Map<string, string>();
  const appleScan = await scanByUserIds<{ user_id: string; plan: string }>(userIds, (chunk) =>
    db
      .from("apple_iap_subscriptions")
      .select("user_id, plan")
      .in("user_id", chunk)
      .in("status", [...APPLE_ACCESS_STATUSES]),
  );
  if (appleScan.error) {
    return apiError(`Apple subscription scan failed: ${appleScan.error}`, 500);
  }
  for (const row of appleScan.rows) {
    if (isPaidTier(row.plan)) applePlanByUser.set(row.user_id, row.plan);
  }

  // (f) Live yearly $HermesOS subscriptions. A yearly payment is swept out of
  //     the wallet, so a yearly-only subscriber usually has no qualification
  //     and a below-threshold snapshot. Without this read the loop below
  //     treated them as a lapsed holder and live-resized their paid instances
  //     down to credit_base on every tick, while createInstance (via
  //     resolveEffectiveSubscription) kept provisioning them at the paid tier.
  const yearlyByUser = new Map<string, YearlyEntitlementRow>();
  const yearlyScan = await scanByUserIds<YearlyEntitlementRow & { user_id: string }>(userIds, (chunk) =>
    db
      .from("yearly_token_subscriptions")
      .select("user_id, tier, expires_at, paid_at")
      .in("user_id", chunk)
      .in("status", [...YEARLY_LIVE_STATUSES]),
  );
  if (yearlyScan.error) {
    return apiError(`Yearly subscription scan failed: ${yearlyScan.error}`, 500);
  }
  const rowsByUser = new Map<string, YearlyEntitlementRow[]>();
  for (const row of yearlyScan.rows) {
    const rows = rowsByUser.get(row.user_id) ?? [];
    rows.push(row);
    rowsByUser.set(row.user_id, rows);
  }
  for (const [userId, rows] of rowsByUser) {
    const entitled = pickEntitledYearlySubscription(rows);
    if (entitled) yearlyByUser.set(userId, entitled);
  }

  // (g) Venice compute-boost eligibility (holds ≥ $199 VVV). Drives the
  //     +1 vCPU / +2 GB effective-spec bump, but ONLY on paid tiers
  //     (resolveEffectiveTierSpec enforces that). Read as a batch so the
  //     per-user loop below stays round-trip-free.
  const boostByUser =
    userIds.length > 0
      ? await fetchVeniceBoostEligibleUsers(userIds)
      : new Set<string>();

  const tierChanges: Array<{ userId: string; from: string; to: string }> = [];
  const tierFailures: Array<{ userId: string; error: string }> = [];

  for (const rows of cohorts.values()) {
    const { user_id: userId, seat_funding: funding } = rows[0];
    const holder = funding === "holder";
    const sub = subByUser.get(userId);
    const qual = qualByUser.get(userId);
    const admissionTier = admissionByUser.get(userId);
    const admittedQual = qual && admissionTier
      ? admissionTier === "power" && qual === "fleet"
        ? "fleet"
        : "operator"
      : null;
    const applePlan = applePlanByUser.get(userId);
    const yearly = yearlyByUser.get(userId);
    const boost = boostByUser.has(userId);

    // Stripe-paid users are managed by handleSubscriptionChange, which owns
    // their BASE tier. We must NOT downgrade them here — but we still mirror
    // their plan as the desired tier and fall through to the boost-aware
    // re-apply below, so a VVV boost gained or lost is reflected on the VM
    // even when the base plan is unchanged (Stripe webhooks don't fire when
    // the VVV price drifts, so without this the boost would never reach a
    // card-paid user's instances).
    // Use the canonical plan-access predicate (active/trialing/past_due) so a
    // past_due-but-still-entitled subscriber is treated as paid here too —
    // otherwise they fall through to token logic and can be downgraded to
    // credit_base, fighting the grace reconciler that keeps their access. This
    // matches how purge-expired / force-delete decide "owner has plan access".
    const paidStripe =
      !!sub &&
      sub.plan !== "free" &&
      hasPlanAccessStatus(sub.status);

    let desiredTier: TierKey;
    let reason: string;

    if (!holder && paidStripe) {
      desiredTier = tierFromPlanKey(sub!.plan);
      reason = `cron: stripe plan ${sub!.plan} (boost re-apply)`;
    } else if (!holder && applePlan) {
      desiredTier = tierFromPlanKey(applePlan);
      reason = `cron: apple iap plan ${applePlan}`;
    } else if (!holder && yearly) {
      // Yearly sits after paid Stripe and Apple and before token holdings,
      // exactly as in resolveEffectiveSubscription. Its own 'grace' status
      // covers the days after expires_at, so no snapshot grace applies here.
      desiredTier = tierFromPlanKey(yearlyTierPlanKey(yearly.tier));
      reason = `cron: yearly $HermesOS ${yearly.tier} subscription`;
    } else if (holder && admittedQual) {
      desiredTier = admittedQual;
      reason = `cron: admitted token-tier qualification ${admittedQual === "fleet" ? "power" : "pro"}`;
    } else {
      desiredTier = "credit_base";
      reason = "cron: no paid plan or token-tier qualification";
    }

    // Boost only stacks on paid tiers.
    const boostActive = !holder && boost && isPaidTier(desiredTier);

    // Change detection. Re-apply when the base tier changed (original
    // behaviour) OR when the Venice boost specifically needs toggling.
    //
    // The boost toggle is deliberately conservative: it fires ONLY when an
    // instance sits EXACTLY at the tier spec (base or boosted). That catches
    // the boost-only case the old `desiredTier === currentTier` skip missed,
    // without resizing intentionally custom-sized VMs (the host-allocation UI
    // lets users distribute capacity below tier max — we must not clobber it).
    const baseSpec = resolveTierSpec(desiredTier);
    const boostedSpec = applyComputeBoost(baseSpec, true);
    const changed = rows.find((row) => {
      const atBase = row.cpu_limit === baseSpec.cpuLimit && row.ram_limit === baseSpec.ramLimitMb;
      const atBoosted = row.cpu_limit === boostedSpec.cpuLimit && row.ram_limit === boostedSpec.ramLimitMb;
      if (holder && ((row.cpu_limit ?? 0) > baseSpec.cpuLimit || (row.ram_limit ?? 0) > baseSpec.ramLimitMb)) return true;
      return (row.resource_tier ?? "credit_base") !== desiredTier || (boostActive ? atBase : atBoosted);
    });
    if (!changed) continue;
    const currentTier = changed.resource_tier ?? "credit_base";

    try {
      await applyTierChange({
        userId,
        newTier: desiredTier,
        source: "token_snapshot",
        holderSeats: holder,
        veniceBoost: boostActive,
        reason,
      });
      tierChanges.push({ userId, from: currentTier, to: desiredTier });
    } catch (err) {
      tierFailures.push({
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // applyTierChange drives live Proxmox resizes; a per-user failure can leave a
  // tenant unresized or wrongly downgraded. Per-user failures are isolated into
  // tierFailures (good — one bad resize must not abort the sweep), but without a
  // signal they only show in this route's JSON. Surface a single warn breadcrumb
  // so a systemic resize/DB outage is visible on the ops feed. Best-effort:
  // reportOpsEvent swallows its own errors and never throws.
  if (tierFailures.length > 0) {
    await reportOpsEvent({
      source: "cron.refresh-token-tiers",
      severity: "warn",
      title: `refresh-token-tiers: ${tierFailures.length} tier change(s) failed`,
      message:
        `${tierFailures.length} of ${userIds.length} scanned user(s) failed applyTierChange ` +
        `(live Proxmox resize + DB write). Affected tenants may be left ` +
        `unresized or with a stale resource_tier until the next tick succeeds. Investigate ` +
        `if this persists across runs — it can indicate a host/SSH or DB outage.`,
      route: "/api/cron/refresh-token-tiers",
      metadata: {
        failureType: "tier_change_failed",
        usersScanned: userIds.length,
        tierChangeFailures: tierFailures.length,
        sampleUserIds: tierFailures.slice(0, 25).map((f) => f.userId),
      },
    });
  }

  return apiSuccess({
    snapshots_refreshed: refreshResult.refreshed ?? 0,
    snapshots_failed: refreshResult.failed ?? 0,
    snapshots_budget_exhausted: refreshResult.budgetExhausted ?? false,
    standing_unjudged: refreshResult.cycle?.unjudged ?? null,
    users_scanned: userIds.length,
    venice_boost_eligible: boostByUser.size,
    tier_changes: tierChanges.length,
    tier_change_details: tierChanges.slice(0, 50),
    tier_change_failures: tierFailures,
    holder_admission: holderAdmission,
    holder_admission_error: holderAdmissionError,
  });
}

export const GET = handle;
export const POST = handle;
