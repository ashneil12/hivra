// The live-usage cache (public.hivra_computer_usage) behind
// GET /api/hivra/agents/[id]/usage.
//
// One host read per computer per COMPUTER_USAGE_FRESH_SECONDS, across every
// server instance: a request first serves a fresh stored observation; else it
// claims the refresh in the database (claim_hivra_computer_usage_refresh, a
// conditional update on the database clock), and only the claim's winner
// reads the host. A request that loses the claim gets the last observation
// marked as refreshing. Within one instance, concurrent winners for the same
// computer also share one read (singleFlightUsageRead).

import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { COMPUTER_USAGE_FRESH_SECONDS, type ComputerUsageSource } from "@/lib/hivra/computer-usage-contract";

/** How long a claim holds off other readers; also bounds retries after a failed read. */
export const COMPUTER_USAGE_CLAIM_SECONDS = 20;

/** Error codes the cache keeps, for the next cached read. */
export type ComputerUsageErrorCode = "host_unreachable" | "binding_mismatch" | "probe_invalid" | "context_unavailable";

export interface ComputerUsageCacheRow {
  sample: unknown;
  observedAt: string | null;
  lastErrorCode: string | null;
}

export class ComputerUsageCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerUsageCacheError";
  }
}

function db() {
  if (!supabaseAdmin) throw new ComputerUsageCacheError("database_unavailable");
  return supabaseAdmin;
}

function cacheRow(value: unknown): ComputerUsageCacheRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return {
    sample: row.sample ?? null,
    observedAt: typeof row.observedAt === "string" ? row.observedAt : null,
    lastErrorCode: typeof row.lastErrorCode === "string" ? row.lastErrorCode : null,
  };
}

/** The stored observation for one owner's computer, or null when there is none yet. */
export async function readComputerUsageCache(agentId: string, userId: string): Promise<ComputerUsageCacheRow | null> {
  const { data, error } = await db()
    .from("hivra_computer_usage")
    .select("sample, observed_at, last_error_code")
    .eq("agent_id", agentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new ComputerUsageCacheError("cache_read_failed");
  if (!data) return null;
  const row = data as { sample?: unknown; observed_at?: unknown; last_error_code?: unknown };
  return {
    sample: row.sample ?? null,
    observedAt: typeof row.observed_at === "string" ? row.observed_at : null,
    lastErrorCode: typeof row.last_error_code === "string" ? row.last_error_code : null,
  };
}

/**
 * Claim the next host read. `force` skips the freshness check (the stored
 * observation predates the computer's last state change); the claim itself
 * still admits one reader at a time.
 */
export async function claimComputerUsageRefresh(input: {
  agentId: string;
  userId: string;
  source: ComputerUsageSource;
  force: boolean;
}): Promise<{ claimed: boolean; row: ComputerUsageCacheRow | null }> {
  const { data, error } = await db().rpc("claim_hivra_computer_usage_refresh", {
    p_agent_id: input.agentId,
    p_user_id: input.userId,
    p_source: input.source,
    p_fresh_seconds: input.force ? 0 : COMPUTER_USAGE_FRESH_SECONDS,
    p_claim_seconds: COMPUTER_USAGE_CLAIM_SECONDS,
  });
  if (error) throw new ComputerUsageCacheError("cache_claim_failed");
  const claimed = Boolean(data && typeof data === "object" && (data as { claimed?: unknown }).claimed === true);
  return { claimed, row: cacheRow(data) };
}

/**
 * Save a read. A sample replaces the observation and releases the claim; an
 * error keeps the claim until it expires, so a failing host isn't retried by
 * every request. `clearSample` drops the observation (the computer's identity
 * no longer checks out, so its old numbers mustn't be shown).
 */
export async function recordComputerUsage(input: {
  agentId: string;
  userId: string;
  sample: unknown | null;
  errorCode: ComputerUsageErrorCode | null;
  clearSample?: boolean;
}): Promise<ComputerUsageCacheRow | null> {
  const { data, error } = await db().rpc("record_hivra_computer_usage", {
    p_agent_id: input.agentId,
    p_user_id: input.userId,
    p_sample: input.sample,
    p_error_code: input.errorCode,
    p_clear_sample: input.clearSample === true,
  });
  if (error) throw new ComputerUsageCacheError("cache_record_failed");
  return cacheRow(data);
}

const inFlight = new Map<string, Promise<unknown>>();

/** One host read per computer at a time in this server instance. */
export function singleFlightUsageRead<T>(agentId: string, read: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(agentId);
  if (existing) return existing as Promise<T>;
  const pending = read().finally(() => {
    if (inFlight.get(agentId) === pending) inFlight.delete(agentId);
  });
  inFlight.set(agentId, pending);
  return pending;
}
