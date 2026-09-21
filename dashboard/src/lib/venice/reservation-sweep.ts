import {
  loadManagedVeniceReservation,
  releaseManagedVeniceReservation,
} from "@/lib/billing/managed-venice-wallets";
import { supabaseAdmin } from "@/lib/supabase";

type QueryError = { message?: string } | null;

type SupabaseLike = { from: (table: string) => unknown };

// Reconciliation-item reasons that signal "Venice returned 200 but we could
// not settle the request from its usage telemetry" — a missing SSE usage
// frame, a settlement insert that threw, or a non-streaming response with no
// usage block. Every one of those paths files a reconciliation item with
// pauseKey:false and leaves the reservation hold *active*: the stream's
// controller.close()/controller.error() never fires the cancel() callback
// that would release it. So the held estimate sits on the wallet forever,
// silently shrinking the user's available balance. These are the items the
// sweep is allowed to resolve.
//
// Deliberately excludes `managed_venice_overage_uncovered`: that path already
// captured the reservation and represents genuinely unpaid usage we mean to
// collect (and which legitimately pauses the key) — not a telemetry gap.
export const SWEEPABLE_RECONCILIATION_REASONS = [
  "managed_venice_missing_stream_usage",
  "managed_venice_stream_settlement_failed",
  "managed_venice_missing_usage",
] as const;

// A chat request that returned 200 is definitively finished within seconds,
// so a hold still active hours later is stranded, not in-flight. 6h is far
// past any plausible slow stream, so releasing can't race a live settlement.
const STALE_RECONCILIATION_AGE_HOURS = 6;

const PER_RUN_ITEM_CAP = 500;

interface ReconciliationItemRow {
  id: string;
  user_id: string;
  reason: string;
  status: string;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
}

type SweepDisposition =
  | "released_stale_reservation"
  | "reservation_already_captured"
  | "reservation_already_released"
  | "reservation_not_found"
  | "missing_reference_id";

interface ReservationSweepResult {
  itemId: string;
  userId: string;
  reason: string;
  referenceId: string | null;
  disposition: SweepDisposition;
  releasedMicroUsd: number;
}

export interface ReservationSweepSummary {
  scanned: number;
  closed: number;
  releasedReservations: number;
  totalReleasedMicroUsd: number;
  results: ReservationSweepResult[];
}

type ItemSelectChain = {
  select: (cols: string) => {
    eq: (col: string, val: string) => {
      in: (col: string, vals: readonly string[]) => {
        lt: (col: string, val: string) => {
          order: (col: string, opts: { ascending: boolean }) => {
            limit: (n: number) => Promise<{ data: unknown; error: QueryError }>;
          };
        };
      };
    };
  };
};

type ItemUpdateChain = {
  update: (patch: Record<string, unknown>) => {
    eq: (col: string, val: string) => Promise<{ error: QueryError }>;
  };
};

function readReferenceId(metadata: Record<string, unknown> | null): string | null {
  const ref = metadata?.referenceId;
  return typeof ref === "string" && ref.trim() ? ref : null;
}

async function loadStaleItems(
  db: SupabaseLike,
  cutoff: string,
  limit: number
): Promise<ReconciliationItemRow[]> {
  const { data, error } = await (db.from(
    "managed_venice_reconciliation_items"
  ) as unknown as ItemSelectChain)
    .select("id, user_id, reason, status, metadata, created_at")
    .eq("status", "open")
    .in("reason", SWEEPABLE_RECONCILIATION_REASONS)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(error.message || "Failed to load managed Venice reconciliation items");
  }
  return Array.isArray(data) ? (data as ReconciliationItemRow[]) : [];
}

async function closeItem(
  db: SupabaseLike,
  item: ReconciliationItemRow,
  disposition: SweepDisposition,
  releasedMicroUsd: number,
  referenceId: string | null
): Promise<void> {
  const sweptAt = new Date().toISOString();
  const note =
    `Closed by reservation sweep: ${disposition}` +
    (releasedMicroUsd > 0 ? ` (released ${releasedMicroUsd} µUSD hold)` : "");

  const { error } = await (db.from(
    "managed_venice_reconciliation_items"
  ) as unknown as ItemUpdateChain)
    .update({
      status: "ignored",
      resolved_at: sweptAt,
      operator_notes: note,
      metadata: {
        ...(item.metadata || {}),
        sweep: {
          disposition,
          releasedMicroUsd,
          referenceId,
          sweptAt,
        },
      },
    })
    .eq("id", item.id);

  if (error) {
    throw new Error(error.message || "Failed to close managed Venice reconciliation item");
  }
}

/**
 * Release stranded reservation holds for managed-Venice requests that
 * returned 200 but whose usage telemetry was missing/garbled, then close the
 * reconciliation items that flagged them. Without this, a hold filed by
 * {@link SWEEPABLE_RECONCILIATION_REASONS} stays active indefinitely and the
 * user's available balance shrinks for usage we never billed.
 *
 * We release rather than capture: there is no usage data to compute an actual
 * cost, the hold is only a defensive over-estimate, and we'd rather eat the
 * (rare, low-volume) Venice cost than over-bill a paying customer for a gap
 * that is Venice's, not theirs. Idempotent: closed items drop out of the
 * scan, and release is a no-op once the reservation is no longer active.
 */
export async function sweepStaleManagedVeniceReservations(
  params: { ageHours?: number; limit?: number } = {},
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ReservationSweepSummary> {
  if (!db) throw new Error("Database not configured");
  const ageHours = params.ageHours ?? STALE_RECONCILIATION_AGE_HOURS;
  const limit = params.limit ?? PER_RUN_ITEM_CAP;
  const cutoff = new Date(Date.now() - ageHours * 60 * 60 * 1_000).toISOString();

  const items = await loadStaleItems(db, cutoff, limit);
  const results: ReservationSweepResult[] = [];
  let releasedReservations = 0;
  let totalReleasedMicroUsd = 0;

  for (const item of items) {
    const referenceId = readReferenceId(item.metadata);
    let disposition: SweepDisposition;
    let releasedMicroUsd = 0;

    if (!referenceId) {
      disposition = "missing_reference_id";
    } else {
      const reservation = await loadManagedVeniceReservation(item.user_id, referenceId, db);
      if (!reservation) {
        disposition = "reservation_not_found";
      } else if (reservation.status === "captured") {
        disposition = "reservation_already_captured";
      } else if (reservation.status !== "active") {
        disposition = "reservation_already_released";
      } else {
        const released = await releaseManagedVeniceReservation(
          { userId: item.user_id, referenceId },
          db
        );
        if (released.released) {
          disposition = "released_stale_reservation";
          releasedMicroUsd = released.releasedMicroUsd ?? 0;
          releasedReservations += 1;
          totalReleasedMicroUsd += releasedMicroUsd;
        } else {
          // Lost a race: the reservation was resolved between our load and
          // our release. Treat it as already released and close the item.
          disposition = "reservation_already_released";
        }
      }
    }

    await closeItem(db, item, disposition, releasedMicroUsd, referenceId);
    results.push({
      itemId: item.id,
      userId: item.user_id,
      reason: item.reason,
      referenceId,
      disposition,
      releasedMicroUsd,
    });
  }

  return {
    scanned: items.length,
    closed: results.length,
    releasedReservations,
    totalReleasedMicroUsd,
    results,
  };
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
