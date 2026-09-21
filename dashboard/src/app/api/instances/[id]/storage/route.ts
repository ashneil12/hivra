import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { getInstanceMeteringRollup } from "@/lib/services/instance-metering";
import {
  DEFAULT_INSTANCE_DISK_GB,
  computeStorageUsage,
} from "@/lib/storage-usage";

const ROUTE = "/api/instances/[id]/storage";

// The metering cron writes a disk sample roughly every 5 minutes. A 24h window
// always contains the latest sample for an active instance while keeping the
// read bounded. An instance with no sample in the window reports 0% (no banner)
// — correct for monitoring-only Layer A, which never blocks anything.
const DISK_SAMPLE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface InstanceStorageRow {
  disk_size_gb: number | null;
  resource_tier: string | null;
  status: string;
}

/**
 * Read-only disk-usage summary for one instance, surfacing the existing
 * `disk_used_bytes_last` metering rollup against the instance's provisioned
 * disk. Monitoring/visibility only — this endpoint never writes and is never on
 * a blocking path (Layer B enforcement is a separate, owner-gated item).
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

    const { data: instance, error } = await supabaseAdmin
      .from("hermes_instances")
      .select("disk_size_gb, resource_tier, status")
      .eq("id", id)
      .eq("user_id", userId)
      .neq("status", "deleted")
      .maybeSingle<InstanceStorageRow>();

    if (error) {
      return apiError(
        "Failed to read instance storage",
        500,
        { failureType: "instance_storage_read_failed" },
        undefined,
        { route: ROUTE, source: "instance-storage", instanceId: id, userId, cause: error }
      );
    }
    if (!instance) return apiError("Instance not found", 404);

    // disk_size_gb is a thin-provisioning reservation hint for the allocator,
    // NOT the guest's real disk — it drifts from the actual VM disk (e.g. an
    // 800G thin disk recorded as 40). Echoed for info only; never the denominator.
    const provisionedGb =
      typeof instance.disk_size_gb === "number" && instance.disk_size_gb > 0
        ? instance.disk_size_gb
        : DEFAULT_INSTANCE_DISK_GB;

    const since = new Date(Date.now() - DISK_SAMPLE_LOOKBACK_MS);
    const rollup = await getInstanceMeteringRollup(id, since);

    // Prefer the REAL measured guest '/' total as the denominator. The recorded
    // disk_size_gb is often a stale/default provisioned value (e.g. 40GB on a
    // box whose real disk is 774GB), which would make a lightly-used disk read
    // as ">100% full". When no real total was measured, we have no reliable
    // denominator — report 0% (no banner) instead of guessing with the stale
    // disk_size_gb, which would reproduce the bug this PR fixes.
    const guestTotalBytes = rollup.disk_total_bytes_last;
    const provisionedBytes = guestTotalBytes > 0 ? guestTotalBytes : 0;

    const usage = computeStorageUsage(rollup.disk_used_bytes_last, provisionedBytes);

    // If the recorded "used" value is really the provisioned capacity (the guest
    // df read was unavailable, so disk_used fell back to maxdisk), it would
    // falsely read ~100%. Suppress the banner rather than alarm the user.
    const suppressed = rollup.disk_used_is_capacity_fallback_last;
    const level = suppressed ? "ok" : usage.level;
    const percent = suppressed ? 0 : usage.percent;

    return apiSuccess({
      level,
      percent,
      // Unclamped ratio for observability — detects a denominator bug even when
      // the user-facing percent is clamped/suppressed.
      rawPercent: usage.rawPercent,
      disk_used_bytes: usage.usedBytes,
      provisioned_bytes: usage.provisionedBytes,
      disk_total_bytes: guestTotalBytes,
      disk_size_gb: provisionedGb,
      has_sample: rollup.sample_count > 0,
      has_guest_total: guestTotalBytes > 0,
      sampled_at: rollup.last_sampled_at,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
