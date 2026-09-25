import {
  ManagedVeniceInsufficientBalanceError,
  captureManagedVeniceReservation,
  loadManagedVeniceReservation,
  releaseManagedVeniceReservation,
} from "@/lib/billing/managed-venice-wallets";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { CHAT_STREAM_CANCELLED_RECONCILIATION_REASON } from "./chat-stream-reconciliation";
import {
  CHAT_RELEASE_FAILED_RECONCILIATION_REASON,
  MANAGED_VENICE_CHAT_HOLD_TTL_MS,
  MANAGED_VENICE_SWEEP_CAPTURE_POLICY,
  MEDIA_CAPTURE_FAILED_RECONCILIATION_REASON,
  MEDIA_RELEASE_FAILED_RECONCILIATION_REASON,
  holdEstimateMicroUsd,
  observedOutputChargeMicroUsd,
  readObservedOutputTokens,
} from "./hold-lifecycle";
import { recordManagedVeniceEstimatedCapture } from "./proxy-settlement";
import { RESPONSES_RECONCILIATION_REASON, RESPONSES_UNKNOWN_OUTCOME_CAUSES } from "./responses-protocol";

type QueryError = { code?: string; message?: string } | null;

type SupabaseLike = { from: (table: string) => unknown };

// The stale-hold sweep settles wallet holds the request path could not. It
// runs hourly (/api/cron/managed-venice-hold-sweep). One rule decides every
// hold:
//   * Venice answered 2xx (or nothing proves it didn't): CAPTURE, at the
//     number the request path recorded: Venice's reported usage when only
//     writing it failed, the input estimate plus the output the request
//     observed, or a media request's catalog price. Only a hold with none of
//     those on record (the function died mid-request) is charged an
//     estimate: input plus at most MANAGED_VENICE_SWEEP_OUTPUT_TOKENS_PER_CHOICE
//     output tokens per choice.
//   * Venice refused the request (or it never reached Venice) and the
//     in-request release failed: RELEASE.
//   * Venice's outcome is unknown (a Responses 5xx, a dispatch that threw):
//     left for an operator until the hold expires, then RELEASED.
// No hold is left active for good. Captures go through
// capture_managed_venice_reservation, which debits and closes the hold in one
// transaction, so retrying a capture whose outcome was lost, or two sweeps
// racing, never charges twice.
//
// Security review 2026-09 (#150, #160, #167): this sweep used to RELEASE holds
// for 200 streams that finished without a usage frame (free inference six
// hours later), and once it captured them, charged a flat estimate however
// much had streamed. Kept stream and Responses holds sat for a day or for
// good, and a refused request whose release failed was charged once its hold
// expired.

// Items the sweep captures once STALE_RECONCILIATION_AGE_HOURS old. Every one
// follows a request Venice answered 2xx whose in-request settlement did not
// finish.
export const SWEEP_CAPTURE_REASONS = [
  // Venice answered 200, but the usage never arrived or settling it threw.
  "managed_venice_missing_stream_usage",
  "managed_venice_stream_settlement_failed",
  "managed_venice_missing_usage",
  "managed_venice_anthropic_missing_usage",
  "managed_venice_anthropic_capture_failed",
  "managed_venice_anthropic_stream_capture_failed",
  // The client closed a 200 stream before the usage frame, and charging the
  // observed output in the request failed.
  CHAT_STREAM_CANCELLED_RECONCILIATION_REASON,
  // A media 2xx whose capture failed (media-spend-gate.ts).
  MEDIA_CAPTURE_FAILED_RECONCILIATION_REASON,
] as const;

// Items the sweep releases once STALE_RECONCILIATION_AGE_HOURS old: Venice
// refused the request, or it never reached Venice, and the release failed.
export const SWEEP_RELEASE_REASONS = [
  MEDIA_RELEASE_FAILED_RECONCILIATION_REASON,
  CHAT_RELEASE_FAILED_RECONCILIATION_REASON,
] as const;

// Responses items (RESPONSES_RECONCILIATION_REASON) are captured like the
// capture reasons above, except RESPONSES_UNKNOWN_OUTCOME_CAUSES: Venice's
// answer never arrived, or was a 5xx that may or may not follow generation.
// An operator can settle those from Venice's records while the hold lasts;
// once it expires the sweep releases it.
export { RESPONSES_UNKNOWN_OUTCOME_CAUSES };

// A request whose in-request settlement did not finish is over well within
// this: the Vercel routes stop at MANAGED_VENICE_STREAM_DEADLINE_MS and the
// Worker files its item when its stream ends.
const STALE_RECONCILIATION_AGE_HOURS = 0.25;
// Unknown-outcome items are due when their hold expires, a day after the
// request; an item is filed within minutes of its hold, so no item younger
// than this can be due. Filtering on it keeps not-yet-due items out of the
// run's budget.
const UNKNOWN_OUTCOME_AGE_HOURS = MANAGED_VENICE_CHAT_HOLD_TTL_MS / (60 * 60 * 1000);

const PER_RUN_ITEM_CAP = 500;
// Expired holds with no item have their own budget, so a backlog of items
// can never starve them.
const PER_RUN_EXPIRED_HOLD_CAP = 500;

const OPEN_DISPOSITIONS = new Set<string>(["capture_failed", "release_failed", "waiting_for_hold_expiry"]);

interface ReconciliationItemRow {
  id: string;
  user_id: string;
  proxy_key_id?: string | null;
  reason: string;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
}

interface ReservationRow {
  id: string;
  account_id?: string | null;
  user_id: string;
  wallet_type: string;
  status: string;
  reference_id: string;
  estimated_cost_micro_usd?: number | null;
  reserved_micro_usd: number;
  model?: string | null;
  endpoint?: string | null;
  expires_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type SweepDisposition =
  | "captured_hold"
  | "captured_expired_hold"
  | "released_failed_request"
  | "released_unknown_outcome"
  | "reservation_already_captured"
  | "reservation_already_released"
  | "reservation_not_found"
  | "missing_reference_id"
  | "capture_failed"
  | "release_failed"
  | "waiting_for_hold_expiry"
  | "left_for_open_item";

export type SweepCaptureBasis = "catalog_price" | "reported_usage" | "observed_output" | "pre_request_estimate";

export interface ReservationSweepResult {
  itemId: string | null;
  userId: string;
  reason: string | null;
  referenceId: string | null;
  disposition: SweepDisposition;
  capturedMicroUsd: number;
  releasedMicroUsd: number;
  basis?: SweepCaptureBasis;
}

export interface ReservationSweepSummary {
  /** Items and expired holds examined. */
  scanned: number;
  /** Items closed. */
  closed: number;
  capturedReservations: number;
  totalCapturedMicroUsd: number;
  releasedReservations: number;
  totalReleasedMicroUsd: number;
  /** Expired holds left alone because an open item decides them. */
  heldForOpenItem: number;
  /** Captures or releases that failed; the item or hold is retried next run. */
  failed: number;
  results: ReservationSweepResult[];
}

type SelectChain = {
  select: (cols: string) => SelectChain;
  eq: (col: string, val: string) => SelectChain;
  neq: (col: string, val: string) => SelectChain;
  in: (col: string, vals: readonly string[]) => SelectChain;
  lt: (col: string, val: string) => SelectChain;
  order: (col: string, opts: { ascending: boolean }) => SelectChain;
  limit: (n: number) => PromiseLike<{ data: unknown; error: QueryError }>;
};

type ItemUpdateChain = {
  update: (patch: Record<string, unknown>) => {
    eq: (col: string, val: string) => PromiseLike<{ error: QueryError }>;
  };
};

function select(db: SupabaseLike, table: string) {
  return db.from(table) as SelectChain;
}

function readReferenceId(metadata: Record<string, unknown> | null | undefined): string | null {
  const ref = metadata?.referenceId;
  return typeof ref === "string" && ref.trim() ? ref : null;
}

function readMicroUsd(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function readStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function isUnknownOutcome(item: ReconciliationItemRow): boolean {
  return (
    item.reason === RESPONSES_RECONCILIATION_REASON &&
    (RESPONSES_UNKNOWN_OUTCOME_CAUSES as readonly unknown[]).includes(item.metadata?.cause)
  );
}

function isReleaseItem(item: ReconciliationItemRow): boolean {
  return (SWEEP_RELEASE_REASONS as readonly string[]).includes(item.reason) || isUnknownOutcome(item);
}

async function loadItems(
  db: SupabaseLike,
  query: (chain: SelectChain) => SelectChain,
  cutoff: string,
  limit: number
): Promise<ReconciliationItemRow[]> {
  if (limit <= 0) return [];
  const { data, error } = await query(
    select(db, "managed_venice_reconciliation_items")
      .select("id, user_id, proxy_key_id, reason, status, metadata, created_at")
      .eq("status", "open")
  )
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    throw new Error(error.message || "Failed to load managed Venice reconciliation items");
  }
  return Array.isArray(data) ? (data as ReconciliationItemRow[]) : [];
}

async function loadExpiredHolds(db: SupabaseLike, nowIso: string, limit: number): Promise<ReservationRow[]> {
  if (limit <= 0) return [];
  // expires_at < now leaves out holds without an expiry: those predate
  // expiring holds, and settling them is an operator's call.
  const { data, error } = await select(db, "managed_venice_reservations")
    .select("*")
    .eq("status", "active")
    .lt("expires_at", nowIso)
    .order("expires_at", { ascending: true })
    .limit(limit);
  if (error) {
    throw new Error(error.message || "Failed to load expired managed Venice reservations");
  }
  return Array.isArray(data) ? (data as ReservationRow[]) : [];
}

async function hasOpenItem(db: SupabaseLike, hold: ReservationRow): Promise<boolean> {
  const { data, error } = await select(db, "managed_venice_reconciliation_items")
    .select("id")
    .eq("status", "open")
    .eq("user_id", hold.user_id)
    .eq("metadata->>referenceId", hold.reference_id)
    .limit(1);
  if (error) {
    throw new Error(error.message || "Failed to load managed Venice reconciliation items for a hold");
  }
  return Array.isArray(data) && data.length > 0;
}

// What a capture charges, from the best number on record:
//   1. a media request's catalog price, recorded on the hold when it was made
//      (media-spend-gate.ts) or on its capture-failed item;
//   2. Venice's reported usage, when the request had it but writing the
//      charge failed;
//   3. the input estimate plus the output the request observed;
//   4. the hold's estimate (holdEstimateMicroUsd), for a hold nothing
//      recorded anything about.
// Never more than the hold.
function captureAmount(
  hold: ReservationRow,
  item: ReconciliationItemRow | null
): { amountMicroUsd: number; listMicroUsd: number; basis: SweepCaptureBasis } {
  const reserved = hold.reserved_micro_usd;
  const holdMeta = hold.metadata ?? {};
  const itemMeta = item?.metadata ?? {};
  const catalog = readMicroUsd(holdMeta.captureOnSuccessMicroUsd) ?? readMicroUsd(itemMeta.chargeMicroUsd);
  if (catalog !== null && catalog <= reserved) {
    const list =
      readMicroUsd(holdMeta.captureOnSuccessListMicroUsd) ?? readMicroUsd(itemMeta.listCostMicroUsd) ?? catalog;
    return { amountMicroUsd: catalog, listMicroUsd: list, basis: "catalog_price" };
  }
  const usageCost = readMicroUsd(itemMeta.usageCostMicroUsd);
  if (usageCost !== null) {
    const amount = Math.min(reserved, usageCost);
    return { amountMicroUsd: amount, listMicroUsd: amount, basis: "reported_usage" };
  }
  const observedTokens = readObservedOutputTokens(itemMeta.observedOutputTokens);
  const observed = observedTokens === null ? null : observedOutputChargeMicroUsd(hold, observedTokens);
  if (observed !== null) {
    return { amountMicroUsd: observed, listMicroUsd: observed, basis: "observed_output" };
  }
  const amount = holdEstimateMicroUsd(hold);
  return { amountMicroUsd: amount, listMicroUsd: amount, basis: "pre_request_estimate" };
}

async function closeItem(
  db: SupabaseLike,
  item: ReconciliationItemRow,
  result: ReservationSweepResult,
  sweptAt: string
): Promise<void> {
  const settled =
    result.disposition === "captured_hold" ||
    result.disposition === "released_failed_request" ||
    result.disposition === "released_unknown_outcome";
  const amount = result.capturedMicroUsd || result.releasedMicroUsd;
  const note =
    `Closed by reservation sweep: ${result.disposition}` +
    (amount > 0 ? ` (${result.capturedMicroUsd > 0 ? "captured" : "released"} ${amount} µUSD)` : "");

  const { error } = await (db.from("managed_venice_reconciliation_items") as unknown as ItemUpdateChain)
    .update({
      status: settled ? "resolved" : "ignored",
      resolved_at: sweptAt,
      operator_notes: note,
      metadata: {
        ...(item.metadata || {}),
        sweep: {
          disposition: result.disposition,
          basis: result.basis ?? null,
          capturedMicroUsd: result.capturedMicroUsd,
          releasedMicroUsd: result.releasedMicroUsd,
          referenceId: result.referenceId,
          sweptAt,
        },
      },
    })
    .eq("id", item.id);

  if (error) {
    throw new Error(error.message || "Failed to close managed Venice reconciliation item");
  }
}

async function captureHold(
  db: SupabaseLike,
  hold: ReservationRow,
  item: ReconciliationItemRow | null,
  disposition: "captured_hold" | "captured_expired_hold",
  sweptAt: string
): Promise<Omit<ReservationSweepResult, "itemId" | "userId" | "reason" | "referenceId">> {
  const price = captureAmount(hold, item);
  try {
    const captured = await captureManagedVeniceReservation(
      { userId: hold.user_id, referenceId: hold.reference_id, captureMicroUsd: price.amountMicroUsd },
      db
    );
    if (!captured.captured) {
      // Settled between the read and the capture (another sweep, a late
      // in-request settlement). The function moved no money.
      return { disposition: "reservation_already_captured", capturedMicroUsd: 0, releasedMicroUsd: 0 };
    }
  } catch (error) {
    log.error("Managed Venice sweep could not capture a stale hold", error, {
      source: "managed-venice-reservation-sweep",
      failureType:
        error instanceof ManagedVeniceInsufficientBalanceError
          ? "managed_venice_sweep_capture_uncovered"
          : "managed_venice_sweep_capture_failed",
      userId: hold.user_id,
      referenceId: hold.reference_id,
      captureMicroUsd: price.amountMicroUsd,
      reason: item?.reason ?? null,
    });
    return { disposition: "capture_failed", capturedMicroUsd: 0, releasedMicroUsd: 0, basis: price.basis };
  }
  const proxyKeyId =
    (typeof item?.proxy_key_id === "string" && item.proxy_key_id) ||
    (typeof hold.metadata?.proxyKeyId === "string" ? hold.metadata.proxyKeyId : null);
  await recordManagedVeniceEstimatedCapture(
    {
      hold,
      proxyKeyId,
      amountMicroUsd: price.amountMicroUsd,
      listMicroUsd: price.listMicroUsd,
      pricingPolicy: MANAGED_VENICE_SWEEP_CAPTURE_POLICY,
      upstreamStatus: readStatus(item?.metadata?.upstreamStatus),
      idempotencyKey: `managed_venice_hold_sweep_capture:${hold.reference_id}`,
      detailKey: "sweep",
      detail: {
        disposition,
        basis: price.basis,
        reason: item?.reason ?? null,
        itemId: item?.id ?? null,
        heldMicroUsd: hold.reserved_micro_usd,
        sweptAt,
      },
    },
    db
  );
  return { disposition, capturedMicroUsd: price.amountMicroUsd, releasedMicroUsd: 0, basis: price.basis };
}

async function releaseHold(
  db: SupabaseLike,
  item: ReconciliationItemRow,
  referenceId: string,
  disposition: "released_failed_request" | "released_unknown_outcome"
): Promise<Pick<ReservationSweepResult, "disposition" | "capturedMicroUsd" | "releasedMicroUsd">> {
  try {
    const released = await releaseManagedVeniceReservation({ userId: item.user_id, referenceId }, db);
    if (!released.released) {
      return { disposition: "reservation_already_released", capturedMicroUsd: 0, releasedMicroUsd: 0 };
    }
    return { disposition, capturedMicroUsd: 0, releasedMicroUsd: released.releasedMicroUsd ?? 0 };
  } catch (error) {
    log.error("Managed Venice sweep could not release a hold", error, {
      source: "managed-venice-reservation-sweep",
      failureType: "managed_venice_sweep_release_failed",
      userId: item.user_id,
      referenceId,
      reason: item.reason,
    });
    return { disposition: "release_failed", capturedMicroUsd: 0, releasedMicroUsd: 0 };
  }
}

function holdHasExpired(hold: ReservationRow, item: ReconciliationItemRow, nowMs: number, fallbackCutoffMs: number) {
  const expiresAt = hold.expires_at ? Date.parse(hold.expires_at) : Number.NaN;
  if (Number.isFinite(expiresAt)) return expiresAt <= nowMs;
  // A hold from before holds expired: a day after its item.
  const filedAt = item.created_at ? Date.parse(item.created_at) : Number.NaN;
  return Number.isFinite(filedAt) && filedAt <= fallbackCutoffMs;
}

async function settleItem(
  db: SupabaseLike,
  item: ReconciliationItemRow,
  sweptAt: string,
  clock: { nowMs: number; unknownOutcomeCutoffMs: number }
): Promise<ReservationSweepResult> {
  const referenceId = readReferenceId(item.metadata);
  const base = { itemId: item.id, userId: item.user_id, reason: item.reason, referenceId };
  if (!referenceId) {
    return { ...base, disposition: "missing_reference_id", capturedMicroUsd: 0, releasedMicroUsd: 0 };
  }
  const hold = (await loadManagedVeniceReservation(item.user_id, referenceId, db)) as ReservationRow | null;
  if (!hold) {
    return { ...base, disposition: "reservation_not_found", capturedMicroUsd: 0, releasedMicroUsd: 0 };
  }
  if (hold.status === "captured") {
    return { ...base, disposition: "reservation_already_captured", capturedMicroUsd: 0, releasedMicroUsd: 0 };
  }
  if (hold.status !== "active") {
    return { ...base, disposition: "reservation_already_released", capturedMicroUsd: 0, releasedMicroUsd: 0 };
  }

  if (isUnknownOutcome(item)) {
    if (!holdHasExpired(hold, item, clock.nowMs, clock.unknownOutcomeCutoffMs)) {
      return { ...base, disposition: "waiting_for_hold_expiry", capturedMicroUsd: 0, releasedMicroUsd: 0 };
    }
    return { ...base, ...(await releaseHold(db, item, referenceId, "released_unknown_outcome")) };
  }
  if (isReleaseItem(item)) {
    return { ...base, ...(await releaseHold(db, item, referenceId, "released_failed_request")) };
  }
  return { ...base, ...(await captureHold(db, hold, item, "captured_hold", sweptAt)) };
}

/**
 * Settle wallet holds the request path left active, by the rule at the top of
 * this file:
 *   1. open items with SWEEP_CAPTURE_REASONS or SWEEP_RELEASE_REASONS, and
 *      Responses items with a known outcome, once `ageHours` old;
 *   2. Responses items with an unknown outcome once their hold expires
 *      (looked up only once `unknownOutcomeAgeHours` old), released;
 *   3. then, on their own budget, active holds past their `expires_at` with
 *      no open item, which nothing settled at all (the function died
 *      mid-request): captured.
 * Idempotent: settled items drop out of the scan, and a hold that is no longer
 * active is never charged again.
 */
export async function sweepStaleManagedVeniceReservations(
  params: { ageHours?: number; unknownOutcomeAgeHours?: number; limit?: number; expiredHoldLimit?: number } = {},
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ReservationSweepSummary> {
  if (!db) throw new Error("Database not configured");
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cutoff = (hours: number) => new Date(now - hours * 60 * 60 * 1_000).toISOString();
  const staleCutoff = cutoff(params.ageHours ?? STALE_RECONCILIATION_AGE_HOURS);
  const unknownOutcomeCutoff = cutoff(params.unknownOutcomeAgeHours ?? UNKNOWN_OUTCOME_AGE_HOURS);
  const clock = { nowMs: now, unknownOutcomeCutoffMs: Date.parse(unknownOutcomeCutoff) };
  let budget = params.limit ?? PER_RUN_ITEM_CAP;

  const items: ReconciliationItemRow[] = [];
  const take = (rows: ReconciliationItemRow[]) => {
    items.push(...rows);
    budget -= rows.length;
  };
  take(
    await loadItems(
      db,
      (chain) => chain.in("reason", [...SWEEP_CAPTURE_REASONS, ...SWEEP_RELEASE_REASONS]),
      staleCutoff,
      budget
    )
  );
  take(
    await loadItems(
      db,
      (chain) =>
        RESPONSES_UNKNOWN_OUTCOME_CAUSES.reduce(
          (next, cause) => next.neq("metadata->>cause", cause),
          chain.eq("reason", RESPONSES_RECONCILIATION_REASON)
        ),
      staleCutoff,
      budget
    )
  );
  take(
    await loadItems(
      db,
      (chain) =>
        chain.eq("reason", RESPONSES_RECONCILIATION_REASON).in("metadata->>cause", RESPONSES_UNKNOWN_OUTCOME_CAUSES),
      unknownOutcomeCutoff,
      budget
    )
  );

  const summary: ReservationSweepSummary = {
    scanned: items.length,
    closed: 0,
    capturedReservations: 0,
    totalCapturedMicroUsd: 0,
    releasedReservations: 0,
    totalReleasedMicroUsd: 0,
    heldForOpenItem: 0,
    failed: 0,
    results: [],
  };
  const count = (result: ReservationSweepResult) => {
    summary.results.push(result);
    if (result.disposition === "captured_hold" || result.disposition === "captured_expired_hold") {
      summary.capturedReservations += 1;
      summary.totalCapturedMicroUsd += result.capturedMicroUsd;
    }
    if (result.disposition === "released_failed_request" || result.disposition === "released_unknown_outcome") {
      summary.releasedReservations += 1;
      summary.totalReleasedMicroUsd += result.releasedMicroUsd;
    }
    if (result.disposition === "capture_failed" || result.disposition === "release_failed") summary.failed += 1;
    if (result.disposition === "left_for_open_item") summary.heldForOpenItem += 1;
  };

  for (const item of items) {
    const sweptAt = new Date().toISOString();
    const result = await settleItem(db, item, sweptAt, clock);
    count(result);
    // A failed capture or release, or an unknown outcome whose hold has not
    // expired, keeps its item open for a later run.
    if (!OPEN_DISPOSITIONS.has(result.disposition)) {
      await closeItem(db, item, result, sweptAt);
      summary.closed += 1;
    }
  }

  const expired = await loadExpiredHolds(db, nowIso, params.expiredHoldLimit ?? PER_RUN_EXPIRED_HOLD_CAP);
  summary.scanned += expired.length;
  for (const hold of expired) {
    const base = { itemId: null, userId: hold.user_id, reason: null, referenceId: hold.reference_id };
    if (await hasOpenItem(db, hold)) {
      count({ ...base, disposition: "left_for_open_item", capturedMicroUsd: 0, releasedMicroUsd: 0 });
      continue;
    }
    const sweptAt = new Date().toISOString();
    count({ ...base, ...(await captureHold(db, hold, null, "captured_expired_hold", sweptAt)) });
  }

  return summary;
}

// managed_venice_reservations grows ~1 row per inference and is never pruned,
// so a busy agent accrues thousands of terminal (released/captured) rows. A
// reservation row is purely OPERATIONAL once its request settles — the durable
// billing audit lives in managed_venice_financial_events — so old terminal
// rows can be deleted to keep the table (and the per-request balance reads
// that scan it) bounded. 30 days is far past any settlement/reconciliation
// window, and only released/captured rows are ever touched — never an active
// hold.
const TERMINAL_RESERVATION_RETENTION_DAYS = 30;
const PER_RUN_PRUNE_CAP = 2_000;

export interface ReservationPruneSummary {
  pruned: number;
}

type ReservationSelectChain = {
  select: (cols: string) => {
    in: (col: string, vals: readonly string[]) => {
      lt: (col: string, val: string) => {
        limit: (n: number) => Promise<{ data: unknown; error: QueryError }>;
      };
    };
  };
};
type ReservationDeleteChain = {
  delete: () => {
    in: (col: string, vals: string[]) => Promise<{ error: QueryError }>;
  };
};

export async function pruneTerminalManagedVeniceReservations(
  params: { retentionDays?: number; limit?: number } = {},
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ReservationPruneSummary> {
  if (!db) throw new Error("Database not configured");
  const retentionDays = params.retentionDays ?? TERMINAL_RESERVATION_RETENTION_DAYS;
  const limit = params.limit ?? PER_RUN_PRUNE_CAP;
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1_000
  ).toISOString();

  // Select a bounded page of long-settled terminal rows, then delete by id
  // (PostgREST delete has no LIMIT, so cap via the select).
  const { data, error } = await (db.from(
    "managed_venice_reservations"
  ) as unknown as ReservationSelectChain)
    .select("id")
    .in("status", ["released", "captured"])
    .lt("updated_at", cutoff)
    .limit(limit);

  if (error) {
    throw new Error(error.message || "Failed to load prunable managed Venice reservations");
  }

  const ids = (Array.isArray(data) ? data : [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return { pruned: 0 };

  const { error: deleteError } = await (db.from(
    "managed_venice_reservations"
  ) as unknown as ReservationDeleteChain)
    .delete()
    .in("id", ids);

  if (deleteError) {
    throw new Error(deleteError.message || "Failed to prune managed Venice reservations");
  }

  return { pruned: ids.length };
}
