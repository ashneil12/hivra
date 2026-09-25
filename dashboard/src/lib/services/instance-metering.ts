/**
 * Per-instance metering service. Owns reads against and writes into
 * `public.instance_metering_events` (Sprint 0 W3 of the V2 launch). Sampling
 * cron writes raw rows; future billing reconciliation reads them via
 * {@link getInstanceMeteringRollup} to compare against Hetzner host bills
 * within the 5% tolerance the build plan calls for.
 *
 * This file is the contract surface between sampling (Proxmox-pulled
 * snapshots) and consumption (billing reconciliation, dashboard usage UI).
 * Keep it framework-agnostic — both the Vercel cron and any background job
 * can reuse it.
 */

import "server-only";

import { supabaseAdmin } from "@/lib/supabase";

/**
 * Minimal Supabase client surface this service needs. Tests pass an
 * in-memory stub matching this shape; real callers pass `supabaseAdmin`.
 */
export interface MeteringDb {
  from(table: string): {
    insert(rows: Record<string, unknown> | Record<string, unknown>[]):
      | Promise<{ error: { message?: string } | null }>
      | { select: (...args: unknown[]) => Promise<{ data: unknown; error: unknown }> };
    select(...args: unknown[]): {
      eq: (column: string, value: unknown) => {
        gte?: (column: string, value: unknown) => {
          order?: (column: string, opts?: unknown) => Promise<{ data: unknown; error: { message?: string } | null }>;
        };
        order?: (column: string, opts?: unknown) => Promise<{ data: unknown; error: { message?: string } | null }>;
      };
    };
  };
}

export interface InstanceMeteringSampleInput {
  instance_id: string;
  cpu_seconds_total: number;
  ram_peak_bytes: number;
  disk_used_bytes: number;
  /**
   * Guest filesystem total bytes (`df /`) at sample time. Optional: omit (or
   * pass 0) when the sample was not guest-sourced, and the column is left NULL.
   */
  disk_total_bytes?: number;
  runtime_seconds: number;
  net_out_bytes: number;
  source?: string;
  metadata?: Record<string, unknown>;
  /** Optional caller-supplied sample timestamp; defaults to DB `now()`. */
  sampled_at?: string;
}

export interface InstanceMeteringRollup {
  /** Total samples included in the rollup. */
  sample_count: number;
  /** Earliest sample timestamp covered (ISO). */
  first_sampled_at: string | null;
  /** Latest sample timestamp covered (ISO). */
  last_sampled_at: string | null;
  /** Cumulative CPU seconds delta — last sample minus first sample. */
  cpu_seconds_total: number;
  /** Outbound bytes delta — last sample minus first sample (cumulative counter on host). */
  net_out_bytes: number;
  /** Wall-clock runtime delta — last sample uptime minus first sample uptime. */
  runtime_seconds: number;
  /** Highest RAM observed across samples. */
  ram_peak_bytes: number;
  /** Latest disk-used observation. */
  disk_used_bytes_last: number;
  /**
   * Latest guest filesystem total (`df /` bytes) — the real disk size. 0 when
   * the latest sample was not guest-sourced. Prefers the `disk_total_bytes`
   * column on the row; falls back to the same value stored in the row's
   * JSONB `metadata` (for rows written before the column existed). The storage
   * banner uses this as the denominator; it never divides by the
   * thin-provisioned disk_size_gb.
   */
  disk_total_bytes_last: number;
  /**
   * True when the LAST sample's `disk_used_bytes` was a capacity fallback
   * (not a real usage reading), surfaced from the row's JSONB `metadata`. The
   * banner suppresses itself in this case to avoid a bogus "almost full".
   */
  disk_used_is_capacity_fallback_last: boolean;
}

export interface InstanceMeteringSampleRow {
  sampled_at: string;
  cpu_seconds_total: number | string;
  ram_peak_bytes: number | string;
  disk_used_bytes: number | string;
  disk_total_bytes?: number | string | null;
  runtime_seconds: number | string;
  net_out_bytes: number | string;
  /** JSONB blob; may arrive as an object, a JSON string, or null. */
  metadata?: Record<string, unknown> | string | null;
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Increase of a cumulative per-VM counter across time-ordered samples.
 *
 * - Samples <= 0 are "no reading" and are skipped. Every metering row written
 *   on PVE 9 before the kvm /proc CPU source landed has cpu_seconds_total = 0,
 *   and a running VM never has a real 0; treating that 0 as a baseline would
 *   turn the first real reading (CPU since VM start) into a fake spike.
 * - A drop means the VM restarted and the counter began again from 0, so the
 *   new value itself is the increase since the restart.
 */
export function cumulativeCounterIncrease(values: readonly unknown[]): number {
  let total = 0;
  let previous: number | null = null;
  for (const value of values) {
    const current = toNumber(value);
    if (current <= 0) continue;
    if (previous !== null) {
      total += current >= previous ? current - previous : current;
    }
    previous = current;
  }
  return total;
}

/**
 * Coerce a JSONB metadata field — which Supabase may hand back as an object,
 * a JSON string, or null — into a plain record. Returns {} on anything else.
 */
function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON string — ignore.
    }
  }
  return {};
}

function emptyRollup(): InstanceMeteringRollup {
  return {
    sample_count: 0,
    first_sampled_at: null,
    last_sampled_at: null,
    cpu_seconds_total: 0,
    net_out_bytes: 0,
    runtime_seconds: 0,
    ram_peak_bytes: 0,
    disk_used_bytes_last: 0,
    disk_total_bytes_last: 0,
    disk_used_is_capacity_fallback_last: false,
  };
}

/**
 * Insert a single metering sample. Idempotency is the caller's
 * responsibility — every cron tick should attempt one row per active
 * instance, and Postgres' clock-driven default for `sampled_at` keeps
 * accidental duplicates separated by their write timestamp.
 */
export async function recordInstanceMeteringSample(
  sample: InstanceMeteringSampleInput,
  db: MeteringDb | null = supabaseAdmin as unknown as MeteringDb | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!db) {
    return { ok: false, error: "Supabase admin client is not configured" };
  }

  const row: Record<string, unknown> = {
    instance_id: sample.instance_id,
    cpu_seconds_total: sample.cpu_seconds_total,
    ram_peak_bytes: Math.max(0, Math.floor(sample.ram_peak_bytes)),
    disk_used_bytes: Math.max(0, Math.floor(sample.disk_used_bytes)),
    runtime_seconds: sample.runtime_seconds,
    net_out_bytes: Math.max(0, Math.floor(sample.net_out_bytes)),
    source: sample.source ?? "proxmox",
    metadata: sample.metadata ?? {},
  };
  // Only persist a real, guest-sourced total. A missing/zero total stays NULL
  // so downstream readers (the storage banner) can tell "we don't know the
  // real disk size" apart from a genuine measurement.
  if (
    typeof sample.disk_total_bytes === "number" &&
    Number.isFinite(sample.disk_total_bytes) &&
    sample.disk_total_bytes > 0
  ) {
    row.disk_total_bytes = Math.floor(sample.disk_total_bytes);
  }
  if (sample.sampled_at) {
    row.sampled_at = sample.sampled_at;
  }

  const result = await db.from("instance_metering_events").insert(row);
  // Some Supabase builders return a thenable; await above handles both shapes.
  const error = (result as { error?: { message?: string } | null } | undefined)?.error;
  if (error) {
    return { ok: false, error: error.message || "Insert failed" };
  }
  return { ok: true };
}

/**
 * Aggregate raw metering rows for a single instance into running totals.
 *
 * Semantics:
 *   * `cpu_seconds_total`, `net_out_bytes`, `runtime_seconds` are
 *     monotonic counters on the host; we report the delta between the
 *     latest and earliest sample in the window.
 *   * `ram_peak_bytes` is the per-tick observation; the rollup picks
 *     the maximum across the window (true peak).
 *   * `disk_used_bytes_last` is the latest sample's value (disk usage
 *     fluctuates; "current" is the actionable signal for billing).
 *
 * This function is what billing reconciliation will call once per
 * billing period to compare against the Hetzner host bill.
 */
export async function getInstanceMeteringRollup(
  instanceId: string,
  since: Date | null = null,
  db: MeteringDb | null = supabaseAdmin as unknown as MeteringDb | null
): Promise<InstanceMeteringRollup> {
  if (!db) {
    return emptyRollup();
  }

  const baseSelect = db
    .from("instance_metering_events")
    .select(
      "sampled_at, cpu_seconds_total, ram_peak_bytes, disk_used_bytes, disk_total_bytes, runtime_seconds, net_out_bytes, metadata"
    )
    .eq("instance_id", instanceId);

  let query: { data?: unknown; error?: { message?: string } | null };
  if (since && typeof baseSelect.gte === "function") {
    const sinceQuery = baseSelect.gte("sampled_at", since.toISOString());
    if (sinceQuery && typeof sinceQuery.order === "function") {
      query = await sinceQuery.order("sampled_at", { ascending: true });
    } else {
      query = (await Promise.resolve(sinceQuery)) as typeof query;
    }
  } else if (typeof baseSelect.order === "function") {
    query = await baseSelect.order("sampled_at", { ascending: true });
  } else {
    query = (await Promise.resolve(baseSelect)) as typeof query;
  }

  if (query?.error) {
    throw new Error(query.error.message || "Failed to read metering rollup");
  }

  const rows: InstanceMeteringSampleRow[] = Array.isArray(query?.data)
    ? (query!.data as InstanceMeteringSampleRow[])
    : [];

  if (rows.length === 0) {
    return emptyRollup();
  }

  // Already ordered ascending; first row is the baseline.
  const first = rows[0];
  const last = rows[rows.length - 1];

  let ramPeak = 0;
  for (const row of rows) {
    const observed = toNumber(row.ram_peak_bytes);
    if (observed > ramPeak) ramPeak = observed;
  }

  // Real guest disk total + capacity-fallback flag live in the LAST sample's
  // JSONB metadata. Defensive: metadata may be null or a JSON string.
  const lastMetadata = parseMetadata(last.metadata);
  // Prefer the canonical `disk_total_bytes` column on the last row; fall back
  // to the same value carried in the row's JSONB `metadata` (for rows written
  // before the column existed). 0 => not guest-sourced => banner stays silent.
  const columnTotal = toNumber(last.disk_total_bytes);
  const diskTotalLast = columnTotal > 0 ? columnTotal : toNumber(lastMetadata.disk_total_bytes);

  return {
    sample_count: rows.length,
    first_sampled_at: first.sampled_at,
    last_sampled_at: last.sampled_at,
    cpu_seconds_total: cumulativeCounterIncrease(rows.map((row) => row.cpu_seconds_total)),
    net_out_bytes: Math.max(0, toNumber(last.net_out_bytes) - toNumber(first.net_out_bytes)),
    runtime_seconds: Math.max(0, toNumber(last.runtime_seconds) - toNumber(first.runtime_seconds)),
    ram_peak_bytes: ramPeak,
    disk_used_bytes_last: toNumber(last.disk_used_bytes),
    disk_total_bytes_last: diskTotalLast,
    disk_used_is_capacity_fallback_last:
      lastMetadata.disk_used_is_capacity_fallback === true,
  };
}
