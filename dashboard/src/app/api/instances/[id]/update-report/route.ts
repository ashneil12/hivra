import { NextRequest } from "next/server";

import { decryptApiKey } from "@/lib/crypto";
import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { DIGEST_PATTERN } from "@/lib/hermes-releases/policy";
import { recordBoxOutcome, type BoxOutcome } from "@/lib/hermes-releases/store";
import { log } from "@/lib/logger";
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

type ReleaseReportKind = BoxOutcome["kind"];

const RELEASE_REPORT_KINDS: readonly string[] = ["updated", "failed", "rolled_back", "paused"];

/** What the box's update stack adds about the image it runs (all optional). */
interface ReleaseReport {
  /** Digest running on the box after this operation. */
  digest?: string;
  /** Digest the operation was moving the box to (the release being judged). */
  targetDigest?: string;
  kind?: ReleaseReportKind;
  /** Version of the box-side update stack that sent the report. */
  stackVersion?: number;
}

interface NormalizedUpdateReport {
  status: UpdateStatus;
  runType: UpdateRunType;
  reason?: string;
  detail?: string;
  occurredAt?: string;
}

function parseReleaseReport(raw: {
  digest?: unknown;
  targetDigest?: unknown;
  kind?: unknown;
  stackVersion?: unknown;
}): ReleaseReport {
  const digest = normalizeOptionalString(raw.digest);
  const targetDigest = normalizeOptionalString(raw.targetDigest);
  const kind = normalizeOptionalString(raw.kind);
  const stackVersion = Number(normalizeOptionalString(String(raw.stackVersion ?? "")));
  return {
    ...(digest && DIGEST_PATTERN.test(digest) ? { digest } : {}),
    ...(targetDigest && DIGEST_PATTERN.test(targetDigest) ? { targetDigest } : {}),
    ...(kind && RELEASE_REPORT_KINDS.includes(kind) ? { kind: kind as ReleaseReportKind } : {}),
    ...(Number.isInteger(stackVersion) && stackVersion >= 1 && stackVersion <= 99 ? { stackVersion } : {}),
  };
}

const HEALTH_BY_KIND: Record<ReleaseReportKind, string> = {
  updated: "ok",
  failed: "failed",
  rolled_back: "rolled_back",
  paused: "paused",
};

/**
 * Record what the box says it runs and how its update stack is doing, then
 * judge the release (a release that enough boxes fail halts itself). Best
 * effort: a failure here never fails the status callback itself.
 */
async function recordReleaseReport(
  instance: { id: string; user_id: string },
  report: NormalizedUpdateReport,
  release: ReleaseReport
): Promise<void> {
  if (!supabaseAdmin) return;
  const kind: ReleaseReportKind | undefined =
    release.kind ?? (release.digest || release.targetDigest ? (report.status === "succeeded" ? "updated" : "failed") : undefined);
  if (!kind && !release.digest && !release.stackVersion) return;

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {};
  if (release.stackVersion) patch.update_stack_version = release.stackVersion;
  if (release.digest) {
    const { data: known } = await supabaseAdmin
      .from("hermes_releases")
      .select("id, version")
      .eq("digest", release.digest)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; version: string }>();
    patch.agent_image_digest = release.digest;
    patch.agent_release_id = known?.id ?? null;
    patch.agent_version = known?.version ?? null;
    patch.agent_image_reported_at = now;
  }
  if (kind) {
    patch.update_health = HEALTH_BY_KIND[kind];
    patch.update_health_detail = kind === "updated" ? null : (report.reason ?? report.detail ?? null)?.slice(0, 500) ?? null;
    patch.update_health_at = now;
  }
  const { error } = await supabaseAdmin.from("hermes_instances").update(patch).eq("id", instance.id);
  if (error) {
    log.error("release report write failed", new Error("release_report_write_failed"), {
      source: "instance-update-status",
      failureType: "release_report_write_failed",
      instanceId: instance.id,
    });
  }
  if (kind) {
    try {
      await recordBoxOutcome(supabaseAdmin, {
        instanceId: instance.id,
        userId: instance.user_id,
        kind,
        targetDigest: release.targetDigest ?? release.digest ?? null,
        detail: report.reason ?? report.detail ?? null,
      });
    } catch (err) {
      log.error("release outcome record failed", err instanceof Error ? err : new Error(String(err)), {
        source: "instance-update-status",
        failureType: "release_outcome_record_failed",
        instanceId: instance.id,
      });
    }
  }
}

const RELEASE_KIND_LABEL: Partial<Record<ReleaseReportKind, string>> = {
  paused: "Auto-update paused",
  rolled_back: "Update rolled back",
};

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
  release?: ReleaseReport;
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
  const releaseReport = params.release ?? {};
  const kindLabel = releaseReport.kind ? RELEASE_KIND_LABEL[releaseReport.kind] : undefined;
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
      .not("status", "in", NON_RESURRECTABLE_STATUS_FILTER)
      // Soft-delete paths (e.g. cold-storage purge) set deleted_at without
      // changing status, so the write re-checks it too.
      .is("deleted_at", null);

    if (statusError) {
      return apiError("Failed to update instance status", 500);
    }
  }

  await recordReleaseReport(instance, report, releaseReport);

  await reportOpsEvent({
    source: "instance-update-status",
    severity: report.status === "failed" ? "error" : "info",
    title: kindLabel ?? `${updateLabel} ${report.status === "failed" ? "failed" : "succeeded"}`,
    message:
      report.status === "failed"
        ? `${kindLabel ?? updateLabel} reported a host-side failure.`
        : `${updateLabel} completed successfully.`,
    route: "/api/instances/[id]/update-report",
    userId: instance.user_id,
    instanceId: instance.id,
    metadata: {
      status: report.status,
      runType: report.runType,
      ...(releaseReport.kind ? { kind: releaseReport.kind } : {}),
      ...(releaseReport.digest ? { digest: releaseReport.digest } : {}),
      ...(releaseReport.targetDigest ? { targetDigest: releaseReport.targetDigest } : {}),
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
      release: parseReleaseReport({
        digest: searchParams.get("i"),
        targetDigest: searchParams.get("ti"),
        kind: searchParams.get("k"),
        stackVersion: searchParams.get("sv"),
      }),
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
      release: parseReleaseReport({
        digest: body?.digest,
        targetDigest: body?.targetDigest,
        kind: body?.kind,
        stackVersion: body?.stackVersion,
      }),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
