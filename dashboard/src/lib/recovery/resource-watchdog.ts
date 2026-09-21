import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
  shutdownProxmoxInstance,
  type ProxmoxInfrastructure,
} from "@/lib/services/proxmox-instance-service";
import { sendResourceWatchdogCustomerEmail } from "@/lib/email/resource-watchdog-customer";
import { sendFreeRamPressureEmail } from "@/lib/email/resource-watchdog-free-ram";
import { sendResourceWatchdogAdminEmail } from "@/lib/email/resource-watchdog-admin";

const LOG_SOURCE = "resource-watchdog";

const FREE_TIER_VALUES = new Set(["credit_base", "token_base"]);
const PAID_TIER_VALUES = new Set(["operator", "fleet", "command"]);

const RAM_PCT_THRESHOLD = 0.95;
const CPU_PCT_THRESHOLD = 0.95;
// A genuine free-tier VM is provisioned AT its ram_limit (both the VM memory
// and the agent container are sized to ram_limit MB), so its metered peak
// cannot materially exceed the cap. A peak far above the cap means the row's
// resource_tier/ram_limit is stale relative to how the VM was actually
// provisioned (a "split-brain" row — e.g. a Command-sized VM still tagged
// credit_base). Pausing it would wrongly shut down and RAM-shame a paid-sized
// workload — exactly the fixturenodea incident. Above this multiple we skip the pause
// and raise an ops event so the stale tier/ram_limit gets reconciled instead.
const RAM_SPLIT_BRAIN_FACTOR = 2.0;
const RAM_WINDOW_MINUTES = 60;
const RAM_MIN_SAMPLES = 1;
const CPU_WINDOW_HOURS = 24;
const CPU_MIN_INTERVAL_HOURS = 12;
const FLEET_BATCH_LIMIT = 200;

type WatchdogInstance = {
  id: string;
  user_id: string;
  resource_tier: string | null;
  cpu_limit: number | null;
  ram_limit: number | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
  name: string | null;
};

type MeteringSample = {
  sampled_at: string;
  cpu_seconds_total: number;
  ram_peak_bytes: number;
  runtime_seconds: number;
};

export type ResourceWatchdogSummary = {
  scanned: number;
  ramCapHits: number;
  ramCapInconsistencies: number;
  cpuSustainedFlags: number;
  errors: number;
};

type FreeRamFinding =
  | {
      kind: "ram_cap";
      avg_ram_pct: number;
      sample_count: number;
      window_minutes: number;
      ram_limit_mb: number;
    }
  | {
      kind: "cap_inconsistent";
      max_ram_mb: number;
      ram_limit_mb: number;
      over_cap_ratio: number;
      sample_count: number;
    };

async function getCustomerEmail(userId: string): Promise<string | null> {
  try {
    const { clerkClient } = await import("@clerk/nextjs/server");
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const primary = user.primaryEmailAddress?.emailAddress?.trim();
    if (primary) return primary;
    const first = user.emailAddresses?.[0]?.emailAddress?.trim();
    return first || null;
  } catch (err) {
    log.warn("clerk lookup for watchdog email failed", {
      source: LOG_SOURCE,
      failureType: "clerk_user_lookup_failed",
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function loadActiveInstances(): Promise<WatchdogInstance[]> {
  const supabase = supabaseAdmin;
  if (!supabase) throw new Error("Database not configured");

  const { data, error } = await supabase
    .from("hermes_instances")
    .select(
      "id, user_id, resource_tier, cpu_limit, ram_limit, proxmox_node, proxmox_vmid, host_id, config, name"
    )
    .eq("lifecycle_state", "active")
    .eq("infrastructure_provider", "proxmox")
    .limit(FLEET_BATCH_LIMIT);

  if (error) {
    throw new Error(
      `Failed to load watchdog candidates: ${error.message}`
    );
  }

  return (data ?? []) as WatchdogInstance[];
}

async function loadRecentMeteringSamples(
  instanceId: string,
  sinceIso: string
): Promise<MeteringSample[]> {
  const supabase = supabaseAdmin;
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("instance_metering_events")
    .select("sampled_at, cpu_seconds_total, ram_peak_bytes, runtime_seconds")
    .eq("instance_id", instanceId)
    .gte("sampled_at", sinceIso)
    .order("sampled_at", { ascending: true });

  if (error) {
    log.warn("metering query failed for watchdog", {
      source: LOG_SOURCE,
      failureType: "metering_query_failed",
      instanceId,
      error: error.message,
    });
    return [];
  }

  return (data ?? []) as MeteringSample[];
}

async function hasOpenFlag(
  instanceId: string,
  flagType: string
): Promise<boolean> {
  const supabase = supabaseAdmin;
  if (!supabase) return false;

  const { data, error } = await supabase
    .from("instance_flags")
    .select("id")
    .eq("instance_id", instanceId)
    .eq("flag_type", flagType)
    .is("resolved_at", null)
    .limit(1)
    .maybeSingle();

  if (error) {
    log.warn("instance_flags lookup failed", {
      source: LOG_SOURCE,
      failureType: "instance_flags_query_failed",
      instanceId,
      flagType,
      error: error.message,
    });
    return false;
  }
  return Boolean(data);
}

async function insertFlag(params: {
  instanceId: string;
  userId: string;
  flagType: string;
  flagData: Record<string, unknown>;
  resolveImmediately?: boolean;
  resolutionAction?: string;
}): Promise<void> {
  const supabase = supabaseAdmin;
  if (!supabase) return;

  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    instance_id: params.instanceId,
    user_id: params.userId,
    flag_type: params.flagType,
    flag_data: params.flagData,
    created_at: now,
  };
  if (params.resolveImmediately) {
    row.resolved_at = now;
    row.resolution_action = params.resolutionAction ?? "auto_resolved";
  }

  const { error } = await supabase.from("instance_flags").insert(row);
  if (error && error.code !== "23505") {
    // 23505 = unique_violation on the open-per-type partial index. Means
    // an open flag already exists; that's fine, we just skip.
    log.warn("instance_flags insert failed", {
      source: LOG_SOURCE,
      failureType: "instance_flags_insert_failed",
      instanceId: params.instanceId,
      flagType: params.flagType,
      error: error.message,
    });
  }
}

function resolveProxmoxInfraForInstance(
  instance: WatchdogInstance
): ProxmoxInfrastructure | null {
  const fromConfig = getProxmoxInfrastructure(instance.config);
  if (fromConfig) return fromConfig;
  if (instance.proxmox_vmid && instance.proxmox_node) {
    return {
      provider: "proxmox" as const,
      node: instance.proxmox_node,
      vmid: instance.proxmox_vmid,
      privateIpv4: "",
      gatewayHost: "",
    } satisfies ProxmoxInfrastructure;
  }
  return null;
}

/**
 * Pause a free box that pinned its RAM cap, then TELL its owner.
 *
 * The policy uses the instance's recorded allocation, including exceptions.
 * High sampled memory use is not proof of an OOM crash or a time limit.
 * Email explains the safeguard to owners who use Telegram/Discord and may
 * not see the dashboard banner.
 *
 * Send failures are swallowed on purpose: the pause is the contract, the email
 * is a courtesy, and a Resend outage must not roll back a completed shutdown
 * or burn the run's error budget.
 */
async function pauseForRamCap(
  instance: WatchdogInstance,
  finding: Extract<FreeRamFinding, { kind: "ram_cap" }>,
  now: Date
): Promise<void> {
  const supabase = supabaseAdmin;
  if (!supabase) throw new Error("Database not configured");

  const infra = resolveProxmoxInfraForInstance(instance);
  if (!infra) throw new Error("instance is not Proxmox-backed");

  const result = await shutdownProxmoxInstance(infra, {
    hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(infra, {
      host_id: instance.host_id,
    }),
  });

  if (!result.ok) {
    throw new Error(
      result.error || result.stderr || "Proxmox graceful shutdown failed"
    );
  }

  const { error: updateError } = await supabase
    .from("hermes_instances")
    .update({
      lifecycle_state: "paused",
      paused_reason: "ram_cap_hit",
      status: "stopped",
      last_lifecycle_transition_at: new Date().toISOString(),
    })
    .eq("id", instance.id);

  if (updateError) {
    throw new Error(
      `Failed to mark instance ${instance.id} as paused: ${updateError.message}`
    );
  }

  await insertFlag({
    instanceId: instance.id,
    userId: instance.user_id,
    flagType: "ram_cap_hit",
    flagData: finding,
    resolveImmediately: true,
    resolutionAction: "auto_resolved",
  });

  const customerEmail = await getCustomerEmail(instance.user_id);
  if (!customerEmail) return;

  const emailResult = await sendFreeRamPressureEmail({
    email: customerEmail,
    agentName: instance.name ?? "your agent",
    avgRamPct: finding.avg_ram_pct,
    ramLimitMb: finding.ram_limit_mb,
    windowMinutes: finding.window_minutes,
    // Day-scoped: the flag is auto-resolved, so a user who keeps re-pinning
    // gets paused again (by design) but not mailed again the same day.
    idempotencyKey: `watchdog-ram/${instance.id}/${now
      .toISOString()
      .slice(0, 10)}`,
  });

  if (!emailResult.sent) {
    log.warn("free-tier RAM pause email not sent", {
      source: LOG_SOURCE,
      failureType: "ram_cap_email_not_sent",
      instanceId: instance.id,
      userId: instance.user_id,
      reason: emailResult.reason,
    });
  }
}

function evaluateFreeRam(
  samples: MeteringSample[],
  ramLimitMb: number
): FreeRamFinding | null {
  if (samples.length < RAM_MIN_SAMPLES) return null;
  if (ramLimitMb <= 0) return null;

  const ramLimitBytes = ramLimitMb * 1024 * 1024;
  const thresholdBytes = ramLimitBytes * RAM_PCT_THRESHOLD;
  let triggered = true;
  let totalPct = 0;
  let maxBytes = 0;

  for (const sample of samples) {
    if (sample.ram_peak_bytes > maxBytes) maxBytes = sample.ram_peak_bytes;
    if (sample.ram_peak_bytes < thresholdBytes) {
      triggered = false;
      break;
    }
    totalPct += sample.ram_peak_bytes / ramLimitBytes;
  }

  if (!triggered) return null;

  // Split-brain guard: the metered footprint dwarfs the supposed cap, so the
  // cap value is stale, not a real free-tier pin. Don't pause — surface it.
  if (maxBytes > ramLimitBytes * RAM_SPLIT_BRAIN_FACTOR) {
    return {
      kind: "cap_inconsistent",
      max_ram_mb: Math.round(maxBytes / 1024 / 1024),
      ram_limit_mb: ramLimitMb,
      over_cap_ratio: Math.round((maxBytes / ramLimitBytes) * 100) / 100,
      sample_count: samples.length,
    };
  }

  return {
    kind: "ram_cap",
    avg_ram_pct: totalPct / samples.length,
    sample_count: samples.length,
    window_minutes: RAM_WINDOW_MINUTES,
    ram_limit_mb: ramLimitMb,
  };
}

function evaluatePaidCpu(
  samples: MeteringSample[],
  cpuLimit: number
): Record<string, number> | null {
  if (samples.length < 2) return null;
  if (cpuLimit <= 0) return null;

  const first = samples[0];
  const last = samples[samples.length - 1];
  const deltaSeconds =
    (new Date(last.sampled_at).getTime() -
      new Date(first.sampled_at).getTime()) /
    1000;
  if (deltaSeconds < CPU_MIN_INTERVAL_HOURS * 60 * 60) return null;

  const cpuDelta = last.cpu_seconds_total - first.cpu_seconds_total;
  // Negative = VM was rebooted between samples (counter reset). Skip.
  if (cpuDelta <= 0) return null;

  const maxCpu = deltaSeconds * cpuLimit;
  const cpuPct = cpuDelta / maxCpu;
  if (cpuPct < CPU_PCT_THRESHOLD) return null;

  return {
    avg_cpu_pct: cpuPct,
    window_hours: deltaSeconds / 3600,
    cpu_seconds_delta: cpuDelta,
    runtime_seconds_delta: last.runtime_seconds - first.runtime_seconds,
    sample_count: samples.length,
    cpu_limit: cpuLimit,
  };
}

export async function runResourceWatchdog(
  options: { now?: Date } = {}
): Promise<ResourceWatchdogSummary> {
  const supabase = supabaseAdmin;
  if (!supabase) throw new Error("Database not configured");

  const now = options.now ?? new Date();
  const ramSince = new Date(
    now.getTime() - RAM_WINDOW_MINUTES * 60 * 1000
  ).toISOString();
  const cpuSince = new Date(
    now.getTime() - CPU_WINDOW_HOURS * 60 * 60 * 1000
  ).toISOString();

  const instances = await loadActiveInstances();
  const summary: ResourceWatchdogSummary = {
    scanned: instances.length,
    ramCapHits: 0,
    ramCapInconsistencies: 0,
    cpuSustainedFlags: 0,
    errors: 0,
  };

  for (const instance of instances) {
    const tier = instance.resource_tier?.trim() ?? "";
    try {
      if (FREE_TIER_VALUES.has(tier)) {
        const samples = await loadRecentMeteringSamples(instance.id, ramSince);
        const ramFinding = evaluateFreeRam(samples, instance.ram_limit ?? 0);
        if (!ramFinding) continue;

        if (ramFinding.kind === "cap_inconsistent") {
          // The VM's real footprint dwarfs its ram_limit — the row is
          // mislabeled (e.g. a Command-sized VM still tagged credit_base).
          // Pausing here would wrongly shut down and RAM-shame a paid
          // workload, so skip the pause and raise an ops event so the stale
          // resource_tier/ram_limit gets reconciled.
          //
          // De-dup like the ram_cap_hit / cpu_sustained branches: only emit
          // once per open mismatch. Without this guard the */15 cron re-fired
          // an identical warn every tick until the row was reconciled (6×
          // alert-spam from a single row, 2026-06-09 incident).
          if (await hasOpenFlag(instance.id, "ram_cap_inconsistent")) continue;
          summary.ramCapInconsistencies += 1;
          log.warn("watchdog skipped RAM pause: ram_limit looks stale", {
            source: LOG_SOURCE,
            failureType: "ram_cap_inconsistent",
            instanceId: instance.id,
            userId: instance.user_id,
            ...ramFinding,
          });
          await reportOpsEvent({
            source: LOG_SOURCE,
            title: "ram_cap_inconsistent",
            message: `Instance ${instance.name ?? instance.id} metered ${ramFinding.max_ram_mb}MB against a ${ramFinding.ram_limit_mb}MB cap (${ramFinding.over_cap_ratio}x) — resource_tier/ram_limit is stale; not pausing.`,
            severity: "warn",
            instanceId: instance.id,
            userId: instance.user_id,
            metadata: { ...ramFinding, resourceTier: tier },
          });
          await insertFlag({
            instanceId: instance.id,
            userId: instance.user_id,
            flagType: "ram_cap_inconsistent",
            flagData: ramFinding,
          });
          continue;
        }

        if (await hasOpenFlag(instance.id, "ram_cap_hit")) continue;
        await pauseForRamCap(instance, ramFinding, now);
        summary.ramCapHits += 1;
        log.info("watchdog paused free-tier instance for RAM cap", {
          source: LOG_SOURCE,
          instanceId: instance.id,
          userId: instance.user_id,
          ...ramFinding,
        });
        continue;
      }

      if (PAID_TIER_VALUES.has(tier)) {
        const samples = await loadRecentMeteringSamples(instance.id, cpuSince);
        const cpuFinding = evaluatePaidCpu(samples, instance.cpu_limit ?? 0);
        if (!cpuFinding) continue;
        if (await hasOpenFlag(instance.id, "cpu_sustained")) continue;
        await insertFlag({
          instanceId: instance.id,
          userId: instance.user_id,
          flagType: "cpu_sustained",
          flagData: cpuFinding,
        });
        summary.cpuSustainedFlags += 1;
        const customerEmail = await getCustomerEmail(instance.user_id);
        if (customerEmail) {
          await sendResourceWatchdogCustomerEmail({
            email: customerEmail,
            agentName: instance.name ?? "your agent",
            avgCpuPct: cpuFinding.avg_cpu_pct,
            windowHours: cpuFinding.window_hours,
            idempotencyKey: `watchdog-cpu/${instance.id}/${now
              .toISOString()
              .slice(0, 10)}`,
          });
        }
        await sendResourceWatchdogAdminEmail({
          instanceId: instance.id,
          userId: instance.user_id,
          agentName: instance.name ?? null,
          resourceTier: tier,
          flagData: cpuFinding,
          idempotencyKey: `watchdog-cpu-admin/${instance.id}/${now
            .toISOString()
            .slice(0, 10)}`,
        });
        log.info("watchdog raised paid CPU flag", {
          source: LOG_SOURCE,
          instanceId: instance.id,
          userId: instance.user_id,
          ...cpuFinding,
        });
      }
    } catch (err) {
      summary.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      log.error("watchdog evaluation failed", err, {
        source: LOG_SOURCE,
        failureType: "watchdog_eval_failed",
        instanceId: instance.id,
        userId: instance.user_id,
        resourceTier: tier,
      });
      try {
        await reportOpsEvent({
          source: LOG_SOURCE,
          title: "watchdog_eval_failed",
          message: "watchdog failed to evaluate instance",
          severity: "error",
          instanceId: instance.id,
          userId: instance.user_id,
          metadata: { error: message },
        });
      } catch {
        // ops-event logging is best-effort
      }
    }
  }

  return summary;
}
