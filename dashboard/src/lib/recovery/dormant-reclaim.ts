import "server-only";

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { removeInstanceDnsBestEffort } from "@/lib/services/cloudflare-dns";
import {
  archiveProxmoxDormantInstance,
  deleteProxmoxInstance,
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
  removeProxmoxDormantArchive,
  type ProxmoxInfrastructure,
} from "@/lib/services/proxmox-instance-service";
import { DORMANT_ARCHIVE_NOT_STOPPED_MARKER } from "@/lib/services/proxmox/script-builders";
import { stripProxmoxInfrastructure } from "@/lib/services/proxmox-infrastructure";

const LOG_SOURCE = "dormant-reclaim";
const DEFAULT_RECLAIM_AFTER_DAYS = 7;
const DEFAULT_BATCH_LIMIT = 10;

type ProxmoxHostRoutingConfigArg = Parameters<typeof removeProxmoxDormantArchive>[1]["hostConfig"];

type DormantCandidate = {
  id: string;
  user_id: string;
  name: string | null;
  status: string | null;
  lifecycle_state: string | null;
  paused_reason: string | null;
  resource_tier: string | null;
  host_id: string | null;
  infrastructure_provider: string | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  gateway_url: string | null;
  subdomain: string | null;
  config: Record<string, unknown> | null;
  created_at: string | null;
  last_activity_at: string | null;
  last_lifecycle_transition_at: string | null;
  updated_at: string | null;
  cpu_limit: number | null;
  ram_limit: number | null;
  disk_size_gb: number | null;
};

// Matches the marker buildProxmoxDeleteScript prints when refuseIfRunning
// refuses a guest that is running.
const DELETE_RUNNING_REFUSED_MARKER = "HERMES_PROXMOX_DELETE_VM_RUNNING_REFUSED";

export type DormantReclaimSummary = {
  enabled: boolean;
  commit: boolean;
  scanned: number;
  archived: number;
  reclaimed: number;
  skipped: number;
  failed: number;
  reclaimAfterDays: number;
};

type RunDormantReclaimOptions = {
  now?: Date;
};

function readBooleanEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

// Agent-side activity guard (mirrors inactivity-sweep). A row reaches this sweep
// already paused-by-inactivity, but the inactivity-sweep that paused it could only
// see dashboard-originated activity. If instance_usage_snapshots shows the agent ran
// sessions in the days before it was paused (Telegram/Discord/standalone-webui use),
// the pause was a false positive and we must NOT destructively archive + delete the
// VM — leave the row paused so the user can wake it. Day-granular (stat_date is a
// DATE). Look back AGENT_USAGE_LOOKBACK_DAYS from the pause moment.
const AGENT_USAGE_LOOKBACK_DAYS = 7;

async function hadAgentUsageBeforePause(
  candidate: DormantCandidate
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  // Anchor the look-back on the transition that paused the row; fall back to
  // created_at, then now, so a missing timestamp never silently disables the guard.
  const pausedAtMs =
    Date.parse(candidate.last_lifecycle_transition_at ?? "") ||
    Date.parse(candidate.created_at ?? "") ||
    Date.now();
  const sinceDay = new Date(pausedAtMs - AGENT_USAGE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const { data, error } = await supabaseAdmin
    .from("instance_usage_snapshots")
    .select("instance_id")
    .eq("instance_id", candidate.id)
    .gt("sessions", 0)
    .gte("stat_date", sinceDay)
    .limit(1);

  if (error) {
    // Fail CLOSED: an unreadable usage signal means we can't prove the pause was
    // genuine, and dormant-reclaim's action (archive + qm destroy + DNS removal)
    // is irreversible-in-place. Treat as "had usage" to skip the destructive path.
    log.warn("dormant reclaim could not read agent-side usage; skipping to be safe", {
      source: LOG_SOURCE,
      instanceId: candidate.id,
      userId: candidate.user_id,
      failureType: "dormant_reclaim_agent_usage_unreadable",
      errorMessage: error.message,
    });
    return true;
  }

  return (data?.length ?? 0) > 0;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function extractArchivePath(stdout: string): string | null {
  const match = stdout.match(/^HERMES_DORMANT_ARCHIVE_PATH=(.+)$/m);
  const path = match?.[1]?.trim();
  return path || null;
}

function extractArchiveSizeBytes(stdout: string): number | null {
  const match = stdout.match(/^HERMES_DORMANT_ARCHIVE_SIZE_BYTES=(\d+)$/m);
  const size = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function parseGatewayHost(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

function resolveCandidateInfrastructure(
  candidate: DormantCandidate
): ProxmoxInfrastructure | null {
  const configInfra = getProxmoxInfrastructure(candidate.config);
  if (configInfra) return configInfra;

  if (!candidate.proxmox_node || !candidate.proxmox_vmid) {
    return null;
  }

  const gatewayHost = parseGatewayHost(candidate.gateway_url) ?? candidate.subdomain;
  if (!gatewayHost) {
    return null;
  }

  return {
    provider: "proxmox",
    node: candidate.proxmox_node,
    vmid: candidate.proxmox_vmid,
    privateIpv4: "",
    gatewayHost,
  };
}

async function fetchDormantCandidates(cutoffIso: string): Promise<DormantCandidate[]> {
  if (!supabaseAdmin) throw new Error("Database not configured");

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select(
      [
        "id",
        "user_id",
        "name",
        "status",
        "lifecycle_state",
        "paused_reason",
        "resource_tier",
        "host_id",
        "infrastructure_provider",
        "proxmox_node",
        "proxmox_vmid",
        "gateway_url",
        "subdomain",
        "config",
        "created_at",
        "last_activity_at",
        "last_lifecycle_transition_at",
        "updated_at",
        "cpu_limit",
        "ram_limit",
        "disk_size_gb",
      ].join(", ")
    )
    .eq("lifecycle_state", "paused")
    // capacity_pressure parks (capacity-pressure-sweep) follow the same reaper
    // path as inactivity parks, so neither shape sits paused forever.
    // 'dormant_reclaiming' is the intermediate state a row holds AFTER its
    // archive is recorded but BEFORE the VM is destroyed: it must remain
    // selectable so a crash mid-sequence is retried (and finalized) by a later
    // sweep rather than leaving a live, orphaned VM no reconciler can see.
    .in("paused_reason", ["inactivity", "capacity_pressure", "dormant_reclaiming"])
    .lt("last_lifecycle_transition_at", cutoffIso)
    // Oldest pause first. A row that keeps failing stays selectable, so without an order
    // a few such rows could take every slot in the batch on every run.
    .order("last_lifecycle_transition_at", { ascending: true })
    .limit(DEFAULT_BATCH_LIMIT);

  if (error) {
    throw new Error(`Failed to load dormant reclaim candidates: ${error.message}`);
  }

  return ((data ?? []) as unknown) as DormantCandidate[];
}

function buildDormancyArchivePayload(input: {
  candidate: DormantCandidate;
  infrastructure: ProxmoxInfrastructure;
  archivePath: string;
  archiveSizeBytes: number;
  nowIso: string;
}) {
  return {
    instance_id: input.candidate.id,
    user_id: input.candidate.user_id,
    archive_kind: "proxmox_vzdump",
    archive_path: input.archivePath,
    archive_size_bytes: input.archiveSizeBytes,
    source_proxmox_node: input.infrastructure.node ?? input.candidate.proxmox_node,
    source_proxmox_vmid: input.infrastructure.vmid,
    source_host_id: input.candidate.host_id,
    metadata: {
      name: input.candidate.name,
      status: input.candidate.status,
      lifecycle_state: input.candidate.lifecycle_state,
      paused_reason: input.candidate.paused_reason,
      resource_tier: input.candidate.resource_tier,
      gateway_url: input.candidate.gateway_url,
      subdomain: input.candidate.subdomain,
      config: input.candidate.config,
      created_at: input.candidate.created_at,
      last_activity_at: input.candidate.last_activity_at,
      last_lifecycle_transition_at: input.candidate.last_lifecycle_transition_at,
      cpu_limit: input.candidate.cpu_limit,
      ram_limit: input.candidate.ram_limit,
      disk_size_gb: input.candidate.disk_size_gb,
    },
    created_at: input.nowIso,
  };
}

async function recordDormancyArchive(input: {
  candidate: DormantCandidate;
  infrastructure: ProxmoxInfrastructure;
  archivePath: string;
  archiveSizeBytes: number;
  nowIso: string;
}): Promise<string> {
  if (!supabaseAdmin) throw new Error("Database not configured");

  const { data, error } = await supabaseAdmin
    .from("instance_dormancy_archives")
    .insert(buildDormancyArchivePayload(input))
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to record dormancy archive: ${error.message}`);
  }

  const archiveId =
    data && typeof data === "object" && "id" in data ? String(data.id) : "";
  return archiveId;
}

// The row as it stands now. The sweep reads it at selection and again before each
// destructive step, because the owner can start or edit the row in between (the
// archive takes minutes). Every write bumps updated_at (hermes_instances trigger), but
// only a lifecycle change (the start route, a pause) moves last_lifecycle_transition_at,
// and the start route also clears paused_reason.
type DormantRowState = {
  lifecycle_state: string | null;
  paused_reason: string | null;
  last_lifecycle_transition_at: string | null;
  updated_at: string | null;
  config: Record<string, unknown> | null;
};

async function readDormantRowState(instanceId: string): Promise<DormantRowState | null> {
  if (!supabaseAdmin) throw new Error("Database not configured");

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("lifecycle_state, paused_reason, last_lifecycle_transition_at, updated_at, config")
    .eq("id", instanceId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to re-read dormant instance: ${error.message}`);
  }
  return (data as DormantRowState | null) ?? null;
}

// True only while the row is still the paused row the sweep decided on: the same
// pause reason and the same lifecycle transition. Owner activity and settings saves
// do not move either, so they do not count as the row changing. Missing values never match.
function rowStillPaused(
  row: DormantRowState | null,
  expected: { paused_reason: string | null; last_lifecycle_transition_at: string | null }
): row is DormantRowState {
  return (
    row !== null &&
    expected.paused_reason !== null &&
    expected.last_lifecycle_transition_at !== null &&
    row.lifecycle_state === "paused" &&
    row.paused_reason === expected.paused_reason &&
    row.last_lifecycle_transition_at === expected.last_lifecycle_transition_at
  );
}

async function markDormantReclaimed(input: {
  candidate: DormantCandidate;
  archiveId: string;
  archivePath: string;
  nowIso: string;
}) {
  if (!supabaseAdmin) throw new Error("Database not configured");

  // Merge into the config as it is now, not the selection snapshot, so settings
  // the owner saved while the VM was being destroyed are kept.
  const current = await readDormantRowState(input.candidate.id);
  if (!current?.updated_at || current.paused_reason !== "dormant_reclaiming") {
    throw new Error("Dormant instance changed before the reclaim was recorded");
  }

  // Compare on the updated_at of that read. A settings save that lands between the read
  // and this update moves it, so the update refuses instead of writing back a config that
  // no longer has the owner's save.
  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .update({
      lifecycle_state: "paused",
      paused_reason: "dormant_reclaimed",
      status: "stopped",
      host_id: null,
      infrastructure_provider: null,
      proxmox_node: null,
      proxmox_vmid: null,
      config: stripProxmoxInfrastructure(
        {
          ...(current.config ?? {}),
          dormantArchive: {
            archiveId: input.archiveId,
            archivePath: input.archivePath,
            archivedAt: input.nowIso,
          },
        },
        "dormant_reclaim"
      ),
      last_lifecycle_transition_at: input.nowIso,
      updated_at: input.nowIso,
    })
    .eq("id", input.candidate.id)
    .eq("paused_reason", "dormant_reclaiming")
    .eq("updated_at", current.updated_at)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to mark dormant instance reclaimed: ${error.message}`);
  }
  if (!data) {
    throw new Error("Dormant instance changed before the reclaim was recorded");
  }
}

function readRecordedDormantArchive(
  config: Record<string, unknown> | null
): { archiveId: string; archivePath: string } | null {
  const blob = (
    config as { dormantArchive?: { archiveId?: unknown; archivePath?: unknown } } | null
  )?.dormantArchive;
  if (
    blob &&
    typeof blob.archiveId === "string" &&
    typeof blob.archivePath === "string"
  ) {
    return { archiveId: blob.archiveId, archivePath: blob.archivePath };
  }
  return null;
}

// Records the archive on the row and moves it to the intermediate 'dormant_reclaiming'
// reason, which the candidate query still selects, so a crash before the destroy is
// retried by a later sweep. The write only lands while the row is still the paused row
// the sweep selected (same lifecycle transition and reason), so an owner Start during the
// archive leaves the row alone. Owner activity during the archive does not abort it.
// Returns false when the row changed and the VM must not be destroyed.
async function markDormantArchiveRecorded(input: {
  candidate: DormantCandidate;
  archiveId: string;
  archivePath: string;
  nowIso: string;
}): Promise<boolean> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const { candidate } = input;
  if (!candidate.paused_reason || !candidate.last_lifecycle_transition_at) return false;

  // Re-read right before the write. The config merge then keeps any settings the owner
  // saved during the archive, and the compare-and-swap on updated_at below fails only
  // for a write that lands between this read and the update.
  const current = await readDormantRowState(candidate.id);
  if (!current?.updated_at || !rowStillPaused(current, candidate)) return false;

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .update({
      lifecycle_state: "paused",
      // Intermediate, STILL-RECLAIMABLE reason. The candidate query matches
      // 'dormant_reclaiming', so if the process dies between here and the
      // qm destroy below, the next sweep re-selects this row, skips
      // re-archiving (the archive blob is already recorded), and retries the
      // (idempotent) destroy. Only markDormantReclaimed flips to the terminal
      // 'dormant_reclaimed' AFTER the VM is gone — so a live VM is never
      // orphaned outside the reclaimable set.
      paused_reason: "dormant_reclaiming",
      lifecycle_substate: "dormant_archive_recorded",
      status: "stopped",
      config: {
        ...(current.config ?? {}),
        dormantArchive: {
          archiveId: input.archiveId,
          archivePath: input.archivePath,
          archivedAt: input.nowIso,
        },
      },
      // Intentionally NOT bumping last_lifecycle_transition_at: the candidate
      // query filters on it being older than the cutoff, so bumping it here
      // would make a mid-death row un-reselectable.
      updated_at: input.nowIso,
    })
    .eq("id", candidate.id)
    .eq("lifecycle_state", "paused")
    .eq("paused_reason", candidate.paused_reason)
    .eq("last_lifecycle_transition_at", candidate.last_lifecycle_transition_at)
    .eq("updated_at", current.updated_at)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to mark dormant archive recorded: ${error.message}`);
  }
  return data !== null;
}

// The row changed while the disk was being archived, so the VM stays as the owner has
// it and the dump is no use to anyone: a copy of a guest that still runs. Remove the file
// first, and only then the manifest row that points at it, so a failed removal leaves
// both in place and consistent.
async function discardAbandonedDormantArchive(input: {
  infrastructure: ProxmoxInfrastructure;
  hostConfig: ProxmoxHostRoutingConfigArg;
  archiveDir: string;
  archiveId: string;
  archivePath: string;
}) {
  if (!supabaseAdmin) throw new Error("Database not configured");

  const removed = await removeProxmoxDormantArchive(input.infrastructure, {
    archiveDir: input.archiveDir,
    archivePath: input.archivePath,
    hostConfig: input.hostConfig,
  });
  if (!removed.ok) {
    throw new Error(
      removed.error || removed.stderr || "Failed to remove the abandoned dormant archive"
    );
  }

  const { error } = await supabaseAdmin
    .from("instance_dormancy_archives")
    .delete()
    .eq("id", input.archiveId);
  if (error) {
    throw new Error(`Failed to remove abandoned dormancy archive record: ${error.message}`);
  }
}

// Logs a reclaim the sweep abandoned because the owner changed the row (or started
// the VM). The VM is left as the owner has it.
function logDormantRowChanged(
  candidate: DormantCandidate,
  stage: string,
  infrastructure: ProxmoxInfrastructure,
  archive?: { archiveId: string; archivePath: string }
) {
  log.warn("dormant reclaim aborted: instance changed, VM left as the owner has it", {
    source: LOG_SOURCE,
    instanceId: candidate.id,
    userId: candidate.user_id,
    proxmoxNode: infrastructure.node ?? null,
    proxmoxVmid: infrastructure.vmid,
    stage,
    failureType: "dormant_reclaim_row_changed",
    ...(archive ? { archiveId: archive.archiveId, archivePath: archive.archivePath } : {}),
  });
}

export async function runDormantReclaimSweep(
  options: RunDormantReclaimOptions = {}
): Promise<DormantReclaimSummary> {
  const reclaimAfterDays = readPositiveIntegerEnv(
    "HERMES_DORMANT_RECLAIM_AFTER_DAYS",
    DEFAULT_RECLAIM_AFTER_DAYS
  );
  const commit = readBooleanEnv("HERMES_DORMANT_RECLAIM_COMMIT");

  if (!readBooleanEnv("HERMES_DORMANT_RECLAIM_ENABLED")) {
    log.warn("dormant reclaim sweep is disabled", {
      source: LOG_SOURCE,
      reason: "explicit_opt_in_required",
      optInEnv: "HERMES_DORMANT_RECLAIM_ENABLED",
    });
    return {
      enabled: false,
      commit: false,
      scanned: 0,
      archived: 0,
      reclaimed: 0,
      skipped: 0,
      failed: 0,
      reclaimAfterDays,
    };
  }

  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const cutoffIso = new Date(
    now.getTime() - reclaimAfterDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const candidates = await fetchDormantCandidates(cutoffIso);
  let archived = 0;
  let reclaimed = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const infrastructure = resolveCandidateInfrastructure(candidate);
    if (!infrastructure) {
      skipped += 1;
      log.warn("dormant reclaim skipped instance without Proxmox infrastructure", {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        userId: candidate.user_id,
        failureType: "dormant_reclaim_missing_proxmox_infrastructure",
      });
      continue;
    }

    // Don't destructively archive a row whose agent was actually being used
    // (over Telegram/Discord/standalone-webui) right up until it was paused —
    // that pause was a false positive of the dashboard-only idle signal.
    if (await hadAgentUsageBeforePause(candidate)) {
      skipped += 1;
      log.info("dormant reclaim skipped agent-side-active instance", {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        userId: candidate.user_id,
        proxmoxNode: infrastructure.node ?? null,
        proxmoxVmid: infrastructure.vmid,
        signal: "instance_usage_snapshots.sessions",
        cutoffIso,
      });
      continue;
    }

    if (!commit) {
      skipped += 1;
      log.info("dormant reclaim dry-run candidate", {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        userId: candidate.user_id,
        proxmoxNode: infrastructure.node ?? null,
        proxmoxVmid: infrastructure.vmid,
        cutoffIso,
      });
      continue;
    }

    const archiveDir = process.env.HERMES_DORMANT_ARCHIVE_DIR?.trim();
    if (!archiveDir) {
      failed += 1;
      log.error("dormant reclaim cannot commit without archive directory", undefined, {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        userId: candidate.user_id,
        failureType: "dormant_reclaim_archive_dir_missing",
        requiredEnv: "HERMES_DORMANT_ARCHIVE_DIR",
      });
      continue;
    }

    const hostConfig = getProxmoxHostRoutingConfigFromInfrastructure(
      infrastructure,
      { host_id: candidate.host_id }
    );

    try {
      // Re-entry: a prior run recorded the archive (row is 'dormant_reclaiming')
      // but died before the VM was destroyed. Skip re-archiving and resume at
      // the idempotent destroy step using the already-recorded archive.
      const recorded =
        candidate.paused_reason === "dormant_reclaiming"
          ? readRecordedDormantArchive(candidate.config)
          : null;

      let archiveId: string;
      let archivePath: string;

      if (recorded) {
        archiveId = recorded.archiveId;
        archivePath = recorded.archivePath;
        log.info("dormant reclaim resuming from recorded archive", {
          source: LOG_SOURCE,
          instanceId: candidate.id,
          userId: candidate.user_id,
          archiveId,
        });
      } else {
        // The owner may have started the VM after the sweep read this row. Don't
        // dump a row that has moved on: the dump can stop a running guest.
        const beforeArchive = await readDormantRowState(candidate.id);
        if (!rowStillPaused(beforeArchive, candidate)) {
          skipped += 1;
          logDormantRowChanged(candidate, "before archive", infrastructure);
          continue;
        }

        const archiveResult = await archiveProxmoxDormantInstance(
          infrastructure,
          {
            archiveDir,
            instanceId: candidate.id,
            hostConfig,
          }
        );
        // The host refuses to dump a guest that is not exactly stopped. Nothing was
        // dumped, so nothing is recorded and the row is left exactly as it is.
        if (!archiveResult.ok && archiveResult.stderr.includes(DORMANT_ARCHIVE_NOT_STOPPED_MARKER)) {
          skipped += 1;
          log.warn("dormant reclaim skipped instance whose VM is not stopped", {
            source: LOG_SOURCE,
            instanceId: candidate.id,
            userId: candidate.user_id,
            proxmoxNode: infrastructure.node ?? null,
            proxmoxVmid: infrastructure.vmid,
            failureType: "dormant_reclaim_vm_not_stopped",
          });
          continue;
        }
        const resolvedPath = archiveResult.ok
          ? extractArchivePath(archiveResult.stdout)
          : null;
        const archiveSizeBytes = archiveResult.ok
          ? extractArchiveSizeBytes(archiveResult.stdout)
          : null;
        if (!archiveResult.ok || !resolvedPath || archiveSizeBytes === null) {
          throw new Error(
            archiveResult.error ||
              archiveResult.stderr ||
              "Proxmox dormant archive did not produce an archive path and size"
          );
        }
        archiveId = await recordDormancyArchive({
          candidate,
          infrastructure,
          archivePath: resolvedPath,
          archiveSizeBytes,
          nowIso,
        });
        archivePath = resolvedPath;

        // Mark the archive recorded BEFORE destroy, keeping the row in the reclaimable
        // 'dormant_reclaiming' state so a crash before destroy is retried by a later
        // sweep instead of orphaning a live VM. If an owner Start landed during the
        // archive, the dump is discarded and the VM is left as the owner has it.
        const marked = await markDormantArchiveRecorded({
          candidate,
          archiveId,
          archivePath,
          nowIso,
        });
        if (!marked) {
          await discardAbandonedDormantArchive({
            infrastructure,
            hostConfig,
            archiveDir,
            archiveId,
            archivePath,
          });
          skipped += 1;
          logDormantRowChanged(candidate, "while archiving", infrastructure, {
            archiveId,
            archivePath,
          });
          continue;
        }
        archived += 1;
      }

      // Last check before the destroy: the row must still be the dormant_reclaiming
      // row this run recorded or resumed. A Start since then aborts. Owner activity
      // and settings saves do not, and the terminal write keeps the config as it is.
      const beforeDestroy = await readDormantRowState(candidate.id);
      if (
        !rowStillPaused(beforeDestroy, {
          paused_reason: "dormant_reclaiming",
          last_lifecycle_transition_at: candidate.last_lifecycle_transition_at,
        })
      ) {
        skipped += 1;
        logDormantRowChanged(candidate, "before destroy", infrastructure, {
          archiveId,
          archivePath,
        });
        continue;
      }

      // refuseIfRunning: even if the row check above passed, a guest that is
      // running now (started by its owner) is refused rather than shut down.
      const deleteResult = await deleteProxmoxInstance(infrastructure, {
        hostConfig,
        expectedInstanceId: candidate.id,
        refuseIfRunning: true,
      });
      if (!deleteResult.ok) {
        if (deleteResult.stderr.includes(DELETE_RUNNING_REFUSED_MARKER)) {
          skipped += 1;
          logDormantRowChanged(candidate, "VM is running at destroy", infrastructure, {
            archiveId,
            archivePath,
          });
          continue;
        }
        throw new Error(
          deleteResult.error ||
            deleteResult.stderr ||
            "Proxmox delete failed after dormant archive"
        );
      }

      await removeInstanceDnsBestEffort(candidate.subdomain, {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        userId: candidate.user_id,
      });

      await markDormantReclaimed({
        candidate,
        archiveId,
        archivePath,
        nowIso,
      });
      reclaimed += 1;
      log.info("dormant reclaim archived and released instance", {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        userId: candidate.user_id,
        archiveId,
        archivePath,
        proxmoxNode: infrastructure.node ?? null,
        proxmoxVmid: infrastructure.vmid,
      });
    } catch (err) {
      failed += 1;
      log.error("dormant reclaim failed for instance", err, {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        userId: candidate.user_id,
        proxmoxNode: infrastructure.node ?? null,
        proxmoxVmid: infrastructure.vmid,
        failureType: "dormant_reclaim_instance_failed",
      });
    }
  }

  return {
    enabled: true,
    commit,
    scanned: candidates.length,
    archived,
    reclaimed,
    skipped,
    failed,
    reclaimAfterDays,
  };
}
