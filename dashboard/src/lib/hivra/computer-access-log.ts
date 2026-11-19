// The owner-visible log of connections into an agent's computer.
//
// Each Proxmox host records, from its own audit log, every command, console,
// SSH session or file copy that reaches into a guest from the host, and who
// ran it (scripts/proxmox-host-guest-access-audit.sh). A cron drains each
// host's spool and stores hourly counts per computer in
// hivra_computer_access_log; the owner reads their own computer's rows in
// Manage. No arguments, file names, contents or output are kept.
//
// Switches, both off by default:
//   HIVRA_ACCESS_LOG_COLLECTION=on        the cron drains hosts
//   NEXT_PUBLIC_HIVRA_ACCESS_LOG=true      owners see the log

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  isProxmoxProvisioningConfigured,
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import { resolveHivraProxmoxHost } from "@/lib/hivra/proxmox-target";

type EnvLike = Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the admin client is untyped here, as in the other sweeps
type Db = any;

const LOG_SOURCE = "hivra-access-log";
export const ACCESS_EVENT_PREFIX = "HIVRA_ACCESS_V1 ";
export const ACCESS_END_PREFIX = "HIVRA_ACCESS_END ";
export const ACCESS_AUDIT_PATH = "/usr/local/sbin/hivra-guest-access-audit";
export const ACCESS_DRAIN_BATCH = 2000;
/** One cron run reads at most this many batches per host; the rest wait. */
const MAX_BATCHES_PER_HOST = 5;
const HOSTS_IN_PARALLEL = 4;
const SCRIPT_TIMEOUT_MS = 90_000;
export const ACCESS_LOG_RETENTION_DAYS = 180;
export const ACCESS_LOG_VIEW_DAYS = 30;

export const ACCESS_CHANNELS = ["command", "files", "console", "screen", "status", "ssh"] as const;
export type AccessChannel = (typeof ACCESS_CHANNELS)[number];
export type ActorClass = "system" | "staff";

export function accessLogViewEnabled(env: EnvLike = process.env): boolean {
  return env.NEXT_PUBLIC_HIVRA_ACCESS_LOG === "true";
}

export function accessLogCollectionEnabled(env: EnvLike = process.env): boolean {
  return env.HIVRA_ACCESS_LOG_COLLECTION?.trim().toLowerCase() === "on";
}

/** Drops spool lines up to `afterSeq` on the host and prints the next batch. */
export function buildAccessDrainScript(afterSeq: number, batch = ACCESS_DRAIN_BATCH): string {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("Invalid cursor.");
  if (!Number.isInteger(batch) || batch < 1 || batch > 99_999) throw new Error("Invalid batch.");
  return `set -uo pipefail
if [ ! -x ${ACCESS_AUDIT_PATH} ]; then
  printf '%s{"installed":false}\\n' '${ACCESS_END_PREFIX}'
  exit 0
fi
timeout -k 5 80 ${ACCESS_AUDIT_PATH} --drain ${afterSeq} ${batch} </dev/null
`;
}

export interface AccessEvent {
  seq: number;
  at: number;
  vmid: number;
  channel: AccessChannel;
  actorClass: ActorClass;
  actorLabel: string;
  program: string | null;
}

export interface DrainResult {
  installed: boolean;
  lastSeq: number;
  /** The newest sequence number the host has handed out. */
  headSeq: number;
  more: boolean;
  events: AccessEvent[];
  rejected: number;
}

const PROGRAM = /^[A-Za-z0-9._+-]{1,40}$/;
const LABEL = /^[^\u0000-\u001f]{1,80}$/;

function parseEvent(raw: unknown): AccessEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const seq = r.seq, at = r.at, vmid = r.vmid;
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) return null;
  if (!Number.isSafeInteger(at) || (at as number) < 1_500_000_000 || (at as number) > 4_000_000_000) return null;
  if (!Number.isSafeInteger(vmid) || (vmid as number) < 100 || (vmid as number) > 999_999_999) return null;
  if (typeof r.channel !== "string" || !(ACCESS_CHANNELS as readonly string[]).includes(r.channel)) return null;
  if (r.actor_class !== "system" && r.actor_class !== "staff") return null;
  if (typeof r.actor_label !== "string" || !LABEL.test(r.actor_label)) return null;
  const program = typeof r.program === "string" && PROGRAM.test(r.program) ? r.program : null;
  return {
    seq: seq as number, at: at as number, vmid: vmid as number,
    channel: r.channel as AccessChannel, actorClass: r.actor_class, actorLabel: r.actor_label, program,
  };
}

/** Reads a drain run's output. Null when it printed no end line (the run failed). */
export function parseAccessDrainOutput(stdout: string): DrainResult | null {
  const events: AccessEvent[] = [];
  let rejected = 0;
  let end: Record<string, unknown> | null = null;
  for (const line of (stdout ?? "").split("\n")) {
    if (line.startsWith(ACCESS_EVENT_PREFIX)) {
      let parsed: AccessEvent | null = null;
      try {
        parsed = parseEvent(JSON.parse(line.slice(ACCESS_EVENT_PREFIX.length)));
      } catch {
        parsed = null;
      }
      if (parsed) events.push(parsed); else rejected += 1;
    } else if (line.startsWith(ACCESS_END_PREFIX)) {
      try {
        end = JSON.parse(line.slice(ACCESS_END_PREFIX.length)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  if (!end) return null;
  if (end.installed === false) return { installed: false, lastSeq: 0, headSeq: 0, more: false, events: [], rejected: 0 };
  if (!Number.isSafeInteger(end.last_seq) || (end.last_seq as number) < 0) return null;
  const headSeq = Number.isSafeInteger(end.head_seq) && (end.head_seq as number) >= 0 ? (end.head_seq as number) : (end.last_seq as number);
  return { installed: true, lastSeq: end.last_seq as number, headSeq, more: end.more === true, events, rejected };
}

export interface AgentCandidate {
  id: string;
  user_id: string;
  vmid: number | null;
  proxmox_host: string | null;
  status: string | null;
  created_at: string | null;
}

/**
 * The agent a host + VMID belonged to at a moment. VMIDs are reused, so the
 * newest agent created at or before the event wins; a deleted row only when
 * no live one fits.
 */
export function agentAt(candidates: AgentCandidate[], host: string, vmid: number, atSec: number, env: EnvLike = process.env): AgentCandidate | null {
  const at = atSec * 1000;
  const fits = candidates
    .filter((c) => c.vmid === vmid && resolveHivraProxmoxHost(c.proxmox_host, env).toLowerCase() === host.toLowerCase())
    .filter((c) => !c.created_at || Date.parse(c.created_at) <= at + 60_000)
    .sort((a, b) => Date.parse(b.created_at ?? "0") - Date.parse(a.created_at ?? "0"));
  return fits.find((c) => c.status !== "deleted") ?? fits[0] ?? null;
}

export interface AccessBucket {
  proxmox_host: string;
  vmid: number;
  agent_id: string | null;
  user_id: string | null;
  hour: string;
  actor_class: ActorClass;
  actor_label: string;
  channel: AccessChannel;
  programs: string[];
  count: number;
  first_at: string;
  last_at: string;
}

/** Hourly buckets per computer, who and channel, ready for hivra_record_computer_access. */
export function bucketAccessEvents(host: string, events: AccessEvent[], candidates: AgentCandidate[], env: EnvLike = process.env): AccessBucket[] {
  const buckets = new Map<string, AccessBucket>();
  for (const e of events) {
    const hour = new Date(Math.floor(e.at / 3600) * 3600 * 1000).toISOString();
    const key = [e.vmid, hour, e.actorClass, e.actorLabel, e.channel].join("|");
    const iso = new Date(e.at * 1000).toISOString();
    let b = buckets.get(key);
    if (!b) {
      const agent = agentAt(candidates, host, e.vmid, e.at, env);
      b = {
        proxmox_host: host, vmid: e.vmid, agent_id: agent?.id ?? null, user_id: agent?.user_id ?? null, hour,
        actor_class: e.actorClass, actor_label: e.actorLabel, channel: e.channel, programs: [], count: 0, first_at: iso, last_at: iso,
      };
      buckets.set(key, b);
    }
    b.count += 1;
    if (iso < b.first_at) b.first_at = iso;
    if (iso > b.last_at) b.last_at = iso;
    if (e.program && !b.programs.includes(e.program) && b.programs.length < 12) b.programs.push(e.program);
  }
  return [...buckets.values()];
}

export type AccessCollectionSummary = {
  skipped: boolean;
  reason?: string;
  failed?: boolean;
  hosts: number;
  notInstalled: string[];
  unreachable: string[];
  events: number;
  buckets: number;
  rejected: number;
  pruned?: number;
  errors: number;
};

export type AccessCollectionDeps = {
  db?: Db;
  env?: EnvLike;
  runHostScript?: typeof runProxmoxHostScript;
};

async function inParallel<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

export async function runAccessLogCollection(deps: AccessCollectionDeps = {}): Promise<AccessCollectionSummary> {
  const env = deps.env ?? process.env;
  const summary: AccessCollectionSummary = {
    skipped: false, hosts: 0, notInstalled: [], unreachable: [], events: 0, buckets: 0, rejected: 0, errors: 0,
  };
  if (!accessLogCollectionEnabled(env)) return { ...summary, skipped: true, reason: "flag_off" };
  const db = deps.db ?? supabaseAdmin;
  if (!db) return { ...summary, skipped: true, reason: "no_database" };
  const runHostScript = deps.runHostScript ?? runProxmoxHostScript;

  const { data: hostData, error: hostError } = await db.from("proxmox_hosts").select("id").eq("status", "active");
  if (hostError) return { ...summary, failed: true, errors: 1, reason: "hosts_query_failed" };
  const hosts = ((hostData ?? []) as Array<{ id: string }>)
    .map((row) => ({ id: String(row.id), env: resolveProxmoxTargetConfiguration(env, String(row.id)).env }))
    .filter((host) => isProxmoxProvisioningConfigured(host.env));
  summary.hosts = hosts.length;

  await inParallel(hosts, HOSTS_IN_PARALLEL, async ({ id: host, env: hostEnv }) => {
    const { data: cursorRow } = await db.from("hivra_access_log_cursors").select("last_seq").eq("proxmox_host", host).maybeSingle();
    let cursor = Number((cursorRow as { last_seq?: number } | null)?.last_seq ?? 0) || 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_HOST; batch += 1) {
      let drained: DrainResult | null = null;
      try {
        const run = await runHostScript(buildAccessDrainScript(cursor), hostEnv, { timeoutMs: SCRIPT_TIMEOUT_MS, maxOutputBytes: 4 * 1024 * 1024 });
        drained = parseAccessDrainOutput(run?.stdout ?? "");
      } catch {
        drained = null;
      }
      if (!drained) { summary.unreachable.push(host); return; }
      if (!drained.installed) { summary.notInstalled.push(host); return; }
      summary.rejected += drained.rejected;
      // The host started its numbering again (its state was wiped): read from the start.
      if (drained.headSeq < cursor) {
        cursor = 0;
        log.warn("access log: host numbering restarted", { source: LOG_SOURCE, proxmoxHost: host, failureType: "access_log_seq_reset" });
        continue;
      }
      const fresh = drained.events.filter((e) => e.seq > cursor);
      if (fresh.length > 0) {
        const vmids = [...new Set(fresh.map((e) => e.vmid))];
        const { data: agentData, error: agentError } = await db
          .from("hivra_agents").select("id, user_id, vmid, proxmox_host, status, created_at").in("vmid", vmids);
        if (agentError) { summary.errors += 1; return; }
        const buckets = bucketAccessEvents(host, fresh, (agentData ?? []) as AgentCandidate[], env);
        const { error: rpcError } = await db.rpc("hivra_record_computer_access", { entries: buckets });
        // Not stored: keep the cursor so the next run reads the same lines again.
        if (rpcError) { summary.errors += 1; log.warn("access log: store failed", { source: LOG_SOURCE, proxmoxHost: host, failureType: "access_log_store_failed" }); return; }
        summary.events += fresh.length;
        summary.buckets += buckets.length;
      }
      if (drained.lastSeq > cursor) {
        cursor = drained.lastSeq;
        const { error: cursorError } = await db.from("hivra_access_log_cursors")
          .upsert({ proxmox_host: host, last_seq: cursor, collected_at: new Date().toISOString() }, { onConflict: "proxmox_host" });
        if (cursorError) { summary.errors += 1; return; }
      } else if (!cursorRow) {
        await db.from("hivra_access_log_cursors").upsert({ proxmox_host: host, last_seq: cursor, collected_at: new Date().toISOString() }, { onConflict: "proxmox_host" });
      }
      if (!drained.more) return;
    }
  });

  const cutoff = new Date(Date.now() - ACCESS_LOG_RETENTION_DAYS * 86_400_000).toISOString();
  const { error: pruneError, count } = await db.from("hivra_computer_access_log").delete({ count: "exact" }).lt("hour", cutoff);
  if (pruneError) summary.errors += 1; else summary.pruned = count ?? 0;
  if (summary.unreachable.length) {
    log.warn("access log: hosts unreachable", { source: LOG_SOURCE, failureType: "access_log_host_unreachable", hosts: summary.unreachable });
  }
  return summary;
}

export interface AccessLogEntry {
  hour: string;
  firstAt: string;
  lastAt: string;
  who: ActorClass;
  label: string;
  channel: AccessChannel;
  programs: string[];
  count: number;
}

export interface AccessLogView {
  /** True once this computer's server has reported at least once. */
  recording: boolean;
  recordingSince: string | null;
  lastCollectedAt: string | null;
  days: number;
  entries: AccessLogEntry[];
  totals: { staff: number; system: number };
}

export async function readAccessLog(db: Db, input: { agentId: string; proxmoxHost: string | null }): Promise<AccessLogView> {
  const host = resolveHivraProxmoxHost(input.proxmoxHost);
  const since = new Date(Date.now() - ACCESS_LOG_VIEW_DAYS * 86_400_000).toISOString();
  const [{ data: rows, error }, { data: cursor }] = await Promise.all([
    db.from("hivra_computer_access_log")
      .select("hour, first_at, last_at, actor_class, actor_label, channel, programs, count")
      .eq("agent_id", input.agentId)
      .gte("hour", since)
      .order("last_at", { ascending: false })
      .limit(500),
    db.from("hivra_access_log_cursors").select("first_collected_at, collected_at").eq("proxmox_host", host).maybeSingle(),
  ]);
  if (error) throw new Error("Could not read this computer's access log");
  const entries: AccessLogEntry[] = ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    hour: String(r.hour), firstAt: String(r.first_at), lastAt: String(r.last_at),
    who: r.actor_class === "staff" ? "staff" : "system", label: String(r.actor_label),
    channel: r.channel as AccessChannel, programs: Array.isArray(r.programs) ? (r.programs as string[]) : [], count: Number(r.count) || 0,
  }));
  const c = cursor as { first_collected_at?: string; collected_at?: string } | null;
  return {
    recording: Boolean(c),
    recordingSince: c?.first_collected_at ?? null,
    lastCollectedAt: c?.collected_at ?? null,
    days: ACCESS_LOG_VIEW_DAYS,
    entries,
    totals: {
      staff: entries.filter((e) => e.who === "staff").reduce((n, e) => n + e.count, 0),
      system: entries.filter((e) => e.who === "system").reduce((n, e) => n + e.count, 0),
    },
  };
}
