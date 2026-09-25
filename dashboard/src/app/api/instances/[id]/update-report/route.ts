import { NextRequest } from "next/server";

import { decryptApiKey } from "@/lib/crypto";
import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

type UpdateRunType = "manual" | "scheduled";
type UpdateStatus = "succeeded" | "failed";

interface InstanceUpdateReportRecord {
  id: string;
  user_id: string;
  api_server_key_encrypted: string | null;
  status: string | null;
  deleted_at: string | null;
}

// A late/retried/replayed "succeeded" callback must never resurrect an
// instance that has since been soft-deleted or moved to a terminal/cold
// lifecycle state. We still record the ops-event, but skip the status write.
// `scheduled_for_deletion` belongs here too: reviving it to "running" takes
// the row out of the purge-expired cron's selection, so its VM is never torn
// down.
const NON_RESURRECTABLE_STATUSES = new Set([
  "deleted",
  "scheduled_for_deletion",
  "archived",
  "cold_archived",
  "stopped",
  "suspended",
]);
// PostgREST `not.in` list for the same statuses, so the write itself refuses a
// row that moved into one of them after we read it.
const NON_RESURRECTABLE_STATUS_FILTER = `(${[...NON_RESURRECTABLE_STATUSES]
  .map((status) => `"${status}"`)
  .join(",")})`;

interface NormalizedUpdateReport {
  status: UpdateStatus;
  runType: UpdateRunType;
  reason?: string;
  detail?: string;
  occurredAt?: string;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isUpdateStatus(value: string | undefined): value is UpdateStatus {
  return value === "succeeded" || value === "failed";
}

function isUpdateRunType(value: string | undefined): value is UpdateRunType {
  return value === "manual" || value === "scheduled";
}

async function recordUpdateReport(params: {
  id: string;
  authHeader: string | null;
  report: {
    status?: string;
    runType?: string;
    reason?: string;
    detail?: string;
    occurredAt?: string;
  };
}) {
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const { data: instance, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, user_id, api_server_key_encrypted, status, deleted_at")
    .eq("id", params.id)
    .is("deleted_at", null)
    .maybeSingle<InstanceUpdateReportRecord>();

  if (error || !instance) return apiError("Instance not found", 404);
  if (!instance.api_server_key_encrypted) return apiError("Unauthorized", 401);

  const expectedToken = decryptApiKey(instance.api_server_key_encrypted);
  if (!verifyBearerHeader(params.authHeader ?? null, expectedToken)) {
    return apiError("Unauthorized", 401);
  }

  const normalized: {
    status?: string;
    runType?: string;
    reason?: string;
    detail?: string;
    occurredAt?: string;
  } = {
    status: normalizeOptionalString(params.report.status),
    runType: normalizeOptionalString(params.report.runType),
    reason: normalizeOptionalString(params.report.reason),
    detail: normalizeOptionalString(params.report.detail),
    occurredAt: normalizeOptionalString(params.report.occurredAt),
  };

  if (!isUpdateStatus(normalized.status)) {
    return apiError("Invalid update status", 400);
  }

  if (!isUpdateRunType(normalized.runType)) {
    return apiError("Invalid update run type", 400);
  }

  const report: NormalizedUpdateReport = {
    status: normalized.status,
    runType: normalized.runType,
    reason: normalized.reason,
    detail: normalized.detail,
    occurredAt: normalized.occurredAt,
  };
  const updateLabel = report.runType === "scheduled" ? "Auto-update" : "Manual update";
  // Only resurrect to "running" when the row is live and not in a terminal/cold
  // lifecycle state — a replayed/late callback must not revive a soft-deleted,
  // stopped, or cold-archived instance. The ops-event below is still recorded.
  const canResurrect =
    !instance.deleted_at &&
    !NON_RESURRECTABLE_STATUSES.has((instance.status ?? "").toLowerCase());
  const nextInstanceStatus =
    report.status === "succeeded" && canResurrect ? "running" : null;

  if (nextInstanceStatus) {
    const { error: statusError } = await supabaseAdmin
      .from("hermes_instances")
      .update({ status: nextInstanceStatus, updated_at: new Date().toISOString() })
      .eq("id", instance.id)
      .not("status", "in", NON_RESURRECTABLE_STATUS_FILTER);

    if (statusError) {
      return apiError("Failed to update instance status", 500);
    }
  }

  await reportOpsEvent({
    source: "instance-update-status",
    severity: report.status === "failed" ? "error" : "info",
    title: `${updateLabel} ${report.status === "failed" ? "failed" : "succeeded"}`,
    message:
      report.status === "failed"
        ? `${updateLabel} reported a host-side failure.`
        : `${updateLabel} completed successfully.`,
    route: "/api/instances/[id]/update-report",
    userId: instance.user_id,
    instanceId: instance.id,
    metadata: {
      status: report.status,
      runType: report.runType,
      ...(report.status === "failed"
        ? {
            failureOwner: "hermes",
            failurePhase: "update",
            failureType: "instance_update_failed",
            recoveryAction: "open_console",
          }
        : {}),
      ...(report.reason ? { reason: report.reason } : {}),
      ...(report.occurredAt ? { occurredAt: report.occurredAt } : {}),
      ...(report.status === "failed" && report.detail ? { detail: report.detail } : {}),
    },
  });

  return apiSuccess({ recorded: true });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const searchParams = req.nextUrl.searchParams;

    return await recordUpdateReport({
      id,
      authHeader: req.headers.get("authorization"),
      report: {
        status: searchParams.get("s") ?? undefined,
        runType: searchParams.get("t") ?? undefined,
        reason: searchParams.get("r") ?? undefined,
        occurredAt: searchParams.get("o") ?? undefined,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();

    return await recordUpdateReport({
      id,
      authHeader: req.headers.get("authorization"),
      report: {
        status: body?.status,
        runType: body?.runType,
        reason: body?.reason,
        detail: body?.detail,
        occurredAt: body?.occurredAt,
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
