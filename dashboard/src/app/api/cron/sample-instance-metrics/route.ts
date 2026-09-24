import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
} from "@/lib/services/proxmox-infrastructure";
import {
  getProxmoxInstanceMetrics,
  type ProxmoxInstanceMetrics,
} from "@/lib/services/proxmox-instance-service";
import { recordInstanceMeteringSample } from "@/lib/services/instance-metering";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

/**
 * Per-instance metering sampler. Sprint 0 W3 of the V2 launch.
 *
 * Vercel cron hits this endpoint every 5 minutes. We pull host-side
 * resource counters (CPU seconds, RAM, disk, runtime, outbound bytes)
 * for every active Proxmox VM and append a row to
 * `public.instance_metering_events`. Future billing reconciliation reads
 * those rows and compares aggregate consumption against the Hetzner host
 * bill — the build plan's 5%-tolerance check.
 *
 * Throttling:
 *   - paid tiers (token_base, operator, fleet, command): every 5-minute
 *     tick. They cost real money to run; we want fine-grained timeline
 *     for billing audits.
 *   - free tier (credit_base): every 30 minutes only — i.e. on the `:00`
 *     and `:30` ticks. Free agents are slow-changing and high-volume;
 *     6x sample reduction keeps storage costs sane without losing the
 *     daily-aggregate accuracy we need.
 *
 * Read-only against Proxmox. We never mutate VMs from the metering path.
 */

const FREE_TIER = "credit_base";

// Treat anything that's not actively running on a host as not-meterable.
// 'paused' is included because Proxmox/Hetzner can still bill for stopped
// VMs in some configurations, and we want the snapshot to capture that
// state — sampling a paused VM yields a `null` from the helper if it's
// gone, which is also informative (the row simply isn't written).
const SAMPLED_LIFECYCLE_STATES = ["active", "paused"] as const;

// Bounded parallelism for per-VM Proxmox round-trips. On the `:00` tick we
// sample ~140 instances; serial execution exceeded the 60s default
// function timeout and silently dropped rows. 10 in-flight spreads to
// ~2/host across a six-host fleet — well under SSH connection limits
// and bringing the wallclock to a few seconds.
const SAMPLE_CONCURRENCY = 10;

// Cron can legitimately run up to a few seconds even with parallelism
// (worst case: every host slow to SSH). 300s is the Pro-plan cap; we
// almost never need it, but keep headroom so a slow Proxmox tick can't
// truncate metering rows again.
export const maxDuration = 300;

// Per-run wall-clock budget. Each sample SSHes the pve host AND nested-SSHes
// into the guest (df, ConnectTimeout=5) — on a `:00`/`:30` tick we attempt the
// whole sampleable fleet (~800 instances). When a slice of those guests are
// unreachable (paused/dead/booting), each worker stalls on the 5s connect
// timeout and the serial-per-worker wall-clock runs past 300s, tripping
// "Task timed out after 300 seconds" — the run is SIGKILLed and reports
// nothing. We stop pulling NEW work a safe margin under maxDuration and return
// cleanly; the next 5-min tick re-samples (metering is append-only + every tick
// reads the live fleet, so a truncated run loses at most one sample interval for
// the unreached tail and self-heals — no cursor needed). In-flight samples are
// allowed to finish; the budget only gates whether we START another.
const SAMPLE_TIME_BUDGET_MS = 250_000;

// Belt-and-suspenders cap on samples STARTED per run. The time budget is the
// real guard; this bounds the absolute work even if the wall-clock somehow runs
// fast (e.g. every guest instantly reachable) so a single run can never fan out
// unboundedly as the fleet grows. Generously above the steady-state fleet size.
const SAMPLE_MAX_PER_RUN = 1_500;

interface SampleableInstance {
  id: string;
  proxmox_vmid: number | null;
  proxmox_node?: string | null;
  resource_tier: string | null;
  lifecycle_state: string | null;
  infrastructure_provider: string | null;
  host_id?: string | null;
  config?: unknown;
}

function shouldSampleAtThisTick(now: Date, resourceTier: string | null): boolean {
  // Paid tiers: sample every tick.
  if (resourceTier !== FREE_TIER) return true;
  // Free tier: only :00 and :30 minute ticks. Vercel cron fires on
  // exact-minute boundaries, so we check the minute-of-hour. We allow a
  // small drift window (any minute % 30 == 0) so a slightly delayed
  // invocation still hits.
  return now.getUTCMinutes() % 30 === 0;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("missing CRON_SECRET"), {
      source: "sample-instance-metrics",
      route: "/api/cron/sample-instance-metrics",
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }

  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  if (!supabaseAdmin) {
    log.error("Supabase admin client is not configured", new Error("missing supabase admin"), {
      source: "sample-instance-metrics",
      route: "/api/cron/sample-instance-metrics",
      method: "GET",
      failureType: "supabase_admin_missing",
    });
    return apiError("Supabase service role is not configured", 500);
  }

  const now = new Date();

  try {
    const { data, error } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, proxmox_vmid, proxmox_node, resource_tier, lifecycle_state, infrastructure_provider, host_id, config")
      .in("lifecycle_state", SAMPLED_LIFECYCLE_STATES as unknown as string[]);

    if (error) {
      throw new Error(error.message || "Failed to load active instances");
    }

    const instances = (data ?? []) as SampleableInstance[];

    // Partition cheaply (no host I/O) into "actually sample" vs "skip".
    // Doing this up front lets the worker pool work on a uniform list
    // and keeps the sequential filter logic in one place.
    const toSample: SampleableInstance[] = [];
    let skipped = 0;
    for (const instance of instances) {
      if (!shouldSampleAtThisTick(now, instance.resource_tier)) {
        skipped++;
        continue;
      }
      const provider = instance.infrastructure_provider?.toLowerCase().trim();
      if (provider !== "proxmox") {
        skipped++;
        continue;
      }
      if (typeof instance.proxmox_vmid !== "number" || !Number.isFinite(instance.proxmox_vmid)) {
        skipped++;
        continue;
      }
      toSample.push(instance);
    }

    let sampled = 0;
    let errors = 0;

    // Wall-clock deadline + hard cap. Workers stop pulling NEW instances once
    // either is hit, so the function returns cleanly under maxDuration instead
    // of being SIGKILLed mid-sample (which truncates the run silently and
    // reports nothing). The remaining instances are picked up by the next tick.
    const startedAt = Date.now();
    const deadline = startedAt + SAMPLE_TIME_BUDGET_MS;
    let budgetExhausted = false;

    const sampleOne = async (instance: SampleableInstance): Promise<void> => {
      let metrics: ProxmoxInstanceMetrics | null = null;
      try {
        const infrastructure = getProxmoxInfrastructure(instance.config);
        const metricsTarget = {
          vmid: instance.proxmox_vmid as number,
          node: infrastructure?.node ?? instance.proxmox_node ?? undefined,
          ...(infrastructure?.hostId ? { hostId: infrastructure.hostId } : {}),
          ...(infrastructure?.hostSlug ? { hostSlug: infrastructure.hostSlug } : {}),
          ...(infrastructure?.hostEnvPrefix ? { hostEnvPrefix: infrastructure.hostEnvPrefix } : {}),
        };
        metrics = await getProxmoxInstanceMetrics(
          metricsTarget,
          {
            hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(metricsTarget, { host_id: instance.host_id ?? null }),
          },
        );
      } catch (err) {
        log.error("proxmox metrics fetch failed", err, {
          source: "sample-instance-metrics",
          route: "/api/cron/sample-instance-metrics",
          method: "GET",
          instanceId: instance.id,
          vmid: instance.proxmox_vmid,
          failureType: "proxmox_metrics_fetch_failed",
        });
        errors++;
        return;
      }

      if (!metrics) {
        // VM gone or unreadable. Skip silently — VM may be mid-delete.
        skipped++;
        return;
      }

      const writeResult = await recordInstanceMeteringSample(
        {
          instance_id: instance.id,
          cpu_seconds_total: metrics.cpu_seconds_total,
          ram_peak_bytes: metrics.ram_peak_bytes,
          disk_used_bytes: metrics.disk_used_bytes,
          disk_total_bytes: metrics.disk_total_bytes,
          runtime_seconds: metrics.runtime_seconds,
          net_out_bytes: metrics.net_out_bytes,
          source: "proxmox",
          metadata: {
            vmid: instance.proxmox_vmid,
            resource_tier: instance.resource_tier,
            // Keep a few raw fields for postmortem if delta math goes
            // sideways. Capped to scalars so the JSONB stays lean.
            qm_status: metrics.raw.status ?? null,
            qm_cpu: metrics.raw.cpu ?? null,
            // "kvm_proc" = /proc utime+stime of the kvm process. Rows without
            // this key predate it and carry cpu_seconds_total = 0 on PVE 9.
            cpu_seconds_source: metrics.cpu_seconds_source ?? null,
            // Real guest '/' total + whether disk_used is a capacity fallback,
            // so the disk-usage banner can divide by the real total (not the
            // stale provisioned disk_size_gb) and suppress a bogus reading.
            disk_total_bytes: metrics.disk_total_bytes,
            disk_used_is_capacity_fallback: metrics.disk_used_is_capacity_fallback,
          },
        },
        supabaseAdmin as unknown as Parameters<typeof recordInstanceMeteringSample>[1]
      );

      if (!writeResult.ok) {
        log.error("failed to insert metering row", new Error(writeResult.error || "metering insert failed"), {
          source: "sample-instance-metrics",
          route: "/api/cron/sample-instance-metrics",
          method: "GET",
          instanceId: instance.id,
          failureType: "metering_insert_failed",
        });
        errors++;
        return;
      }

      sampled++;
    };

    // Bounded-concurrency worker pool. Workers pull from a shared index
    // cursor so slow Proxmox hosts don't head-of-line block the rest of
    // the fleet. `sampleOne` already catches its own errors, but we wrap
    // each await defensively so one rejected promise can't kill the
    // worker — the loop has to keep going.
    let cursor = 0;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(SAMPLE_CONCURRENCY, toSample.length); i++) {
      workers.push((async () => {
        while (true) {
          // Stop pulling new work once the time budget or per-run cap is hit.
          // Set the shared flag so the summary can report a truncated run.
          if (Date.now() >= deadline || cursor >= SAMPLE_MAX_PER_RUN) {
            budgetExhausted = true;
            return;
          }
          const idx = cursor++;
          if (idx >= toSample.length) return;
          try {
            await sampleOne(toSample[idx]);
          } catch {
            errors++;
          }
        }
      })());
    }
    await Promise.all(workers);

    // How many sampleable instances we never got to this run (time/cap budget
    // ran out). They are re-attempted next tick. Surfaced for observability so a
    // persistently-truncated run (fleet outgrew the budget) is visible rather
    // than silent.
    const attemptedCount = Math.min(cursor, toSample.length);
    const unsampled = Math.max(0, toSample.length - attemptedCount);
    if (budgetExhausted && unsampled > 0) {
      log.warn("sample-instance-metrics hit per-run budget; tail deferred to next tick", {
        source: "sample-instance-metrics",
        route: "/api/cron/sample-instance-metrics",
        method: "GET",
        failureType: "metering_run_budget_exhausted",
        sampled,
        errors,
        unsampled,
        toSample: toSample.length,
        elapsedMs: Date.now() - startedAt,
      });
    }

    // Surface systemic sampling failure: previously a run where every sample
    // errored still returned HTTP 200, so a fleet-wide metering outage (SSH/key
    // churn, host down) looked successful and silently created billing-audit
    // gaps. Emit a warn event when errors are a material share of what we tried
    // to sample. Best-effort — never let alerting mask the result.
    const attempted = attemptedCount;
    if (errors > 0 && (sampled === 0 || errors >= Math.max(5, Math.ceil(attempted * 0.5)))) {
      await reportOpsEvent({
        source: "cron.sample_instance_metrics_degraded",
        severity: "warn",
        title: `sample-instance-metrics: ${errors} of ${attempted} sample(s) errored`,
        message:
          `sample-instance-metrics sampled ${sampled} and errored ${errors} of ${attempted} attempted ` +
          `instance(s). A systemic metering outage creates billing-audit gaps — check Proxmox SSH/host ` +
          `health and the metering insert path.`,
        route: "/api/cron/sample-instance-metrics",
        metadata: { sampled, errors, attempted, total: instances.length },
      });
    }

    return apiSuccess({
      sampled,
      skipped,
      errors,
      total: instances.length,
      toSample: toSample.length,
      unsampled,
      budgetExhausted,
    });
  } catch (err) {
    return apiError("Failed to sample instance metrics", 500, {
      failureType: "instance_metering_cron_failed",
      errorName: err instanceof Error ? err.name : typeof err,
    });
  }
}
