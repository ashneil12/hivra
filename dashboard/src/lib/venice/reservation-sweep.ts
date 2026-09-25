import { appendManagedVeniceFinancialEvent } from "@/lib/billing/managed-venice-financial-events";
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
  MANAGED_VENICE_SWEEP_CAPTURE_POLICY,
  MEDIA_CAPTURE_FAILED_RECONCILIATION_REASON,
  MEDIA_RELEASE_FAILED_RECONCILIATION_REASON,
} from "./hold-lifecycle";
import { RESPONSES_RECONCILIATION_REASON } from "./responses-protocol";

type QueryError = { code?: string; message?: string } | null;

type SupabaseLike = { from: (table: string) => unknown };

// The stale-hold sweep settles wallet holds that the request path left
// active. One rule decides every hold:
//   * Venice answered 2xx (or nothing proves it didn't): CAPTURE. Venice ran
//     the request and billed Hivra for it. A media hold is charged the catalog
//     price of the tier that was sent. A chat hold is charged its input
//     estimate plus at most MANAGED_VENICE_SWEEP_OUTPUT_TOKENS_PER_CHOICE
//     output tokens per choice, never more than the pre-request estimate.
//   * Venice refused the request and the in-request release failed: RELEASE.
//   * An outcome only an operator can judge: leave it.
// Captures go through capture_managed_venice_reservation, which debits and
// closes the hold in one transaction, so retrying a capture whose outcome was
// lost, or two sweeps racing, never charges twice.
//
// Security review 2026-09 (#150, #160): this sweep used to RELEASE holds for
// 200 streams that finished without a usage frame, so anyone who could make
// Venice leave the usage frame out got free inference six hours later. Kept
// stream holds, media holds and holds kept after a failed capture were never
// settled at all, and shrank the user's balance for good.

// Reconciliation items settled once STALE_RECONCILIATION_AGE_HOURS old. Every
// one follows a request whose in-request settlement did not finish.
export const SWEEPABLE_RECONCILIATION_REASONS = [
  // Venice answered 200, but no usage arrived or settling it threw.
  "managed_venice_missing_stream_usage",
  "managed_venice_stream_settlement_failed",
  "managed_venice_missing_usage",
  "managed_venice_anthropic_missing_usage",
  "managed_venice_anthropic_capture_failed",
  "managed_venice_anthropic_stream_capture_failed",
  // A media 2xx whose capture failed, and a refused media request whose
  // release failed (media-spend-gate.ts).
  MEDIA_CAPTURE_FAILED_RECONCILIATION_REASON,
  MEDIA_RELEASE_FAILED_RECONCILIATION_REASON,
] as const;

// Kept holds: Venice had answered 200 when the client went away, or the
// Responses usage was ambiguous after a 200. Deliberately NOT in
// SWEEPABLE_RECONCILIATION_REASONS: a kept hold waits until the hold itself
// expires (a day after the request, MANAGED_VENICE_CHAT_HOLD_TTL_MS), time in
// which an operator can settle the exact usage from Venice's own records, and
// is then charged its estimate. A hold from before holds expired waits
// KEPT_HOLD_AGE_HOURS from its item instead. Kept holds are never released.
const KEPT_HOLD_REASONS = [CHAT_STREAM_CANCELLED_RECONCILIATION_REASON] as const;

// Responses items are kept holds only when Venice had answered 200. Items
// whose upstream outcome is unknown (the fetch threw, or Venice answered a
// status the route cannot call a rejection) stay with an operator.
const RESPONSES_AFTER_200_CAUSES = [
  "stream_aborted",
  "missing_terminal_usage",
  "invalid_response",
  "invalid_stream",
  "settlement_failed",
] as const;

// A request whose in-request settlement did not finish is long over after
// six hours, so settling it can't race a live settlement.
const STALE_RECONCILIATION_AGE_HOURS = 6;
const KEPT_HOLD_AGE_HOURS = 24;

const PER_RUN_ITEM_CAP = 500;

const OPEN_DISPOSITIONS = new Set<string>(["capture_failed", "release_failed", "kept_until_hold_expires"]);

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
  | "reservation_already_captured"
  | "reservation_already_released"
  | "reservation_not_found"
  | "missing_reference_id"
  | "capture_failed"
  | "release_failed"
  | "kept_until_hold_expires"
  | "left_for_open_item";

export type SweepCaptureBasis = "catalog_price" | "pre_request_estimate";

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

type InsertTable = {
  insert: (row: Record<string, unknown>) => PromiseLike<{ error: QueryError }>;
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

// What a capture charges. A media hold records the price of a success when it
// is created (media-spend-gate.ts); a capture-failed item carries the same
// number. A chat hold records its sweep estimate (proxy-settlement.ts). A hold
// from before either was recorded is charged the pre-request estimate it was
// sized from.
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
  const sweepEstimate = readMicroUsd(holdMeta.sweepEstimateMicroUsd);
  const estimate = sweepEstimate ?? readMicroUsd(hold.estimated_cost_micro_usd);
  const amount = Math.min(reserved, estimate ?? reserved);
  return { amountMicroUsd: amount, listMicroUsd: amount, basis: "pre_request_estimate" };
}

// Money has moved; record it like any in-request capture (a usage row and an
// immutable usage_capture event, keyed to the hold) so the subsidy report's
// ledger check and the user's usage history both see it. A failure here is
// logged, never retried: retrying could not move money again anyway.
async function recordSweepCapture(
  db: SupabaseLike,
  params: {
    hold: ReservationRow;
    item: ReconciliationItemRow | null;
    amountMicroUsd: number;
    listMicroUsd: number;
    basis: SweepCaptureBasis;
    disposition: SweepDisposition;
    sweptAt: string;
  }
) {
  const { hold, item } = params;
  const proxyKeyId =
    (typeof item?.proxy_key_id === "string" && item.proxy_key_id) ||
    (typeof hold.metadata?.proxyKeyId === "string" ? hold.metadata.proxyKeyId : null);
  const sweep = {
    disposition: params.disposition,
    basis: params.basis,
    reason: item?.reason ?? null,
    itemId: item?.id ?? null,
    heldMicroUsd: hold.reserved_micro_usd,
    sweptAt: params.sweptAt,
  };
  try {
    const { error } = await (db.from("managed_venice_usage_events") as InsertTable).insert({
      account_id: hold.account_id,
      user_id: hold.user_id,
      proxy_key_id: proxyKeyId,
      wallet_type: hold.wallet_type,
      endpoint: hold.endpoint || "/api/v1/chat/completions",
      model: hold.model || "unknown",
      estimated_cost_micro_usd: hold.reserved_micro_usd,
      actual_cost_micro_usd: params.listMicroUsd,
      charged_micro_usd: params.amountMicroUsd,
      discount_micro_usd: 0,
      status: "recorded",
      upstream_status: readStatus(item?.metadata?.upstreamStatus),
      reference_id: hold.reference_id,
      metadata: { pricingPolicy: MANAGED_VENICE_SWEEP_CAPTURE_POLICY, sweep },
    });
    if (error) throw new Error(error.message || "Failed to record the swept capture's usage");

    await appendManagedVeniceFinancialEvent(
      {
        userId: hold.user_id,
        accountId: hold.account_id ?? null,
        walletType: hold.wallet_type === "card" ? "card" : "hermesos",
        eventType: "usage_capture",
        amountMicroUsd: params.amountMicroUsd,
        veniceCostMicroUsd: params.listMicroUsd,
        discountMicroUsd: 0,
        referenceId: hold.reference_id,
        idempotencyKey: `managed_venice_hold_sweep_capture:${hold.reference_id}`,
        metadata: { pricingPolicy: MANAGED_VENICE_SWEEP_CAPTURE_POLICY, model: hold.model ?? null, endpoint: hold.endpoint ?? null, sweep },
      },
      db
    );
  } catch (error) {
    log.error("Managed Venice sweep capture could not be recorded", error, {
      source: "managed-venice-reservation-sweep",
      failureType: "managed_venice_sweep_capture_record_failed",
      userId: hold.user_id,
      referenceId: hold.reference_id,
      capturedMicroUsd: params.amountMicroUsd,
    });
  }
}

async function closeItem(
  db: SupabaseLike,
  item: ReconciliationItemRow,
  result: ReservationSweepResult,
  sweptAt: string
): Promise<void> {
  const settled =
    result.disposition === "captured_hold" || result.disposition === "released_failed_request";
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
  await recordSweepCapture(db, { hold, item, ...price, disposition, sweptAt });
  return { disposition, capturedMicroUsd: price.amountMicroUsd, releasedMicroUsd: 0, basis: price.basis };
}

function keptHoldIsDue(hold: ReservationRow, item: ReconciliationItemRow, nowMs: number, keptCutoffMs: number) {
  const expiresAt = hold.expires_at ? Date.parse(hold.expires_at) : Number.NaN;
  if (Number.isFinite(expiresAt)) return expiresAt <= nowMs;
  const filedAt = item.created_at ? Date.parse(item.created_at) : Number.NaN;
  return Number.isFinite(filedAt) && filedAt <= keptCutoffMs;
}

async function settleItem(
  db: SupabaseLike,
  item: ReconciliationItemRow,
  sweptAt: string,
  keptHold: { nowMs: number; cutoffMs: number } | null
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
  if (keptHold && !keptHoldIsDue(hold, item, keptHold.nowMs, keptHold.cutoffMs)) {
    return { ...base, disposition: "kept_until_hold_expires", capturedMicroUsd: 0, releasedMicroUsd: 0 };
  }

  if (item.reason === MEDIA_RELEASE_FAILED_RECONCILIATION_REASON) {
    try {
      const released = await releaseManagedVeniceReservation({ userId: item.user_id, referenceId }, db);
      if (!released.released) {
        return { ...base, disposition: "reservation_already_released", capturedMicroUsd: 0, releasedMicroUsd: 0 };
      }
      return {
        ...base,
        disposition: "released_failed_request",
        capturedMicroUsd: 0,
        releasedMicroUsd: released.releasedMicroUsd ?? 0,
      };
    } catch (error) {
      log.error("Managed Venice sweep could not release a refused request's hold", error, {
        source: "managed-venice-reservation-sweep",
        failureType: "managed_venice_sweep_release_failed",
        userId: item.user_id,
        referenceId,
      });
      return { ...base, disposition: "release_failed", capturedMicroUsd: 0, releasedMicroUsd: 0 };
    }
  }

  return { ...base, ...(await captureHold(db, hold, item, "captured_hold", sweptAt)) };
}

/**
 * Settle wallet holds the request path left active:
 *   1. open reconciliation items, by the rule at the top of this file:
 *      SWEEPABLE_RECONCILIATION_REASONS once `ageHours` old, kept stream
 *      holds once the hold expires (or, without an expiry, `keptHoldAgeHours`
 *      after the item);
 *   2. then active holds past their `expires_at` with no open item, which
 *      nothing settled at all (the function died mid-request), captured.
 * Idempotent: settled items drop out of the scan, and a hold that is no longer
 * active is never charged again.
 */
export async function sweepStaleManagedVeniceReservations(
  params: { ageHours?: number; keptHoldAgeHours?: number; limit?: number } = {},
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ReservationSweepSummary> {
  if (!db) throw new Error("Database not configured");
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cutoff = (hours: number) => new Date(now - hours * 60 * 60 * 1_000).toISOString();
  const staleCutoff = cutoff(params.ageHours ?? STALE_RECONCILIATION_AGE_HOURS);
  const keptHold = { nowMs: now, cutoffMs: Date.parse(cutoff(params.keptHoldAgeHours ?? KEPT_HOLD_AGE_HOURS)) };
  let budget = params.limit ?? PER_RUN_ITEM_CAP;

  const items: Array<{ item: ReconciliationItemRow; kept: boolean }> = [];
  const take = (rows: ReconciliationItemRow[], kept: boolean) => {
    items.push(...rows.map((item) => ({ item, kept })));
    budget -= rows.length;
  };
  take(
    await loadItems(db, (chain) => chain.in("reason", SWEEPABLE_RECONCILIATION_REASONS), staleCutoff, budget),
    false
  );
  // Kept holds are due when their hold expires, so every open one is read,
  // oldest first; the ones not yet due are left for a later run.
  take(await loadItems(db, (chain) => chain.in("reason", KEPT_HOLD_REASONS), nowIso, budget), true);
  take(
    await loadItems(
      db,
      (chain) =>
        chain.eq("reason", RESPONSES_RECONCILIATION_REASON).in("metadata->>cause", RESPONSES_AFTER_200_CAUSES),
      nowIso,
      budget
    ),
    true
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
    if (result.disposition === "released_failed_request") {
      summary.releasedReservations += 1;
      summary.totalReleasedMicroUsd += result.releasedMicroUsd;
    }
    if (result.disposition === "capture_failed" || result.disposition === "release_failed") summary.failed += 1;
    if (result.disposition === "left_for_open_item") summary.heldForOpenItem += 1;
  };

  for (const { item, kept } of items) {
    const sweptAt = new Date().toISOString();
    const result = await settleItem(db, item, sweptAt, kept ? keptHold : null);
    count(result);
    // A failed capture or release, or a kept hold not yet due, keeps its item
    // open for a later run.
    if (!OPEN_DISPOSITIONS.has(result.disposition)) {
      await closeItem(db, item, result, sweptAt);
      summary.closed += 1;
    }
  }

  const expired = await loadExpiredHolds(db, nowIso, Math.max(0, budget));
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
