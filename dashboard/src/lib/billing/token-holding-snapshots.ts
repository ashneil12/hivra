import {
  HERMESOS_TOKEN_ADDRESS,
  VVV_TOKEN_ADDRESS,
  normalizeNumericToBigIntString,
} from "@/lib/billing/token-holdings";
import { supabaseAdmin } from "@/lib/supabase";

interface SnapshotRow {
  user_id: string;
  balance_raw: string;
}

type SnapshotReaderDb = {
  from: (name: string) => unknown;
};

type SnapshotQuery = {
  select: (...args: unknown[]) => SnapshotQuery;
  in: (...args: unknown[]) => SnapshotQuery;
  eq: (...args: unknown[]) => SnapshotQuery;
  order: (...args: unknown[]) => Promise<{ data: unknown; error: unknown }>;
};

async function fetchLatestSnapshotsByUserForToken(
  tokenAddress: string,
  userIds: string[],
  db: SnapshotReaderDb | null | undefined
): Promise<Map<string, bigint>> {
  const map = new Map<string, bigint>();
  if (!db || userIds.length === 0) return map;

  // Read the latest row per user_id for a SPECIFIC token address so the
  // Hivra tier balance and the VVV boost balance can never be mistaken
  // for one another.
  const { data, error } = await (db.from("token_holding_snapshots") as SnapshotQuery)
    // ::text casts the numeric(78,0) column to text at the database
    // level so PostgREST ships it as a precise digit string. Without
    // the cast, PostgREST emits a JSON number; values > 2^53 lose
    // precision (e.g. 5e23 -> 499999999999999991611392).
    .select("user_id, balance_raw::text, checked_at")
    .in("user_id", userIds)
    .eq("token_address", tokenAddress)
    .order("checked_at", { ascending: false });

  if (error || !Array.isArray(data)) return map;

  for (const row of data as Array<SnapshotRow & { checked_at: string }>) {
    if (map.has(row.user_id)) continue;
    try {
      map.set(row.user_id, BigInt(normalizeNumericToBigIntString(row.balance_raw)));
    } catch {
      // Skip malformed snapshot rows; the caller treats a missing balance
      // as "do not evaluate this user" for that cron tick.
    }
  }
  return map;
}

export async function fetchLatestHermesSnapshotsByUser(
  userIds: string[],
  db: SnapshotReaderDb | null | undefined = supabaseAdmin
): Promise<Map<string, bigint>> {
  return fetchLatestSnapshotsByUserForToken(HERMESOS_TOKEN_ADDRESS, userIds, db);
}

/**
 * Latest VVV (Venice token) balance per user, in raw base units. Used by
 * the compute-boost evaluator to value a holding against the $199 threshold.
 */
export async function fetchLatestVvvSnapshotsByUser(
  userIds: string[],
  db: SnapshotReaderDb | null | undefined = supabaseAdmin
): Promise<Map<string, bigint>> {
  return fetchLatestSnapshotsByUserForToken(VVV_TOKEN_ADDRESS, userIds, db);
}
