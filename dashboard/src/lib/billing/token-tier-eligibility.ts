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
 * Platform tokens. Each row is held in ONE token (token_key): $HermesOS or
 * $HIVRA. Rows compare against the balance of their own token. New rows are
 * written in a token the user may hold (token-access.ts): $HermesOS before
 * $HIVRA is active and for the grandfather cohort, $HIVRA otherwise. A
 * converted member's $HermesOS rows count either token during the conversion
 * grace (the $HIVRA side against the threshold locked at conversion) and then
 * move to $HIVRA at the then-current threshold.
 *
 * Live prices. Only steps that need a NEW threshold read a live price: a
 * first qualification without a deposit quote, a re-qualification after
 * suspension, and moving a row to $HIVRA. Breach, grace, recovery and suspend
 * compare balances with the row's fixed qualifying_quantity and run whether
 * or not the price feed is up. When a price is missing, the steps that need it
 * are skipped for that tick with a warning.
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
  isFoundersRateUser,
  type ResolvedThreshold,
  type ThresholdTierCode,
  type TierKey,
} from "./tier-thresholds";
import { getLiveActiveThresholds, type LiveTierThresholds } from "./live-thresholds";
import {
  consumeDepositQuote,
  getActiveDepositQuotes,
  type DepositQuote,
} from "./deposit-quotes";
import { platformTokenByKey, type PlatformTokenKey } from "./token-registry";
import {
  conversionDue,
  resolveUserTokenAccess,
  tierRowTokenCounts,
  type TokenAccessDb,
  type UserTokenAccess,
} from "./token-access";

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

/** Balances per platform token, in raw units. A missing token was not read. */
export type PlatformTokenBalances = Partial<Record<PlatformTokenKey, bigint>>;

interface TierQualificationRow {
  id: string;
  user_id: string;
  tier: TierKey;
  token_key?: PlatformTokenKey | null;
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
  /** Token the tier is held in after this evaluation; null when none. */
  tokenKey: PlatformTokenKey | null;
  /** Current threshold for a NEW qualification, when one could be resolved. */
  threshold: bigint | null;
  thresholdCode: ThresholdTierCode | null;
  balance: bigint;
  qualifyingQuantity: bigint | null;
  qualifyingThresholdTier: ThresholdTierCode | null;
  currentlyEligible: boolean;
  inGrace: boolean;
  cooldownEndsAt: Date | null;
  transition: EligibilityTransition;
  /** Set when this evaluation moved a $HermesOS row to $HIVRA. */
  movedToHivra?: boolean;
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
  /** $HermesOS balance. Kept for callers that only read $HermesOS. */
  currentBalance?: bigint;
  /** Balance per platform token; takes precedence over currentBalance. */
  balances?: PlatformTokenBalances;
  /** Token access, when the caller already resolved it (crons). */
  access?: UserTokenAccess;
  db?: SupabaseLike | null;
  now?: Date;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// ERC-20 wallets and swaps can leave harmless sub-token dust around a
// copied whole-token quote. Keep the tolerance far below one token so
// users cannot meaningfully underpay, but a few raw units do not block
// eligibility. Both platform tokens have 18 decimals.
const TOKEN_DUST_TOLERANCE_RAW = 10_000_000_000n; // 0.00000001 token
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

function rowTokenKey(row: TierQualificationRow): PlatformTokenKey {
  return row.token_key === "hivra" ? "hivra" : "hermesos";
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
      "id, user_id, tier, token_key, qualifying_quantity::text, threshold_at_qualification::text, qualifying_threshold_tier, qualified_at, currently_eligible, last_balance_seen::text, last_evaluated_at, last_breach_at, last_suspend_at, cooldown_ends_at, requalification_count, requalification_window_start, metadata, created_at, updated_at"
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

type ThresholdLookup = (token: PlatformTokenKey) => Promise<ResolvedThreshold | null>;

interface EvaluateTierContext {
  db: SupabaseLike;
  userId: string;
  tier: TierKey;
  access: UserTokenAccess;
  balances: PlatformTokenBalances;
  thresholdFor: ThresholdLookup;
  now: Date;
  warnings: string[];
}

async function updateRow(
  db: SupabaseLike,
  row: TierQualificationRow,
  payload: Record<string, unknown>,
  failure: string
) {
  const { error } = await db.from("token_tier_qualifications").update(payload).eq("id", row.id);
  if (error) throw new Error(`${failure} for ${row.user_id}/${row.tier}`);
}

async function loadActiveQuote(ctx: EvaluateTierContext): Promise<DepositQuote | null> {
  // Quote-aware threshold resolution.
  //
  // If the user has an active deposit quote for this tier, the
  // qualifying quantity is the quote's tokens_required (the locked-in
  // rate) in the quote's token, NOT the live threshold. Quotes are minted
  // when the user clicks "Get quote" and lock for 20 minutes.
  try {
    const quotes = await getActiveDepositQuotes({ userId: ctx.userId, tier: ctx.tier, now: ctx.now });
    return quotes[0] ?? null;
  } catch (quoteErr) {
    ctx.warnings.push(
      `Could not load deposit quotes for ${ctx.userId}/${ctx.tier}: ${
        quoteErr instanceof Error ? quoteErr.message : String(quoteErr)
      }`
    );
    return null;
  }
}

function quoteTokenKey(quote: DepositQuote): PlatformTokenKey {
  return quote.tokenKey === "hivra" ? "hivra" : "hermesos";
}

async function consumeQuoteQuietly(
  ctx: EvaluateTierContext,
  quote: DepositQuote,
  balance: bigint,
  what: string
) {
  try {
    await consumeDepositQuote({ quoteId: quote.id, consumedBalanceRaw: balance, now: ctx.now });
  } catch (consumeErr) {
    ctx.warnings.push(
      `${what} ${quote.id}: ${consumeErr instanceof Error ? consumeErr.message : String(consumeErr)}`
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// Case (a) — first-time qualification: no row yet.
// ──────────────────────────────────────────────────────────────────────
async function evaluateFirstQualification(
  ctx: EvaluateTierContext,
  activeQuote: DepositQuote | null
): Promise<TierEvaluationResult> {
  const { db, userId, tier, access, balances, now, warnings } = ctx;
  const nowStamp = nowIso(now);

  type Candidate = { token: PlatformTokenKey; amount: bigint; code: ThresholdTierCode; quote: DepositQuote | null };
  const candidates: Candidate[] = [];
  if (activeQuote) {
    const token = quoteTokenKey(activeQuote);
    if (access.qualifyTokens.includes(token)) {
      candidates.push({ token, amount: activeQuote.tokensRequiredRaw, code: activeQuote.thresholdTierCode, quote: activeQuote });
    } else {
      warnings.push(
        `Ignoring deposit quote ${activeQuote.id} for ${userId}/${tier}: ${token} is not a token this user can qualify in.`
      );
    }
  }
  if (candidates.length === 0) {
    for (const token of access.qualifyTokens) {
      const active = await ctx.thresholdFor(token);
      if (active) candidates.push({ token, amount: active.amount, code: active.code, quote: null });
    }
  }

  for (const candidate of candidates) {
    const balance = balances[candidate.token];
    if (balance === undefined || !meetsRequiredBalance(balance, candidate.amount)) continue;
    const { error } = await db.from("token_tier_qualifications").insert({
      user_id: userId,
      tier,
      token_key: candidate.token,
      qualifying_quantity: candidate.amount.toString(),
      threshold_at_qualification: candidate.amount.toString(),
      qualifying_threshold_tier: candidate.code,
      qualified_at: nowStamp,
      currently_eligible: true,
      last_balance_seen: balance.toString(),
      last_evaluated_at: nowStamp,
      metadata: candidate.quote
        ? {
            consumed_quote_id: candidate.quote.id,
            quote_price_usd: candidate.quote.priceUsdAtQuote,
            quote_usd_cents: candidate.quote.usdTargetCents,
          }
        : {},
    });
    if (error) {
      throw new Error(`Failed to insert qualification row for ${userId}/${tier}`);
    }
    // Mark the quote consumed so subsequent ticks don't re-fire.
    if (candidate.quote) {
      await consumeQuoteQuietly(ctx, candidate.quote, balance, "Qualification recorded but quote could not be marked consumed:");
    }
    return {
      tier,
      tokenKey: candidate.token,
      threshold: candidate.amount,
      thresholdCode: candidate.code,
      balance,
      qualifyingQuantity: candidate.amount,
      qualifyingThresholdTier: candidate.code,
      currentlyEligible: true,
      inGrace: false,
      cooldownEndsAt: null,
      transition: "qualified",
    };
  }

  // No row, balance below every threshold (or no threshold) — nothing to record.
  const shown = candidates[0] ?? null;
  return {
    tier,
    tokenKey: null,
    threshold: shown?.amount ?? null,
    thresholdCode: shown?.code ?? null,
    balance: balances[shown?.token ?? access.qualifyTokens[0]] ?? 0n,
    qualifyingQuantity: null,
    qualifyingThresholdTier: null,
    currentlyEligible: false,
    inGrace: false,
    cooldownEndsAt: null,
    transition: "unchanged",
  };
}

/**
 * Move a $HermesOS row to $HIVRA at the current $HIVRA threshold: after a
 * converted member's grace, or for a $HermesOS row that no longer counts. A
 * row that was eligible or in grace becomes eligible in $HIVRA, so the normal
 * flow either keeps it (enough $HIVRA) or opens a fresh breach grace: never an
 * immediate loss. A suspended row stays suspended and re-qualifies in $HIVRA.
 */
async function moveRowToHivra(
  ctx: EvaluateTierContext,
  row: TierQualificationRow,
  threshold: ResolvedThreshold
): Promise<TierQualificationRow> {
  const nowStamp = nowIso(ctx.now);
  const suspended = !!row.last_suspend_at;
  const payload: Record<string, unknown> = {
    token_key: "hivra",
    qualifying_quantity: threshold.amount.toString(),
    threshold_at_qualification: threshold.amount.toString(),
    qualifying_threshold_tier: threshold.code,
    qualified_at: nowStamp,
    metadata: {
      ...(row.metadata ?? {}),
      moved_from_hermesos: {
        at: nowStamp,
        qualifying_quantity: row.qualifying_quantity,
        qualifying_threshold_tier: row.qualifying_threshold_tier,
        qualified_at: row.qualified_at,
      },
    },
    ...(suspended ? {} : { currently_eligible: true, last_breach_at: null }),
  };
  await updateRow(ctx.db, row, payload, "Failed to move the tier to $HIVRA");
  return {
    ...row,
    ...(payload as Partial<TierQualificationRow>),
    token_key: "hivra",
    qualifying_quantity: threshold.amount.toString(),
    threshold_at_qualification: threshold.amount.toString(),
  };
}

async function evaluateTier(ctx: EvaluateTierContext): Promise<TierEvaluationResult> {
  const { db, userId, tier, access, balances, now, warnings } = ctx;
  let row = await loadRow(db, userId, tier);
  const activeQuote = await loadActiveQuote(ctx);

  if (!row) return evaluateFirstQualification(ctx, activeQuote);

  let tokenKey = rowTokenKey(row);
  let movedToHivra = false;

  // A $HermesOS row whose owner converted and whose grace is over, or that
  // no longer counts for this user, moves to $HIVRA at today's threshold.
  if (
    tokenKey === "hermesos" &&
    access.phase === "active" &&
    (conversionDue(access, now) || !tierRowTokenCounts(access, "hermesos"))
  ) {
    const hivraThreshold = await ctx.thresholdFor("hivra");
    if (hivraThreshold) {
      row = await moveRowToHivra(ctx, row, hivraThreshold);
      tokenKey = "hivra";
      movedToHivra = true;
    } else {
      warnings.push(
        `User ${userId} (${tier}) is due to move to $HIVRA but no live $HIVRA price is available; retrying next tick.`
      );
    }
  }

  const rowBalance = balances[tokenKey];
  if (rowBalance === undefined) {
    // Never judge a row on a balance that was not read this tick.
    warnings.push(`No ${tokenKey} balance for ${userId}/${tier}; row left unchanged.`);
    return {
      tier,
      tokenKey,
      threshold: null,
      thresholdCode: null,
      balance: 0n,
      qualifyingQuantity: BigInt(row.qualifying_quantity),
      qualifyingThresholdTier: row.qualifying_threshold_tier,
      currentlyEligible: row.currently_eligible,
      inGrace: !!row.last_breach_at && !row.last_suspend_at,
      cooldownEndsAt: row.cooldown_ends_at ? new Date(row.cooldown_ends_at) : null,
      transition: "unchanged",
      movedToHivra,
    };
  }

  // Conversion grace: a converted member's $HermesOS row counts either token.
  const lockedHivra = access.conversionThresholds[tier];
  const eitherToken =
    tokenKey === "hermesos" && access.phase === "active" && !!access.convertedAt && !!lockedHivra;
  const hivraBalance = balances.hivra;
  const meetsWithEither = (required: bigint) =>
    meetsRequiredBalance(rowBalance, required) ||
    (eitherToken && hivraBalance !== undefined && meetsRequiredBalance(hivraBalance, lockedHivra!.amount));

  const qualifyingQuantity = BigInt(row.qualifying_quantity);
  const qualifyingThresholdTier = row.qualifying_threshold_tier;
  const wasStrictlyEligible = row.currently_eligible;
  const breachAt = row.last_breach_at ? new Date(row.last_breach_at) : null;
  const suspendAt = row.last_suspend_at ? new Date(row.last_suspend_at) : null;
  const cooldownEndsAt = row.cooldown_ends_at
    ? new Date(row.cooldown_ends_at)
    : null;
  const nowStamp = nowIso(now);
  const base = { tier, tokenKey, balance: rowBalance, movedToHivra };

  // Only re-qualification needs the current threshold (a quote in the row's
  // token, else the live threshold). Resolved lazily.
  const resolveRequalification = async (): Promise<{ amount: bigint; code: ThresholdTierCode } | null> => {
    if (activeQuote && quoteTokenKey(activeQuote) === tokenKey) {
      return { amount: activeQuote.tokensRequiredRaw, code: activeQuote.thresholdTierCode };
    }
    const active = await ctx.thresholdFor(tokenKey);
    return active ? { amount: active.amount, code: active.code } : null;
  };

  // Diagnostic: gated on non-test.
  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.log(
      `[evaluateTier] user=${userId} tier=${tier} token=${tokenKey} balance=${rowBalance.toString()} qualifying=${qualifyingQuantity.toString()} quoteId=${activeQuote?.id ?? "none"} eitherToken=${eitherToken}`
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Case (e/f/g) — currently suspended branch.
  // ──────────────────────────────────────────────────────────────────
  if (suspendAt) {
    const cooldownActive = cooldownEndsAt !== null && now < cooldownEndsAt;
    const requal = await resolveRequalification();
    const touch = { last_balance_seen: rowBalance.toString(), last_evaluated_at: nowStamp };
    const suspendedResult = {
      ...base,
      threshold: requal?.amount ?? null,
      thresholdCode: requal?.code ?? null,
      qualifyingQuantity,
      qualifyingThresholdTier,
      currentlyEligible: false,
      inGrace: false,
      cooldownEndsAt,
    };

    if (!requal) {
      warnings.push(
        `User ${userId} (${tier}) re-qualification skipped: no live ${tokenKey} price.`
      );
      await updateRow(db, row, touch, "Failed to update suspended row");
      return { ...suspendedResult, transition: "unchanged" };
    }

    // Still strictly below threshold — nothing to do.
    if (!meetsRequiredBalance(rowBalance, requal.amount)) {
      await updateRow(db, row, touch, "Failed to update suspended row");
      return { ...suspendedResult, transition: "unchanged" };
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
      await updateRow(db, row, touch, "Failed to update cooldown-blocked row");
      return { ...suspendedResult, transition: "requalification_blocked_cooldown" };
    }

    const window = nextRequalificationWindow(row, now);
    if (window.capReached) {
      warnings.push(
        `User ${userId} (${tier}) re-qualification blocked: cap of ` +
          `${REQUALIFICATION_CAP_PER_YEAR} per ${REQUALIFICATION_WINDOW_DAYS}d ` +
          `reached.`
      );
      await updateRow(db, row, touch, "Failed to update cap-blocked row");
      return { ...suspendedResult, transition: "requalification_blocked_cap" };
    }

    // Re-qualify at the *current* epoch's threshold and code (lose launch
    // grandfathering if applicable).
    await updateRow(
      db,
      row,
      {
        qualifying_quantity: requal.amount.toString(),
        threshold_at_qualification: requal.amount.toString(),
        qualifying_threshold_tier: requal.code,
        qualified_at: nowStamp,
        currently_eligible: true,
        last_balance_seen: rowBalance.toString(),
        last_evaluated_at: nowStamp,
        last_breach_at: null,
        last_suspend_at: null,
        cooldown_ends_at: null,
        requalification_count: window.nextCount,
        requalification_window_start: window.nextWindowStart,
      },
      "Failed to re-qualify"
    );
    if (activeQuote && quoteTokenKey(activeQuote) === tokenKey) {
      await consumeQuoteQuietly(ctx, activeQuote, rowBalance, "Re-qualified but quote could not be marked consumed:");
    }
    return {
      ...base,
      threshold: requal.amount,
      thresholdCode: requal.code,
      qualifyingQuantity: requal.amount,
      qualifyingThresholdTier: requal.code,
      currentlyEligible: true,
      inGrace: false,
      cooldownEndsAt: null,
      transition: "re_qualified",
    };
  }

  // The current threshold is informational for a held row (the UI and emails
  // quote it as "re-qualify at"); the state machine below never needs it, so
  // a price outage only blanks it.
  const current = await ctx.thresholdFor(tokenKey);
  const heldResult = {
    ...base,
    threshold: current?.amount ?? null,
    thresholdCode: current?.code ?? null,
    qualifyingQuantity,
    qualifyingThresholdTier,
  };

  // ──────────────────────────────────────────────────────────────────
  // Mid-grace branches: row has last_breach_at but no last_suspend_at.
  // ──────────────────────────────────────────────────────────────────
  if (breachAt && !suspendAt) {
    const graceEndsAt = addHours(breachAt, REQUALIFICATION_GRACE_HOURS);

    // (c) grace recovery: balance returned to ≥ qualifying_quantity.
    if (meetsWithEither(qualifyingQuantity)) {
      await updateRow(
        db,
        row,
        {
          currently_eligible: true,
          last_balance_seen: rowBalance.toString(),
          last_evaluated_at: nowStamp,
          last_breach_at: null,
        },
        "Failed to record grace recovery"
      );
      return {
        ...heldResult,
        currentlyEligible: true,
        inGrace: false,
        cooldownEndsAt: null,
        transition: "grace_recovered",
      };
    }

    // (d) grace expired without recovery → suspend.
    if (now >= graceEndsAt) {
      const cooldownEnd = addDays(now, REQUALIFICATION_COOLDOWN_DAYS);
      await updateRow(
        db,
        row,
        {
          last_suspend_at: nowStamp,
          cooldown_ends_at: cooldownEnd.toISOString(),
          last_balance_seen: rowBalance.toString(),
          last_evaluated_at: nowStamp,
          currently_eligible: false,
        },
        "Failed to suspend"
      );
      return {
        ...heldResult,
        currentlyEligible: false,
        inGrace: false,
        cooldownEndsAt: cooldownEnd,
        transition: "suspended",
      };
    }

    // Still in grace, balance still below qualifying_quantity → unchanged
    // (the access-layer caller may treat this as "still has access" until
    // suspend, but the eligibility row already records the breach).
    await updateRow(
      db,
      row,
      { last_balance_seen: rowBalance.toString(), last_evaluated_at: nowStamp },
      "Failed to update grace-pending row"
    );
    return {
      ...heldResult,
      currentlyEligible: false,
      inGrace: true,
      cooldownEndsAt: null,
      transition: "unchanged",
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Case (b) — fresh breach: was strictly eligible, now below qualifying.
  // ──────────────────────────────────────────────────────────────────
  if (wasStrictlyEligible && !meetsWithEither(qualifyingQuantity)) {
    await updateRow(
      db,
      row,
      {
        currently_eligible: false,
        last_balance_seen: rowBalance.toString(),
        last_evaluated_at: nowStamp,
        last_breach_at: nowStamp,
      },
      "Failed to mark breach"
    );
    return {
      ...heldResult,
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
    await consumeQuoteQuietly(
      ctx,
      activeQuote,
      rowBalance,
      `Could not reconcile orphaned deposit quote for ${userId}/${tier}:`
    );
  }

  await updateRow(
    db,
    row,
    { last_balance_seen: rowBalance.toString(), last_evaluated_at: nowStamp },
    "Failed to update last_balance"
  );
  return {
    ...heldResult,
    currentlyEligible: wasStrictlyEligible,
    inGrace: false,
    cooldownEndsAt: null,
    transition: movedToHivra ? "re_qualified" : "unchanged",
  };
}

/**
 * Evaluate a user's platform-token balances against the tier thresholds and
 * persist any transitions to `token_tier_qualifications`.
 *
 * Live thresholds are resolved per token, lazily and once per call. A price
 * outage only skips the steps that need a new threshold (see the header).
 */
export async function evaluateAndRecordTokenTierEligibility(
  params: EvaluateParams
): Promise<EligibilityResult> {
  const warnings: string[] = [];
  const now = params.now ?? new Date();

  const db = (params.db ?? (supabaseAdmin as unknown)) as SupabaseLike | null;
  if (!db) {
    warnings.push("Supabase admin client unavailable; eligibility not recorded.");
    return { configured: true, warnings, pro: null, power: null };
  }

  const balances: PlatformTokenBalances =
    params.balances ??
    (params.currentBalance !== undefined ? { hermesos: params.currentBalance } : {});
  const access =
    params.access ??
    (await resolveUserTokenAccess(params.userId, { db: db as unknown as TokenAccessDb, now }));

  // Allowlisted founders are pinned to the launch epoch past the global
  // promo window, so they qualify against (and snapshot) the cheaper launch
  // threshold, in whichever token. No-op for everyone else.
  const forceLaunchEpoch = isFoundersRateUser(params.userId);
  const liveByToken = new Map<PlatformTokenKey, Promise<LiveTierThresholds | null>>();
  const liveThresholds = (key: PlatformTokenKey) => {
    let pending = liveByToken.get(key);
    if (!pending) {
      const token = platformTokenByKey(key);
      pending = token
        ? getLiveActiveThresholds({ now, forceLaunchEpoch, token }).catch((error) => {
            const reason = error instanceof Error ? error.message : String(error);
            warnings.push(`Live ${token.displayUnit} price unavailable; new thresholds skipped: ${reason}`);
            return null;
          })
        : Promise.resolve(null);
      liveByToken.set(key, pending);
    }
    return pending;
  };
  const lookupFor = (tier: TierKey): ThresholdLookup => async (key) => {
    const live = await liveThresholds(key);
    return live ? (tier === "pro" ? live.pro : live.power) : null;
  };

  // Evaluate Pro and Power independently. A user can be eligible for Pro
  // (qualifying_quantity recorded) and not eligible for Power.
  const [pro, power] = await Promise.all(
    (["pro", "power"] as const).map((tier) =>
      evaluateTier({
        db,
        userId: params.userId,
        tier,
        access,
        balances,
        thresholdFor: lookupFor(tier),
        now,
        warnings,
      })
    )
  );

  return { configured: true, warnings, pro, power };
}
