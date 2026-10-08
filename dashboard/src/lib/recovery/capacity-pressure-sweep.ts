import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
  isProxmoxVmMissingResult,
  resolveProxmoxMaxTenantInstances,
  shutdownProxmoxInstance,
  type ProxmoxInfrastructure,
} from "@/lib/services/proxmox-instance-service";
import { buildInstanceLifecyclePatch } from "@/lib/instance-lifecycle";
import { reportOpsEvent } from "@/lib/ops-events";
import { sendCapacityPausedEmail } from "@/lib/email/capacity-pause";

/**
 * Capacity-pressure sweep — when a Proxmox host runs hot on tenant COUNT
 * (active instances at/over max_tenant_instances), park the lowest-priority
 * idle instances so the fleet never needs new servers.
 *
 * Trigger is tenant count, not RAM: stopped VMs already contribute 0 RAM to
 * placement (PROXMOX_HOST_ALLOCATION_STATES), so the binding constraint on a
 * packed host is the per-host tenant cap. RAM pressure is computed and
 * reported alongside for the operator, but never drives a park.
 *
 * Parking = the exact mechanics of the inactivity sweep: graceful qm
 * shutdown via shutdownProxmoxInstance(), then lifecycle_state='paused' with
 * paused_reason='capacity_pressure'. Downstream is reused, not duplicated:
 * the archive-stopped-vms cron cold-archives paused rows after 48h, and the
 * user one-click resumes via POST /api/instances/[id] action=start (which
 * clears paused_reason via buildInstanceLifecyclePatch).
 *
 * Safety rails:
 *   - Explicit opt-in (CAPACITY_PRESSURE_SWEEP_ENABLED), like every sweeper.
 *   - Dry-run by default (CAPACITY_PRESSURE_DRY_RUN, ?dryRun=1) — the cron
 *     computes and returns the full park plan without touching a VM until
 *     the operator flips the env to 'false'.
 *   - Never parks anything with recent activity (any anchor newer than
 *     CAPACITY_PRESSURE_MIN_IDLE_HOURS, default 48h).
 *   - Free tiers first, oldest-idle first; paid tiers only when
 *     CAPACITY_PRESSURE_INCLUDE_PAID='true' AND idle >= 7 days.
 *   - Caps: CAPACITY_PRESSURE_MAX_PER_HOST (default 3) per host,
 *     CAPACITY_PRESSURE_MAX_TOTAL (default 10) per run. Hosts are relieved
 *     worst-pressure-first so the global cap goes where it hurts most.
 */

const LOG_SOURCE = "capacity-pressure-sweep";

const FREE_TIER_VALUES = new Set(["credit_base", "token_base"]);
const PAID_TIER_VALUES = new Set(["operator", "fleet", "command"]);

const COUNT_THRESHOLD_DEFAULT = 1.0;
const MIN_IDLE_HOURS_DEFAULT = 48;
// Paid agents are only ever parked (when opted in) after a much longer idle
// window — a paying customer's box must never disappear under them because
// a host got busy.
const PAID_MIN_IDLE_HOURS = 7 * 24;
const MAX_PER_HOST_DEFAULT = 3;
const MAX_TOTAL_DEFAULT = 10;
// Once a host trips the threshold, park enough to land this far back under
// it — otherwise a single wake/provision re-trips the host on the very next
// run and the sweep oscillates.
const RELIEF_MARGIN = 0.05;
// A single AX41/AX52 host tops out well under this; the limit is just a
// guard against a runaway query.
const HOST_INSTANCE_BATCH_LIMIT = 500;

const CLERK_API_BASE_URL = "https://api.clerk.com/v1";
const NOTIFICATION_KEY = "capacity_paused";

type HostRow = {
  id: string;
  total_ram_mb: number;
  reserved_ram_mb: number;
  wake_headroom_ram_mb: number;
  status: string;
  max_tenant_instances: number | null;
};

type ParkCandidate = {
  id: string;
  user_id: string;
  name: string | null;
  agent_type: string | null;
  resource_tier: string | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
  ram_limit: number | null;
  last_activity_at: string | null;
  created_at: string | null;
  last_lifecycle_transition_at: string | null;
  notifications_sent: Record<string, unknown> | null;
};

type CapacityPressureParkedInstance = {
  id: string;
  tier: string | null;
  idleDays: number;
};

type CapacityPressureHostReport = {
  host: string;
  status: string;
  active: number;
  cap: number | null;
  pressure: number | null;
  ramAllocatedMb: number;
  ramUsableMb: number;
  ramPressure: number | null;
  hot: boolean;
  parked: CapacityPressureParkedInstance[];
};

export type CapacityPressureSweepSummary = {
  skipped: boolean;
  enabled: boolean;
  dryRun: boolean;
  countThreshold: number;
  minIdleHours: number;
  includePaid: boolean;
  maxPerHost: number;
  maxTotal: number;
  hostsScanned: number;
  hotHosts: number;
  parked: number;
  failed: number;
  vmMissing: number;
  emailsSent: number;
  hosts: CapacityPressureHostReport[];
};

type ParkOutcome = "paused" | "vm_missing" | "not_proxmox_backed";

type ClerkUser = {
  id: string;
  first_name?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: Array<{
    id: string;
    email_address: string;
    verification?: { status?: string | null } | null;
  }>;
};

function isSweepEnabled(): boolean {
  return (
    process.env.CAPACITY_PRESSURE_SWEEP_ENABLED?.trim().toLowerCase() === "true"
  );
}

// Dry-run unless the operator has EXPLICITLY set the env to 'false'. Missing,
// empty, or any other value all mean dry-run — the act mode is opt-in twice
// (sweep enabled AND dry-run disabled).
function isDryRunDefault(): boolean {
  return process.env.CAPACITY_PRESSURE_DRY_RUN?.trim().toLowerCase() !== "false";
}

function readEnvFloat(envKey: string, fallback: number): number {
  const raw = process.env[envKey]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readEnvInt(envKey: string, fallback: number): number {
  const raw = process.env[envKey]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readEnvBool(envKey: string, fallback: boolean): boolean {
  const raw = process.env[envKey]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

// Same dormancy rule as the inactivity sweep: park only on GENUINE USER
// inactivity. last_activity_at is the authoritative user-activity signal
// (written solely by real user actions — see instance-activity.ts), and
// created_at is the floor for never-yet-active fresh provisions. We do NOT
// anchor on last_lifecycle_transition_at: it is bumped by PLATFORM maintenance
// (redeploys, reconciles, migrations, archive sweeps) too, so treating it as
// activity lets one fleet-wide maintenance pass shield every idle instance and
// starve the sweep (the 2026-06-08 webfree-migration starvation). User-driven
// transitions already bump last_activity_at, so no real user signal is lost.
function getMostRecentActivityAnchor(candidate: ParkCandidate): number | null {
  const anchors = [
    parseTime(candidate.last_activity_at),
    parseTime(candidate.created_at),
  ].filter((value): value is number => value !== null);

  return anchors.length > 0 ? Math.max(...anchors) : null;
}

function idleDaysOf(candidate: ParkCandidate, nowMs: number): number {
  const anchor = getMostRecentActivityAnchor(candidate);
  if (anchor === null) return 0;
  return Math.max(0, Math.floor((nowMs - anchor) / 86_400_000));
}

function round3(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

async function fetchSweepHosts(): Promise<HostRow[]> {
  const supabase = supabaseAdmin;
  if (!supabase) throw new Error("Database not configured");

  // 'active' and 'maintenance' hosts both carry live tenants that count
  // against the cap; 'draining' is excluded — the operator is already
  // emptying those by hand and a parallel sweep would fight that.
  const { data, error } = await supabase
    .from("proxmox_hosts")
    .select(
      "id, total_ram_mb, reserved_ram_mb, wake_headroom_ram_mb, status, max_tenant_instances"
    )
    .in("status", ["active", "maintenance"]);

  if (error) {
    throw new Error(`Failed to load proxmox_hosts for pressure sweep: ${error.message}`);
  }

  return (data ?? []) as HostRow[];
}

async function fetchHostActiveInstances(hostId: string): Promise<ParkCandidate[]> {
  const supabase = supabaseAdmin;
  if (!supabase) throw new Error("Database not configured");

  const { data, error } = await supabase
    .from("hermes_instances")
    .select(
      "id, user_id, name, agent_type, resource_tier, proxmox_node, proxmox_vmid, host_id, config, ram_limit, last_activity_at, created_at, last_lifecycle_transition_at, notifications_sent"
    )
    .eq("proxmox_node", hostId)
    .eq("lifecycle_state", "active")
    .is("deleted_at", null)
    .limit(HOST_INSTANCE_BATCH_LIMIT);

  if (error) {
    throw new Error(
      `Failed to load active instances on ${hostId} for pressure sweep: ${error.message}`
    );
  }

  return (data ?? []) as ParkCandidate[];
}

// Lowest-priority-first ranking: free tiers (oldest activity first), then —
// only when explicitly opted in — paid tiers idle past the 7-day floor.
function rankParkCandidates(
  instances: ParkCandidate[],
  now: Date,
  config: { minIdleHours: number; includePaid: boolean }
): ParkCandidate[] {
  const freeCutoff = now.getTime() - config.minIdleHours * 3_600_000;
  const paidCutoff =
    now.getTime() - Math.max(config.minIdleHours, PAID_MIN_IDLE_HOURS) * 3_600_000;

  const free: ParkCandidate[] = [];
  const paid: ParkCandidate[] = [];

  for (const instance of instances) {
    const anchor = getMostRecentActivityAnchor(instance);
    // No usable activity anchor at all — never park blind.
    if (anchor === null) continue;

    const tier = instance.resource_tier ?? "";
    if (FREE_TIER_VALUES.has(tier)) {
      if (anchor < freeCutoff) free.push(instance);
    } else if (config.includePaid && PAID_TIER_VALUES.has(tier)) {
      if (anchor < paidCutoff) paid.push(instance);
    }
    // Unknown tiers are never parked.
  }

  const byOldestActivity = (a: ParkCandidate, b: ParkCandidate) =>
    (parseTime(a.last_activity_at) ?? 0) - (parseTime(b.last_activity_at) ?? 0);
  free.sort(byOldestActivity);
  paid.sort(byOldestActivity);

  return [...free, ...paid];
}

// Same mechanics as the inactivity sweep's pauseInstance(), with
// paused_reason='capacity_pressure' so the dashboard / dormant-reclaim /
// support can tell the two apart.
async function parkInstance(
  candidate: ParkCandidate
): Promise<{ outcome: ParkOutcome; pausedAtIso: string | null }> {
  const supabase = supabaseAdmin;
  if (!supabase) throw new Error("Database not configured");

  const infra =
    getProxmoxInfrastructure(candidate.config) ??
    (candidate.proxmox_vmid && candidate.proxmox_node
      ? ({
          provider: "proxmox" as const,
          node: candidate.proxmox_node,
          vmid: candidate.proxmox_vmid,
          privateIpv4: "",
          gatewayHost: "",
        } satisfies ProxmoxInfrastructure)
      : null);

  if (!infra) {
    // Hetzner-backed agent (legacy single-tenant box) — doesn't live on a
    // pve host, so it can't relieve pve pressure. Skip.
    return { outcome: "not_proxmox_backed", pausedAtIso: null };
  }

  const result = await shutdownProxmoxInstance(infra, {
    expectedInstanceId: candidate.id,
    hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(infra, {
      host_id: candidate.host_id,
    }),
  });

  if (isProxmoxVmMissingResult(result)) {
    // VM destroyed out from under us. Mark the row failed so the sweep stops
    // counting it against the host and the user sees a clear re-create path
    // — exactly the inactivity-sweep handling.
    const nowIso = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("hermes_instances")
      .update(buildInstanceLifecyclePatch("error", { now: nowIso }))
      .eq("id", candidate.id);

    if (updateError) {
      throw new Error(
        `Failed to mark missing-VM instance ${candidate.id} as failed: ${updateError.message}`
      );
    }
    return { outcome: "vm_missing", pausedAtIso: null };
  }

  if (!result.ok) {
    throw new Error(
      result.error ||
        result.stderr ||
        "Proxmox graceful shutdown returned non-zero"
    );
  }

  const pausedAtIso = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("hermes_instances")
    .update({
      lifecycle_state: "paused",
      paused_reason: "capacity_pressure",
      status: "stopped",
      last_lifecycle_transition_at: pausedAtIso,
    })
    .eq("id", candidate.id);

  if (updateError) {
    // The VM is already shut down but the row still reads active: the next run
    // re-counts it against the host and retries (qm shutdown on a stopped VM is
    // a no-op), so this self-heals — but surface the desync so the operator
    // isn't reading a stopped VM as a live tenant in the meantime.
    await reportOpsEvent({
      source: LOG_SOURCE,
      title: "capacity_pressure_park_db_desync",
      message: "VM shut down but lifecycle patch failed; row still reads active until the next run retries",
      severity: "error",
      instanceId: candidate.id,
      userId: candidate.user_id,
      metadata: { error: updateError.message },
    }).catch(() => undefined);
    throw new Error(
      `Failed to mark instance ${candidate.id} as paused: ${updateError.message}`
    );
  }
  return { outcome: "paused", pausedAtIso };
}

async function fetchClerkUser(secretKey: string, userId: string): Promise<ClerkUser | null> {
  const response = await fetch(`${CLERK_API_BASE_URL}/users/${userId}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Clerk user fetch failed for ${userId}: ${response.status}`);
  }
  return (await response.json()) as ClerkUser;
}

function chooseEmail(user: ClerkUser): string | null {
  const addresses = user.email_addresses ?? [];
  const primary = addresses.find((a) => a.id === user.primary_email_address_id);
  const verified = addresses.find((a) => a.verification?.status === "verified");
  return primary?.email_address ?? verified?.email_address ?? addresses[0]?.email_address ?? null;
}

// Best-effort "your agent is napping — wake it anytime" email. A failed
// email must never fail (or roll back) the park: the instance is already
// shut down and the dashboard shows the resume path regardless.
async function notifyOwnerOfPark(
  candidate: ParkCandidate,
  pausedAtIso: string
): Promise<boolean> {
  try {
    const clerkSecret = process.env.CLERK_SECRET_KEY?.trim();
    if (!clerkSecret) {
      log.warn("CLERK_SECRET_KEY not configured; skipping capacity-pause email", {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        userId: candidate.user_id,
      });
      return false;
    }

    const clerkUser = await fetchClerkUser(clerkSecret, candidate.user_id);
    const email = clerkUser ? chooseEmail(clerkUser) : null;
    if (!email) {
      log.warn("no email address found for capacity-paused instance owner", {
        source: LOG_SOURCE,
        instanceId: candidate.id,
        userId: candidate.user_id,
      });
      return false;
    }

    const result = await sendCapacityPausedEmail({
      email,
      firstName: clerkUser?.first_name ?? null,
      agentName: candidate.name,
      agentType: candidate.agent_type,
      idempotencyKey: `${candidate.id}:capacity_paused:${pausedAtIso}`,
    });
    if (!result.sent) return false;

    // Record in notifications_sent like the cold-storage senders do. If this
    // marker write fails the Resend idempotencyKey still dedupes a re-send
    // within its window.
    const supabase = supabaseAdmin;
    if (supabase) {
      const next = {
        ...(candidate.notifications_sent ?? {}),
        [NOTIFICATION_KEY]: pausedAtIso,
      };
      const { error } = await supabase
        .from("hermes_instances")
        .update({ notifications_sent: next })
        .eq("id", candidate.id);
      if (error) {
        log.warn("failed to persist capacity_paused notification marker", {
          source: LOG_SOURCE,
          instanceId: candidate.id,
          errorMessage: error.message,
        });
      }
    }
    return true;
  } catch (err) {
    log.warn("capacity-pause email failed", {
      source: LOG_SOURCE,
      instanceId: candidate.id,
      userId: candidate.user_id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function runCapacityPressureSweep(
  options: { now?: Date; dryRun?: boolean } = {}
): Promise<CapacityPressureSweepSummary> {
  const now = options.now ?? new Date();
  const countThreshold = readEnvFloat(
    "CAPACITY_PRESSURE_COUNT_THRESHOLD",
    COUNT_THRESHOLD_DEFAULT
  );
  const minIdleHours = readEnvInt(
    "CAPACITY_PRESSURE_MIN_IDLE_HOURS",
    MIN_IDLE_HOURS_DEFAULT
  );
  const includePaid = readEnvBool("CAPACITY_PRESSURE_INCLUDE_PAID", false);
  const maxPerHost = readEnvInt("CAPACITY_PRESSURE_MAX_PER_HOST", MAX_PER_HOST_DEFAULT);
  const maxTotal = readEnvInt("CAPACITY_PRESSURE_MAX_TOTAL", MAX_TOTAL_DEFAULT);
  // ?dryRun=1 forces a dry run; otherwise the env decides (default: dry).
  const dryRun = options.dryRun === true ? true : isDryRunDefault();

  const baseSummary = {
    dryRun,
    countThreshold,
    minIdleHours,
    includePaid,
    maxPerHost,
    maxTotal,
  };

  if (!isSweepEnabled()) {
    log.warn("capacity pressure sweep is disabled", {
      source: LOG_SOURCE,
      reason: "explicit_opt_in_required",
      optInEnv: "CAPACITY_PRESSURE_SWEEP_ENABLED",
    });
    return {
      skipped: true,
      enabled: false,
      ...baseSummary,
      hostsScanned: 0,
      hotHosts: 0,
      parked: 0,
      failed: 0,
      vmMissing: 0,
      emailsSent: 0,
      hosts: [],
    };
  }

  const supabase = supabaseAdmin;
  if (!supabase) throw new Error("Database not configured");

  const hosts = await fetchSweepHosts();
  const globalCap = resolveProxmoxMaxTenantInstances();

  const evaluations: Array<{
    report: CapacityPressureHostReport;
    cap: number | null;
    instances: ParkCandidate[];
  }> = [];

  for (const host of hosts) {
    const instances = await fetchHostActiveInstances(host.id);
    const cap = host.max_tenant_instances ?? globalCap;
    const pressure = cap && cap > 0 ? instances.length / cap : null;

    // RAM pressure is informational only: allocated ram_limit of the live
    // tenants vs what the host can actually hand out (total minus the
    // Proxmox reserve and the wake-burst headroom).
    const ramAllocatedMb = instances.reduce(
      (sum, instance) => sum + (instance.ram_limit ?? 0),
      0
    );
    const ramUsableMb = Math.max(
      0,
      host.total_ram_mb - host.reserved_ram_mb - host.wake_headroom_ram_mb
    );
    const ramPressure = ramUsableMb > 0 ? ramAllocatedMb / ramUsableMb : null;

    evaluations.push({
      report: {
        host: host.id,
        status: host.status,
        active: instances.length,
        cap,
        pressure: round3(pressure),
        ramAllocatedMb,
        ramUsableMb,
        ramPressure: round3(ramPressure),
        hot: pressure !== null && pressure >= countThreshold,
        parked: [],
      },
      cap,
      instances,
    });
  }

  // Worst hosts first so they get relief before the global cap runs out.
  evaluations.sort(
    (a, b) => (b.report.pressure ?? -1) - (a.report.pressure ?? -1)
  );

  let parked = 0;
  let failed = 0;
  let vmMissing = 0;
  let emailsSent = 0;

  for (const { report, cap, instances } of evaluations) {
    if (!report.hot || cap === null) continue;

    const remainingGlobal = maxTotal - parked;
    if (remainingGlobal <= 0) break;

    // Park enough to land back under (threshold - margin), never more than
    // the per-host / global caps allow.
    // Never plan to fully drain a host: tiny caps (e.g. max_tenant_instances=1
    // on a maintenance box) would otherwise floor to a target of 0.
    const targetCount = Math.max(1, Math.floor(cap * (countThreshold - RELIEF_MARGIN)));
    const needed = Math.max(0, report.active - targetCount);
    const budget = Math.min(needed, maxPerHost, remainingGlobal);
    if (budget <= 0) continue;

    const candidates = rankParkCandidates(instances, now, {
      minIdleHours,
      includePaid,
    }).slice(0, budget);

    for (const candidate of candidates) {
      const parkedEntry: CapacityPressureParkedInstance = {
        id: candidate.id,
        tier: candidate.resource_tier,
        idleDays: idleDaysOf(candidate, now.getTime()),
      };

      if (dryRun) {
        report.parked.push(parkedEntry);
        parked += 1;
        continue;
      }

      try {
        const { outcome, pausedAtIso } = await parkInstance(candidate);
        if (outcome === "paused") {
          report.parked.push(parkedEntry);
          parked += 1;
          log.info("capacity pressure sweep parked instance", {
            source: LOG_SOURCE,
            instanceId: candidate.id,
            userId: candidate.user_id,
            resourceTier: candidate.resource_tier,
            proxmoxNode: report.host,
            lastActivityAt: candidate.last_activity_at,
            idleDays: parkedEntry.idleDays,
          });
          if (pausedAtIso && (await notifyOwnerOfPark(candidate, pausedAtIso))) {
            emailsSent += 1;
          }
        } else if (outcome === "vm_missing") {
          vmMissing += 1;
          log.warn("capacity pressure sweep found missing VM, marked failed", {
            source: LOG_SOURCE,
            failureType: "capacity_pressure_vm_missing",
            instanceId: candidate.id,
            userId: candidate.user_id,
            resourceTier: candidate.resource_tier,
            proxmoxNode: report.host,
            proxmoxVmid: candidate.proxmox_vmid,
          });
        }
        // not_proxmox_backed: nothing to park, nothing to count.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed += 1;
        log.error("capacity pressure sweep failed to park instance", err, {
          source: LOG_SOURCE,
          failureType: "capacity_pressure_park_failed",
          instanceId: candidate.id,
          userId: candidate.user_id,
          resourceTier: candidate.resource_tier,
          proxmoxNode: report.host,
        });
        try {
          await reportOpsEvent({
            source: LOG_SOURCE,
            title: "capacity_pressure_park_failed",
            message: "capacity pressure sweep failed to park instance",
            severity: "error",
            instanceId: candidate.id,
            userId: candidate.user_id,
            metadata: { error: message, proxmoxNode: report.host },
          });
        } catch {
          // Ops-event logging is best-effort; never let it derail the sweep.
        }
      }
    }
  }

  const reports = evaluations.map((evaluation) => evaluation.report);
  const hotHosts = reports.filter((report) => report.hot).length;

  log.info("capacity pressure sweep complete", {
    source: LOG_SOURCE,
    dryRun,
    hostsScanned: reports.length,
    hotHosts,
    parked,
    failed,
    vmMissing,
    emailsSent,
    countThreshold,
  });

  return {
    skipped: false,
    enabled: true,
    ...baseSummary,
    hostsScanned: reports.length,
    hotHosts,
    parked,
    failed,
    vmMissing,
    emailsSent,
    hosts: reports,
  };
}
