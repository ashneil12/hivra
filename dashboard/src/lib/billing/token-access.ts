/**
 * Which platform tokens a user may hold for a tier and pay in.
 *
 * Before $HIVRA is active (dormant or scheduled) everyone is on $HermesOS and
 * nothing here touches the database. Once it is active:
 *
 *   - The grandfather cohort (token_grandfather_cohort) is everyone with a
 *     $HermesOS tier qualification, yearly token subscription, managed Venice
 *     token deposit or $HermesOS base-tier balance before the activation
 *     instant. It is recorded durably the first time the platform sees $HIVRA
 *     active (record_platform_token_activation), and any member that pass
 *     missed is recorded on first check (ensure_token_grandfather_membership).
 *   - Members keep $HermesOS tiers and payments with no deadline, and may also
 *     pay in $HIVRA.
 *   - A member may convert. For TOKEN_CONVERSION_GRACE_HOURS after converting,
 *     holding either token keeps their tier (the $HIVRA side counts against the
 *     $HIVRA threshold locked at conversion). After that the evaluator moves
 *     each $HermesOS tier row to $HIVRA at the then-current $HIVRA threshold.
 *   - Everyone else holds and pays in $HIVRA only; $HermesOS is refused
 *     server-side.
 *
 * The SQL twin of the allowed-token rule is token_key_allowed_for_user
 * (20260923150000_dual_platform_token_foundation.sql). Keep them in step.
 */
import { supabaseAdmin } from "@/lib/supabase";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  TOKEN_CONVERSION_GRACE_HOURS,
  getConfiguredHivraToken,
  platformTokenByKey,
  getHivraTokenPhase,
  type HivraTokenPhase,
  type PlatformTokenKey,
} from "./token-registry";
import { isFoundersRateUser, type ThresholdTierCode, type TierKey } from "./tier-thresholds";
import { getLiveActiveThresholds } from "./live-thresholds";
import {
  getLatestHermesTokenHoldingSnapshot,
  getLatestTokenHoldingSnapshot,
  type HermesTokenHoldingSnapshot,
} from "./token-holdings";

type QueryError = { code?: string; message?: string } | null;
type QueryResult = { data: unknown; error: QueryError };
type DbQuery = PromiseLike<QueryResult> & {
  select: (...args: unknown[]) => DbQuery;
  eq: (...args: unknown[]) => DbQuery;
  in: (...args: unknown[]) => DbQuery;
  is: (...args: unknown[]) => DbQuery;
  update: (...args: unknown[]) => DbQuery;
  maybeSingle: () => PromiseLike<QueryResult>;
};

export type TokenAccessDb = {
  from: (name: string) => unknown;
  rpc?: (name: string, params: Record<string, unknown>) => PromiseLike<QueryResult>;
};

function table(db: TokenAccessDb, name: string): DbQuery {
  return db.from(name) as DbQuery;
}

function requireRpc(db: TokenAccessDb) {
  if (typeof db.rpc !== "function") throw new Error("Database client does not support RPC");
  return db.rpc.bind(db);
}

export interface ConversionThreshold {
  amount: bigint;
  code: ThresholdTierCode;
}

export interface UserTokenAccess {
  phase: HivraTokenPhase;
  /** In the $HermesOS grandfather cohort. Always false before activation. */
  grandfathered: boolean;
  convertedAt: Date | null;
  conversionGraceEndsAt: Date | null;
  /** $HIVRA thresholds locked when the member converted, per tier. */
  conversionThresholds: Partial<Record<TierKey, ConversionThreshold>>;
  /** Tokens the user may pay in and newly hold for a tier. */
  allowedTokens: PlatformTokenKey[];
  /** Tokens tried, in order, for a first tier qualification. */
  qualifyTokens: PlatformTokenKey[];
  /** Default token for a new payment quote. */
  paymentToken: PlatformTokenKey;
}

interface CohortRow {
  user_id: string;
  converted_at: string | null;
  conversion_grace_ends_at: string | null;
  metadata: Record<string, unknown> | null;
}

const COHORT_SELECT = "user_id, converted_at, conversion_grace_ends_at, metadata";
const HOUR_MS = 60 * 60 * 1000;

export class TokenNotAllowedError extends Error {
  readonly status = 403;
  constructor(
    readonly tokenKey: PlatformTokenKey,
    readonly allowedTokens: PlatformTokenKey[]
  ) {
    super(
      tokenKey === "hermesos"
        ? "$HermesOS is only accepted from accounts that used it before $HIVRA launched. Use $HIVRA."
        : "$HIVRA is not live yet. Use $HermesOS."
    );
    this.name = "TokenNotAllowedError";
  }
}

export class HivraActivationConflictError extends Error {
  constructor(readonly result: Record<string, unknown>) {
    super(`$HIVRA activation does not match the recorded activation: ${String(result.status)}`);
    this.name = "HivraActivationConflictError";
  }
}

function parseConversionThresholds(metadata: Record<string, unknown> | null) {
  const out: Partial<Record<TierKey, ConversionThreshold>> = {};
  const conversion = metadata?.conversion;
  if (!conversion || typeof conversion !== "object") return out;
  const thresholds = (conversion as Record<string, unknown>).hivraThresholds;
  if (!thresholds || typeof thresholds !== "object") return out;
  for (const tier of ["pro", "power"] as const) {
    const entry = (thresholds as Record<string, unknown>)[tier] as Record<string, unknown> | undefined;
    if (entry && typeof entry.amount === "string" && /^\d+$/.test(entry.amount) && typeof entry.code === "string") {
      out[tier] = { amount: BigInt(entry.amount), code: entry.code as ThresholdTierCode };
    }
  }
  return out;
}

/** Pure: the access a user has at `now`, from the phase and their cohort row. */
export function computeUserTokenAccess(params: {
  phase: HivraTokenPhase;
  cohort: CohortRow | null;
  now: Date;
}): UserTokenAccess {
  if (params.phase !== "active") {
    return {
      phase: params.phase,
      grandfathered: false,
      convertedAt: null,
      conversionGraceEndsAt: null,
      conversionThresholds: {},
      allowedTokens: ["hermesos"],
      qualifyTokens: ["hermesos"],
      paymentToken: "hermesos",
    };
  }
  if (!params.cohort) {
    return {
      phase: "active",
      grandfathered: false,
      convertedAt: null,
      conversionGraceEndsAt: null,
      conversionThresholds: {},
      allowedTokens: ["hivra"],
      qualifyTokens: ["hivra"],
      paymentToken: "hivra",
    };
  }
  const convertedAt = params.cohort.converted_at ? new Date(params.cohort.converted_at) : null;
  const graceEndsAt = params.cohort.conversion_grace_ends_at
    ? new Date(params.cohort.conversion_grace_ends_at)
    : null;
  const inGrace = !!graceEndsAt && params.now.getTime() < graceEndsAt.getTime();
  const common = {
    phase: "active" as const,
    grandfathered: true,
    convertedAt,
    conversionGraceEndsAt: graceEndsAt,
    conversionThresholds: parseConversionThresholds(params.cohort.metadata),
  };
  if (!convertedAt) {
    return {
      ...common,
      allowedTokens: ["hermesos", "hivra"],
      qualifyTokens: ["hermesos", "hivra"],
      paymentToken: "hermesos",
    };
  }
  return {
    ...common,
    allowedTokens: inGrace ? ["hermesos", "hivra"] : ["hivra"],
    qualifyTokens: ["hivra"],
    paymentToken: "hivra",
  };
}

/**
 * Whether an EXISTING tier row in `tokenKey` still counts for this user. A
 * member's $HermesOS rows count until the evaluator moves them to $HIVRA, even
 * after conversion grace (the move needs a live price and may lag a tick).
 */
export function tierRowTokenCounts(access: UserTokenAccess, tokenKey: PlatformTokenKey): boolean {
  if (access.allowedTokens.includes(tokenKey)) return true;
  return tokenKey === "hermesos" && access.grandfathered;
}

/** True while a converted member's $HermesOS rows are due to move to $HIVRA. */
export function conversionDue(access: UserTokenAccess, now: Date): boolean {
  return (
    access.phase === "active" &&
    !!access.conversionGraceEndsAt &&
    now.getTime() >= access.conversionGraceEndsAt.getTime()
  );
}

/**
 * The token base tier: one whole token of a platform token the user may hold.
 * Before $HIVRA is active this is exactly the old "≥ 1 $HermesOS" rule.
 */
export function qualifiesForTokenBaseTier(
  access: UserTokenAccess,
  balances: Partial<Record<PlatformTokenKey, bigint>>
): boolean {
  return access.allowedTokens.some((key) => {
    const token = platformTokenByKey(key);
    const balance = balances[key];
    return !!token && balance !== undefined && balance >= 10n ** BigInt(token.decimals);
  });
}

/**
 * The holding snapshot that decides the token base tier: before $HIVRA is
 * active, exactly the latest $HermesOS snapshot (as before). Once active, the
 * latest snapshot of a token the user may hold, preferring one that meets
 * the base tier. Drop-in for getLatestHermesTokenHoldingSnapshot.
 */
export async function getLatestAccessTokenHoldingSnapshot(
  userId: string,
  db?: Parameters<typeof getLatestHermesTokenHoldingSnapshot>[1],
  now: Date = new Date()
): Promise<HermesTokenHoldingSnapshot | null> {
  if (getHivraTokenPhase(now) !== "active") return getLatestHermesTokenHoldingSnapshot(userId, db);
  let access: UserTokenAccess;
  try {
    access = await resolveUserTokenAccess(userId, {
      db: db as TokenAccessDb | null | undefined,
      now,
      recordMembership: false,
    });
  } catch (error) {
    // A $HIVRA activation conflict (already alerted) must not take the base
    // tier away from $HermesOS holders on this read path.
    if (!(error instanceof HivraActivationConflictError)) throw error;
    return getLatestHermesTokenHoldingSnapshot(userId, db);
  }
  const snapshots: HermesTokenHoldingSnapshot[] = [];
  for (const key of access.allowedTokens) {
    const token = platformTokenByKey(key);
    if (!token) continue;
    const snapshot = await getLatestTokenHoldingSnapshot(userId, token.address, db);
    if (snapshot) snapshots.push(snapshot);
  }
  return snapshots.find((snapshot) => snapshot.qualifiesBaseTier) ?? snapshots[0] ?? null;
}

let recordedActivationAddress: string | null = null;

/** Test seam. */
export function _resetTokenAccessStateForTests() {
  recordedActivationAddress = null;
}

/**
 * Record $HIVRA's activation and the grandfather cohort once $HIVRA is live.
 * Cheap after the first success in a process. A recorded activation with a
 * different address or instant is a hard stop for every $HIVRA path.
 */
export async function ensureHivraActivationRecorded(params: {
  db?: TokenAccessDb | null;
  now?: Date;
} = {}): Promise<"dormant" | "recorded"> {
  const now = params.now ?? new Date();
  if (getHivraTokenPhase(now) !== "active") return "dormant";
  const hivra = getConfiguredHivraToken();
  if (!hivra || !hivra.activatesAt) return "dormant";
  if (recordedActivationAddress === hivra.address) return "recorded";

  const db = (params.db ?? (supabaseAdmin as unknown)) as TokenAccessDb | null;
  if (!db) throw new Error("Database not configured");

  // Cheap path for every process after the first: the activation (and its
  // cohort pass) is already recorded with this exact address and instant.
  const { data: recorded, error: recordedError } = await table(db, "platform_token_activations")
    .select("token_address, activated_at, cohort_recorded_at")
    .eq("token_key", "hivra")
    .maybeSingle();
  if (recordedError) {
    throw new Error(`Failed to read the $HIVRA activation: ${recordedError.message ?? "unknown"}`);
  }
  const recordedRow = recorded as { token_address?: string; activated_at?: string; cohort_recorded_at?: string | null } | null;
  if (
    recordedRow &&
    recordedRow.token_address === hivra.address &&
    recordedRow.cohort_recorded_at &&
    typeof recordedRow.activated_at === "string" &&
    Date.parse(recordedRow.activated_at) === hivra.activatesAt.getTime()
  ) {
    recordedActivationAddress = hivra.address;
    return "recorded";
  }

  const { data, error } = await requireRpc(db)("record_platform_token_activation", {
    p_token_key: "hivra",
    p_chain_id: hivra.chainId,
    p_token_address: hivra.address,
    p_token_symbol: hivra.symbol,
    p_token_decimals: hivra.decimals,
    p_activated_at: hivra.activatesAt.toISOString(),
    p_now: now.toISOString(),
  });
  if (error) throw new Error(`Failed to record the $HIVRA activation: ${error.message ?? "unknown"}`);
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.status === "activated" || result.status === "already_active") {
    if (result.status === "activated") {
      // eslint-disable-next-line no-console
      console.info(
        `[token-access] recorded the $HIVRA activation; grandfather cohort ${String(result.cohort_size)}`
      );
    }
    recordedActivationAddress = hivra.address;
    return "recorded";
  }
  await reportOpsEvent({
    source: "billing.token-access",
    severity: "fatal",
    title: "$HIVRA activation conflicts with the recorded activation",
    message:
      "hivra-token-launch.ts does not match platform_token_activations. $HIVRA payments and " +
      "tier moves are refused until an operator reconciles them.",
    metadata: { failureType: "hivra_activation_conflict", result },
  });
  throw new HivraActivationConflictError(result);
}

/** The user's token access at `now`. No database reads while $HIVRA is not active. */
export async function resolveUserTokenAccess(
  userId: string,
  params: {
    db?: TokenAccessDb | null;
    now?: Date;
    /**
     * Record a member the activation pass missed (a write). Money paths and
     * the evaluator do; read-only hot paths pass false and rely on the cohort
     * recorded at activation.
     */
    recordMembership?: boolean;
  } = {}
): Promise<UserTokenAccess> {
  const now = params.now ?? new Date();
  const phase = getHivraTokenPhase(now);
  if (phase !== "active") return computeUserTokenAccess({ phase, cohort: null, now });

  const db = (params.db ?? (supabaseAdmin as unknown)) as TokenAccessDb | null;
  if (!db) throw new Error("Database not configured");
  await ensureHivraActivationRecorded({ db, now });
  let member = true; // read the cohort row below either way
  if (params.recordMembership !== false) {
    const { data, error: memberError } = await requireRpc(db)("ensure_token_grandfather_membership", {
      p_user_id: userId,
      p_now: now.toISOString(),
    });
    if (memberError) {
      throw new Error(`Failed to check the $HermesOS cohort: ${memberError.message ?? "unknown"}`);
    }
    member = data === true;
  }
  let cohort: CohortRow | null = null;
  if (member) {
    const { data, error } = await table(db, "token_grandfather_cohort")
      .select(COHORT_SELECT)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load the $HermesOS cohort row: ${error.message ?? "unknown"}`);
    cohort = (data as CohortRow | null) ?? null;
  }
  return computeUserTokenAccess({ phase, cohort, now });
}

/** Batch form for crons. Relies on the cohort recorded at activation. */
export async function resolveTokenAccessForUsers(
  userIds: string[],
  params: { db?: TokenAccessDb | null; now?: Date } = {}
): Promise<Map<string, UserTokenAccess>> {
  const now = params.now ?? new Date();
  const phase = getHivraTokenPhase(now);
  const out = new Map<string, UserTokenAccess>();
  if (phase !== "active" || userIds.length === 0) {
    for (const userId of userIds) out.set(userId, computeUserTokenAccess({ phase, cohort: null, now }));
    return out;
  }
  const db = (params.db ?? (supabaseAdmin as unknown)) as TokenAccessDb | null;
  if (!db) throw new Error("Database not configured");
  await ensureHivraActivationRecorded({ db, now });
  const { data, error } = await table(db, "token_grandfather_cohort").select(COHORT_SELECT).in("user_id", userIds);
  if (error) throw new Error(`Failed to load the $HermesOS cohort: ${error.message ?? "unknown"}`);
  const rows = new Map(((data as CohortRow[] | null) ?? []).map((row) => [row.user_id, row]));
  for (const userId of userIds) {
    out.set(userId, computeUserTokenAccess({ phase, cohort: rows.get(userId) ?? null, now }));
  }
  return out;
}

/** Refuse a payment or new holding in a token this user may not use. */
export async function assertTokenAllowedForUser(
  userId: string,
  tokenKey: PlatformTokenKey,
  params: { db?: TokenAccessDb | null; now?: Date; access?: UserTokenAccess } = {}
): Promise<UserTokenAccess> {
  const access = params.access ?? (await resolveUserTokenAccess(userId, params));
  if (!access.allowedTokens.includes(tokenKey)) throw new TokenNotAllowedError(tokenKey, access.allowedTokens);
  return access;
}

export class TokenConversionError extends Error {
  constructor(
    readonly code: "hivra_not_active" | "not_grandfathered" | "already_converted" | "price_unavailable",
    message: string
  ) {
    super(message);
    this.name = "TokenConversionError";
  }
}

/**
 * A grandfathered member chooses to move to $HIVRA. Locks the $HIVRA
 * thresholds for the conversion grace (so the grace needs no live price) and
 * starts it. Fails closed without a live $HIVRA price.
 */
export async function convertGrandfatheredUserToHivra(
  userId: string,
  params: { db?: TokenAccessDb | null; now?: Date } = {}
): Promise<UserTokenAccess> {
  const now = params.now ?? new Date();
  const db = (params.db ?? (supabaseAdmin as unknown)) as TokenAccessDb | null;
  if (!db) throw new Error("Database not configured");
  const access = await resolveUserTokenAccess(userId, { db, now });
  if (access.phase !== "active") {
    throw new TokenConversionError("hivra_not_active", "$HIVRA is not live yet.");
  }
  if (!access.grandfathered) {
    throw new TokenConversionError("not_grandfathered", "This account already uses $HIVRA.");
  }
  if (access.convertedAt) {
    throw new TokenConversionError("already_converted", "This account has already switched to $HIVRA.");
  }
  const hivra = getConfiguredHivraToken();
  if (!hivra) throw new TokenConversionError("hivra_not_active", "$HIVRA is not live yet.");

  let thresholds;
  try {
    thresholds = await getLiveActiveThresholds({
      now,
      token: hivra,
      forceLaunchEpoch: isFoundersRateUser(userId),
    });
  } catch {
    throw new TokenConversionError(
      "price_unavailable",
      "The $HIVRA price is unavailable right now, so the switch can't lock your amounts. Try again in a few minutes."
    );
  }
  const graceEndsAt = new Date(now.getTime() + TOKEN_CONVERSION_GRACE_HOURS * HOUR_MS);

  const { data: current, error: readError } = await table(db, "token_grandfather_cohort")
    .select(COHORT_SELECT)
    .eq("user_id", userId)
    .maybeSingle();
  if (readError || !current) {
    throw new Error(`Failed to load the $HermesOS cohort row: ${readError?.message ?? "missing"}`);
  }
  const metadata = {
    ...(((current as CohortRow).metadata as Record<string, unknown> | null) ?? {}),
    conversion: {
      convertedAt: now.toISOString(),
      graceHours: TOKEN_CONVERSION_GRACE_HOURS,
      hivraPriceUsd: thresholds.priceUsd,
      hivraThresholds: {
        pro: { amount: thresholds.pro.amount.toString(), code: thresholds.pro.code },
        power: { amount: thresholds.power.amount.toString(), code: thresholds.power.code },
      },
    },
  };
  const { data: updated, error } = await table(db, "token_grandfather_cohort")
    .update({
      converted_at: now.toISOString(),
      conversion_grace_ends_at: graceEndsAt.toISOString(),
      metadata,
    })
    .eq("user_id", userId)
    .is("converted_at", null)
    .select(COHORT_SELECT);
  if (error) throw new Error(`Failed to record the switch to $HIVRA: ${error.message ?? "unknown"}`);
  const row = Array.isArray(updated) ? (updated[0] as CohortRow | undefined) : undefined;
  if (!row) {
    throw new TokenConversionError("already_converted", "This account has already switched to $HIVRA.");
  }
  return computeUserTokenAccess({ phase: "active", cohort: row, now });
}
