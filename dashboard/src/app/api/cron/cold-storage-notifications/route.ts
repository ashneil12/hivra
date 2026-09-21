/**
 * Cron: cold-storage email notifications.
 *
 * Daily sweep. Walks cold_archived/pending_deletion/deleted rows, decides
 * which Resend email is due based on lifecycle_state +
 * scheduled_deletion_at + notifications_sent, sends, marks notified.
 *
 * Notifications:
 *   `cold_archived`         on first archive
 *   `cold_pending_deletion` when row goes pending_deletion (≈ retention - grace days)
 *   `cold_final_notice`     2 days before scheduled_deletion_at
 *   `cold_deleted`          after retention purge
 *
 * Idempotency: notifications_sent JSONB tracks which kinds have been sent
 * per row. Resend idempotencyKey = "${instanceId}:${kind}:${archived_at}"
 * — double-trigger safe even if notifications_sent gets reset.
 *
 * Auth: Bearer CRON_SECRET. Env knobs: COLD_STORAGE_NOTIFICATIONS_ENABLED.
 */

import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import {
  sendColdArchivedEmail,
  sendColdDeletedEmail,
  sendColdPendingDeletionEmail,
  type ColdStorageEmailSendResult,
} from "@/lib/email/cold-storage";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
// Up to 100 sequential Clerk fetches + Resend sends per run can exceed the
// default function budget. Give it a real ceiling.
export const maxDuration = 800;

const LOG_SOURCE = "cron:cold-storage-notifications";
const CLERK_API_BASE_URL = "https://api.clerk.com/v1";

type NotificationsRow = {
  id: string;
  user_id: string;
  name: string | null;
  agent_type: string | null;
  resource_tier: string | null;
  lifecycle_state: string | null;
  archived_at: string | null;
  archive_uri: string | null;
  scheduled_deletion_at: string | null;
  notifications_sent: Record<string, unknown> | null;
  deleted_at: string | null;
};

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

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
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

function notificationAlreadySent(row: NotificationsRow, key: string): boolean {
  const ns = row.notifications_sent;
  if (!ns) return false;
  return typeof ns[key] === "string";
}

async function markNotificationSent(row: NotificationsRow, key: string): Promise<void> {
  if (!supabaseAdmin) return;
  const next = { ...(row.notifications_sent ?? {}), [key]: new Date().toISOString() };
  // supabase-js resolves with `{ error }` instead of throwing. If this marker
  // write silently fails, the notifications_sent key is never persisted and
  // the same email re-sends on the next run — so surface the failure to the
  // caller (which counts it as failed rather than a clean send).
  const { error } = await supabaseAdmin
    .from("hermes_instances")
    .update({ notifications_sent: next })
    .eq("id", row.id);
  if (error) {
    throw new Error(
      `Failed to persist notifications_sent[${key}] for ${row.id}: ${error.message || "unknown"}`
    );
  }
}

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("Cron secret is not configured", 500);
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const enabled = envBool("COLD_STORAGE_NOTIFICATIONS_ENABLED", false);
  const batchSize = Math.max(1, Math.min(500, envInt("COLD_STORAGE_NOTIFICATIONS_BATCH_SIZE", 100)));
  const clerkSecret = process.env.CLERK_SECRET_KEY?.trim();

  const nowIso = new Date().toISOString();
  const twoDaysOut = new Date(Date.now() + 2 * 86400_000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const { data: rows, error: queryErr } = await supabaseAdmin
    .from("hermes_instances")
    .select(
      "id, user_id, name, agent_type, resource_tier, lifecycle_state, archived_at, archive_uri, scheduled_deletion_at, notifications_sent, deleted_at"
    )
    .in("lifecycle_state", ["cold_archived", "pending_deletion", "deleted"])
    .not("archive_uri", "is", null)
    .or(`deleted_at.is.null,deleted_at.gt.${sevenDaysAgo}`)
    // Deterministic oldest-first ordering. Previously the flat `.limit(100)` had
    // no `.order()`, so on a large cold fleet rows past the first (arbitrary) 100
    // could be permanently starved while already-notified rows in the window
    // counted as skipped and masked it. Surfacing the oldest archives first
    // prioritizes the rows nearest their deletion deadline. (A precise
    // "notification actually due" filter is JSONB-shaped per-kind logic kept in
    // the loop below; this ordering is the safe additive mitigation.)
    .order("scheduled_deletion_at", { ascending: true, nullsFirst: true })
    .order("archived_at", { ascending: true, nullsFirst: true })
    .limit(batchSize);

  if (queryErr) return apiError(`candidate query failed: ${queryErr.message}`, 500);

  const candidates = (rows ?? []) as NotificationsRow[];
  const summary = {
    candidates: candidates.length,
    archived_sent: 0,
    pending_sent: 0,
    final_sent: 0,
    deleted_sent: 0,
    skipped_already_sent: 0,
    skipped_no_clerk: 0,
    skipped_no_email: 0,
    failed: 0,
  };

  for (const row of candidates) {
    let kind:
      | "cold_archived"
      | "cold_pending_deletion"
      | "cold_final_notice"
      | "cold_deleted"
      | null = null;

    if (row.lifecycle_state === "deleted" && row.deleted_at) {
      if (!notificationAlreadySent(row, "cold_deleted")) kind = "cold_deleted";
    } else if (row.lifecycle_state === "pending_deletion" && row.scheduled_deletion_at) {
      if (row.scheduled_deletion_at <= twoDaysOut && row.scheduled_deletion_at > nowIso) {
        if (!notificationAlreadySent(row, "cold_final_notice")) kind = "cold_final_notice";
      } else if (!notificationAlreadySent(row, "cold_pending_deletion")) {
        kind = "cold_pending_deletion";
      }
    } else if (row.lifecycle_state === "cold_archived") {
      if (!notificationAlreadySent(row, "cold_archived")) kind = "cold_archived";
    }

    if (!kind) {
      summary.skipped_already_sent += 1;
      continue;
    }

    if (!enabled) {
      switch (kind) {
        case "cold_archived":
          summary.archived_sent += 1;
          break;
        case "cold_pending_deletion":
          summary.pending_sent += 1;
          break;
        case "cold_final_notice":
          summary.final_sent += 1;
          break;
        case "cold_deleted":
          summary.deleted_sent += 1;
          break;
      }
      continue;
    }

    if (!clerkSecret) {
      summary.skipped_no_clerk += 1;
      continue;
    }

    let clerkUser: ClerkUser | null;
    try {
      clerkUser = await fetchClerkUser(clerkSecret, row.user_id);
    } catch (err) {
      summary.failed += 1;
      log.warn("clerk fetch failed", {
        source: LOG_SOURCE,
        instanceId: row.id,
        userId: row.user_id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!clerkUser) {
      summary.skipped_no_email += 1;
      continue;
    }
    const email = chooseEmail(clerkUser);
    if (!email) {
      summary.skipped_no_email += 1;
      continue;
    }

    const idem = `${row.id}:${kind}:${row.archived_at ?? "unknown"}`;
    const baseParams = {
      email,
      firstName: clerkUser.first_name ?? null,
      agentName: row.name ?? null,
      agentType: row.agent_type ?? null,
      idempotencyKey: idem,
    };

    let res: ColdStorageEmailSendResult;
    try {
      if (kind === "cold_archived") {
        res = await sendColdArchivedEmail(baseParams);
      } else if (kind === "cold_pending_deletion" || kind === "cold_final_notice") {
        const scheduled = row.scheduled_deletion_at ?? new Date().toISOString();
        const daysUntil = Math.max(
          1,
          Math.ceil((Date.parse(scheduled) - Date.now()) / 86400_000)
        );
        res = await sendColdPendingDeletionEmail({
          ...baseParams,
          daysUntilDeletion: daysUntil,
          scheduledDeletionDateIso: scheduled,
        });
      } else {
        res = await sendColdDeletedEmail(baseParams);
      }
    } catch (err) {
      summary.failed += 1;
      log.warn("email send threw", {
        source: LOG_SOURCE,
        instanceId: row.id,
        kind,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (res.sent) {
      try {
        await markNotificationSent(row, kind);
      } catch (err) {
        // Email went out but the idempotency marker didn't persist. Count it
        // as failed (not a clean send) and move on — Resend's idempotencyKey
        // dedupes a re-send within its window, and the row will be retried.
        summary.failed += 1;
        log.warn("failed to persist notification-sent marker; email may re-send next run", {
          source: LOG_SOURCE,
          instanceId: row.id,
          kind,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      switch (kind) {
        case "cold_archived":
          summary.archived_sent += 1;
          break;
        case "cold_pending_deletion":
          summary.pending_sent += 1;
          break;
        case "cold_final_notice":
          summary.final_sent += 1;
          break;
        case "cold_deleted":
          summary.deleted_sent += 1;
          break;
      }
    } else {
      summary.failed += 1;
    }
  }

  log.info("cold-storage notifications cron complete", {
    source: LOG_SOURCE,
    enabled,
    ...summary,
  });

  // Surface systemic send failures: previously Clerk-fetch/send failures only
  // emitted log.warn while the route returned 200 with ok:true, so a broken
  // Resend/Clerk integration was invisible. Emit a warn event when any send
  // failed and report an honest ok flag. Best-effort.
  if (summary.failed > 0) {
    await reportOpsEvent({
      source: "cron.cold_storage_notifications_failed",
      severity: "warn",
      title: `Cold-storage notifications: ${summary.failed} of ${summary.candidates} failed`,
      message:
        `cold-storage-notifications failed ${summary.failed} of ${summary.candidates} candidate(s). ` +
        `Tenants may not be receiving archive/deletion warnings — check Clerk + Resend health and ` +
        `the notifications_sent marker writes.`,
      route: "/api/cron/cold-storage-notifications",
      metadata: { enabled, ...summary },
    });
  }

  return apiSuccess({ ok: summary.failed === 0, mode: enabled ? "applied" : "dry_run", ...summary });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
