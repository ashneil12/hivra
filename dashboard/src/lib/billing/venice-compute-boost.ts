/**
 * Venice compute-boost evaluator.
 *
 * A user who holds >= $199 of VVV (Venice's token, valued via DEX) earns a
 * +1 vCPU / +2 GB RAM per-instance boost ON TOP of a paid tier. This module
 * tracks ONLY the "holds enough VVV" half and persists it to
 * `venice_compute_boost_qualifications`. The paid-tier gate is applied later,
 * at spec-resolution time (see tier-specs.resolveEffectiveTierSpec /
 * isPaidTier), so a free holder is recorded eligible here but gets no compute
 * until they upgrade — at which point the boost applies with no re-eval.
 *
 * Grace model (intentionally simpler than token_tier_qualifications — this is
 * a bonus, not a paid entitlement):
 *   - currently_eligible becomes true when value held >= threshold.
 *   - On a drop below threshold, last_breach_at is set and currently_eligible
 *     stays true through a 48h grace window.
 *   - Recovery within grace clears last_breach_at, no penalty.
 *   - Grace expiry while still below flips currently_eligible to false.
 *
 * The `refresh-token-holdings` cron is the writer: it fetches the VVV/USD
 * price once per tick and calls evaluateAndRecordVeniceComputeBoost for each
 * user whose VVV snapshot refreshed. Price-feed failure → the cron skips the
 * whole step, so existing holders are never flipped off by a transient oracle
 * outage.
 */

import { supabaseAdmin } from "@/lib/supabase";
import { VVV_TOKEN_DECIMALS } from "@/lib/billing/token-holdings";
import { VENICE_BOOST_USD_THRESHOLD } from "@/lib/services/tier-boost";

const HOUR_MS = 60 * 60 * 1000;
export const VENICE_BOOST_GRACE_HOURS = 48;

export type VeniceBoostTransition =
  | "qualified"
  | "breached"
  | "grace_recovered"
  | "re_qualified"
  | "expired"
  | "unchanged";

export interface VeniceBoostResult {
  /** True when the boost is active (held >= threshold, or below but in grace). */
  eligible: boolean;
  transition: VeniceBoostTransition;
  /** USD value of the holding at this evaluation. */
  usdValue: number;
  inGrace: boolean;
}

interface BoostQualRow {
  id: string;
  user_id: string;
  currently_eligible: boolean;
  last_breach_at: string | null;
  last_balance_seen: string | null;
  last_usd_value: string | number | null;
}

type QueryResponse<T> = { data: T; error: unknown };

interface SelectEqBuilder {
  maybeSingle(): Promise<QueryResponse<BoostQualRow | null>>;
  in(col: string, vals: readonly string[]): Promise<QueryResponse<unknown>>;
}
interface SelectBuilder {
  eq(col: string, val: string | boolean): SelectEqBuilder;
}
interface UpdateBuilder {
  eq(col: string, val: string): Promise<QueryResponse<unknown>>;
}
interface BoostTable {
  select(cols: string): SelectBuilder;
  insert(payload: Record<string, unknown>): Promise<QueryResponse<unknown>>;
  update(payload: Record<string, unknown>): UpdateBuilder;
}
export interface VeniceBoostDb {
  from(name: string): BoostTable;
}

const TABLE = "venice_compute_boost_qualifications";

/**
 * Exact USD valuation of a raw VVV balance against a price string, with no
 * floating point in the threshold comparison.
 *
 *   usd = balanceRaw / 10^decimals * priceUsd
 *   meets ⟺ balanceRaw * priceInteger * 100 >= thresholdCents * 10^(decimals+fracDigits)
 */
export function computeVvvHoldingUsd(
  balanceRaw: bigint,
  priceUsd: string,
  thresholdUsd: number,
  decimals: number = VVV_TOKEN_DECIMALS
): { usdValue: number; meetsThreshold: boolean } {
  const priceStr = priceUsd.trim();
  if (!/^\d+(\.\d+)?$/.test(priceStr)) {
    throw new Error(`Invalid VVV price: ${priceUsd}`);
  }
  const [whole, fraction = ""] = priceStr.split(".");
  const fracDigits = fraction.length;
  const priceInteger = BigInt(whole + fraction);

  const rawProduct = balanceRaw * priceInteger;
  const scale = 10n ** BigInt(decimals + fracDigits);

  const thresholdCents = BigInt(Math.round(thresholdUsd * 100));
  const meetsThreshold = rawProduct * 100n >= thresholdCents * scale;

  // Display/storage value — float here is fine; it never gates anything.
  const usdValue = Number(rawProduct) / Number(scale);

  return { usdValue, meetsThreshold };
}

function resolveDb(db?: VeniceBoostDb | null): VeniceBoostDb | null {
  return (db ?? (supabaseAdmin as unknown as VeniceBoostDb)) ?? null;
}

interface EvaluateParams {
  userId: string;
  vvvBalanceRaw: bigint;
  /** VVV/USD price string from DEX (fetched once per cron tick). */
  vvvPriceUsd: string;
  thresholdUsd?: number;
  now?: Date;
  db?: VeniceBoostDb | null;
}

/**
 * Evaluate a user's VVV holding and persist boost eligibility. Returns the
 * resulting state; the caller dispatches any notification.
 */
export async function evaluateAndRecordVeniceComputeBoost(
  params: EvaluateParams
): Promise<VeniceBoostResult> {
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const thresholdUsd = params.thresholdUsd ?? VENICE_BOOST_USD_THRESHOLD;
  const db = resolveDb(params.db);
  if (!db) {
    return { eligible: false, transition: "unchanged", usdValue: 0, inGrace: false };
  }

  const { usdValue, meetsThreshold } = computeVvvHoldingUsd(
    params.vvvBalanceRaw,
    params.vvvPriceUsd,
    thresholdUsd
  );

  const { data: row, error: loadErr } = await db
    .from(TABLE)
    .select(
      "id, user_id, currently_eligible, last_breach_at, last_balance_seen::text, last_usd_value::text"
    )
    .eq("user_id", params.userId)
    .maybeSingle();
  if (loadErr) {
    throw new Error(`Failed to read ${TABLE} for ${params.userId}`);
  }

  const baseFields = {
    threshold_usd: thresholdUsd,
    last_balance_seen: params.vvvBalanceRaw.toString(),
    last_usd_value: usdValue,
    last_vvv_price_usd: params.vvvPriceUsd,
    last_evaluated_at: nowIso,
  };

  // ── No row yet ────────────────────────────────────────────────────────
  if (!row) {
    if (!meetsThreshold) {
      // Don't litter the table with non-holders; record nothing.
      return { eligible: false, transition: "unchanged", usdValue, inGrace: false };
    }
    const { error } = await db.from(TABLE).insert({
      user_id: params.userId,
      currently_eligible: true,
      last_breach_at: null,
      ...baseFields,
    });
    if (error) throw new Error(`Failed to insert ${TABLE} for ${params.userId}`);
    return { eligible: true, transition: "qualified", usdValue, inGrace: false };
  }

  const wasEligible = row.currently_eligible;
  const breachAt = row.last_breach_at ? new Date(row.last_breach_at) : null;

  // ── Holding is at/above threshold ─────────────────────────────────────
  if (meetsThreshold) {
    if (wasEligible && breachAt) {
      await updateRow(db, params.userId, {
        currently_eligible: true,
        last_breach_at: null,
        ...baseFields,
      });
      return { eligible: true, transition: "grace_recovered", usdValue, inGrace: false };
    }
    if (!wasEligible) {
      await updateRow(db, params.userId, {
        currently_eligible: true,
        last_breach_at: null,
        ...baseFields,
      });
      return { eligible: true, transition: "re_qualified", usdValue, inGrace: false };
    }
    // Already eligible, no breach — just refresh the snapshot fields.
    await updateRow(db, params.userId, baseFields);
    return { eligible: true, transition: "unchanged", usdValue, inGrace: false };
  }

  // ── Holding is below threshold ────────────────────────────────────────
  if (!wasEligible) {
    // Already ineligible — refresh snapshot only.
    await updateRow(db, params.userId, baseFields);
    return { eligible: false, transition: "unchanged", usdValue, inGrace: false };
  }

  if (!breachAt) {
    // Fresh breach — open the grace window, stay eligible.
    await updateRow(db, params.userId, { last_breach_at: nowIso, ...baseFields });
    return { eligible: true, transition: "breached", usdValue, inGrace: true };
  }

  const graceEndsAt = new Date(breachAt.getTime() + VENICE_BOOST_GRACE_HOURS * HOUR_MS);
  if (now >= graceEndsAt) {
    // Grace expired while still below — drop the boost.
    await updateRow(db, params.userId, {
      currently_eligible: false,
      last_breach_at: null,
      ...baseFields,
    });
    return { eligible: false, transition: "expired", usdValue, inGrace: false };
  }

  // Still in grace.
  await updateRow(db, params.userId, baseFields);
  return { eligible: true, transition: "unchanged", usdValue, inGrace: true };
}

async function updateRow(
  db: VeniceBoostDb,
  userId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const { error } = await db.from(TABLE).update(fields).eq("user_id", userId);
  if (error) throw new Error(`Failed to update ${TABLE} for ${userId}`);
}

/**
 * Single-user read of the persisted boost flag. Used by applyTierChange to
 * self-resolve the boost when a caller (Stripe webhook, "fix my caps" resize)
 * doesn't pass it explicitly. Cheap boolean read — no oracle call.
 */
export async function isVeniceBoostEligible(
  userId: string,
  db?: VeniceBoostDb | null
): Promise<boolean> {
  const client = resolveDb(db);
  if (!client) return false;
  const { data, error } = await client
    .from(TABLE)
    .select("currently_eligible")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return false;
  return Boolean((data as { currently_eligible?: boolean }).currently_eligible);
}

/**
 * Batch read of currently-eligible users. Used by the tier-refresh cron so it
 * can decide per user whether the effective spec changed without N round-trips.
 */
export async function fetchVeniceBoostEligibleUsers(
  userIds: string[],
  db?: VeniceBoostDb | null
): Promise<Set<string>> {
  const out = new Set<string>();
  const client = resolveDb(db);
  if (!client || userIds.length === 0) return out;
  const { data, error } = await client
    .from(TABLE)
    .select("user_id")
    .eq("currently_eligible", true)
    .in("user_id", userIds);
  if (error || !Array.isArray(data)) return out;
  for (const r of data as Array<{ user_id: string }>) out.add(r.user_id);
  return out;
}
