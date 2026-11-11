// POST /api/hivra/agents/[id]/move/undo
//
// Undo a move within its window: the old computer starts again and this new one is removed.
// Anything done on this computer since the move is lost.
import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { createMoveDeps } from "@/lib/hermes-move/deps";
import { toMoveView, undoMove } from "@/lib/hermes-move/orchestrator";
import { advanceAfterResponse, moveRequestErrorResponse, UUID_RE } from "@/lib/hermes-move/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(request.headers.get("host"))) return apiError("Not found", 404);
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!isSameOriginMutationRequest(request)) return apiError("Undo the move from this dashboard.", 403);
    const { id } = await params;
    if (!UUID_RE.test(id)) return apiError("Invalid ID format", 400);
    const move = await undoMove({ userId, agentId: id }, createMoveDeps());
    advanceAfterResponse(move.id);
    return apiSuccess({ move: toMoveView(move), instanceId: move.instance_id }, 202);
  } catch (err) {
    return moveRequestErrorResponse(err) ?? handleApiError(err);
  }
}
