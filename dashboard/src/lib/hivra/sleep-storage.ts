import "server-only";

import { randomUUID } from "node:crypto";

import { log } from "@/lib/logger";
import type { supabaseAdmin } from "@/lib/supabase";
import { buildColdStorageInstallScriptOrExit } from "@/lib/cold-storage-ssh";
import {
  runProxmoxHostScript,
  runProxmoxHostScriptWithStdin,
} from "@/lib/services/proxmox-instance-service";
import { resolveHivraProxmoxHost } from "./proxmox-target";
import type { HivraLifecycleTarget } from "./agent-lifecycle-host";
import {
  buildBackupPollScript,
  buildBackupStartScript,
  parseBackupPoll,
  parseBackupStartReceipt,
  type BackupDisk,
} from "./computer-backups/scripts";
import { computerBackupPassword, computerBackupSettings } from "./computer-backups/sweep";
import { isAgentStored } from "./sleep-storage-state";

export { isAgentStored, requestAgentUnstore } from "./sleep-storage-state";

/**
 * The last step of the sleep ladder: storage.
 *
 * A paid agent nobody has used for HIVRA_SLEEP_STORE_AFTER_DAYS days, whose
 * saved memory was already dropped, is packed into the storage box: its disks
 * are copied there (the backup tooling's encrypted, deduplicated repository),
 * read back and compared, and only then freed on the host. The computer keeps
 * its number, address, settings and place on its host; only its disk space is
 * given back. When its owner returns, the disks are written back and the
 * normal wake boots it. That takes minutes, so a wake of a stored agent
 * answers `waking` at once and the sleep sweep finishes the job.
 *
 * Everything is state on the row, never an in-flight promise:
 *   sleep_store_job_id          packing is running on the host
 *   sleep_stored_at             the disks are in the storage box
 *   sleep_unstore_requested_at  someone asked for it back
 *   sleep_unstore_job_id        the disks are being written back
 *
 * Bringing agents back runs whenever such rows exist, whatever the setting
 * says, so switching storage off never strands a stored agent. Only packing
 * new ones needs the setting.
 */

const LOG_SOURCE = "sleep-storage";
type Db = NonNullable<typeof supabaseAdmin>;
type EnvLike = Record<string, string | undefined>;
type AgentRow = Record<string, unknown>;

const SCRIPT_TIMEOUT_MS = 60_000;
const STORE_SCAN_LIMIT = 20;
/** A job row the host no longer knows is lost after this long. */
const JOB_LOST_AFTER_MS = 10 * 60_000;
/** A failed attempt to bring an agent back is tried again after this long. */
export const UNSTORE_RETRY_MS = 3 * 60_000;

/**
 * HIVRA_SLEEP_STORE_AFTER_DAYS: days in deep sleep before an agent is packed
 * into the storage box. A whole number from 1 to 365; anything else is off.
 */
export function sleepStoreAfterDays(env: string | undefined | null = process.env.HIVRA_SLEEP_STORE_AFTER_DAYS): number | null {
  const value = env?.trim() ?? "";
  if (!/^[0-9]{1,3}$/.test(value)) return null;
  const days = Number.parseInt(value, 10);
  return days >= 1 && days <= 365 ? days : null;
}

export interface SleepStorageCounts {
  /** Agents waiting for, or in, a job at the start of the run. */
  tracked: number;
  stored: number;
  storeStarted: number;
  storeEnded: number;
  unstoreStarted: number;
  /** Disks written back; the agent is then woken. */
  unstored: number;
  unstoreFailed: number;
  refused: number;
}

export interface SleepStorageInput {
  db: Db;
  env: EnvLike;
  now: () => number;
  deadline: number;
  /** No new host call starts after this (the run's budget for starting work). Left out: the deadline alone decides. */
  startBy?: number;
  /** Whether sleep acts on this host at all. Asked only when something may be packed. */
  hostActs: (host: string) => Promise<boolean>;
  resolveTarget: (row: AgentRow, source: string) => Promise<{ ok: true; target: HivraLifecycleTarget } | { ok: false; code?: string }>;
  /** Wakes an agent whose disks are back. Its failure is the wake's own to report. */
  wake: (agentId: string) => Promise<unknown>;
  runHostScript?: typeof runProxmoxHostScript;
  runHostScriptWithStdin?: typeof runProxmoxHostScriptWithStdin;
  newId?: () => string;
}

interface JobRow {
  id: string;
  agent_id: string;
  kind: string;
  status: "running" | "succeeded" | "failed" | "skipped";
  reason: string | null;
  disks: BackupDisk[] | null;
  started_at: string;
}

const unstoreRetryAt = new Map<string, number>();
export function resetSleepStorageState(): void {
  unstoreRetryAt.clear();
}

const hostOf = (row: AgentRow): string =>
  resolveHivraProxmoxHost(typeof row.proxmox_host === "string" ? row.proxmox_host : null);

export async function runSleepStorage(input: SleepStorageInput): Promise<{ counts: SleepStorageCounts; errors: number }> {
  const { db, env, now } = input;
  const runHostScript = input.runHostScript ?? runProxmoxHostScript;
  const runWithStdin = input.runHostScriptWithStdin ?? runProxmoxHostScriptWithStdin;
  const newId = input.newId ?? randomUUID;
  const counts: SleepStorageCounts = {
    tracked: 0, stored: 0, storeStarted: 0, storeEnded: 0, unstoreStarted: 0, unstored: 0, unstoreFailed: 0, refused: 0,
  };
  let errors = 0;
  const problem = (message: string, error: unknown, failureType: string, agentId?: string) => {
    errors += 1;
    log.error(message, error instanceof Error ? error : new Error(JSON.stringify(error)), {
      source: LOG_SOURCE,
      failureType,
      ...(agentId ? { instanceId: agentId } : {}),
    });
  };
  const outOfTime = () => now() >= (input.startBy ?? input.deadline) || input.deadline - now() < SCRIPT_TIMEOUT_MS + 5_000;
  const iso = () => new Date(now()).toISOString();

  // Every agent with storage work pending. With none, and packing off, this one query is the whole run.
  const { data: trackedData, error: trackedError } = await db
    .from("hivra_agents")
    .select("*")
    .or("sleep_store_job_id.not.is.null,sleep_unstore_requested_at.not.is.null,sleep_unstore_job_id.not.is.null")
    .neq("status", "deleted")
    .limit(200);
  if (trackedError) {
    problem("failed to load agents with storage work", trackedError, "sleep_storage_query_failed");
    return { counts, errors };
  }
  const tracked = (trackedData ?? []) as AgentRow[];
  counts.tracked = tracked.length;

  const targets = new Map<string, HivraLifecycleTarget | null>();
  const targetFor = async (row: AgentRow): Promise<HivraLifecycleTarget | null> => {
    const id = String(row.id);
    if (targets.has(id)) return targets.get(id) ?? null;
    let target: HivraLifecycleTarget | null = null;
    try {
      const resolved = await input.resolveTarget(row, LOG_SOURCE);
      if (resolved.ok && resolved.target.bindingTag) target = resolved.target;
    } catch {
      target = null;
    }
    targets.set(id, target);
    return target;
  };

  // --- 1. Settle the jobs that were running -----------------------------------
  const jobIds = tracked
    .flatMap((row) => [row.sleep_store_job_id, row.sleep_unstore_job_id])
    .filter((id): id is string => typeof id === "string");
  const jobs = new Map<string, JobRow>();
  if (jobIds.length > 0) {
    const { data, error } = await db
      .from("hivra_computer_backups")
      .select("id, agent_id, kind, status, reason, disks, started_at")
      .in("id", jobIds);
    if (error) {
      problem("failed to load storage jobs", error, "sleep_storage_jobs_query_failed");
      return { counts, errors };
    }
    for (const job of (data ?? []) as JobRow[]) jobs.set(job.id, job);
  }
  /** Hosts with a storage job still running: one job per host at a time. */
  const busyHosts = new Set<string>();
  for (const row of tracked) {
    const agentId = String(row.id);
    for (const column of ["sleep_store_job_id", "sleep_unstore_job_id"] as const) {
      const jobId = row[column];
      if (typeof jobId !== "string") continue;
      const job = jobs.get(jobId);
      if (job && job.status === "running" && !outOfTime()) {
        // Ask the host. The backup cron polls these too; whoever sees the end first records it.
        const target = await targetFor(row);
        if (target) {
          try {
            const run = await runHostScript(buildBackupPollScript([jobId]), target.env, { timeoutMs: SCRIPT_TIMEOUT_MS });
            const seen = parseBackupPoll(run?.stdout ?? "").find((p) => p.jobId === jobId);
            const age = now() - Date.parse(job.started_at);
            const maxMs = (computerBackupSettings(env).maxHours + 1) * 3_600_000;
            if (seen?.state === "finished") {
              const { error } = await db.from("hivra_computer_backups").update({
                status: seen.status, reason: seen.reason, added_bytes: seen.addedBytes, disks: seen.disks,
                finished_at: seen.finishedAt ?? iso(),
              }).eq("id", jobId).eq("status", "running");
              if (error) problem("failed to record a storage job's end", error, "sleep_storage_job_record_failed", agentId);
              else Object.assign(job, { status: seen.status, reason: seen.reason, disks: seen.disks });
            } else if ((seen?.state === "missing" && age > JOB_LOST_AFTER_MS) || age > maxMs) {
              const reason = seen?.state === "missing" ? "job_lost" : "timed_out";
              await db.from("hivra_computer_backups").update({ status: "failed", reason, finished_at: iso() })
                .eq("id", jobId).eq("status", "running");
              Object.assign(job, { status: "failed", reason });
            }
          } catch (error) {
            problem("failed to ask a host about a storage job", error, "sleep_storage_poll_failed", agentId);
          }
        }
      }
      if (job && job.status === "running") {
        busyHosts.add(hostOf(row));
        continue;
      }
      // The job ended (or its row is gone). Act on how.
      if (column === "sleep_store_job_id") {
        const stored = !!job && job.status === "succeeded" && (job.reason === "stored" || job.reason === "stored_free_partial");
        const { error } = await db
          .from("hivra_agents")
          .update({ sleep_store_job_id: null, ...(stored ? { sleep_stored_at: iso() } : {}) })
          .eq("id", agentId)
          .eq("sleep_store_job_id", jobId);
        if (error) {
          problem("failed to record a packed agent", error, "sleep_storage_store_record_failed", agentId);
          continue;
        }
        row.sleep_store_job_id = null;
        if (stored) {
          row.sleep_stored_at = iso();
          counts.stored += 1;
          log.info("agent packed into storage; its disks on the host are freed", { source: LOG_SOURCE, instanceId: agentId });
        } else {
          counts.storeEnded += 1;
          const reason = job?.reason ?? "job_missing";
          // Its owner woke it meanwhile, or it changed: ordinary. Anything else deserves a look.
          if (job?.status === "failed") {
            problem("packing an agent into storage failed", new Error(reason), `sleep_storage_store_${reason}`, agentId);
          }
        }
      } else {
        const restored = !!job && job.status === "succeeded" && job.reason === "restored";
        const { error } = await db
          .from("hivra_agents")
          .update(restored
            ? { sleep_unstore_job_id: null, sleep_unstore_requested_at: null, sleep_stored_at: null }
            : { sleep_unstore_job_id: null })
          .eq("id", agentId)
          .eq("sleep_unstore_job_id", jobId);
        if (error) {
          problem("failed to record an agent brought back from storage", error, "sleep_storage_unstore_record_failed", agentId);
          continue;
        }
        row.sleep_unstore_job_id = null;
        if (restored) {
          row.sleep_stored_at = null;
          row.sleep_unstore_requested_at = null;
          counts.unstored += 1;
          unstoreRetryAt.delete(agentId);
          log.info("agent's disks are back from storage; waking it", { source: LOG_SOURCE, instanceId: agentId });
          try {
            await input.wake(agentId);
          } catch (error) {
            problem("wake after bringing an agent back from storage failed", error, "sleep_storage_wake_failed", agentId);
          }
        } else {
          counts.unstoreFailed += 1;
          unstoreRetryAt.set(agentId, now() + UNSTORE_RETRY_MS);
          // Someone is waiting for this agent: always an error.
          problem("bringing an agent back from storage failed", new Error(job?.reason ?? "job_missing"),
            `sleep_storage_unstore_${job?.reason ?? "job_missing"}`, agentId);
        }
      }
    }
  }

  const startJob = async (
    row: AgentRow,
    kind: "store" | "unstore",
    column: "sleep_store_job_id" | "sleep_unstore_job_id",
    disks?: BackupDisk[],
    sourceId?: string,
  ): Promise<"started" | "refused"> => {
    const agentId = String(row.id);
    const target = await targetFor(row);
    const password = computerBackupPassword(agentId, env);
    if (!target || !target.bindingTag || !password) return "refused";
    const settings = computerBackupSettings(env);
    const jobId = newId();
    let script: string;
    try {
      script = buildBackupStartScript({
        kind, jobId, agentId, vmid: target.vmid, bindingTag: target.bindingTag,
        keepDaily: settings.keepDaily, keepWeekly: settings.keepWeekly,
        uploadLimitKiB: kind === "store" ? settings.uploadLimitKiB : 0, maxHours: settings.maxHours,
        ...(disks ? { disks } : {}),
        coldStorageInstall: buildColdStorageInstallScriptOrExit(env),
      });
    } catch {
      return "refused";
    }
    const host = hostOf(row).toLowerCase();
    // The job row and the agent's pointer exist before the host starts work.
    const { error: insertError } = await db.from("hivra_computer_backups").insert({
      id: jobId, agent_id: agentId, user_id: String(row.user_id), kind, status: "running",
      proxmox_host: host, vmid: target.vmid, source_backup_id: sourceId ?? null, started_at: iso(),
    });
    if (insertError) {
      problem("failed to record a storage job", insertError, "sleep_storage_job_insert_failed", agentId);
      return "refused";
    }
    const { data: claimed, error: claimError } = await db
      .from("hivra_agents")
      .update({ [column]: jobId, ...(kind === "store" ? { sleep_store_tried_at: iso() } : {}) })
      .eq("id", agentId)
      .eq("sleep_state", "hibernated")
      .is("operation_id", null)
      .is(column, null)
      .select("id");
    if (claimError || !Array.isArray(claimed) || claimed.length !== 1) {
      await db.from("hivra_computer_backups").update({ status: "skipped", reason: "agent_changed", finished_at: iso() }).eq("id", jobId);
      return "refused";
    }
    let receipt: ReturnType<typeof parseBackupStartReceipt> = null;
    try {
      const run = await runWithStdin(script, `${password}\n`, target.env, { timeoutMs: SCRIPT_TIMEOUT_MS });
      receipt = parseBackupStartReceipt(run?.stdout ?? "", jobId);
    } catch {
      receipt = null;
    }
    if (!receipt?.ok) {
      const reason = receipt?.reason ?? "no_receipt";
      const busy = reason === "host_busy" || reason === "already_running";
      await db.from("hivra_computer_backups").update({ status: busy ? "skipped" : "failed", reason, finished_at: iso() }).eq("id", jobId);
      await db.from("hivra_agents").update({ [column]: null }).eq("id", agentId).eq(column, jobId);
      if (!busy) problem(`starting a ${kind} job failed`, new Error(reason), `sleep_storage_${kind}_start_${reason}`, agentId);
      return "refused";
    }
    row[column] = jobId;
    return "started";
  };

  // --- 2. Bring back the agents someone asked for: before anything is packed ---
  const waiting = tracked
    .filter((row) => typeof row.sleep_unstore_requested_at === "string" && row.sleep_unstore_job_id == null)
    .sort((a, b) => Date.parse(String(a.sleep_unstore_requested_at)) - Date.parse(String(b.sleep_unstore_requested_at)));
  /** Hosts where an agent is waiting to come back: nothing new is packed there this run. */
  const reservedHosts = new Set<string>();
  for (const row of waiting) {
    const agentId = String(row.id);
    const host = hostOf(row);
    if (!isAgentStored(row)) {
      // Not stored any more (or never was): the request has nothing to do.
      await db.from("hivra_agents").update({ sleep_unstore_requested_at: null }).eq("id", agentId);
      continue;
    }
    reservedHosts.add(host);
    if (row.sleep_store_job_id != null || busyHosts.has(host) || outOfTime()) continue;
    if ((unstoreRetryAt.get(agentId) ?? 0) > now()) continue;
    // The copy to write back: the job that packed it.
    const { data: source, error } = await db
      .from("hivra_computer_backups")
      .select("id, disks")
      .eq("agent_id", agentId)
      .eq("kind", "store")
      .eq("status", "succeeded")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const disks = (source?.disks ?? []) as BackupDisk[];
    if (error || !source || disks.length === 0) {
      unstoreRetryAt.set(agentId, now() + UNSTORE_RETRY_MS);
      problem("a stored agent has no copy on record to bring back", error ?? new Error("store_job_missing"),
        "sleep_storage_unstore_source_missing", agentId);
      counts.unstoreFailed += 1;
      continue;
    }
    const started = await startJob(row, "unstore", "sleep_unstore_job_id", disks, String(source.id));
    if (started === "started") {
      counts.unstoreStarted += 1;
      busyHosts.add(host);
    } else {
      counts.refused += 1;
      unstoreRetryAt.set(agentId, now() + 60_000);
    }
  }

  // --- 3. Pack long sleepers: only with the setting on -------------------------
  const days = sleepStoreAfterDays(env.HIVRA_SLEEP_STORE_AFTER_DAYS);
  if (days === null || outOfTime() || !computerBackupPassword("00000000-0000-0000-0000-000000000000", env)) {
    return { counts, errors };
  }
  const { data: candidateData, error: candidateError } = await db.rpc("hivra_sleep_store_candidates", {
    p_cutoff: new Date(now() - days * 86_400_000).toISOString(),
    p_limit: STORE_SCAN_LIMIT,
  });
  if (candidateError) {
    problem("failed to load agents to pack into storage", candidateError, "sleep_storage_candidates_failed");
    return { counts, errors };
  }
  for (const candidate of (candidateData ?? []) as Array<{ id: string; proxmox_host: string | null }>) {
    if (outOfTime()) break;
    const host = hostOf(candidate);
    if (busyHosts.has(host) || reservedHosts.has(host) || !(await input.hostActs(host))) continue;
    const { data: row, error } = await db.from("hivra_agents").select("*").eq("id", candidate.id).maybeSingle();
    if (error || !row) continue;
    const started = await startJob(row as AgentRow, "store", "sleep_store_job_id");
    if (started === "started") {
      counts.storeStarted += 1;
      busyHosts.add(host);
    } else {
      counts.refused += 1;
      // Not retried every minute: the candidate list leaves it out for a day.
      await db.from("hivra_agents").update({ sleep_store_tried_at: iso() }).eq("id", candidate.id);
    }
  }
  return { counts, errors };
}
