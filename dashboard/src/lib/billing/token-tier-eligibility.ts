/**
 * Eligibility evaluator for the hold-not-lock tier model.
 *
 * State machine (per BUILD_PLAN.md, locked spec 2026-04-29):
 *
 *   Inputs:
 *     - user's current $HERMESOS balance (token base units)
 *     - existing qualification row, if any
 *     - active threshold for the *current epoch* (launch vs standard)
 *
 *   Transitions:
 *
 *     a. qualified — no row yet, balance ≥ active threshold.
 *        INSERT row with qualifying_quantity = active threshold,
 *        qualifying_threshold_tier = active epoch's code.
 *
 *     b. breached — row exists, currently_eligible was true,
 *        balance dropped below qualifying_quantity. UPDATE
 *        currently_eligible = false (within grace, treat as still eligible
 *        for instance access, but flag the breach), set last_breach_at.
 *        NOTE: We do not change currently_eligible to true during grace —
 *        the cron flow is responsible for surfacing grace state to the
 *        access layer. Within the eligibility row, currently_eligible
 *        tracks the strict "balance ≥ qualifying_quantity" check.
 *
 *     c. grace_recovered — was breached but not yet suspended (last_breach_at
 *        set, last_suspend_at null, balance back ≥ qualifying_quantity).
 *        UPDATE currently_eligible = true, clear last_breach_at, do NOT
 *        bump qualifying_quantity (still grandfathered at original).
 *
 *     d. suspended — was breached, grace expired (now > last_breach_at + 48h),
 *        balance still below qualifying_quantity. Set last_suspend_at = now,
 *        cooldown_ends_at = now + 7d.
 *
 *     e. re_qualified — row exists, was suspended, cooldown has elapsed,
 *        re-qualification cap not hit, balance ≥ active threshold (the
 *        current epoch's threshold, not the original qualifying_quantity).
 *        UPDATE qualifying_quantity = active threshold,
 *        qualifying_threshold_tier = active epoch's code,
 *        clear last_breach_at / last_suspend_at / cooldown_ends_at,
 *        increment requalification_count, manage rolling 365d window.
 *
 *     f. requalification_blocked_cooldown — was suspended, cooldown still
 *        active, balance ≥ active threshold. No state change. Warning
 *        emitted so the dashboard can show "X days left in cooldown".
 *
 *     g. requalification_blocked_cap — cooldown elapsed, balance ≥ active
 *        threshold, but already re-qualified twice in the rolling 365d
 *        window. No state change. Warning emitted.
 *
 *     h. unchanged — none of the above. UPDATE only last_balance_seen and
 *        last_evaluated_at.
 *
 * The function fails-closed when thresholds are not configured: returns
 * `configured: false` with a warning, writes nothing.
 *
 * Caller is the `refresh-token-holdings` cron (or its successor). After
 * the cron writes a fresh balance snapshot, it calls this evaluator with
 * the snapshot value. Returned transitions are then dispatched to email
 * notification helpers.
 */

import { supabaseAdmin } from "@/lib/supabase";
import {
  REQUALIFICATION_CAP_PER_YEAR,
  REQUALIFICATION_COOLDOWN_DAYS,
  REQUALIFICATION_GRACE_HOURS,
  REQUALIFICATION_WINDOW_DAYS,
  bestQualifyingTier,
  getTierThresholds,
  isFoundersRateUser,
  resolveActiveThresholds,
  type ResolvedThreshold,
  type ThresholdTierCode,
  type TierKey,
  type TierThresholds,
  type TierThresholdsForEpoch,
} from "./tier-thresholds";
import { getLiveActiveThresholds } from "./live-thresholds";
import {
  consumeDepositQuote,
  getActiveDepositQuotes,
  type DepositQuote,
} from "./deposit-quotes";

export type { TierKey } from "./tier-thresholds";

export type EligibilityTransition =
  | "qualified"
  | "breached"
  | "grace_recovered"
  | "suspended"
  | "re_qualified"
  | "requalification_blocked_cooldown"
  | "requalification_blocked_cap"
  | "unchanged";

export type { ThresholdTierCode } from "./tier-thresholds";

interface TierQualificationRow {
  id: string;
  user_id: string;
  tier: TierKey;
  qualifying_quantity: string;          // numeric column → string from PostgREST
  threshold_at_qualification: string;
  qualifying_threshold_tier: ThresholdTierCode;
  qualified_at: string;
  currently_eligible: boolean;
  last_balance_seen: string | null;
  last_evaluated_at: string | null;
  last_breach_at: string | null;
  last_suspend_at: string | null;
  cooldown_ends_at: string | null;
  requalification_count: number;
  requalification_window_start: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface TierEvaluationResult {
  tier: TierKey;
  threshold: bigint;
  thresholdCode: ThresholdTierCode;
  balance: bigint;
  qualifyingQuantity: bigint | null;
  qualifyingThresholdTier: ThresholdTierCode | null;
  currentlyEligible: boolean;
  inGrace: boolean;
  cooldownEndsAt: Date | null;
  transition: EligibilityTransition;
}

export interface EligibilityResult {
  configured: boolean;
  warnings: string[];
  pro: TierEvaluationResult | null;
  power: TierEvaluationResult | null;
}

type SupabaseLike = {
  from: (name: string) => {
    select: (...args: unknown[]) => {
      eq: (
        col: string,
        val: string
      ) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => Promise<{
            data: TierQualificationRow | null;
            error: unknown;
          }>;
        };
      };
    };
    insert: (payload: Record<string, unknown>) => Promise<{ error: unknown }>;
    update: (
      payload: Record<string, unknown>
    ) => {
      eq: (
        col: string,
        val: string
      ) => Promise<{ error: unknown }>;
    };
  };
};

interface EvaluateParams {
  userId: string;
  currentBalance: bigint;
  db?: SupabaseLike | null;
  now?: Date;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// ERC-20 wallets and swaps can leave harmless sub-token dust around a
// copied whole-token quote. Keep the tolerance far below one token so
// users cannot meaningfully underpay, but a few raw units do not block
// eligibility.
const TOKEN_DUST_TOLERANCE_RAW = 10_000_000_000n; // 0.00000001 Hivra
const ONE_TOKEN_RAW = 10n ** 18n;

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function addHours(at: Date, hours: number): Date {
  return new Date(at.getTime() + hours * HOUR_MS);
}

function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

function meetsRequiredBalance(balance: bigint, required: bigint): boolean {
  const tolerance = required >= ONE_TOKEN_RAW ? TOKEN_DUST_TOLERANCE_RAW : 0n;
  return balance >= required || required - balance <= tolerance;
}

function isBelowRequiredBalance(balance: bigint, required: bigint): boolean {
  return !meetsRequiredBalance(balance, required);
}

async function loadRow(
  db: SupabaseLike,
  userId: string,
  tier: TierKey
): Promise<TierQualificationRow | null> {
  // ::text on numeric columns prevents JSON-Number precision loss in
  // PostgREST. Without it, values > 2^53 round to the nearest float
  // and BigInt(JSON.parse(...)) returns the WRONG value, silently
  // breaking >= comparisons against precise threshold bigints.
  const { data, error } = await db
    .from("token_tier_qualifications")
    .select(
      "id, user_id, tier, qualifying_quantity::text, threshold_at_qualification::text, qualifying_threshold_tier, qualified_at, currently_eligible, last_balance_seen::text, last_evaluated_at, last_breach_at, last_suspend_at, cooldown_ends_at, requalification_count, requalification_window_start, metadata, created_at, updated_at"
    )
    .eq("user_id", userId)
    .eq("tier", tier)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to read token_tier_qualifications for ${userId}/${tier}`
    );
  }
  return data;
}

/**
 * Decide what re-qualification window the user is in, and whether the cap
 * is hit. Returns the values to write back if a re-qualification proceeds.
 */
function nextRequalificationWindow(
  row: TierQualificationRow,
  now: Date
): {
  capReached: boolean;
  nextCount: number;
  nextWindowStart: string;
} {
  const windowStart = row.requalification_window_start
    ? new Date(row.requalification_window_start)
    : null;
  const windowEnd = windowStart
    ? addDays(windowStart, REQUALIFICATION_WINDOW_DAYS)
    : null;

  // No window yet → this would be the first re-qualification.
  if (!windowStart || !windowEnd) {
    return {
      capReached: false,
      nextCount: 1,
      nextWindowStart: now.toISOString(),
    };
  }

  // Window has rolled over → reset count.
  if (now >= windowEnd) {
    return {
      capReached: false,
      nextCount: 1,
      nextWindowStart: now.toISOString(),
    };
  }

  // Inside an active window. Check the cap.
  if (row.requalification_count >= REQUALIFICATION_CAP_PER_YEAR) {
    return {
      capReached: true,
      nextCount: row.requalification_count,
      nextWindowStart: row.requalification_window_start ?? now.toISOString(),
    };
  }

  return {
    capReached: false,
    nextCount: row.requalification_count + 1,
    nextWindowStart: row.requalification_window_start ?? now.toISOString(),
  };
}

interface EvaluateTierContext {
  db: SupabaseLike;
  userId: string;
  active: ResolvedThreshold;
  balance: bigint;
  now: Date;
  warnings: string[];
}

async function evaluateTier(
  ctx: EvaluateTierContext
): Promise<TierEvaluationResult> {
  const { db, userId, active, balance, now, warnings } = ctx;
  const tier = active.tier;
  const thresholdCode = active.code;
  const row = await loadRow(db, userId, tier);
  const nowStamp = nowIso(now);

  // Quote-aware threshold resolution.
  //
  // If the user has an active deposit quote for this tier, the
  // qualifying quantity is the quote's tokens_required (the locked-in
  // rate), NOT the constants module's threshold. Quotes are minted
  // when the user clicks "Get quote" and lock for 20 minutes.
  //
  // The constants threshold remains the fallback for the legacy
  // path where no quote exists — e.g. someone deposited via direct
  // on-chain transfer without ever touching the dashboard.
  let activeQuote: DepositQuote | null = null;
  try {
    const quotes = await getActiveDepositQuotes({ userId, tier, now });
    activeQuote = quotes[0] ?? null;
  } catch (quoteErr) {
    warnings.push(
      `Could not load deposit quotes for ${userId}/${tier}: ${
        quoteErr instanceof Error ? quoteErr.message : String(quoteErr)
      }`
    );
  }

  const threshold = activeQuote ? activeQuote.tokensRequiredRaw : active.amount;

  // Diagnostic: log the comparison so we can see exactly what bigints
  // the evaluator is working with on preview/prod. Gated on non-test.
  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.log(
      `[evaluateTier] user=${userId} tier=${tier} balance=${balance.toString()} threshold=${threshold.toString()} quoteId=${activeQuote?.id ?? "none"} hasRow=${Boolean(row)} cmp(balance>=threshold)=${balance >= threshold} meetsRequired=${meetsRequiredBalance(balance, threshold)}`
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Case (a) — first-time qualification: no row yet.
  // ──────────────────────────────────────────────────────────────────
  if (!row) {
    if (meetsRequiredBalance(balance, threshold)) {
      const { error } = await db.from("token_tier_qualifications").insert({
        user_id: userId,
        tier,
        qualifying_quantity: threshold.toString(),
        threshold_at_qualification: threshold.toString(),
        qualifying_threshold_tier: thresholdCode,
        qualified_at: nowStamp,
        currently_eligible: true,
        last_balance_seen: balance.toString(),
        last_evaluated_at: nowStamp,
        metadata: activeQuote
          ? {
              consumed_quote_id: activeQuote.id,
              quote_price_usd: activeQuote.priceUsdAtQuote,
              quote_usd_cents: activeQuote.usdTargetCents,
            }
          : {},
      });
      if (error) {
        throw new Error(`Failed to insert qualification row for ${userId}/${tier}`);
      }
      // Mark the quote consumed so subsequent ticks don't re-fire.
      if (activeQuote) {
        try {
          await consumeDepositQuote({
            quoteId: activeQuote.id,
            consumedBalanceRaw: balance,
            now,
          });
        } catch (consumeErr) {
          warnings.push(
            `Qualification recorded but quote ${activeQuote.id} could not be marked consumed: ${
              consumeErr instanceof Error ? consumeErr.message : String(consumeErr)
            }`
          );
        }
      }
      return {
        tier,
        threshold,
        thresholdCode,
        balance,
        qualifyingQuantity: threshold,
        qualifyingThresholdTier: thresholdCode,
        currentlyEligible: true,
        inGrace: false,
        cooldownEndsAt: null,
        transition: "qualified",
      };
    }
    // No row, balance below threshold — nothing to record.
    return {
      tier,
      threshold,
      thresholdCode,
      balance,
      qualifyingQuantity: null,
      qualifyingThresholdTier: null,
      currentlyEligible: false,
      inGrace: false,
      cooldownEndsAt: null,
      transition: "unchanged",
    };
  }

  // Existing row → derive state.
  const qualifyingQuantity = BigInt(row.qualifying_quantity);
  const qualifyingThresholdTier = row.qualifying_threshold_tier;
  const wasStrictlyEligible = row.currently_eligible;
  const breachAt = row.last_breach_at ? new Date(row.last_breach_at) : null;
  const suspendAt = row.last_suspend_at ? new Date(row.last_suspend_at) : null;
  const cooldownEndsAt = row.cooldown_ends_at
    ? new Date(row.cooldown_ends_at)
    : null;

  // ──────────────────────────────────────────────────────────────────
  // Case (e/f/g) — currently suspended branch.
  // ──────────────────────────────────────────────────────────────────
  if (suspendAt) {
    const cooldownActive = cooldownEndsAt !== null && now < cooldownEndsAt;

    // Still strictly below threshold — nothing to do.
    if (isBelowRequiredBalance(balance, threshold)) {
      const { error } = await db
        .from("token_tier_qualifications")
        .update({
          last_balance_seen: balance.toString(),
          last_evaluated_at: nowStamp,
        })
        .eq("id", row.id);
      if (error) {
        throw new Error(`Failed to update suspended row for ${userId}/${tier}`);
      }
      return {
        tier,
        threshold,
        thresholdCode,
        balance,
        qualifyingQuantity,
        qualifyingThresholdTier,
        currentlyEligible: false,
        inGrace: false,
        cooldownEndsAt,
        transition: "unchanged",
      };
    }

    // Balance is back above the active threshold. Either:
    //   - cooldown still active → block (transition: requalification_blocked_cooldown)
    //   - cap hit → block (transition: requalification_blocked_cap)
    //   - otherwise → re-qualify
    if (cooldownActive) {
      warnings.push(
        `User ${userId} (${tier}) re-qualification blocked: cooldown ends at ` +
          `${cooldownEndsAt!.toISOString()}.`
      );
      const { error } = await db
        .from("token_tier_qualifications")
        .update({
          last_balance_seen: balance.toString(),
          last_evaluated_at: nowStamp,
        })
        .eq("id", row.id);
      if (error) {
        throw new Error(`Failed to update cooldown-blocked row for ${userId}/${tier}`);
      }
      return {
        tier,
        threshold,
        thresholdCode,
        balance,
        qualifyingQuantity,
        qualifyingThresholdTier,
        currentlyEligible: false,
        inGrace: false,
        cooldownEndsAt,
        transition: "requalification_blocked_cooldown",
      };
    }

    const window = nextRequalificationWindow(row, now);
    if (window.capReached) {
      warnings.push(
        `User ${userId} (${tier}) re-qualification blocked: cap of ` +
          `${REQUALIFICATION_CAP_PER_YEAR} per ${REQUALIFICATION_WINDOW_DAYS}d ` +
          `reached.`
      );
      const { error } = await db
        .from("token_tier_qualifications")
        .update({
          last_balance_seen: balance.toString(),
          last_evaluated_at: nowStamp,
        })
        .eq("id", row.id);
      if (error) {
        throw new Error(`Failed to update cap-blocked row for ${userId}/${tier}`);
      }
      return {
        tier,
        threshold,
        thresholdCode,
        balance,
        qualifyingQuantity,
        qualifyingThresholdTier,
        currentlyEligible: false,
        inGrace: false,
        cooldownEndsAt,
        transition: "requalification_blocked_cap",
      };
    }

    // Re-qualify at the *current* epoch's threshold and code (lose launch
    // grandfathering if applicable).
    const { error } = await db
      .from("token_tier_qualifications")
      .update({
        qualifying_quantity: threshold.toString(),
        threshold_at_qualification: threshold.toString(),
        qualifying_threshold_tier: thresholdCode,
        qualified_at: nowStamp,
        currently_eligible: true,
        last_balance_seen: balance.toString(),
        last_evaluated_at: nowStamp,
        last_breach_at: null,
        last_suspend_at: null,
        cooldown_ends_at: null,
        requalification_count: window.nextCount,
        requalification_window_start: window.nextWindowStart,
      })
      .eq("id", row.id);
    if (error) {
      throw new Error(`Failed to re-qualify ${userId}/${tier}`);
    }
    return {
      tier,
      threshold,
      thresholdCode,
      balance,
      qualifyingQuantity: threshold,
      qualifyingThresholdTier: thresholdCode,
      currentlyEligible: true,
      inGrace: false,
      cooldownEndsAt: null,
      transition: "re_qualified",
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Mid-grace branches: row has last_breach_at but no last_suspend_at.
  // ──────────────────────────────────────────────────────────────────
  if (breachAt && !suspendAt) {
    const graceEndsAt = addHours(breachAt, REQUALIFICATION_GRACE_HOURS);

    // (c) grace recovery: balance returned to ≥ qualifying_quantity.
    if (meetsRequiredBalance(balance, qualifyingQuantity)) {
      const { error } = await db
        .from("token_tier_qualifications")
        .update({
          currently_eligible: true,
          last_balance_seen: balance.toString(),
          last_evaluated_at: nowStamp,
          last_breach_at: null,
        })
        .eq("id", row.id);
      if (error) {
        throw new Error(`Failed to record grace recovery for ${userId}/${tier}`);
      }
      return {
        tier,
        threshold,
        thresholdCode,
        balance,
        qualifyingQuantity,
        qualifyingThresholdTier,
        currentlyEligible: true,
        inGrace: false,
        cooldownEndsAt: null,
        transition: "grace_recovered",
      };
    }

    // (d) grace expired without recovery → suspend.
    if (now >= graceEndsAt) {
      const cooldownEnd = addDays(now, REQUALIFICATION_COOLDOWN_DAYS);
      const { error } = await db
        .from("token_tier_qualifications")
        .update({
          last_suspend_at: nowStamp,
          cooldown_ends_at: cooldownEnd.toISOString(),
          last_balance_seen: balance.toString(),
          last_evaluated_at: nowStamp,
          currently_eligible: false,
        })
        .eq("id", row.id);
      if (error) {
        throw new Error(`Failed to suspend ${userId}/${tier}`);
      }
      return {
        tier,
        threshold,
        thresholdCode,
        balance,
        qualifyingQuantity,
        qualifyingThresholdTier,
        currentlyEligible: false,
        inGrace: false,
        cooldownEndsAt: cooldownEnd,
        transition: "suspended",
      };
    }

    // Still in grace, balance still below qualifying_quantity → unchanged
    // (the access-layer caller may treat this as "still has access" until
    // suspend, but the eligibility row already records the breach).
    const { error } = await db
      .from("token_tier_qualifications")
      .update({
        last_balance_seen: balance.toString(),
        last_evaluated_at: nowStamp,
      })
      .eq("id", row.id);
    if (error) {
      throw new Error(`Failed to update grace-pending row for ${userId}/${tier}`);
    }
    return {
      tier,
      threshold,
      thresholdCode,
      balance,
      qualifyingQuantity,
      qualifyingThresholdTier,
      currentlyEligible: false,
      inGrace: true,
      cooldownEndsAt: null,
      transition: "unchanged",
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Case (b) — fresh breach: was strictly eligible, now below qualifying.
  // ──────────────────────────────────────────────────────────────────
  if (wasStrictlyEligible && isBelowRequiredBalance(balance, qualifyingQuantity)) {
    const { error } = await db
      .from("token_tier_qualifications")
      .update({
        currently_eligible: false,
        last_balance_seen: balance.toString(),
        last_evaluated_at: nowStamp,
        last_breach_at: nowStamp,
      })
      .eq("id", row.id);
    if (error) {
      throw new Error(`Failed to mark breach for ${userId}/${tier}`);
    }
    return {
      tier,
      threshold,
      thresholdCode,
      balance,
      qualifyingQuantity,
      qualifyingThresholdTier,
      currentlyEligible: false,
      inGrace: true,
      cooldownEndsAt: null,
      transition: "breached",
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Case (h) — no-op: just refresh last_balance_seen + last_evaluated_at.
  // ──────────────────────────────────────────────────────────────────

  // Self-heal the orphaned-quote race: first-time qualification (Case a)
  // inserts the row and THEN consumes the deposit quote as two non-atomic
  // writes, so a consume failure / crash leaves the quote 'active' forever
  // (the row already exists, so Case a never re-runs). Reconcile it here.
  // Safe because: (1) we only touch a quote when the user is CURRENTLY
  // ELIGIBLE — a still-eligible holder's active quote is orphaned/redundant,
  // never one a suspended user still needs to re-qualify against (those land
  // in the suspend/grace branches above, not here); (2) consumeDepositQuote
  // is idempotent (only flips status 'active'→'consumed'). Best-effort — a
  // reconcile failure must not derail the eligibility tick.
  if (wasStrictlyEligible && activeQuote) {
    try {
      await consumeDepositQuote({
        quoteId: activeQuote.id,
        consumedBalanceRaw: balance,
        now,
      });
    } catch (consumeErr) {
      warnings.push(
        `Could not reconcile orphaned deposit quote ${activeQuote.id} for ` +
          `${userId}/${tier}: ${
            consumeErr instanceof Error ? consumeErr.message : String(consumeErr)
          }`
      );
    }
  }

  const { error } = await db
    .from("token_tier_qualifications")
    .update({
      last_balance_seen: balance.toString(),
      last_evaluated_at: nowStamp,
    })
    .eq("id", row.id);
  if (error) {
    throw new Error(`Failed to update last_balance for ${userId}/${tier}`);
  }
  return {
    tier,
    threshold,
    thresholdCode,
    balance,
    qualifyingQuantity,
    qualifyingThresholdTier,
    currentlyEligible: wasStrictlyEligible,
    inGrace: false,
    cooldownEndsAt: null,
    transition: "unchanged",
  };
}

/**
 * Evaluate a user's $HERMESOS balance against the configured tier thresholds
 * and persist any transitions to `token_tier_qualifications`.
 *
 * Fails-closed when thresholds are not configured: returns `configured: false`
 * with a warning, writes nothing. Caller decides how to surface that to ops.
 */
export async function evaluateAndRecordTokenTierEligibility(
  params: EvaluateParams
): Promise<EligibilityResult> {
  const warnings: string[] = [];
  const now = params.now ?? new Date();

  // Live-priced thresholds with in-process cache (5 min) and a stale-
  // cache window (60 min) for transient CoinGecko hiccups. If both
  // live and cached price are unavailable we INTENTIONALLY skip the
  // evaluation rather than fall back to a stale static threshold —
  // existing holders are unaffected because their qualifying_quantity
  // is already snapshotted on the row. The next cron run picks up
  // when the price feed recovers.
  let active: TierThresholdsForEpoch;
  try {
    // Allowlisted founders are pinned to the launch epoch past the global
    // promo window, so they qualify against (and snapshot) the cheaper
    // launch threshold. No-op for everyone else.
    const live = await getLiveActiveThresholds({
      now,
      forceLaunchEpoch: isFoundersRateUser(params.userId),
    });
    active = {
      epoch: live.epoch,
      promoEndsAt: live.promoEndsAt,
      pro: live.pro,
      power: live.power,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`Live $HERMESOS price unavailable; skipping evaluation: ${reason}`);
    return { configured: false, warnings, pro: null, power: null };
  }

  const db = (params.db ?? (supabaseAdmin as unknown)) as SupabaseLike | null;
  if (!db) {
    warnings.push("Supabase admin client unavailable; eligibility not recorded.");
    return { configured: true, warnings, pro: null, power: null };
  }

  // Evaluate Pro and Power independently. A user can be eligible for Pro
  // (qualifying_quantity recorded) and not eligible for Power.
  const [pro, power] = await Promise.all([
    evaluateTier({
      db,
      userId: params.userId,
      active: active.pro,
      balance: params.currentBalance,
      now,
      warnings,
    }),
    evaluateTier({
      db,
      userId: params.userId,
      active: active.power,
      balance: params.currentBalance,
      now,
      warnings,
    }),
  ]);

  return { configured: true, warnings, pro, power };
}
