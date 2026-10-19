import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

const LOG_SOURCE = "orphaned-instances";

export const ORPHAN_GRACE_HOURS = 72;

export interface OrphanedInstanceRow {
  id: string;
  user_id: string;
  name: string | null;
  status: string;
  backend: string | null;
  infrastructure_provider?: string | null;
  hetzner_server_id: number | null;
  host_id: string | null;
  proxmox_node?: string | null;
  proxmox_vmid?: number | null;
  config: Record<string, unknown> | null;
  created_at: string;
  updated_at?: string;
  scheduled_deletion_at?: string | null;
}

type OrphanCheckStatus = "alive" | "orphan" | "lookup-failed";

export interface OrphanCheck<T = OrphanedInstanceRow> {
  row: T;
  status: OrphanCheckStatus;
  detail?: string;
}

export interface OrphanSweepSummary {
  totalChecked: number;
  alive: number;
  orphans: number;
  lookupFailures: number;
  /**
   * Newly-detected orphans this run — rows where we set owner_orphaned, shut
   * down the VM, and scheduled deletion. Already-flagged rows are not
   * re-counted.
   */
  newlyDisabled: number;
  /** Rows that failed to shut down (Hetzner API errored); deletion was still scheduled. */
  shutdownFailures: number;
  orphanIds: string[];
}

export interface ClerkUserLookup {
  /**
   * Batch-resolve Clerk users by id. Returns only the users that EXIST, so an
   * id present in `data` = alive, absent = the owner was deleted (orphan).
   * Matches the shape of clerkClient().users.getUserList.
   */
  getUserList: (params: {
    userId: string[];
    limit?: number;
  }) => Promise<{ data: Array<{ id: string }> }>;
}

export interface InstanceShutdownResult {
  ok: boolean;
  /** Human-readable detail when ok=false. Surfaced in the ops_event metadata. */
  detail?: string;
  /** True if the row was deliberately skipped (e.g. shared host) — counted separately from real failures. */
  skipped?: boolean;
}

/**
 * Shut down the runtime backing this orphan row. Implementation lives in the
 * cron route (which knows about Hetzner / Proxmox helpers); the helper just
 * calls back into it. The function MUST be safe with shared-host rows —
 * orphaning one tenant on a multi-tenant host should not power-off the
 * shared server, since that would take its other tenants offline too.
 */
export type InstanceShutdownFn = (
  row: OrphanedInstanceRow,
) => Promise<InstanceShutdownResult>;

export async function listLiveInstances(
  supabase: SupabaseClient,
  filter?: { instanceId?: string | null; userId?: string },
): Promise<OrphanedInstanceRow[]> {
  const columns =
    "id, user_id, name, status, lifecycle_state, backend, infrastructure_provider, hetzner_server_id, host_id, proxmox_node, proxmox_vmid, config, created_at, updated_at, scheduled_deletion_at";
  // Keyset-paginate by id. PostgREST caps a single response (~1000 rows) — the
  // sweep previously relied on that implicit cap and so SILENTLY classified
  // only the first page on a >1000-row fleet (~1600 today), leaving the rest of
  // the fleet's orphans permanently undetected. Page until the table is fully
  // walked; keyset (.gt id) is stable under concurrent writes.
  const pageSize = 1000;
  const rows: OrphanedInstanceRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = supabase
      .from("hermes_instances")
      .select(columns)
      // status='deleted' is terminal for the sweep even when lifecycle_state
      // was never flipped: older delete handlers left such rows behind (see
      // 20260429082221), and re-flagging them would resurrect a deleted row as
      // scheduled_for_deletion and retry a shutdown of a server that is gone.
      .neq("status", "deleted");
    if (filter?.instanceId) {
      query = query.eq("id", filter.instanceId);
    }
    if (filter?.userId) {
      query = query.eq("user_id", filter.userId);
    }
    if (cursor) {
      query = query.gt("id", cursor);
    }
    query = query.order("id", { ascending: true }).limit(pageSize);
    const { data, error } = await query;
    if (error) throw new Error(`hermes_instances list failed: ${error.message}`);
    const page = (data || []) as OrphanedInstanceRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }
  return rows;
}

export async function classifyByClerkOwnership<T extends { user_id: string }>(
  rows: T[],
  clerk: ClerkUserLookup,
): Promise<OrphanCheck<T>[]> {
  // Resolve ownership per DISTINCT user via batched Clerk lookups instead of
  // one sequential getUser per instance. The old loop was N sequential Clerk
  // round-trips over the whole live fleet, keyed per-INSTANCE (a user with 5
  // instances = 5 identical calls) — at ~1600 instances that is minutes of
  // serial network wall time that grows with the fleet. getUserList resolves up
  // to ~500 ids per call, so this collapses to a handful of batch calls keyed
  // per distinct owner.
  const distinctUserIds = [...new Set(rows.map((r) => r.user_id).filter((id) => /^user_[a-zA-Z0-9]+$/.test(id)))];
  const ownerStatus = new Map<string, OrphanCheckStatus>();
  const ownerDetail = new Map<string, string>();
  const CHUNK = 100;

  for (let i = 0; i < distinctUserIds.length; i += CHUNK) {
    const chunk = distinctUserIds.slice(i, i + CHUNK);
    try {
      const res = await clerk.getUserList({ userId: chunk, limit: chunk.length });
      const alive = new Set(res.data.map((u) => u.id));
      for (const id of chunk) {
        ownerStatus.set(id, alive.has(id) ? "alive" : "orphan");
      }
    } catch (err) {
      // Fail SAFE: a batch error means we could not confirm these owners, so
      // mark them lookup-failed (NOT orphan) — we must never schedule deletion
      // for a user we couldn't verify. Transient Clerk errors resolve next run.
      const detail = err instanceof Error ? err.message : String(err);
      for (const id of chunk) {
        ownerStatus.set(id, "lookup-failed");
        ownerDetail.set(id, detail);
      }
    }
  }

  return rows.map((row) => {
    const status = ownerStatus.get(row.user_id) ?? "lookup-failed";
    return status === "alive"
      ? { row, status }
      : { row, status, detail: ownerDetail.get(row.user_id) };
  });
}

export function alreadyFlagged(row: OrphanedInstanceRow): boolean {
  return Boolean(
    (row.config as { owner_orphaned?: boolean } | null)?.owner_orphaned,
  );
}

interface DisableOrphanResult {
  shutdownOk: boolean;
  shutdownSkipped: boolean;
  shutdownDetail?: string;
  persisted: boolean;
}

/**
 * Disable a newly-detected orphan: shut down its VM via the caller-supplied
 * shutdown function (best-effort), mark `config.owner_orphaned`, and set
 * `status='scheduled_for_deletion'` with `scheduled_deletion_at = now +
 * graceHours`. The existing `/api/cron/purge-expired` route handles the
 * actual teardown when the deadline passes.
 *
 * The supabase update happens regardless of shutdown success — we always
 * want the row marked, even if the underlying provider is having a bad
 * afternoon and the VM stays up for an extra hour.
 */
async function disableOrphanedInstance(params: {
  supabase: SupabaseClient;
  row: OrphanedInstanceRow;
  graceHours: number;
  shutdownInstance?: InstanceShutdownFn;
}): Promise<DisableOrphanResult> {
  const { supabase, row, graceHours, shutdownInstance } = params;

  let shutdownOk = false;
  let shutdownSkipped = false;
  let shutdownDetail: string | undefined;
  if (shutdownInstance) {
    try {
      const result = await shutdownInstance(row);
      shutdownOk = result.ok;
      shutdownSkipped = Boolean(result.skipped);
      shutdownDetail = result.detail;
      if (!shutdownOk && !shutdownSkipped) {
        log.warn("orphan VM shutdown failed; scheduling deletion anyway", {
          source: LOG_SOURCE,
          failureType: "orphan_shutdown_failed",
          instanceId: row.id,
          userId: row.user_id,
          detail: shutdownDetail,
        });
      }
    } catch (err) {
      shutdownOk = false;
      shutdownDetail = err instanceof Error ? err.message : String(err);
      log.warn(
        "orphan VM shutdown threw; scheduling deletion anyway",
        {
          source: LOG_SOURCE,
          failureType: "orphan_shutdown_failed",
          instanceId: row.id,
          userId: row.user_id,
        },
        err,
      );
    }
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const scheduledDeletionAt = row.scheduled_deletion_at || new Date(
    now.getTime() + graceHours * 60 * 60 * 1000,
  ).toISOString();

  const wasFlagged = alreadyFlagged(row);
  const nextConfig = {
    ...(row.config || {}),
    owner_orphaned: true,
    owner_orphaned_at: row.config?.owner_orphaned_at || nowIso,
    owner_orphaned_shutdown_ok: shutdownOk,
    owner_orphaned_shutdown_checked_at: nowIso,
  };

  let update = supabase
    .from("hermes_instances")
    .update({
      config: nextConfig,
      status: "scheduled_for_deletion",
      ...(!wasFlagged ? { scheduled_deletion_at: scheduledDeletionAt } : {}),
      updated_at: nowIso,
    })
    .eq("id", row.id).eq("user_id", row.user_id).eq("status", row.status);
  if (row.updated_at) update = update.eq("updated_at", row.updated_at);
  const { data, error } = await update.select("id");
  if (error) {
    throw new Error(`Failed to mark ${row.id} for deletion: ${error.message}`);
  }

  return { shutdownOk: Boolean(data?.length) && shutdownOk, shutdownSkipped, shutdownDetail, persisted: Boolean(data?.length) };
}

export interface RunOrphanSweepOptions {
  supabase: SupabaseClient;
  clerk: ClerkUserLookup;
  apply: boolean;
  filter?: { instanceId?: string | null; userId?: string };
  /** Hours of grace before purge-expired tears down the VM. Defaults to 72 (3 days). */
  graceHours?: number;
  maxCandidates?: number;
  now?: Date;
  /**
   * Caller-provided shutdown for the per-row runtime. Optional so the script
   * CLI can no-op shutdowns in dry-run. The function MUST be safe with
   * shared-host rows — orphaning one tenant on a multi-tenant host should
   * not power-off the shared server.
   */
  shutdownInstance?: InstanceShutdownFn;
}

/**
 * Sweep hermes_instances for rows whose Clerk owner has been deleted.
 *
 * When `apply` is true, each newly-discovered orphan gets:
 *   1. Hetzner VM shutdown (best-effort, doesn't block on failure)
 *   2. `status = 'scheduled_for_deletion'` + `scheduled_deletion_at = now + graceHours`
 *   3. `config.owner_orphaned = true` (jsonb flag — no migration needed)
 *   4. An ops_events entry so it surfaces in the audit feed
 *
 * The existing `/api/cron/purge-expired` route picks up the row when the
 * deadline passes (3 days by default) and runs the actual `deleteServer`
 * + `status='deleted'` teardown.
 *
 * Previously flagged rows are checked again without resetting their deadline.
 * A failed shutdown or a restarted VM must not remain live until erasure.
 *
 * The function distinguishes "orphan" (Clerk 404 — owner really gone)
 * from "lookup-failed" (network / rate-limit / 5xx — Clerk is just
 * unhappy right now). We only act on the former; transient failures
 * resolve on their own when Clerk recovers.
 */
export async function runOrphanSweep(
  options: RunOrphanSweepOptions,
): Promise<OrphanSweepSummary> {
  const {
    supabase,
    clerk,
    apply,
    filter,
    graceHours = ORPHAN_GRACE_HOURS,
    shutdownInstance,
    maxCandidates = Number.MAX_SAFE_INTEGER,
    now = new Date(),
  } = options;
  const rows = await listLiveInstances(supabase, filter);
  const checks = await classifyByClerkOwnership(rows, clerk);

  const orphans = checks.filter((c) => c.status === "orphan");
  const lookupFailures = checks.filter((c) => c.status === "lookup-failed");

  let newlyDisabled = 0;
  let shutdownFailures = 0;
  if (apply) {
    // Rotate a bounded window on each scheduled tick, including failures, so
    // one unreachable host cannot keep later orphans out of the sweep forever.
    const candidates = rotatingContainmentBatch(orphans, maxCandidates, now);
    for (const orphan of candidates) {
      const wasFlagged = alreadyFlagged(orphan.row);
      const { shutdownOk, shutdownSkipped, shutdownDetail, persisted } =
        await disableOrphanedInstance({
          supabase,
          row: orphan.row,
          graceHours,
          shutdownInstance,
        });
      if (!wasFlagged && persisted) newlyDisabled += 1;
      if (!shutdownOk) shutdownFailures += 1;

      const messagePrefix = shutdownOk
        ? "VM shut down."
        : shutdownSkipped
          ? `VM shutdown skipped (${shutdownDetail ?? "shared host"}).`
          : `VM shutdown failed (${shutdownDetail ?? "unknown"}).`;
      await reportOpsEvent({
        source: LOG_SOURCE,
        severity: "warn",
        title: "Hermes instance owner is gone from Clerk",
        message: `${messagePrefix} Scheduled for deletion in ${graceHours}h.`,
        instanceId: orphan.row.id,
        userId: orphan.row.user_id,
        metadata: {
          name: orphan.row.name,
          previous_status: orphan.row.status,
          backend: orphan.row.backend,
          hetzner_server_id: orphan.row.hetzner_server_id,
          host_id: orphan.row.host_id,
          created_at: orphan.row.created_at,
          grace_hours: graceHours,
          shutdown_ok: shutdownOk,
          shutdown_skipped: shutdownSkipped,
          ...(shutdownDetail ? { shutdown_detail: shutdownDetail } : {}),
        },
      });
    }
  }

  return {
    totalChecked: checks.length,
    alive: checks.length - orphans.length - lookupFailures.length,
    orphans: orphans.length,
    lookupFailures: lookupFailures.length,
    newlyDisabled,
    shutdownFailures,
    orphanIds: orphans.map((c) => c.row.id),
  };
}

export function rotatingContainmentBatch<T>(rows: T[], limit: number, now = new Date()): T[] {
  if (rows.length <= limit) return rows;
  const size = Math.max(1, Math.floor(limit));
  const offset = (Math.floor(now.getTime() / (15 * 60_000)) * size) % rows.length;
  return Array.from({ length: Math.min(size, rows.length) }, (_, index) => rows[(offset + index) % rows.length]);
}

export type OrphanComputerRow = { id: string; user_id: string; status: string };
export async function listLiveComputers(supabase: SupabaseClient, userId?: string): Promise<OrphanComputerRow[]> {
  const out: OrphanComputerRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    let query = supabase.from("hivra_agents").select("id,user_id,status").neq("status", "deleted").order("id").limit(500);
    if (userId) query = query.eq("user_id", userId);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw new Error(`Computer inventory unavailable: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 500) return out;
    cursor = data[data.length - 1].id;
  }
}
