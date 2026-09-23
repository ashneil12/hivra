/**
 * Cron: refresh $HERMES wallet snapshots → update resource_tier per user.
 *
 * What it does, every run:
 *   1. Loops over every verified wallet via refreshVerifiedHermesTokenHoldings()
 *      (existing helper — pulls live balance from Base RPC, writes
 *      token_holding_snapshots).
 *   2. For each user, derives the new tier from the strongest entitlement,
 *      in resolveEffectiveSubscription's order:
 *        - active Stripe sub → skip (handleSubscriptionChange owns this)
 *        - Apple IAP sub in an access status (active/trialing/grace_period) → its plan
 *        - live yearly $HermesOS Power / Pro subscription → "fleet" / "operator"
 *        - currently_eligible token Power qualification → "fleet"
 *        - currently_eligible token Pro qualification   → "operator"
 *        - balance >= 1 token of a platform token the user may hold → "token_base"
 *        - balance < 1 token                            → "credit_base" (after grace)
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
import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { hasPlanAccessStatus } from "@/lib/billing/subscription-status";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import { refreshVerifiedHermesTokenHoldings } from "@/lib/billing/token-holdings";
import {
  qualifiesForTokenBaseTier,
  resolveTokenAccessForUsers,
  tierRowTokenCounts,
} from "@/lib/billing/token-access";
import { livePlatformTokens, platformTokenByAddress, type PlatformTokenKey } from "@/lib/billing/token-registry";
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
// Grace period: a user whose balance dropped below the threshold doesn't get
// downgraded immediately — give them N hours to top up before the downgrade
// to credit_base takes effect. Mirrors the dashboard's "Grace Period (token
// users): 24-72h" design rule.
const TOKEN_DOWNGRADE_GRACE_HOURS = 48;

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

async function runRefreshTokenTiersCron(db: NonNullable<typeof supabaseAdmin>) {
  // 1. Refresh balances for every verified wallet (writes to
  //    token_holding_snapshots). The helper handles RPC errors gracefully.
  const refreshResult = await refreshVerifiedHermesTokenHoldings({
    db,
    fetchImpl: globalThis.fetch,
  });

  // 2. For each user with a Stripe subscription that's NOT active+paid, AND
  //    a recent snapshot, decide the new tier:
  //      - subscription active+paid → operator/fleet/command (Stripe is
  //        authoritative; skip token-based tier decisions)
  //      - else, snapshot.balance >= threshold → token_base
  //      - else (or no snapshot)              → credit_base (after grace)
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
  //   (b) latest snapshot per user — ordered, bounded by recency
  //   (c) subscriptions for the same user set
  // Then build the decision in JS. No joins, no cartesian.
  const { data: instanceRows, error: instErr } = await db
    .from("hermes_instances")
    .select("user_id, resource_tier, cpu_limit, ram_limit")
    .not("status", "in", '("deleted","scheduled_for_deletion")');
  if (instErr) return apiError(`User scan failed: ${instErr.message}`, 500);

  // De-dup users; keep the first-seen resource_tier + caps per user (rows in
  // hermes_instances usually agree since `applyTierChange` updates all of a
  // user's instances together). The stored caps let us detect a boost-only
  // change — base tier unchanged but +1 vCPU / +2 GB gained or lost — which
  // the old `desiredTier === currentTier` skip would have silently dropped.
  const userIds: string[] = [];
  const tierByUser = new Map<string, string>();
  const specByUser = new Map<string, { cpu: number | null; ram: number | null }>();
  for (const r of (instanceRows ?? []) as Array<{
    user_id: string;
    resource_tier: string | null;
    cpu_limit: number | null;
    ram_limit: number | null;
  }>) {
    if (tierByUser.has(r.user_id)) continue;
    tierByUser.set(r.user_id, r.resource_tier || "credit_base");
    specByUser.set(r.user_id, { cpu: r.cpu_limit, ram: r.ram_limit });
    userIds.push(r.user_id);
  }

  // (b) Latest snapshot per user. Bound by a recency window so the row
  //     count is independent of how long the snapshot table has been
  //     accumulating. 30 days is comfortably wider than the
  //     TOKEN_DOWNGRADE_GRACE_HOURS window so we never exclude a snapshot
  //     that the grace logic would still consider valid.
  // Token access per user: before $HIVRA is active everyone is $HermesOS-only
  // and this reads nothing. After, it decides which tokens' holdings count.
  const accessByUser = await resolveTokenAccessForUsers(userIds, { db });
  const liveTokenAddresses = livePlatformTokens().map((token) => token.address);

  const snapshotsByUser = new Map<
    string,
    {
      balances: Partial<Record<PlatformTokenKey, bigint>>;
      display: Partial<Record<PlatformTokenKey, string>>;
      checked_at: string;
    }
  >();
  if (userIds.length > 0) {
    const recencyCutoff = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    ).toISOString();
    const { data: snapRows, error: snapErr } = await db
      .from("token_holding_snapshots")
      .select("user_id, token_address, balance_raw::text, qualifies_base_tier, checked_at")
      .in("user_id", userIds)
      .in("token_address", liveTokenAddresses)
      .gte("checked_at", recencyCutoff)
      .order("checked_at", { ascending: false });
    if (snapErr) return apiError(`Snapshot scan failed: ${snapErr.message}`, 500);
    for (const s of (snapRows ?? []) as Array<{
      user_id: string;
      token_address: string;
      balance_raw: string;
      qualifies_base_tier: boolean;
      checked_at: string;
    }>) {
      const token = platformTokenByAddress(s.token_address);
      if (!token) continue;
      const entry = snapshotsByUser.get(s.user_id) ?? { balances: {}, display: {}, checked_at: s.checked_at };
      // First write per token wins because we ordered DESC by checked_at.
      if (entry.balances[token.key] === undefined) {
        entry.balances[token.key] = BigInt(s.balance_raw);
        entry.display[token.key] = s.balance_raw;
      }
      snapshotsByUser.set(s.user_id, entry);
    }
  }

  // (c) Subscriptions for the same user set.
  const subByUser = new Map<string, { status: string; plan: string }>();
  if (userIds.length > 0) {
    const { data: subRows, error: subErr } = await db
      .from("hermes_subscriptions")
      .select("user_id, status, plan")
      .in("user_id", userIds);
    if (subErr) return apiError(`Subscription scan failed: ${subErr.message}`, 500);
    for (const s of (subRows ?? []) as Array<{ user_id: string; status: string; plan: string }>) {
      subByUser.set(s.user_id, { status: s.status, plan: s.plan });
    }
  }

  // (d) Pro/Power token-tier qualifications. A user holding enough $HERMES
  //     to qualify for the Pro or Power token tier is entitled to operator
  //     or fleet compute respectively — same as if they paid for it on
  //     Stripe (see resolveEffectiveSubscription). Without this, the cron
  //     below downgrades them to token_base every run, silently capping
  //     paid-equivalent users at 0.5 vCPU / 1 GB.
  const qualByUser = new Map<string, "operator" | "fleet">();
  if (userIds.length > 0) {
    const { data: qualRows, error: qualErr } = await db
      .from("token_tier_qualifications")
      .select("user_id, tier, token_key, currently_eligible")
      .in("user_id", userIds)
      .eq("currently_eligible", true);
    if (qualErr) return apiError(`Qualification scan failed: ${qualErr.message}`, 500);
    for (const q of (qualRows ?? []) as Array<{
      user_id: string;
      tier: "pro" | "power";
      token_key: PlatformTokenKey | null;
      currently_eligible: boolean;
    }>) {
      // A tier row counts only in a token that still counts for the user.
      const access = accessByUser.get(q.user_id);
      if (access && !tierRowTokenCounts(access, q.token_key ?? "hermesos")) continue;
      const mapped: "operator" | "fleet" = q.tier === "power" ? "fleet" : "operator";
      const existing = qualByUser.get(q.user_id);
      // Power outranks Pro when both are present.
      if (existing === "fleet") continue;
      qualByUser.set(q.user_id, mapped);
    }
  }

  // (e) Apple IAP subscriptions. The App Store lane keeps its own table and
  //     never writes hermes_subscriptions, so without this read an Apple-only
  //     subscriber looked like a lapsed holder here and was live-resized down
  //     to credit_base every tick, undoing the tier the Apple webhook applied.
  //     Only access-granting statuses count, as in resolveEffectiveSubscription;
  //     'past_due' (retry with no grace), 'expired' and 'revoked' fall through.
  const applePlanByUser = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: appleRows, error: appleErr } = await db
      .from("apple_iap_subscriptions")
      .select("user_id, plan")
      .in("user_id", userIds)
      .in("status", [...APPLE_ACCESS_STATUSES]);
    if (appleErr) {
      return apiError(`Apple subscription scan failed: ${appleErr.message}`, 500);
    }
    for (const row of (appleRows ?? []) as Array<{ user_id: string; plan: string }>) {
      if (isPaidTier(row.plan)) applePlanByUser.set(row.user_id, row.plan);
    }
  }

  // (f) Live yearly $HermesOS subscriptions. A yearly payment is swept out of
  //     the wallet, so a yearly-only subscriber usually has no qualification
  //     and a below-threshold snapshot. Without this read the loop below
  //     treated them as a lapsed holder and live-resized their paid instances
  //     down to credit_base on every tick, while createInstance (via
  //     resolveEffectiveSubscription) kept provisioning them at the paid tier.
  const yearlyByUser = new Map<string, YearlyEntitlementRow>();
  if (userIds.length > 0) {
    const { data: yearlyRows, error: yearlyErr } = await db
      .from("yearly_token_subscriptions")
      .select("user_id, tier, expires_at, paid_at")
      .in("user_id", userIds)
      .in("status", [...YEARLY_LIVE_STATUSES]);
    if (yearlyErr) {
      return apiError(`Yearly subscription scan failed: ${yearlyErr.message}`, 500);
    }
    const rowsByUser = new Map<string, YearlyEntitlementRow[]>();
    for (const row of (yearlyRows ?? []) as Array<YearlyEntitlementRow & { user_id: string }>) {
      const rows = rowsByUser.get(row.user_id) ?? [];
      rows.push(row);
      rowsByUser.set(row.user_id, rows);
    }
    for (const [userId, rows] of rowsByUser) {
      const entitled = pickEntitledYearlySubscription(rows);
      if (entitled) yearlyByUser.set(userId, entitled);
    }
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

  for (const userId of userIds) {
    const sub = subByUser.get(userId);
    const snapshot = snapshotsByUser.get(userId);
    const currentTier = tierByUser.get(userId) ?? "credit_base";
    const currentSpec = specByUser.get(userId);
    const qual = qualByUser.get(userId);
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

    // Pro/Power token qualification is the strongest token signal — it means
    // the user holds enough $HERMES to be entitled to a paid-tier compute
    // pool. token_tier_qualifications is already grace-aware, so a `true`
    // here needs no extra grace handling.
    let desiredTier: TierKey;
    let reason: string;

    if (paidStripe) {
      desiredTier = tierFromPlanKey(sub!.plan);
      reason = `cron: stripe plan ${sub!.plan} (boost re-apply)`;
    } else if (applePlan) {
      desiredTier = tierFromPlanKey(applePlan);
      reason = `cron: apple iap plan ${applePlan}`;
    } else if (yearly) {
      // Yearly sits after paid Stripe and Apple and before token holdings,
      // exactly as in resolveEffectiveSubscription. Its own 'grace' status
      // covers the days after expires_at, so no snapshot grace applies here.
      desiredTier = tierFromPlanKey(yearlyTierPlanKey(yearly.tier));
      reason = `cron: yearly $HermesOS ${yearly.tier} subscription`;
    } else if (qual) {
      desiredTier = qual;
      reason = `cron: token-tier qualification ${qual === "fleet" ? "power" : "pro"}`;
    } else if (
      snapshot &&
      qualifiesForTokenBaseTier(accessByUser.get(userId)!, snapshot.balances)
    ) {
      desiredTier = "token_base";
      reason = `cron: balance ${JSON.stringify(snapshot.display)} qualifies`;
    } else {
      // Below threshold (or no snapshot). Apply grace: hold the current
      // token-derived tier if the last snapshot is within the grace window;
      // otherwise drop to credit_base.
      const onTokenTier =
        currentTier === "token_base" ||
        currentTier === "operator" ||
        currentTier === "fleet";
      const inGrace =
        onTokenTier &&
        !!snapshot &&
        Date.now() - new Date(snapshot.checked_at).getTime() <
          TOKEN_DOWNGRADE_GRACE_HOURS * 3600 * 1000;
      if (inGrace) {
        desiredTier = currentTier as TierKey;
        reason = "cron: holding tier during downgrade grace";
      } else {
        desiredTier = "credit_base";
        reason = `cron: balance ${JSON.stringify(snapshot?.display ?? {})} below threshold`;
      }
    }

    // Boost only stacks on paid tiers.
    const boostActive = boost && isPaidTier(desiredTier);

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
    const atBase =
      currentSpec?.cpu === baseSpec.cpuLimit &&
      currentSpec?.ram === baseSpec.ramLimitMb;
    const atBoosted =
      currentSpec?.cpu === boostedSpec.cpuLimit &&
      currentSpec?.ram === boostedSpec.ramLimitMb;
    // Need to ADD the boost (eligible + currently at base) or REMOVE it
    // (ineligible + currently at boosted).
    const boostNeedsToggle = boostActive ? atBase : atBoosted;
    const tierChanged = desiredTier !== currentTier;

    if (!tierChanged && !boostNeedsToggle) continue;

    try {
      await applyTierChange({
        userId,
        newTier: desiredTier,
        source: "token_snapshot",
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
    users_scanned: userIds.length,
    venice_boost_eligible: boostByUser.size,
    tier_changes: tierChanges.length,
    tier_change_details: tierChanges.slice(0, 50),
    tier_change_failures: tierFailures,
  });
}

export const GET = handle;
export const POST = handle;
