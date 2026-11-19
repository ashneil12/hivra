import { log } from "@/lib/logger";
import { reportOpsEvent, type OpsEventInput } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import {
  isProxmoxProvisioningConfigured,
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import { resolveHivraProxmoxHost } from "@/lib/hivra/proxmox-target";
import {
  CAPACITY_READING_MAX_AGE_MS,
  classifyHostCapacity,
  hostCapacityAlertsEnabled,
  resolveCapacityThresholds,
  type CapacityLevel,
  type CapacityReasonCode,
  type CapacityThresholds,
  hostCapacityHostFilter,
} from "@/lib/hivra/capacity/classify";
import {
  buildHostCapacityScript, parseHostCapacityOutput, parseVmMemoryLines, type HostCapacityProbe, type VmMemorySample,
} from "@/lib/hivra/capacity/host-probe";
import { agentMemorySamplingEnabled, recordHostMemorySamples } from "@/lib/hivra/capacity/memory-use";

/**
 * Host capacity sweep: one read-only script per active host, the agents on it
 * from the database, a verdict, the reading stored on the host's row, and an
 * ops event when a host (or every host) is close to full.
 *
 * It never changes an agent or a host. With HIVRA_HOST_CAPACITY_ALERTS not
 * `on` it does nothing at all.
 */

type EnvLike = Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the admin client is untyped here, as in the other sweeps
type Db = any;

const LOG_SOURCE = "hivra-host-capacity";
const ROUTE = "/api/cron/hivra-host-capacity";
// The route may run for 120 seconds. One host gets 45 (its script's own timeouts add up to 42), or 53 when
// the script also reads each VM's memory (50), and no host is started after 60, so the fleet check always
// runs. A host that was not started counts as unread.
const HOST_SCRIPT_TIMEOUT_MS = 45_000;
const HOST_SCRIPT_WITH_VM_MEMORY_TIMEOUT_MS = 53_000;
const START_NO_HOST_AFTER_MS = 60_000;
const HOSTS_IN_PARALLEL = 4;
const AGENT_PAGE = 1000;
const AGENT_PAGES_MAX = 20;

/** What is stored in proxmox_hosts.capacity_reading. */
export type StoredCapacityReading = {
  v: 1;
  at: string;
  level: CapacityLevel;
  reasons: CapacityReasonCode[];
  canAdmitStandard: boolean;
  /** Since when the host has had no room for a standard agent, without a break. Absent while it has room. */
  fullSince?: string;
  oversubscriptionRatio: number;
  memTotalMb: number;
  memAvailableMb: number;
  wakeHeadroomMb: number;
  pool: HostCapacityProbe["pool"];
  vms: HostCapacityProbe["vms"];
  agents: AgentTotals;
};

type AgentTotals = {
  total: number;
  napping: number;
  hibernated: number;
  committedRamMb: number;
  hibernatedRamMb: number;
  largestHibernatedRamMb: number;
};

export type HostCapacitySweepSummary = {
  skipped: boolean;
  reason?: string;
  /** The hosts or agents could not be loaded: nothing was checked, and the route answers 500. */
  failed?: boolean;
  hosts: number;
  read: number;
  probeFailed: number;
  levels: Record<CapacityLevel, number>;
  fleetFull: boolean;
  errors: number;
  /** Agents whose memory use was recorded (HIVRA_AGENT_MEMORY_SAMPLING=1). Absent when sampling is off. */
  memorySamples?: number;
};

export type HostCapacitySweepDeps = {
  db?: Db;
  env?: EnvLike;
  now?: () => number;
  runHostScript?: typeof runProxmoxHostScript;
  report?: (event: OpsEventInput) => Promise<unknown>;
};

type HostRow = { id: string; wake_headroom_ram_mb: number | null; capacity_reading: unknown; capacity_reading_at: string | null };

const emptyTotals = (): AgentTotals => ({
  total: 0, napping: 0, hibernated: 0, committedRamMb: 0, hibernatedRamMb: 0, largestHibernatedRamMb: 0,
});

/** The stored reading, or null when the column is empty or holds something else. */
export function readStoredCapacity(value: unknown): StoredCapacityReading | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<StoredCapacityReading>;
  if (r.v !== 1 || typeof r.at !== "string" || typeof r.canAdmitStandard !== "boolean") return null;
  if (r.level !== "ok" && r.level !== "warn" && r.level !== "critical") return null;
  return r as StoredCapacityReading;
}

/** Hivra-managed agents on Proxmox, by host: every row that exists holds its memory when awake. */
async function loadAgentTotals(db: Db): Promise<Map<string, AgentTotals> | null> {
  const byHost = new Map<string, AgentTotals>();
  for (let page = 0; page < AGENT_PAGES_MAX; page += 1) {
    const { data, error } = await db
      .from("hivra_agents")
      .select("id, proxmox_host, ram, ram_max, sleep_state")
      .eq("deployment_mode", "hivra-managed")
      .eq("computer_substrate", "proxmox-kvm")
      .is("deployment_target_id", null)
      .neq("status", "deleted")
      .order("id", { ascending: true })
      .range(page * AGENT_PAGE, (page + 1) * AGENT_PAGE - 1);
    if (error) return null;
    const rows = (data ?? []) as Array<{ proxmox_host: string | null; ram: number | null; ram_max: number | null; sleep_state: string | null }>;
    for (const row of rows) {
      const host = resolveHivraProxmoxHost(row.proxmox_host).toLowerCase();
      const totals = byHost.get(host) ?? emptyTotals();
      // The VM's memory is its maximum (ram_max, GB) when one is set, else ram (GB).
      const gb = Math.max(Number(row.ram) || 0, Number(row.ram_max) || 0);
      const ramMb = Math.round(gb * 1024);
      totals.total += 1;
      totals.committedRamMb += ramMb;
      if (row.sleep_state === "napping") totals.napping += 1;
      if (row.sleep_state === "hibernated") {
        totals.hibernated += 1;
        totals.hibernatedRamMb += ramMb;
        totals.largestHibernatedRamMb = Math.max(totals.largestHibernatedRamMb, ramMb);
      }
      byHost.set(host, totals);
    }
    if (rows.length < AGENT_PAGE) return byHost;
  }
  return byHost;
}

async function inParallel<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

function hostEvent(hostId: string, reading: StoredCapacityReading): OpsEventInput {
  // Title and message stay the same for a host and level, so repeats land on one event. The numbers go in the metadata.
  // Only a fatal event pages an admin, once per fingerprint: a critical host pages once a day while it lasts.
  const critical = reading.level === "critical";
  return {
    source: "hivra.host_capacity",
    severity: critical ? "fatal" : "warn",
    ...(critical ? { fingerprintDetail: reading.at.slice(0, 10) } : {}),
    title: `Host ${hostId} capacity ${reading.level}`,
    message: reading.level === "critical"
      ? `Host ${hostId} is full or nearly full. New agents are placed on other hosts while this lasts. The reasons and numbers are in the metadata.`
      : `Host ${hostId} is getting close to full. The reasons and numbers are in the metadata.`,
    route: ROUTE,
    metadata: { host_id: hostId, ...reading },
  };
}

export async function runHostCapacitySweep(deps: HostCapacitySweepDeps = {}): Promise<HostCapacitySweepSummary> {
  const env = deps.env ?? process.env;
  const summary: HostCapacitySweepSummary = {
    skipped: false, hosts: 0, read: 0, probeFailed: 0, levels: { ok: 0, warn: 0, critical: 0 }, fleetFull: false, errors: 0,
  };
  if (!hostCapacityAlertsEnabled(env)) return { ...summary, skipped: true, reason: "flag_off" };
  const db = deps.db ?? supabaseAdmin;
  if (!db) return { ...summary, skipped: true, reason: "no_database" };

  const now = deps.now ?? Date.now;
  const runHostScript = deps.runHostScript ?? runProxmoxHostScript;
  const report = async (event: OpsEventInput) => {
    try {
      await (deps.report ?? reportOpsEvent)(event);
    } catch {
      summary.errors += 1;
    }
  };
  const thresholds: CapacityThresholds = resolveCapacityThresholds(env);

  const { data: hostData, error: hostError } = await db
    .from("proxmox_hosts")
    .select("id, wake_headroom_ram_mb, capacity_reading, capacity_reading_at")
    .eq("status", "active");
  if (hostError) {
    log.error("host capacity: failed to load hosts", new Error(String(hostError.message ?? hostError)), {
      source: LOG_SOURCE, failureType: "host_capacity_hosts_query_failed",
    });
    return { ...summary, errors: 1, failed: true, reason: "hosts_query_failed" };
  }
  const agentTotals = await loadAgentTotals(db);
  if (!agentTotals) {
    log.error("host capacity: failed to load agents", new Error("hivra_agents query failed"), {
      source: LOG_SOURCE, failureType: "host_capacity_agents_query_failed",
    });
    return { ...summary, errors: 1, failed: true, reason: "agents_query_failed" };
  }

  // Only hosts this deployment is told to read (if a list is set) and can reach: a registry row without connection settings is not probed.
  const only = hostCapacityHostFilter(env);
  const hosts = ((hostData ?? []) as HostRow[])
    .filter((row) => !only || only.has(String(row.id).toLowerCase()))
    .map((row) => ({ row, env: resolveProxmoxTargetConfiguration(env, String(row.id)).env }))
    .filter((host) => isProxmoxProvisioningConfigured(host.env));
  summary.hosts = hosts.length;

  const readings = new Map<string, StoredCapacityReading>();
  const unread: string[] = [];
  const sampling = agentMemorySamplingEnabled(env);
  if (sampling) summary.memorySamples = 0;
  const script = buildHostCapacityScript(sampling ? { vmMemory: true } : {});
  const scriptTimeoutMs = sampling ? HOST_SCRIPT_WITH_VM_MEMORY_TIMEOUT_MS : HOST_SCRIPT_TIMEOUT_MS;
  const startedAt = now();
  const isFresh = (at: string | null | undefined) => {
    const age = now() - Date.parse(at ?? "");
    return Number.isFinite(age) && age <= CAPACITY_READING_MAX_AGE_MS;
  };

  await inParallel(hosts, HOSTS_IN_PARALLEL, async ({ row, env: hostEnv }) => {
    const hostId = String(row.id);
    const previous = readStoredCapacity(row.capacity_reading);
    let probe: HostCapacityProbe | null = null;
    let vmMemory: VmMemorySample[] = [];
    try {
      if (now() - startedAt <= START_NO_HOST_AFTER_MS) {
        const run = await runHostScript(script, hostEnv, { timeoutMs: scriptTimeoutMs });
        probe = parseHostCapacityOutput(run?.stdout ?? "");
        if (sampling && probe) vmMemory = parseVmMemoryLines(run?.stdout ?? "");
      }
    } catch {
      probe = null;
    }
    if (sampling && vmMemory.length > 0) {
      // Recording is beside the point of the sweep: a failure is counted and logged, and the reading goes on.
      const recorded = await recordHostMemorySamples(db, hostId, vmMemory, now());
      summary.memorySamples = (summary.memorySamples ?? 0) + recorded.recorded;
      if (recorded.failed) {
        summary.errors += 1;
        log.warn("host capacity: failed to record agent memory use", {
          source: LOG_SOURCE, failureType: "agent_memory_use_store_failed", proxmoxHost: hostId,
        });
      }
    }
    if (!probe) {
      // No reading: the stored one ages out and placement goes back to its usual behaviour.
      summary.probeFailed += 1;
      log.warn("host capacity: could not read host", {
        source: LOG_SOURCE, failureType: "host_capacity_probe_failed", proxmoxHost: hostId,
      });
      // One missed run is not news. Once the last reading is too old to trust, say so: nobody is watching this host.
      if (!isFresh(row.capacity_reading_at)) {
        unread.push(hostId);
        await report({
          source: "hivra.host_capacity_unread",
          severity: "error",
          title: `Host ${hostId} capacity could not be read`,
          message: `Host ${hostId} has had no capacity reading for over 15 minutes, so a full host would go unnoticed. Check that the host is reachable.`,
          route: ROUTE,
          metadata: { host_id: hostId, last_reading_at: row.capacity_reading_at ?? null },
        });
      } else if (previous) {
        // Still recent enough to count in the fleet check below.
        readings.set(hostId, previous);
      }
      return;
    }

    const agents = agentTotals.get(hostId.toLowerCase()) ?? emptyTotals();
    const wakeHeadroomMb = Math.max(0, Number(row.wake_headroom_ram_mb) || 0);
    const verdict = classifyHostCapacity({
      memTotalMb: probe.memTotalMb,
      memAvailableMb: probe.memAvailableMb,
      wakeHeadroomMb,
      pool: probe.pool,
      committedRamMb: agents.committedRamMb,
      hibernatedRamMb: agents.hibernatedRamMb,
      largestHibernatedRamMb: agents.largestHibernatedRamMb,
    }, thresholds);
    const at = new Date(now()).toISOString();
    const reading: StoredCapacityReading = {
      v: 1,
      at,
      level: verdict.level,
      reasons: verdict.reasons.map((reason) => reason.code),
      canAdmitStandard: verdict.canAdmitStandard,
      ...(verdict.canAdmitStandard ? {} : { fullSince: previous?.canAdmitStandard === false ? previous.fullSince ?? previous.at : at }),
      oversubscriptionRatio: verdict.oversubscriptionRatio,
      memTotalMb: probe.memTotalMb,
      memAvailableMb: probe.memAvailableMb,
      wakeHeadroomMb,
      pool: probe.pool,
      vms: probe.vms,
      agents,
    };
    readings.set(hostId, reading);
    summary.read += 1;
    summary.levels[reading.level] += 1;

    const { error: writeError } = await db
      .from("proxmox_hosts")
      .update({ capacity_reading: reading, capacity_reading_at: reading.at })
      .eq("id", hostId);
    if (writeError) {
      summary.errors += 1;
      log.warn("host capacity: failed to store the reading", {
        source: LOG_SOURCE, failureType: "host_capacity_store_failed", proxmoxHost: hostId,
      });
    }

    if (reading.level !== "ok") {
      await report(hostEvent(hostId, reading));
    } else if (previous && previous.level !== "ok") {
      await report({
        source: "hivra.host_capacity_recovered",
        severity: "info",
        title: `Host ${hostId} capacity recovered`,
        message: `Host ${hostId} is back within its capacity limits.`,
        route: ROUTE,
        metadata: { host_id: hostId, previous_level: previous.level, ...reading },
      });
    }
  });

  // The fleet verdict counts every host with a reading from this run or recent enough to trust. A host
  // unread for longer than that cannot be counted on to take a launch, so it does not hold the alert back.
  const known = [...readings.values()];
  const fleetFull = summary.read > 0 && known.every((reading) => !reading.canAdmitStandard);
  summary.fleetFull = fleetFull;
  const metadata = {
    hosts: hosts.length,
    unread_hosts: unread,
    standard_agent_ram_mb: thresholds.standardAgentRamMb,
    by_host: Object.fromEntries([...readings].map(([id, r]) => [id, {
      level: r.level, reasons: r.reasons, at: r.at, mem_available_mb: r.memAvailableMb, wake_headroom_mb: r.wakeHeadroomMb,
      pool_used_percent: r.pool?.usedPercent ?? null, oversubscription_ratio: r.oversubscriptionRatio,
    }])),
  };
  const storedBefore = hosts.map(({ row }) => readStoredCapacity(row.capacity_reading)).filter((reading) => reading !== null);
  if (fleetFull) {
    // A fatal event pages once per fingerprint. The day makes a lasting outage page again once a day. The
    // hour the fleet last became full (the latest host to fill) makes a second outage on the same day page too.
    const fullSince = known.map((reading) => reading.fullSince ?? reading.at).sort().at(-1) ?? "";
    await report({
      source: "hivra.fleet_capacity",
      severity: "fatal",
      title: "No Hivra host can take a new agent",
      message: "No active host that could be read has room for a standard new agent. Add a host or free capacity. Per-host numbers, and any host that could not be read, are in the metadata.",
      route: ROUTE,
      fingerprintDetail: `${new Date(now()).toISOString().slice(0, 10)} full since ${fullSince.slice(0, 13)}`,
      metadata,
    });
  } else if (summary.read > 0 && storedBefore.length > 0 && storedBefore.every((reading) => !reading.canAdmitStandard)) {
    await report({
      source: "hivra.fleet_capacity_recovered",
      severity: "info",
      title: "A Hivra host can take new agents again",
      message: "At least one active host has room for a standard new agent again.",
      route: ROUTE,
      metadata,
    });
  }

  return summary;
}
