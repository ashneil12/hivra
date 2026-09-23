import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Retention for Hivra agent activity records (hivra_agent_events and
 * hivra_activity_collectors). These are the content-free lifecycle events and
 * run/tool records described in
 * docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md.
 *
 * Policy (matches the Privacy Policy, section 7):
 * - Activity records are kept for ACTIVITY_RETENTION_DAYS (default 90) days.
 * - A deleted computer's records are deleted with it by the
 *   delete_hivra_activity_after_agent_delete trigger; this job also removes
 *   leftovers of computers deleted before that trigger existed.
 * - Account deletion removes all of the user's records
 *   (see ACCOUNT_DELETION_TABLES).
 *
 * The job is OFF unless ACTIVITY_RETENTION_ENABLED=true. While off, every run is
 * a dry run that only reports counts. Each run deletes at most
 * maxBatches * batchSize rows per class, so a large first backlog clears over
 * several daily runs.
 */

export const DEFAULT_ACTIVITY_RETENTION_DAYS = 90;
// Guards against a mistyped env value ("0", "1") wiping recent history.
export const MIN_ACTIVITY_RETENTION_DAYS = 30;
export const DEFAULT_ACTIVITY_RETENTION_BATCH_SIZE = 5000;
export const DEFAULT_ACTIVITY_RETENTION_MAX_BATCHES = 20;

export interface ActivityRetentionConfig {
  enabled: boolean;
  retentionDays: number;
}

export interface ActivityRetentionCounts {
  expiredEvents: number;
  deletedComputerEvents: number;
  deletedComputerCollectors: number;
}

export interface ActivityRetentionSummary {
  dryRun: boolean;
  enabled: boolean;
  retentionDays: number;
  cutoff: string;
  /** Rows eligible for deletion when the run started. */
  eligible: ActivityRetentionCounts;
  /** Rows actually deleted (always zero on a dry run). */
  deleted: ActivityRetentionCounts;
  batches: number;
  /** False when the batch cap stopped the run before the backlog was empty. */
  complete: boolean;
}

export function resolveActivityRetentionConfig(
  env: Record<string, string | undefined> = process.env
): ActivityRetentionConfig {
  const enabled = env.ACTIVITY_RETENTION_ENABLED?.trim().toLowerCase() === "true";
  const raw = env.ACTIVITY_RETENTION_DAYS?.trim();
  const parsed = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
  const retentionDays = Number.isFinite(parsed)
    ? Math.max(parsed, MIN_ACTIVITY_RETENTION_DAYS)
    : DEFAULT_ACTIVITY_RETENTION_DAYS;
  return { enabled, retentionDays };
}

export function activityRetentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

const ZERO: ActivityRetentionCounts = {
  expiredEvents: 0,
  deletedComputerEvents: 0,
  deletedComputerCollectors: 0,
};

function parseCounts(data: unknown): ActivityRetentionCounts {
  const row = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const num = (key: keyof ActivityRetentionCounts): number => {
    const value = Number(row[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`prune_hivra_activity returned an invalid ${key}`);
    }
    return value;
  };
  return {
    expiredEvents: num("expiredEvents"),
    deletedComputerEvents: num("deletedComputerEvents"),
    deletedComputerCollectors: num("deletedComputerCollectors"),
  };
}

async function callPrune(
  client: SupabaseClient,
  cutoff: Date,
  batchSize: number,
  dryRun: boolean
): Promise<ActivityRetentionCounts> {
  const { data, error } = await client.rpc("prune_hivra_activity", {
    p_cutoff: cutoff.toISOString(),
    p_batch_size: batchSize,
    p_dry_run: dryRun,
  });
  if (error) throw new Error(`prune_hivra_activity failed: ${error.message}`);
  return parseCounts(data);
}

export async function runActivityRetention(
  client: SupabaseClient,
  options: {
    config?: ActivityRetentionConfig;
    forceDryRun?: boolean;
    now?: Date;
    batchSize?: number;
    maxBatches?: number;
  } = {}
): Promise<ActivityRetentionSummary> {
  const config = options.config ?? resolveActivityRetentionConfig();
  const dryRun = !config.enabled || options.forceDryRun === true;
  const batchSize = options.batchSize ?? DEFAULT_ACTIVITY_RETENTION_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_ACTIVITY_RETENTION_MAX_BATCHES;
  const cutoff = activityRetentionCutoff(options.now ?? new Date(), config.retentionDays);

  const eligible = await callPrune(client, cutoff, batchSize, true);
  const deleted = { ...ZERO };
  let batches = 0;
  let complete = true;

  if (!dryRun) {
    complete = false;
    while (batches < maxBatches) {
      const batch = await callPrune(client, cutoff, batchSize, false);
      batches += 1;
      deleted.expiredEvents += batch.expiredEvents;
      deleted.deletedComputerEvents += batch.deletedComputerEvents;
      deleted.deletedComputerCollectors += batch.deletedComputerCollectors;
      const fullBatch =
        batch.expiredEvents >= batchSize ||
        batch.deletedComputerEvents >= batchSize ||
        batch.deletedComputerCollectors >= batchSize;
      if (!fullBatch) {
        complete = true;
        break;
      }
    }
  }

  return {
    dryRun,
    enabled: config.enabled,
    retentionDays: config.retentionDays,
    cutoff: cutoff.toISOString(),
    eligible,
    deleted,
    batches,
    complete,
  };
}
