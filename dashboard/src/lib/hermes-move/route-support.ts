// Small helpers shared by the move routes.

import { runAfterResponse } from "@/lib/hivra/after-response";
import { createMoveDeps } from "@/lib/hermes-move/deps";
import { advanceMove, isActiveMove, MoveRequestError, type MoveRow } from "@/lib/hermes-move/orchestrator";
import { apiError } from "@/lib/api-response";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Advance a move after the response is sent, inside the route's own time budget. */
export function advanceAfterResponse(moveId: string): void {
  runAfterResponse(() => advanceMove(moveId, createMoveDeps()), {
    source: "hermes-move",
    failureType: "hermes_move_advance_failed",
    moveId,
  });
}

/** An active move whose lease is free is worth advancing now. */
export function leaseIsFree(move: MoveRow, now: number = Date.now()): boolean {
  return isActiveMove(move) && (!move.lease_until || Date.parse(move.lease_until) <= now);
}

export function moveRequestErrorResponse(err: unknown) {
  if (err instanceof MoveRequestError) return apiError(err.message, err.status, undefined, { code: err.code });
  return null;
}
