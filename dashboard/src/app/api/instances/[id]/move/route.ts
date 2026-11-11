// GET/POST /api/instances/[id]/move
//
// Moving an old Hermes agent onto the official Hermes (docs/release/HERMES-OFFICIAL-MOVE.md).
//   GET   the offer, the move (if any) and where the agent moved to; advances a move in flight
//   POST  start the move (owner only)
import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { createMoveDeps } from "@/lib/hermes-move/deps";
import { isActiveMove, movedToOf, moveOffer, startMove, toMoveView } from "@/lib/hermes-move/orchestrator";
import { advanceAfterResponse, leaseIsFree, moveRequestErrorResponse, UUID_RE } from "@/lib/hermes-move/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The launch step waits for the new computer to be allocated (up to ~2 minutes) and runs after the response.
export const maxDuration = 420;

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    const { id } = await params;
    if (!UUID_RE.test(id)) return apiError("Invalid ID format", 400);
    const deps = createMoveDeps();
    const instance = await deps.store.getInstance(id);
    if (!instance || instance.user_id !== userId || instance.status === "deleted") return apiError("Instance not found", 404);

    const move = await deps.store.latestMoveForInstance(id);
    if (move && leaseIsFree(move)) advanceAfterResponse(move.id);
    const offer = moveOffer(instance, move, deps.isEnabled());
    const to = movedToOf(instance);
    const response = apiSuccess({
      offer,
      move: move ? toMoveView(move) : null,
      movedTo: to ? { agentId: to.agentId } : null,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!isSameOriginMutationRequest(request)) return apiError("Start the move from this dashboard.", 403);
    const { id } = await params;
    if (!UUID_RE.test(id)) return apiError("Invalid ID format", 400);
    const deps = createMoveDeps();
    const move = await startMove({ userId, instanceId: id, initiatedBy: "owner" }, deps);
    if (isActiveMove(move)) advanceAfterResponse(move.id);
    return apiSuccess({ move: toMoveView(move) }, 202);
  } catch (err) {
    return moveRequestErrorResponse(err) ?? handleApiError(err);
  }
}
