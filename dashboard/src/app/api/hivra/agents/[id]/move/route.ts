// GET /api/hivra/agents/[id]/move
//
// For a computer created by a move from an old Hermes agent: where it came from, the move, and
// whether the move can still be undone. Advances an undo in flight.
import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { createMoveDeps } from "@/lib/hermes-move/deps";
import { toMoveView } from "@/lib/hermes-move/orchestrator";
import { advanceAfterResponse, leaseIsFree, UUID_RE } from "@/lib/hermes-move/route-support";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    const { id } = await params;
    if (!UUID_RE.test(id)) return apiError("Invalid ID format", 400);
    const deps = createMoveDeps();
    const agent = await deps.store.getAgent(id);
    if (!agent || agent.user_id !== userId) return apiError("Agent not found", 404);

    const move = await deps.store.moveForAgent(id);
    if (move && move.user_id !== userId) return apiError("Agent not found", 404);
    if (move && leaseIsFree(move)) advanceAfterResponse(move.id);
    const now = deps.now().getTime();
    const moved = move && (move.state === "done" || move.state === "undoing");
    const old = moved ? await deps.store.getInstance(move.instance_id) : null;
    const response = apiSuccess({
      movedFrom: moved && old
        ? { instanceId: move.instance_id, name: old.name, at: move.finished_at ?? move.started_at, undoUntil: move.undo_until }
        : null,
      move: move ? toMoveView(move) : null,
      canUndo: Boolean(move && move.state === "done" && move.undo_until && Date.parse(move.undo_until) > now),
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}
