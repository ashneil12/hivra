import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

const LOG_SOURCE = "update-alerts";

type InstanceUpdateStatus = "failed" | "succeeded";
type InstanceUpdateRunType = "manual" | "scheduled";

interface UpdateAlertOpsRow {
  instance_id: unknown;
  metadata: Record<string, unknown> | null;
  title: unknown;
  message: unknown;
  last_seen_at: unknown;
}

export interface InstanceUpdateAlert {
  title: string;
  message: string;
  lastSeenAt: string;
  reason?: string;
  runType: InstanceUpdateRunType;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isUpdateStatus(value: string | undefined): value is InstanceUpdateStatus {
  return value === "failed" || value === "succeeded";
}

function isUpdateRunType(value: string | undefined): value is InstanceUpdateRunType {
  return value === "manual" || value === "scheduled";
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function logUpdateAlertReadFailure(context: "query_error" | "unexpected_error", error: unknown) {
  log.warn("failed to read update status events; continuing without alert badges", {
    source: LOG_SOURCE,
    failureType: "update_alert_read_failed",
    context,
    errorDescription: describeError(error),
  }, error);
}

export async function getLatestFailedInstanceUpdateAlerts(
  instanceIds: string[]
): Promise<Record<string, InstanceUpdateAlert>> {
  if (!supabaseAdmin) return {};

  const normalizedIds = Array.from(
    new Set(
      instanceIds
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    )
  );
  if (normalizedIds.length === 0) return {};

  // The instance APIs should still load if ops-events is unavailable; we just omit alert badges for that response.
  try {
    // Mirrors getLatestInstanceFailureAlerts: dedupe keeps the first row
    // per instance_id, so a bounded fetch is sufficient. The 8× headroom
    // covers the small set of "resolved-update" rows the next filter loop
    // skips before settling on the alert-worthy row per instance.
    const { data, error } = await supabaseAdmin
      .from("ops_events")
      .select("instance_id, metadata, title, message, last_seen_at")
      .eq("source", "instance-update-status")
      .is("archived_at", null)
      .in("instance_id", normalizedIds)
      .order("last_seen_at", { ascending: false })
      .limit(Math.max(normalizedIds.length * 8, 32));

    if (error) {
      logUpdateAlertReadFailure("query_error", error);
      return {};
    }

    const alerts: Record<string, InstanceUpdateAlert> = {};
    const seen = new Set<string>();

    for (const row of (data || []) as UpdateAlertOpsRow[]) {
      const instanceId = normalizeOptionalString(row.instance_id);
      if (!instanceId || seen.has(instanceId)) continue;

      const title = normalizeOptionalString(row.title);
      const message = normalizeOptionalString(row.message);
      const lastSeenAt = normalizeOptionalString(row.last_seen_at);
      if (!title || !message || !lastSeenAt) continue;

      const metadata = row.metadata && typeof row.metadata === "object"
        ? row.metadata
        : {};
      const status = normalizeOptionalString(metadata.status);
      const runType = normalizeOptionalString(metadata.runType);

      if (!isUpdateStatus(status) || !isUpdateRunType(runType)) continue;

      seen.add(instanceId);
      if (status !== "failed") continue;

      alerts[instanceId] = {
        title,
        message,
        lastSeenAt,
        reason: normalizeOptionalString(metadata.reason),
        runType,
      };
    }

    return alerts;
  } catch (error) {
    logUpdateAlertReadFailure("unexpected_error", error);
    return {};
  }
}
