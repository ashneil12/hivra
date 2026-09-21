import { buildInstanceFailureAlertFromOpsEvent, type InstanceFailureAlert } from "@/lib/failure-ownership";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

const LOG_SOURCE = "instance-failure-alerts";

interface FailureAlertOpsRow {
  instance_id: unknown;
  source: unknown;
  severity: unknown;
  title: unknown;
  message: unknown;
  last_seen_at: unknown;
  metadata: Record<string, unknown> | null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
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

function logFailureAlertReadFailure(context: "query_error" | "unexpected_error", error: unknown) {
  log.warn("failed to read instance failure events; continuing without failure badges", {
    source: LOG_SOURCE,
    failureType: "instance_failure_alert_read_failed",
    context,
    errorDescription: describeError(error),
  }, error);
}

// Synthetic observability probes should stay queryable in Advanced Console logs,
// but should not become scary dashboard/chat failure banners for customers.
// Reserve the synthetic.* source namespace for operator-only probes.
const USER_FACING_ALERT_SUPPRESSED_SOURCE_PREFIX = "synthetic.";

function isResolvedUpdateStatus(row: FailureAlertOpsRow): boolean {
  return (
    normalizeOptionalString(row.source) === "instance-update-status" &&
    normalizeOptionalString(row.metadata?.status) === "succeeded"
  );
}

function isUserFacingAlertSuppressedSource(row: FailureAlertOpsRow): boolean {
  const source = normalizeOptionalString(row.source);
  return Boolean(source?.startsWith(USER_FACING_ALERT_SUPPRESSED_SOURCE_PREFIX));
}

export async function getLatestInstanceFailureAlerts(
  instanceIds: string[]
): Promise<Record<string, InstanceFailureAlert>> {
  if (!supabaseAdmin) return {};

  const normalizedIds = Array.from(
    new Set(
      instanceIds
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    )
  );
  if (normalizedIds.length === 0) return {};

  try {
    // The downstream dedupe loop only keeps the FIRST row per instance_id
    // (i.e. the most recent unarchived failure). Without a limit the query
    // pulled every historical failure across every instance — many MB of
    // metadata jsonb when an instance has had hundreds of transient errors.
    // Cap at ~8× the instance count to retain a safety margin for the
    // resolved-update filter loop below while preventing unbounded scans.
    const { data, error } = await supabaseAdmin
      .from("ops_events")
      .select("instance_id, source, severity, title, message, last_seen_at, metadata")
      .is("archived_at", null)
      .in("instance_id", normalizedIds)
      .order("last_seen_at", { ascending: false })
      .limit(Math.max(normalizedIds.length * 8, 32));

    if (error) {
      logFailureAlertReadFailure("query_error", error);
      return {};
    }

    const alerts: Record<string, InstanceFailureAlert> = {};
    const resolvedUpdateInstances = new Set<string>();

    for (const row of (data || []) as FailureAlertOpsRow[]) {
      const instanceId = normalizeOptionalString(row.instance_id);
      if (!instanceId || alerts[instanceId]) continue;

      if (isResolvedUpdateStatus(row)) {
        resolvedUpdateInstances.add(instanceId);
        continue;
      }

      if (isUserFacingAlertSuppressedSource(row)) continue;

      const alert = buildInstanceFailureAlertFromOpsEvent({
        source: normalizeOptionalString(row.source) ?? "unknown",
        severity: row.severity,
        title: row.title,
        message: row.message,
        lastSeenAt: row.last_seen_at,
        metadata: row.metadata,
      });
      if (!alert) continue;
      if (alert.phase === "update" && resolvedUpdateInstances.has(instanceId)) continue;

      alerts[instanceId] = alert;
    }

    return alerts;
  } catch (error) {
    logFailureAlertReadFailure("unexpected_error", error);
    return {};
  }
}

export interface InstanceLifecycleSnapshot {
  id: string;
  status?: string | null;
  last_lifecycle_transition_at?: string | null;
}

const HEALTHY_LIFECYCLE_STATUSES = new Set(["running", "stopped"]);

function isAlertResolvedByHealthyLifecycle(
  alert: InstanceFailureAlert,
  inst: InstanceLifecycleSnapshot
): boolean {
  const status = inst.status?.trim().toLowerCase();
  if (!status || !HEALTHY_LIFECYCLE_STATUSES.has(status)) return false;
  const transitionAt = inst.last_lifecycle_transition_at;
  if (!transitionAt) return false;
  const transitionMs = Date.parse(transitionAt);
  const seenMs = Date.parse(alert.lastSeenAt);
  if (!Number.isFinite(transitionMs) || !Number.isFinite(seenMs)) return false;
  return seenMs < transitionMs;
}

// A failure that fired while the instance was unhealthy stays in ops_events
// forever (until manually archived). Once a later lifecycle transition lands
// the instance back in a healthy state, the original alert becomes a stale
// banner. We mirror the "newer success suppresses older failed update" rule
// for all sources by treating last_lifecycle_transition_at as the resolution
// clock — if the alert predates the latest healthy transition, hide it. The
// underlying ops_events row is untouched so operators retain the audit
// trail, and the same fingerprint resurfaces on the next real failure.
export function suppressFailureAlertsResolvedByLifecycle(
  alerts: Record<string, InstanceFailureAlert>,
  instances: InstanceLifecycleSnapshot[]
): Record<string, InstanceFailureAlert> {
  if (Object.keys(alerts).length === 0) return alerts;
  const lifecycleById = new Map(instances.map((inst) => [inst.id, inst] as const));
  const filtered: Record<string, InstanceFailureAlert> = {};
  for (const [instanceId, alert] of Object.entries(alerts)) {
    const inst = lifecycleById.get(instanceId);
    if (inst && isAlertResolvedByHealthyLifecycle(alert, inst)) continue;
    filtered[instanceId] = alert;
  }
  return filtered;
}
