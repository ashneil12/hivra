import "server-only";

/**
 * Off-host backups of Hivra computers: the cron sweep.
 *
 * Each run (every ten minutes) does three things, in order:
 *   1. Polls the jobs already running on hosts and records how they ended.
 *   2. Removes the repository of a computer that was deleted.
 *   3. On each host with no job running, starts one: a backup of the awake
 *      computer whose last copy is oldest (and older than the due window), or
 *      else a weekly drill that reads a recent backup back and checks it.
 *
 * HIVRA_COMPUTER_BACKUPS: unset or anything else does nothing; `dry` reports
 * what it would start; `on` runs. HIVRA_COMPUTER_BACKUPS_HOSTS limits it to
 * listed hosts. The numbers (retention, due window, upload limit) are settings.
 */

import { createHmac, randomUUID } from "crypto";

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { buildColdStorageInstallScriptOrExit } from "@/lib/cold-storage-ssh";
import {
  runProxmoxHostScript,
  runProxmoxHostScriptWithStdin,
} from "@/lib/services/proxmox-instance-service";
import { resolveHivraProxmoxHost } from "@/lib/hivra/proxmox-target";
import { resolveSleepTarget } from "@/lib/hivra/agent-wake";
import {
  buildBackupPollScript,
  buildBackupPurgeScript,
  buildBackupStartScript,
  parseBackupPoll,
  parseBackupPurgeReceipt,
  parseBackupStartReceipt,
  type BackupDisk,
  type BackupJobKind,
} from "./scripts";

type EnvLike = Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the admin client is untyped here, as in the other sweeps
type Db = any;

const PURGE_WAIT_REASON = "deleted_waiting";
const LOG_SOURCE = "hivra-computer-backups";
const RUN_BUDGET_MS = 100_000;
const SCRIPT_TIMEOUT_MS = 90_000;
const ROW_LIMIT = 2000;

export type ComputerBackupsMode = "off" | "dry" | "on";

export function computerBackupsMode(env: EnvLike = process.env): ComputerBackupsMode {
  const value = env.HIVRA_COMPUTER_BACKUPS?.trim().toLowerCase();
  return value === "dry" || value === "on" ? value : "off";
}

function envInt(env: EnvLike, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const n = Number.parseInt(raw, 10);
  return n < min || n > max ? fallback : n;
}

export interface ComputerBackupSettings {
  keepDaily: number;
  keepWeekly: number;
  dueHours: number;
  drillDays: number;
  purgeAfterHours: number;
  uploadLimitKiB: number;
  maxHours: number;
  hosts: Set<string> | null;
}

export function computerBackupSettings(env: EnvLike = process.env): ComputerBackupSettings {
  const hosts = (env.HIVRA_COMPUTER_BACKUPS_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return {
    keepDaily: envInt(env, "HIVRA_COMPUTER_BACKUPS_KEEP_DAILY", 7, 1, 90),
    keepWeekly: envInt(env, "HIVRA_COMPUTER_BACKUPS_KEEP_WEEKLY", 4, 0, 52),
    dueHours: envInt(env, "HIVRA_COMPUTER_BACKUPS_DUE_HOURS", 20, 1, 168),
    drillDays: envInt(env, "HIVRA_COMPUTER_BACKUPS_DRILL_DAYS", 7, 1, 90),
    purgeAfterHours: envInt(env, "HIVRA_COMPUTER_BACKUPS_PURGE_AFTER_HOURS", 24, 0, 24 * 90),
    uploadLimitKiB: envInt(env, "HIVRA_COMPUTER_BACKUPS_UPLOAD_LIMIT_KIB", 0, 0, 10_000_000),
    maxHours: envInt(env, "HIVRA_COMPUTER_BACKUPS_MAX_HOURS", 6, 1, 24),
    hosts: hosts.length ? new Set(hosts) : null,
  };
}

/**
 * The repository password of one computer. Derived, never stored: losing the
 * storage box alone opens nothing, and each computer's repository has its own key.
 */
export function computerBackupPassword(agentId: string, env: EnvLike = process.env): string | null {
  const master = env.HIVRA_COMPUTER_BACKUP_KEY?.trim() || env.HERMES_RESTIC_MASTER_KEY?.trim();
  if (!master) return null;
  return createHmac("sha256", master).update(`hivra-computer-backup:${agentId}`).digest("hex");
}

export type BackupRow = {
  id: string;
  agent_id: string;
  user_id: string;
  kind: BackupJobKind | "purge";
  status: "running" | "succeeded" | "failed" | "skipped";
  proxmox_host: string;
  vmid: number | null;
  reason: string | null;
  disks: BackupDisk[] | null;
  started_at: string;
  finished_at: string | null;
};

type AgentRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  vmid: number | null;
  proxmox_host: string | null;
  status: string | null;
  sleep_state: string | null;
};

export type ComputerBackupSweepSummary = {
  skipped: boolean;
  reason?: string;
  mode: ComputerBackupsMode;
  polled: number;
  finished: Record<string, number>;
  started: Record<string, number>;
  refused: Record<string, number>;
  purged: number;
  errors: number;
  plan?: Array<{ host: string; kind: BackupJobKind; vmid: number }>;
};

export type ComputerBackupSweepDeps = {
  db?: Db;
  env?: EnvLike;
  now?: () => number;
  runHostScript?: typeof runProxmoxHostScript;
  runHostScriptWithStdin?: typeof runProxmoxHostScriptWithStdin;
  resolveTarget?: typeof resolveSleepTarget;
  newId?: () => string;
};

function hostOf(agent: { proxmox_host: string | null }): string {
  return resolveHivraProxmoxHost(agent.proxmox_host).toLowerCase();
}

/** Picks what one idle host should do next, or null. Pure, for tests. */
export function pickNextJob(input: {
  agents: AgentRow[];
  lastBackup: Map<string, BackupRow>;
  lastDrill: Map<string, BackupRow>;
  now: number;
  settings: ComputerBackupSettings;
}): { kind: "backup" | "drill"; agent: AgentRow; source?: BackupRow } | null {
  const dueBefore = input.now - input.settings.dueHours * 3_600_000;
  const drillBefore = input.now - input.settings.drillDays * 86_400_000;
  const awake = input.agents.filter((a) => (a.sleep_state ?? "awake") === "awake" && a.status === "running");
  const due = awake
    .map((agent) => ({ agent, last: input.lastBackup.get(agent.id) }))
    .filter(({ last }) => !last || Date.parse(last.finished_at ?? last.started_at) < dueBefore)
    .sort((a, b) => (a.last ? Date.parse(a.last.finished_at ?? a.last.started_at) : 0)
      - (b.last ? Date.parse(b.last.finished_at ?? b.last.started_at) : 0));
  if (due.length) return { kind: "backup", agent: due[0].agent };
  // A drill reads from the storage box only, so the computer may be asleep.
  const drills = input.agents
    .map((agent) => ({ agent, source: input.lastBackup.get(agent.id), drill: input.lastDrill.get(agent.id) }))
    .filter(({ source, drill }) => source && (source.disks?.length ?? 0) > 0
      && (!drill || Date.parse(drill.started_at) < drillBefore))
    .sort((a, b) => (a.drill ? Date.parse(a.drill.started_at) : 0) - (b.drill ? Date.parse(b.drill.started_at) : 0));
  if (drills.length) return { kind: "drill", agent: drills[0].agent, source: drills[0].source };
  return null;
}

export async function runComputerBackupSweep(deps: ComputerBackupSweepDeps = {}): Promise<ComputerBackupSweepSummary> {
  const env = deps.env ?? process.env;
  const mode = computerBackupsMode(env);
  const summary: ComputerBackupSweepSummary = {
    skipped: false, mode, polled: 0, finished: {}, started: {}, refused: {}, purged: 0, errors: 0,
  };
  if (mode === "off") return { ...summary, skipped: true, reason: "flag_off" };
  const db = deps.db ?? supabaseAdmin;
  if (!db) return { ...summary, skipped: true, reason: "no_database" };
  if (!computerBackupPassword("00000000-0000-0000-0000-000000000000", env)) {
    return { ...summary, skipped: true, reason: "no_backup_key" };
  }
  const settings = computerBackupSettings(env);
  const now = deps.now ?? Date.now;
  const runHostScript = deps.runHostScript ?? runProxmoxHostScript;
  const runWithStdin = deps.runHostScriptWithStdin ?? runProxmoxHostScriptWithStdin;
  const resolveTarget = deps.resolveTarget ?? resolveSleepTarget;
  const newId = deps.newId ?? randomUUID;
  const startedAt = now();
  const count = (bucket: Record<string, number>, key: string) => { bucket[key] = (bucket[key] ?? 0) + 1; };
  const outOfTime = () => now() - startedAt > RUN_BUDGET_MS;

  // Every live managed Proxmox computer, on the allowed hosts.
  const { data: agentData, error: agentError } = await db
    .from("hivra_agents")
    .select("*")
    .eq("deployment_mode", "hivra-managed")
    .eq("computer_substrate", "proxmox-kvm")
    .is("deployment_target_id", null)
    .neq("status", "deleted")
    .not("vmid", "is", null)
    .limit(ROW_LIMIT);
  if (agentError) return { ...summary, errors: 1, reason: "agents_query_failed" };
  const agents = ((agentData ?? []) as AgentRow[])
    .filter((a) => !settings.hosts || settings.hosts.has(hostOf(a)));
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const agentsByHost = new Map<string, AgentRow[]>();
  for (const agent of agents) {
    const host = hostOf(agent);
    agentsByHost.set(host, [...(agentsByHost.get(host) ?? []), agent]);
  }

  // A host's environment comes from any computer on it the lifecycle code accepts.
  const hostEnv = new Map<string, Awaited<ReturnType<typeof resolveTarget>> | null>();
  const targetFor = async (agent: AgentRow) => {
    try { return await resolveTarget(agent, LOG_SOURCE); } catch { return null; }
  };
  const envForHost = async (host: string) => {
    if (hostEnv.has(host)) {
      const cached = hostEnv.get(host);
      return cached && cached.ok ? cached.target.env : null;
    }
    for (const agent of agentsByHost.get(host) ?? []) {
      const resolved = await targetFor(agent);
      if (resolved && resolved.ok) { hostEnv.set(host, resolved); return resolved.target.env; }
    }
    hostEnv.set(host, null);
    return null;
  };

  const { data: jobData, error: jobError } = await db
    .from("hivra_computer_backups")
    .select("id, agent_id, user_id, kind, status, proxmox_host, vmid, reason, disks, started_at, finished_at")
    .order("started_at", { ascending: false })
    .limit(ROW_LIMIT * 4);
  if (jobError) return { ...summary, errors: 1, reason: "jobs_query_failed" };
  const jobs = (jobData ?? []) as BackupRow[];

  // 1. Poll running jobs, one script per host.
  const running = jobs.filter((j) => j.status === "running" && j.kind !== "purge");
  const runningByHost = new Map<string, BackupRow[]>();
  for (const job of running) runningByHost.set(job.proxmox_host, [...(runningByHost.get(job.proxmox_host) ?? []), job]);
  const busyHosts = new Set<string>();
  for (const [host, hostJobs] of runningByHost) {
    if (settings.hosts && !settings.hosts.has(host)) { busyHosts.add(host); continue; }
    const hostEnvValue = await envForHost(host);
    if (!hostEnvValue) { busyHosts.add(host); count(summary.refused, "host_unreachable"); continue; }
    let polled: ReturnType<typeof parseBackupPoll> = [];
    try {
      const run = await runHostScript(buildBackupPollScript(hostJobs.map((j) => j.id)), hostEnvValue, { timeoutMs: SCRIPT_TIMEOUT_MS });
      polled = parseBackupPoll(run?.stdout ?? "");
    } catch {
      summary.errors += 1;
    }
    const byId = new Map(polled.map((p) => [p.jobId, p]));
    for (const job of hostJobs) {
      summary.polled += 1;
      const seen = byId.get(job.id);
      const age = now() - Date.parse(job.started_at);
      if (seen?.state === "finished") {
        const { error } = await db.from("hivra_computer_backups").update({
          status: seen.status,
          reason: seen.reason,
          added_bytes: seen.addedBytes,
          disks: seen.disks,
          finished_at: seen.finishedAt ?? new Date(now()).toISOString(),
        }).eq("id", job.id).eq("status", "running");
        if (error) summary.errors += 1;
        // Keep this run's view in step with the row, so the job just finished counts below.
        Object.assign(job, {
          status: seen.status, reason: seen.reason, disks: seen.disks,
          finished_at: seen.finishedAt ?? new Date(now()).toISOString(),
        });
        count(summary.finished, `${job.kind}_${seen.status}`);
        if (seen.status === "failed") {
          log.warn("computer backup job failed", { source: LOG_SOURCE, failureType: `computer_backup_${seen.reason}`, instanceId: job.agent_id });
        }
        continue;
      }
      // A job the host no longer knows, or one far past its time limit, is lost.
      const lost = (seen?.state === "missing" && age > 10 * 60_000) || age > (settings.maxHours + 1) * 3_600_000;
      if (lost) {
        await db.from("hivra_computer_backups").update({
          status: "failed", reason: seen?.state === "missing" ? "job_lost" : "timed_out", finished_at: new Date(now()).toISOString(),
        }).eq("id", job.id).eq("status", "running");
        Object.assign(job, { status: "failed", finished_at: new Date(now()).toISOString() });
        count(summary.finished, `${job.kind}_failed`);
        continue;
      }
      busyHosts.add(host);
    }
  }

  // Latest succeeded backup and latest drill per computer.
  const lastBackup = new Map<string, BackupRow>();
  const lastDrill = new Map<string, BackupRow>();
  const purgedAgents = new Set<string>();
  // When each deleted computer was first seen gone: hivra_agents keeps no deletion time.
  const goneSince = new Map<string, number>();
  const backedUpAgents = new Map<string, BackupRow>();
  for (const job of jobs) {
    if (job.kind === "backup" && job.status === "succeeded") {
      if (!lastBackup.has(job.agent_id)) lastBackup.set(job.agent_id, job);
      if (!backedUpAgents.has(job.agent_id)) backedUpAgents.set(job.agent_id, job);
    }
    // A computer packed into storage (sleep ladder) has a repository too, to remove once it is deleted.
    if (job.kind === "store" && job.status === "succeeded" && !backedUpAgents.has(job.agent_id)) backedUpAgents.set(job.agent_id, job);
    if (job.kind === "drill" && job.status !== "running" && !lastDrill.has(job.agent_id)) lastDrill.set(job.agent_id, job);
    if (job.kind === "purge" && job.status === "succeeded") purgedAgents.add(job.agent_id);
    if (job.kind === "purge" && job.status === "skipped" && job.reason === PURGE_WAIT_REASON) {
      const at = Date.parse(job.started_at);
      const prior = goneSince.get(job.agent_id);
      if (!prior || at < prior) goneSince.set(job.agent_id, at);
    }
  }

  // 2. Purge repositories of deleted computers.
  const orphanIds = [...backedUpAgents.keys()].filter((id) => !agentById.has(id) && !purgedAgents.has(id));
  if (orphanIds.length && !outOfTime()) {
    const { data: goneData, error: goneError } = await db.from("hivra_agents").select("id, status").in("id", orphanIds.slice(0, 200));
    // Without a clear answer from the database nothing is removed.
    const gone = goneError ? null : new Map(((goneData ?? []) as AgentRow[]).map((a) => [a.id, a]));
    if (!gone) summary.errors += 1;
    for (const agentId of gone ? orphanIds.slice(0, 200) : []) {
      if (outOfTime()) break;
      const row = gone!.get(agentId);
      if (row && row.status !== "deleted") continue; // alive but filtered out (another host or mode)
      const source = backedUpAgents.get(agentId)!;
      const lastCopyAt = Date.parse(source.finished_at ?? source.started_at);
      // A note older than the last copy belongs to an earlier deletion that was undone.
      const noted = goneSince.get(agentId);
      const since = noted !== undefined && noted >= lastCopyAt ? noted : undefined;
      if (since === undefined) {
        // First time seen gone: note it, and remove the copies only once the grace period has passed.
        const iso = new Date(now()).toISOString();
        await db.from("hivra_computer_backups").insert({
          id: newId(), agent_id: agentId, user_id: source.user_id, kind: "purge", status: "skipped",
          proxmox_host: source.proxmox_host, vmid: source.vmid, reason: PURGE_WAIT_REASON, started_at: iso, finished_at: iso,
        });
        count(summary.refused, "purge_waiting");
        continue;
      }
      if (now() - since < settings.purgeAfterHours * 3_600_000) { count(summary.refused, "purge_waiting"); continue; }
      const hostEnvValue = await envForHost(source.proxmox_host);
      if (!hostEnvValue) { count(summary.refused, "purge_host_unreachable"); continue; }
      if (mode === "dry") { count(summary.refused, "purge_dry"); continue; }
      let receipt: ReturnType<typeof parseBackupPurgeReceipt> = null;
      try {
        const run = await runHostScript(buildBackupPurgeScript(agentId, buildColdStorageInstallScriptOrExit(env)), hostEnvValue, { timeoutMs: SCRIPT_TIMEOUT_MS });
        receipt = parseBackupPurgeReceipt(run?.stdout ?? "");
      } catch {
        receipt = null;
      }
      const iso = new Date(now()).toISOString();
      await db.from("hivra_computer_backups").insert({
        id: newId(), agent_id: agentId, user_id: source.user_id, kind: "purge",
        status: receipt?.ok ? "succeeded" : "failed", proxmox_host: source.proxmox_host,
        vmid: source.vmid, reason: receipt?.reason ?? "no_receipt", started_at: iso, finished_at: iso,
      });
      if (receipt?.ok) summary.purged += 1; else summary.errors += 1;
    }
  }

  // 3. Start one job on each idle host.
  if (mode === "dry") summary.plan = [];
  for (const [host, hostAgents] of agentsByHost) {
    if (outOfTime()) { count(summary.refused, "next_run"); break; }
    if (busyHosts.has(host)) continue;
    const next = pickNextJob({ agents: hostAgents, lastBackup, lastDrill, now: now(), settings });
    if (!next) continue;
    const vmid = Number(next.agent.vmid);
    if (mode === "dry") { summary.plan?.push({ host, kind: next.kind, vmid }); continue; }
    const resolved = await targetFor(next.agent);
    if (!resolved || !resolved.ok) { count(summary.refused, "target_unavailable"); continue; }
    const target = resolved.target;
    if (!target.bindingTag || target.vmid !== vmid) { count(summary.refused, "binding_not_enforced"); continue; }
    const password = computerBackupPassword(next.agent.id, env)!;
    const jobId = newId();
    let script: string;
    try {
      script = buildBackupStartScript({
        kind: next.kind, jobId, agentId: next.agent.id, vmid, bindingTag: target.bindingTag,
        keepDaily: settings.keepDaily, keepWeekly: settings.keepWeekly, uploadLimitKiB: settings.uploadLimitKiB,
        maxHours: settings.maxHours, disks: next.source?.disks ?? undefined,
        coldStorageInstall: buildColdStorageInstallScriptOrExit(env),
      });
    } catch {
      count(summary.refused, "script_invalid");
      continue;
    }
    // The row exists before the host starts work, so a crash in between leaves a job the poll can time out.
    const { error: insertError } = await db.from("hivra_computer_backups").insert({
      id: jobId, agent_id: next.agent.id, user_id: next.agent.user_id, kind: next.kind, status: "running",
      proxmox_host: host, vmid, source_backup_id: next.source?.id ?? null, started_at: new Date(now()).toISOString(),
    });
    if (insertError) { summary.errors += 1; continue; }
    let receipt: ReturnType<typeof parseBackupStartReceipt> = null;
    try {
      const run = await runWithStdin(script, `${password}\n`, target.env, { timeoutMs: SCRIPT_TIMEOUT_MS });
      receipt = parseBackupStartReceipt(run?.stdout ?? "", jobId);
    } catch {
      receipt = null;
    }
    if (!receipt || !receipt.ok) {
      const reason = receipt?.reason ?? "no_receipt";
      await db.from("hivra_computer_backups").update({
        status: reason === "host_busy" || reason === "already_running" ? "skipped" : "failed",
        reason, finished_at: new Date(now()).toISOString(),
      }).eq("id", jobId);
      count(summary.refused, reason);
      continue;
    }
    count(summary.started, next.kind);
  }
  return summary;
}

export type ComputerBackupStatus = {
  enabled: boolean;
  lastBackupAt: string | null;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  keepDaily: number;
  keepWeekly: number;
};

/** What an owner sees about one computer's off-site copies. */
export async function readComputerBackupStatus(agentId: string, env: EnvLike = process.env, db: Db = supabaseAdmin): Promise<ComputerBackupStatus> {
  const settings = computerBackupSettings(env);
  const base: ComputerBackupStatus = {
    enabled: computerBackupsMode(env) === "on", lastBackupAt: null, lastCheckedAt: null, lastCheckOk: null,
    keepDaily: settings.keepDaily, keepWeekly: settings.keepWeekly,
  };
  if (!db) return base;
  const { data } = await db
    .from("hivra_computer_backups")
    .select("kind, status, started_at, finished_at")
    .eq("agent_id", agentId)
    .in("kind", ["backup", "drill"])
    .in("status", ["succeeded", "failed"])
    .order("started_at", { ascending: false })
    .limit(50);
  const rows = (data ?? []) as Array<{ kind: string; status: string; started_at: string; finished_at: string | null }>;
  const backup = rows.find((r) => r.kind === "backup" && r.status === "succeeded");
  const drill = rows.find((r) => r.kind === "drill");
  return {
    ...base,
    // The copy is of the moment its snapshot was taken, at the job's start.
    lastBackupAt: backup ? backup.started_at : null,
    lastCheckedAt: drill ? (drill.finished_at ?? drill.started_at) : null,
    lastCheckOk: drill ? drill.status === "succeeded" : null,
  };
}

export type RestoreStartResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: string };

/**
 * Starts a restore of one backup over the same computer. Operator-only: the
 * computer must already be stopped (not asleep), and it stays stopped after.
 * The job's outcome arrives through the sweep's poll like any other job.
 */
export async function startComputerRestore(input: {
  agentId: string;
  backupId: string;
}, deps: ComputerBackupSweepDeps = {}): Promise<RestoreStartResult> {
  const env = deps.env ?? process.env;
  const db = deps.db ?? supabaseAdmin;
  if (!db) return { ok: false, reason: "no_database" };
  const now = deps.now ?? Date.now;
  const runWithStdin = deps.runHostScriptWithStdin ?? runProxmoxHostScriptWithStdin;
  const resolveTarget = deps.resolveTarget ?? resolveSleepTarget;
  const newId = deps.newId ?? randomUUID;
  const password = computerBackupPassword(input.agentId, env);
  if (!password) return { ok: false, reason: "no_backup_key" };
  const { data: backup } = await db.from("hivra_computer_backups")
    .select("id, agent_id, user_id, kind, status, proxmox_host, vmid, disks")
    .eq("id", input.backupId).eq("agent_id", input.agentId).maybeSingle();
  if (!backup || backup.kind !== "backup" || backup.status !== "succeeded") return { ok: false, reason: "backup_not_found" };
  const { data: agent } = await db.from("hivra_agents").select("*").eq("id", input.agentId).neq("status", "deleted").maybeSingle();
  if (!agent) return { ok: false, reason: "agent_not_found" };
  if (Number(agent.vmid) !== Number(backup.vmid)) return { ok: false, reason: "vmid_changed" };
  const resolved = await resolveTarget(agent, LOG_SOURCE).catch(() => null);
  if (!resolved || !resolved.ok || !resolved.target.bindingTag) return { ok: false, reason: "target_unavailable" };
  const settings = computerBackupSettings(env);
  const jobId = newId();
  let script: string;
  try {
    script = buildBackupStartScript({
      kind: "restore", jobId, agentId: input.agentId, vmid: resolved.target.vmid, bindingTag: resolved.target.bindingTag,
      keepDaily: settings.keepDaily, keepWeekly: settings.keepWeekly, uploadLimitKiB: 0, maxHours: settings.maxHours,
      disks: (backup.disks ?? []) as BackupDisk[], coldStorageInstall: buildColdStorageInstallScriptOrExit(env),
    });
  } catch {
    return { ok: false, reason: "script_invalid" };
  }
  const { error } = await db.from("hivra_computer_backups").insert({
    id: jobId, agent_id: input.agentId, user_id: backup.user_id, kind: "restore", status: "running",
    proxmox_host: hostOf(agent as AgentRow), vmid: resolved.target.vmid, source_backup_id: backup.id,
    started_at: new Date(now()).toISOString(),
  });
  if (error) return { ok: false, reason: "insert_failed" };
  const run = await runWithStdin(script, `${password}\n`, resolved.target.env, { timeoutMs: SCRIPT_TIMEOUT_MS }).catch(() => null);
  const receipt = parseBackupStartReceipt(run?.stdout ?? "", jobId);
  if (!receipt || !receipt.ok) {
    const reason = receipt?.reason ?? "no_receipt";
    await db.from("hivra_computer_backups").update({ status: "failed", reason, finished_at: new Date(now()).toISOString() }).eq("id", jobId);
    return { ok: false, reason };
  }
  return { ok: true, jobId };
}
