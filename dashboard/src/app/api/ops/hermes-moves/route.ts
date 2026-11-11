// POST/GET /api/ops/hermes-moves (ops admin)
//
// The fleet run: queue moves of old Hermes agents onto the official Hermes. The cron
// (/api/cron/advance-hermes-moves) runs them a few at a time.
//   POST  { instanceIds?: string[], all?: boolean, dryRun?: boolean }
//   GET   every move with its state
import type { NextRequest } from "next/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { requireOpsAdmin } from "@/lib/hermes-releases/ops-auth";
import { createMoveDeps } from "@/lib/hermes-move/deps";
import { moveOffer, MoveRequestError, startMove, toMoveView } from "@/lib/hermes-move/orchestrator";
import { UUID_RE } from "@/lib/hermes-move/route-support";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IDS = 500;

export async function POST(request: NextRequest) {
  try {
    const admin = await requireOpsAdmin();
    if (!admin.ok) return apiError(admin.message, admin.status);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const body = (await request.json().catch(() => null)) as { instanceIds?: unknown; all?: unknown; dryRun?: unknown } | null;
    if (!body || typeof body !== "object") return apiError("Send a JSON body.", 400);
    const all = body.all === true;
    const dryRun = body.dryRun === true;
    const ids = Array.isArray(body.instanceIds) ? body.instanceIds : [];
    if (!all && ids.length === 0) return apiError("Name instanceIds or set all.", 400);
    if (ids.length > MAX_IDS || ids.some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
      return apiError(`instanceIds must be at most ${MAX_IDS} instance ids.`, 400);
    }

    const deps = createMoveDeps();
    let query = supabaseAdmin
      .from("hermes_instances")
      .select("id, user_id, name, status, backend, deleted_at, config")
      .eq("status", "running")
      .in("backend", ["webui", "gateway"])
      .is("deleted_at", null)
      .is("config->movedTo", null)
      .limit(2000);
    if (!all) query = query.in("id", ids as string[]);
    const { data, error } = await query;
    if (error) return apiError("Failed to load agents", 500);

    const active = new Set((await deps.store.listActiveMoves()).map((m) => m.instance_id));
    const eligible = ((data ?? []) as unknown as Array<{ id: string; user_id: string; name: string; status: string; backend: string | null; deleted_at: string | null; config: Record<string, unknown> | null }>)
      .filter((row) => moveOffer(row, active.has(row.id) ? { state: "queued" } : null, deps.isEnabled()).available);
    const listing = eligible.map((row) => ({ id: row.id, name: row.name, ownerId: row.user_id, status: row.status }));

    if (dryRun) return apiSuccess({ dryRun: true, eligible: listing });

    const queued: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const row of eligible) {
      try {
        const move = await startMove({ userId: row.user_id, instanceId: row.id, initiatedBy: "operator" }, deps);
        queued.push(move.id);
      } catch (err) {
        skipped.push({ id: row.id, reason: err instanceof MoveRequestError ? err.code : "error" });
      }
    }
    log.info("hermes moves queued by an operator", { source: "hermes-move", actor: admin.actor, queued: queued.length, skipped: skipped.length });
    return apiSuccess({ dryRun: false, queued: queued.length, moveIds: queued, skipped });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function GET() {
  try {
    const admin = await requireOpsAdmin();
    if (!admin.ok) return apiError(admin.message, admin.status);
    const moves = await createMoveDeps().store.listMoves(500);
    return apiSuccess({
      moves: moves.map((m) => ({
        ...toMoveView(m),
        userId: m.user_id,
        initiatedBy: m.initiated_by,
        failureType: m.failure?.failureType ?? null,
        error: m.error,
      })),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
