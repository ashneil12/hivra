import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { getInstanceMeteringRollup } from "@/lib/services/instance-metering";
import { resolveTierSpec } from "@/lib/services/tier-specs";
import { isPaidTier } from "@/lib/services/tier-boost";
import { BYTES_PER_MB, computeMemoryUsage } from "@/lib/memory-usage";

const ROUTE = "/api/instances/[id]/memory-pressure";

/** Master gate for the memory-pressure upsell banner (default OFF). Separate from
 *  HERMES_RAM_BURST_ENABLED so the harmless upsell signal can roll fleet-wide
 *  before host-level ballooning is enabled on any given host. */
const BANNER_ENABLED_ENV = "HERMES_MEMORY_PRESSURE_BANNER_ENABLED";

// RAM is spiky, so use a short window: the rollup reports the MAX ram_peak across
// it, and a 24h max would pin the banner red all day after a single spike. 2h
// reflects *recent* pressure while still spanning several 5-min samples.
const MEM_SAMPLE_LOOKBACK_MS = 2 * 60 * 60 * 1000;

interface InstanceMemoryRow {
  ram_limit: number | null;
  resource_tier: string | null;
  status: string;
}

/**
 * Read-only memory-pressure summary for one instance: the latest metering
 * `ram_peak_bytes` against the instance's guaranteed baseline RAM (`ram_limit`).
 * Drives the chat upsell banner. Monitoring/visibility only — never writes, never
 * on a blocking path. Returns an "ok" level (no banner) when the feature flag is
 * off so the client can mount unconditionally.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const { id } = await params;
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const enabled = process.env[BANNER_ENABLED_ENV]?.trim().toLowerCase() === "true";

    const { data: instance, error } = await supabaseAdmin
      .from("hermes_instances")
      .select("ram_limit, resource_tier, status")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .maybeSingle<InstanceMemoryRow>();

    if (error) {
      return apiError(
        "Failed to read instance memory",
        500,
        { failureType: "instance_memory_pressure_read_failed" },
        undefined,
        { route: ROUTE, source: "instance-memory-pressure", instanceId: id, userId, cause: error }
      );
    }
    if (!instance) return apiError("Instance not found", 404);

    const tier = instance.resource_tier ?? "credit_base";
    // Baseline = the guaranteed RAM the tenant pays for. Prefer the persisted
    // ram_limit (kept in lockstep with the tier by tier-change + resize), and
    // fall back to the tier spec if a legacy row never had it stamped.
    const baselineMb =
      typeof instance.ram_limit === "number" && instance.ram_limit > 0
        ? instance.ram_limit
        : resolveTierSpec(tier).ramLimitMb;

    // Flag off → always "ok" (banner stays hidden). Still cheap: one indexed read.
    if (!enabled) {
      return apiSuccess({
        level: "ok",
        percent: 0,
        peak_bytes: 0,
        baseline_bytes: baselineMb * BYTES_PER_MB,
        baseline_mb: baselineMb,
        is_paid_tier: isPaidTier(tier),
        has_sample: false,
        sampled_at: null,
        enabled: false,
      });
    }

    const since = new Date(Date.now() - MEM_SAMPLE_LOOKBACK_MS);
    const rollup = await getInstanceMeteringRollup(id, since);

    const usage = computeMemoryUsage(rollup.ram_peak_bytes, baselineMb * BYTES_PER_MB);

    return apiSuccess({
      level: usage.level,
      percent: usage.percent,
      peak_bytes: usage.peakBytes,
      baseline_bytes: usage.baselineBytes,
      baseline_mb: baselineMb,
      is_paid_tier: isPaidTier(tier),
      has_sample: rollup.sample_count > 0,
      sampled_at: rollup.last_sampled_at,
      enabled: true,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
