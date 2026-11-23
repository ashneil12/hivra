import { NextRequest } from "next/server";

import { decryptApiKey } from "@/lib/crypto";
import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { DIGEST_PATTERN } from "@/lib/hermes-releases/policy";
import { recordBoxOutcome, type BoxOutcome } from "@/lib/hermes-releases/store";
import {
  buildInstanceLifecyclePatch,
  LIVE_UPDATE_FAILED_VM_REACHED_SUBSTATE,
} from "@/lib/instance-lifecycle";
import { LIVE_MUTATION_BLOCKED_LIFECYCLE_IN_LIST } from "@/lib/services/instance-live-mutation";
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

const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every refusal (malformed id, unknown or deleted instance, no key, wrong bearer)
// answers this one 401, so a caller cannot tell which instance ids are live. The
// real reason is kept in the server log only.
function refuseUpdateReport(failureType: string) {
  return apiError("Unauthorized", 401, undefined, undefined, { failureType });
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
  /**
   * Attempt identity the launcher baked into the callback URL (`a=`). The
   * update path stamps the same value into last_lifecycle_transition_at
   * when it marks the row 'redeploying', so a report carrying it can be
   * correlated to exactly the attempt it belongs to — no registry read and
   * no timestamp needed. Reports from wrappers built before this existed
   * carry none and fall back to the older correlation bounds.
   */
  attemptStamp?: string;
}

// The attempt stamp is compared verbatim against a timestamp column via a
// PostgREST `eq` filter, so only the characters an ISO timestamp (or a
// similarly shaped token) can carry are allowed — `,()`, `*` and quotes
// would otherwise alter filter parsing.
const ATTEMPT_STAMP_PATTERN = /^[0-9A-Za-z:+.TZ_-]{1,80}$/;

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
  // The release fields are THIS attempt's evidence about the row — the
  // same ownership bounds the lifecycle writes below apply. A delayed or
  // replayed report whose attempt no longer owns the row must not
  // overwrite the image digest / update-health a newer attempt just wrote:
  // it would mis-state which release the current attempt is running and
  // feed stale evidence into the release registry's halt decision.
  let releaseWrite = supabaseAdmin
    .from("hermes_instances")
    .update(patch)
    .eq("id", instance.id)
    .is("deleted_at", null);
  if (report.attemptStamp) {
    releaseWrite = releaseWrite.eq(
      "last_lifecycle_transition_at",
      report.attemptStamp,
    );
  }
  if (report.occurredAt && !Number.isNaN(Date.parse(report.occurredAt))) {
    // Same bound the failed-state write applies: a report the box says
    // happened before the current attempt stamped 'redeploying' cannot
    // describe that attempt's release state.
    releaseWrite = releaseWrite.lte("last_lifecycle_transition_at", report.occurredAt);
  }
  const { error } = await releaseWrite;
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
        // The release to judge. After a success the digest the box runs is the
        // target. After a failure it is NOT: the box is back on the old image,
        // so only an explicit target may be blamed.
        targetDigest: kind === "updated" ? (release.targetDigest ?? release.digest ?? null) : (release.targetDigest ?? null),
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
    attempt?: string;
  };
  release?: ReleaseReport;
}) {
  if (!supabaseAdmin) return apiError("Database not configured", 500);
  // A malformed id cannot name an instance, so it is refused before any query.
  if (!INSTANCE_ID_PATTERN.test(params.id)) return refuseUpdateReport("malformed_instance_id");

  const { data: instance, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, user_id, api_server_key_encrypted, status, deleted_at")
    .eq("id", params.id)
    .is("deleted_at", null)
    .maybeSingle<InstanceUpdateReportRecord>();

  // A lookup failure is an outage, not evidence that the instance is missing.
  if (error) {
    return apiError("Database lookup failed", 500, undefined, undefined, {
      failureType: "instance_update_lookup_failed",
    });
  }
  if (!instance) return refuseUpdateReport("unknown_or_deleted_instance");
  if (!instance.api_server_key_encrypted) return refuseUpdateReport("instance_has_no_key");

  const expectedToken = decryptApiKey(instance.api_server_key_encrypted);
  if (!verifyBearerHeader(params.authHeader ?? null, expectedToken)) {
    return refuseUpdateReport("bearer_mismatch");
  }

  const normalized: {
    status?: string;
    runType?: string;
    reason?: string;
    detail?: string;
    occurredAt?: string;
    attempt?: string;
  } = {
    status: normalizeOptionalString(params.report.status),
    runType: normalizeOptionalString(params.report.runType),
    reason: normalizeOptionalString(params.report.reason),
    detail: normalizeOptionalString(params.report.detail),
    occurredAt: normalizeOptionalString(params.report.occurredAt),
    attempt: normalizeOptionalString(params.report.attempt),
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
    attemptStamp:
      normalized.attempt && ATTEMPT_STAMP_PATTERN.test(normalized.attempt)
        ? normalized.attempt
        : undefined,
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

  // Attempt ownership for a report is decided by the WRITES below, not by
  // comparing the reported target to the release registry's current pin.
  // The registry can repin D1→D2 while the SAME attempt is still in flight
  // — a pin value is policy, not attempt identity — so treating a pin
  // mismatch as "a newer attempt owns this row" wrongly refused the
  // in-flight attempt's own verdict (and stranded the row 'redeploying'),
  // while a pin match could just as wrongly adopt an old attempt's report.
  // What correlates instead: the launch-side attempt stamp (`a=`, the
  // target/identity captured when the attempt launched — carried in
  // last_lifecycle_transition_at) where the wrapper is new enough to send
  // it, and otherwise the reported `occurredAt` against the current
  // attempt's stamp. A legacy report with neither is genuinely ambiguous:
  // the failed write is admitted under the status bound and PRESERVES the
  // row's attempt stamp, so whichever attempt actually owns the row keeps
  // its correlation — its own verdicts can still settle it, and the
  // recorded failure keeps the row retry-eligible rather than paged as
  // an untracked stuck update.

  // Durable first, lifecycle second. The box-side reporter is
  // fire-and-forget (a single `curl -m10`, no retry), so a non-2xx is not a
  // "please try again" — it is the report's only copy lost forever, and no
  // release event, ops event or halt decision would ever exist. The release
  // outcome and ops event therefore land BEFORE any status/lifecycle write
  // that could fail; those writes degrade the response but never the
  // record.
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
      ...(report.attemptStamp ? { attemptStamp: report.attemptStamp } : {}),
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

  if (nextInstanceStatus) {
    // Settle the attempt on the full running lifecycle, not a status-only
    // relabel: a box the launch wrote off ('failed' + preserved stamp,
    // because its SSH died after the wrapper started) needs
    // lifecycle_state back to 'active' too, or recover-stuck keeps
    // re-driving a healthy row. The transition column stays the attempt's
    // own — report writes never mint a transition identity they did not
    // launch with; updated_at records when this settlement landed.
    const { last_lifecycle_transition_at: _successAttemptStamp, ...runningPatch } =
      buildInstanceLifecyclePatch("running");
    let runningWrite = supabaseAdmin
      .from("hermes_instances")
      .update({
        ...runningPatch,
        ...(report.attemptStamp
          ? { last_lifecycle_transition_at: report.attemptStamp }
          : {}),
      })
      .eq("id", instance.id);
    if (report.attemptStamp) {
      // Same attempt scope as the failed stamp below: a delayed success
      // callback from a superseded attempt must not mark a row 'running'
      // while a NEWER attempt owns it — that premature 'running' would
      // also block the newer attempt's own failed-report stamp (its
      // status predicate wants 'redeploying'). Reports without a stamp
      // keep the older terminal-status bounds.
      runningWrite = runningWrite.eq(
        "last_lifecycle_transition_at",
        report.attemptStamp,
      );
    }
    const { error: statusError } = await runningWrite
      .not("status", "in", NON_RESURRECTABLE_STATUS_FILTER)
      // Soft-delete paths (e.g. cold-storage purge) set deleted_at without
      // changing status, so the write re-checks it too.
      .is("deleted_at", null)
      // blocksInstanceLiveMutation's lifecycle exclusions in the same
      // or-form the update path writes (unset lifecycle is not blocked):
      // a deleting/archiving/restoring row is another operation's lock —
      // a late success verdict must not cancel it by flipping to active.
      .or(`lifecycle_state.is.null,lifecycle_state.not.in.${LIVE_MUTATION_BLOCKED_LIFECYCLE_IN_LIST}`);

    if (statusError) {
      // The report is already on file; only the status stamp is missing.
      // A row left 'redeploying' is recovered by the same sweeps that
      // handle any other in-flight update (recover-stuck probes it,
      // fleet-sync re-drives failures), so the row is not stranded — and
      // a 200 keeps the fire-and-forget reporter from "learning" that a
      // recorded report was dropped.
      log.error(
        "update report received but the running-state write failed",
        new Error("update_report_status_write_failed"),
        {
          source: "instance-update-status",
          failureType: "update_report_status_write_failed",
          instanceId: instance.id,
          userId: instance.user_id,
        },
      );
      return apiSuccess({ recorded: true, degraded: "update_report_status_write_failed" });
    }
  }

  if (report.status === "failed") {
    // The update this report describes ran on the box and failed there —
    // the callback itself is the reach evidence. A row still stamped
    // 'redeploying' by the launch sits in a state the fleet-sync sweep
    // does not admit on its own (its retry list is lifecycle 'failed'
    // carrying the reached/maybe_reached substates, a live
    // status/lifecycle, or the degraded-write marker arm described
    // below), and recover-stuck can probe and restart the VM but never
    // re-applies the release — the box would report "update in flight"
    // forever with the release never retried. Stamp it like a launch
    // failure that reached the guest: lifecycle 'failed' + the reached
    // substate keeps the row retry-eligible on the next sweep.
    //
    // Ownership is arbitrated by the write's own predicates, not by a
    // registry-pin comparison — a repinned target does not prove a new
    // attempt owns the row (see above). A stamped report can only land on
    // its own attempt: the launch wrote THAT stamp into the transition
    // column, so an `a=` match means the row is still mid-flight under
    // this attempt — a zero-match means the attempt moved on, which is
    // the correct outcome. For a legacy stamp-less report the
    // status/occurredAt bounds are what remain: admitted while the row
    // is mid-update (and, when the box told us when it happened, only
    // while that time still covers the current attempt's stamp).
    //
    // Either way the transition column is preserved, not re-stamped: it
    // is the owning attempt's identity, and the write only lands where
    // the predicates already proved ownership — so keeping the stamp can
    // never adopt a newer attempt's identity, and the real owner's later
    // verdicts (its `a=` reports) still correlate. updated_at records
    // when the transition actually landed.
    const { last_lifecycle_transition_at: _failedAttemptStamp, ...failedPatch } =
      buildInstanceLifecyclePatch("failed");
    const failedStateWrite = () => {
      // The closure captures the module binding (narrowed above cannot
      // reach in) — supabaseAdmin is proven non-null at line ~241.
      let write = supabaseAdmin!
        .from("hermes_instances")
        .update({
          ...failedPatch,
          // A stamped report re-writes the same value its predicate
          // requires — explicit, so this attempt's identity visibly
          // survives in both branches. A stamp-less report leaves the
          // column untouched entirely.
          ...(report.attemptStamp
            ? { last_lifecycle_transition_at: report.attemptStamp }
            : {}),
          lifecycle_substate: LIVE_UPDATE_FAILED_VM_REACHED_SUBSTATE,
        })
        .eq("id", instance.id)
        .eq("status", "redeploying")
        .is("deleted_at", null);
      if (report.attemptStamp) {
        // The launch stamps its attempt id into the transition column when
        // it marks the row 'redeploying'; the report proves it belongs to
        // THIS attempt by matching it. A stale report — any attempt that
        // has since been superseded, retried or recovered — fails the
        // match instead of stomping the newer attempt's lifecycle state.
        write = write.eq(
          "last_lifecycle_transition_at",
          report.attemptStamp,
        );
      }
      if (report.occurredAt && !Number.isNaN(Date.parse(report.occurredAt))) {
        // last_lifecycle_transition_at is when the CURRENT attempt stamped
        // 'redeploying'; a failure the box says happened before that stamp
        // belongs to an earlier attempt and must not overwrite it.
        write = write.lte("last_lifecycle_transition_at", report.occurredAt);
      }
      return write;
    };
    const { error: failedStateError } = await failedStateWrite();
    if (failedStateError) {
      // The write is a guarded compare-and-swap, so a transient PostgREST
      // error is the likeliest cause of a first failure — retry the same
      // bounded write once before degrading.
      const { error: failedStateRetryError } = await failedStateWrite();
      if (failedStateRetryError) {
        // The full stamp will not land. A bare 'redeploying' row is NOT
        // retry-eligible by itself: the sweep's live/failed arms skip it
        // and recover-stuck never re-applies the release, so the box
        // would sit paged-and-unowned until the attempt aged into
        // takeover. Stamp ONLY the reached marker under the same
        // ownership bounds: 'redeploying' + a reached substate is the
        // exact signature the sweep's degraded-write arm selects (the
        // claim clears the marker on real retries, so the arm can never
        // match an in-flight attempt), and the release is re-driven once
        // the orphaned attempt is old enough to take over. A marker
        // write that also errors is the end of what this response can do
        // — the report itself is already durable above, and an error-free
        // zero-match stays silent-200: a row that moved on is fine.
        let markerWrite = supabaseAdmin
          .from("hermes_instances")
          .update({
            lifecycle_substate: LIVE_UPDATE_FAILED_VM_REACHED_SUBSTATE,
          })
          .eq("id", instance.id)
          .eq("status", "redeploying")
          .is("deleted_at", null);
        if (report.attemptStamp) {
          markerWrite = markerWrite.eq(
            "last_lifecycle_transition_at",
            report.attemptStamp,
          );
        }
        if (report.occurredAt && !Number.isNaN(Date.parse(report.occurredAt))) {
          markerWrite = markerWrite.lte(
            "last_lifecycle_transition_at",
            report.occurredAt,
          );
        }
        const { error: markerWriteError } = await markerWrite;
        log.error(
          "update report received but the failed-state write failed",
          new Error("update_report_state_write_failed"),
          {
            source: "instance-update-status",
            failureType: "update_report_state_write_failed",
            instanceId: instance.id,
            userId: instance.user_id,
            retryMarker: markerWriteError ? "write_failed" : "stamped",
          },
        );
        return apiSuccess({ recorded: true, degraded: "update_report_state_write_failed" });
      }
    }
  }

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
        attempt: searchParams.get("a") ?? undefined,
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
        attempt: body?.attempt,
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
