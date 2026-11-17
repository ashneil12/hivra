/**
 * Admin: re-encrypt PLAIN cold archives with age (operator-triggered, never a cron).
 *
 * Auth: Bearer CRON_SECRET, like the other /api/admin routes (single-tenant operator
 * endpoint; there is no per-user authorization).
 *
 * Gate: HERMES_BACKUP_REENCRYPT_SWEEP = off (default) | dry | on. It also requires
 * HERMES_BACKUP_ENCRYPTION=on and a valid HERMES_BACKUP_AGE_RECIPIENT. "dry" only lists
 * what it would do and touches neither the Storage Box nor the DB.
 * Host: HERMES_BACKUP_REENCRYPT_HOST (PVE host slug with the `cold` alias), falling back to
 * COLD_STORAGE_AUDIT_HOST.
 *
 *   POST /api/admin/reencrypt-cold-archives   { "limit": 2, "cursor": "<last id>" }
 *
 * Small batches on purpose (default 2, max 5 archives per call). Page through with the
 * returned `nextCursor`. The order of operations and why it is restore-safe is documented in
 * src/lib/services/cold-archive-reencrypt.ts.
 */
import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { resolveReencryptSweep, runReencryptSweep } from "@/lib/services/cold-archive-reencrypt";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const LOG_SOURCE = "admin:reencrypt-cold-archives";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOST_SLUG_RE = /^[A-Za-z0-9._-]{1,64}$/;

export async function POST(req: NextRequest) {
  const functionStart = Date.now();
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("CRON_SECRET not configured", 500);
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const sweep = resolveReencryptSweep(process.env);
  if (sweep.mode === "off") {
    return apiError("Re-encryption sweep is disabled (HERMES_BACKUP_REENCRYPT_SWEEP is not dry or on)", 403);
  }
  if (sweep.mode === "error") return apiError(sweep.error, 409);

  const hostSlug = (
    process.env.HERMES_BACKUP_REENCRYPT_HOST ??
    process.env.COLD_STORAGE_AUDIT_HOST ??
    ""
  ).trim();
  if (!HOST_SLUG_RE.test(hostSlug)) {
    return apiError("HERMES_BACKUP_REENCRYPT_HOST (or COLD_STORAGE_AUDIT_HOST) is not configured", 500);
  }

  let body: { limit?: unknown; cursor?: unknown } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text) as typeof body;
  } catch {
    return apiError("Invalid JSON body", 400);
  }
  if (body.limit !== undefined && (!Number.isInteger(body.limit) || (body.limit as number) < 1)) {
    return apiError("limit must be a positive integer", 400);
  }
  if (body.cursor !== undefined && body.cursor !== null && (typeof body.cursor !== "string" || !UUID_RE.test(body.cursor))) {
    return apiError("cursor must be an instance id", 400);
  }

  let result;
  try {
    result = await runReencryptSweep(supabaseAdmin, sweep, {
      hostSlug,
      limit: body.limit as number | undefined,
      cursor: (body.cursor as string | null | undefined) ?? null,
      deadlineMs: functionStart + maxDuration * 1000 - 30_000,
    });
  } catch (err) {
    log.error("re-encrypt sweep failed", err instanceof Error ? err : new Error(String(err)), {
      source: LOG_SOURCE,
      failureType: "reencrypt_sweep_failed",
    });
    return apiError("Re-encryption sweep failed", 500);
  }

  const done = result.outcomes.filter((o) => o.status === "reencrypted");
  const failed = result.outcomes.filter(
    (o) => o.status !== "reencrypted" && o.status !== "would_reencrypt" && o.status !== "skipped_busy"
  );
  if (result.mode === "on") {
    // Audit trail: privileged operation over every tenant's backups. Best-effort.
    try {
      await reportOpsEvent({
        source: "admin.reencrypt_cold_archives",
        severity: failed.length > 0 ? "warn" : "info",
        title: "Admin cold-archive re-encryption batch",
        message: `Re-encrypted ${done.length}/${result.scanned} cold archive(s); ${failed.length} failed`,
        route: "/api/admin/reencrypt-cold-archives",
        metadata: {
          scanned: result.scanned,
          reencrypted_instance_ids: done.map((o) => o.instanceId),
          failed: failed.map((o) => ({ id: o.instanceId, status: o.status })),
          plain_left_behind_ids: done
            .filter((o) => o.status === "reencrypted" && !o.plainDeleted)
            .map((o) => o.instanceId),
        },
      });
    } catch {
      // the work is already done; an audit hiccup must not turn into a non-2xx
    }
  }
  log.info("re-encrypt sweep batch complete", {
    source: LOG_SOURCE,
    mode: result.mode,
    scanned: result.scanned,
    reencrypted: done.length,
    failed: failed.length,
  });

  return apiSuccess(result);
}
