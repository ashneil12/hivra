import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { createMoveDeps, createWaveDeps } from "@/lib/hermes-move/deps";
import { sweepMoves } from "@/lib/hermes-move/orchestrator";
import { runMoveWave, type WaveResult } from "@/lib/hermes-move/wave";

/**
 * Cron: advance the Hermes moves in flight and start queued ones, at most
 * HERMES_MOVE_CONCURRENCY (default 2) at a time. The owner's page also advances
 * a move, so this is what finishes one nobody is watching (fleet runs). Then the
 * automatic wave (wave.ts) queues the next old agents and tells the next owners,
 * when an operator has turned it on (hermes_move_wave).
 * Schedule: every 2 minutes (vercel.json).
 */
export const dynamic = "force-dynamic";
// A queued move's first step launches the new computer, which can take several minutes.
export const maxDuration = 420;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: "advance-hermes-moves",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);

  try {
    const parsed = Number.parseInt(process.env.HERMES_MOVE_CONCURRENCY ?? "", 10);
    const concurrency = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10) : 2;
    const deps = createMoveDeps();
    const sweep = await sweepMoves(concurrency, deps);
    let wave: WaveResult | { state: "error" };
    try {
      wave = await runMoveWave(createWaveDeps(deps));
    } catch (err) {
      log.error("hermes move wave failed", err, { source: "advance-hermes-moves", failureType: "hermes_move_wave_failed" });
      wave = { state: "error" };
    }
    return apiSuccess({ ...sweep, wave });
  } catch (err) {
    log.error("advance-hermes-moves failed", err, { source: "advance-hermes-moves", failureType: "advance_hermes_moves_failed" });
    return apiError("Failed to advance moves", 500);
  }
}
