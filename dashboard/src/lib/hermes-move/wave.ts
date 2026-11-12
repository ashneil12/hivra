// The automatic move of every old Hermes agent onto the official Hermes.
//
// There is no button: every old agent has to move to keep getting updates. On each cron run the
// wave (one row in hermes_move_wave, off by default):
//   1. stops if it is off or paused;
//   2. pauses itself when an automatic move ended failed or needs attention since the last resume
//      (an operator looks, then resumes);
//   3. queues agents whose owner was told at least a day ago, up to the daily limit, skipping an
//      agent that was busy in the last half hour (it is tried on a later run);
//   4. tells the next owners (email, and config.moveNoticeAt, which the agent's page shows),
//      up to the same daily limit.
// The moves themselves run through the same state machine as an operator's (orchestrator.ts),
// with the old computer kept for 7 days and Undo.

import { MOVE_NOTICE_MS, MoveRequestError, moveOffer, startMove, type InstanceRow, type MoveDeps, type MoveRow } from "@/lib/hermes-move/orchestrator";
import { log } from "@/lib/logger";

const DAY_MS = 24 * 60 * 60 * 1000;
/** An agent with activity this recent is left for a later run. */
export const BUSY_WINDOW_MS = 30 * 60 * 1000;

export interface WaveSettings {
  enabled: boolean;
  per_day: number;
  paused_at: string | null;
  paused_reason: string | null;
  resumed_at: string | null;
}

export interface WaveCandidate extends InstanceRow {
  created_at?: string | null;
  last_agent_activity_at?: string | null;
}

export interface WaveStore {
  getSettings(): Promise<WaveSettings | null>;
  pause(reason: string, atIso: string): Promise<void>;
  /** Automatic moves that ended failed or needs_attention after `sinceIso` (all of them when null). */
  failedAutoMovesSince(sinceIso: string | null): Promise<MoveRow[]>;
  countAutoMovesSince(sinceIso: string): Promise<number>;
  /** Old agents whose owner was told at or after `sinceIso`. */
  countNoticesSince(sinceIso: string): Promise<number>;
  /** Old agents whose owner undid a move: the wave leaves them for an operator. */
  undoneInstanceIds(): Promise<Set<string>>;
  /** Running, undeleted, unmoved old Hermes agents (moveOffer has the final say). */
  listCandidates(limit: number): Promise<WaveCandidate[]>;
  /** Record that the owner was told (merges config.moveNoticeAt). */
  setNotice(instance: WaveCandidate, atIso: string): Promise<void>;
}

export interface WaveDeps {
  store: WaveStore;
  moves: MoveDeps;
  sendNotice: (p: { userId: string; agentName: string; moveAfter: string }) => Promise<{ sent: boolean; reason?: string }>;
}

export type WaveResult =
  | { state: "off" }
  | { state: "paused"; reason: string | null }
  | { state: "ran"; queued: string[]; told: string[]; busy: number; skipped: Array<{ id: string; reason: string }> };

const noticeAt = (row: WaveCandidate): number => {
  const v = row.config?.moveNoticeAt;
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

export async function runMoveWave(deps: WaveDeps): Promise<WaveResult> {
  const settings = await deps.store.getSettings();
  if (!settings?.enabled) return { state: "off" };
  if (settings.paused_at) return { state: "paused", reason: settings.paused_reason };

  const now = deps.moves.now();
  const nowIso = now.toISOString();

  // 2. A failed automatic move pauses the whole wave until an operator resumes it.
  const failed = await deps.store.failedAutoMovesSince(settings.resumed_at);
  if (failed.length > 0) {
    const first = failed[0];
    const reason = `Move ${first.id} ended ${first.state}: ${(first.failure?.technical ?? first.error ?? "").toString().slice(0, 200)}`;
    await deps.store.pause(reason, nowIso);
    await deps.moves.alert({
      title: "The Hermes move wave paused itself",
      message: `${failed.length} automatic move(s) did not finish. ${reason}`,
      moveId: first.id,
      userId: first.user_id,
      instanceId: first.instance_id,
      failureType: "move_wave_paused",
    }).catch(() => undefined);
    return { state: "paused", reason };
  }

  const perDay = Math.max(0, Math.floor(settings.per_day));
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const active = new Set((await deps.moves.store.listActiveMoves()).map((m) => m.instance_id));
  const undone = await deps.store.undoneInstanceIds();
  const candidates = (await deps.store.listCandidates(2000)).filter(
    (row) => !undone.has(row.id) && moveOffer(row, active.has(row.id) ? { state: "queued" } : null).available,
  );

  // 3. Move the agents whose owner was told at least a day ago.
  const queued: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  let busy = 0;
  let moveBudget = perDay - (await deps.store.countAutoMovesSince(dayAgo));
  const due = candidates
    .filter((row) => noticeAt(row) <= now.getTime() - MOVE_NOTICE_MS)
    .sort((a, b) => noticeAt(a) - noticeAt(b));
  for (const row of due) {
    if (moveBudget <= 0) break;
    const lastActive = row.last_agent_activity_at ? Date.parse(row.last_agent_activity_at) : NaN;
    if (Number.isFinite(lastActive) && now.getTime() - lastActive < BUSY_WINDOW_MS) {
      busy += 1;
      continue;
    }
    try {
      const move = await startMove({ userId: row.user_id, instanceId: row.id, initiatedBy: "auto" }, deps.moves);
      queued.push(move.id);
      moveBudget -= 1;
    } catch (err) {
      skipped.push({ id: row.id, reason: err instanceof MoveRequestError ? err.code : "error" });
      if (!(err instanceof MoveRequestError)) log.error("hermes move wave could not queue a move", err, { source: "hermes-move-wave", instanceId: row.id });
    }
  }

  // 4. Tell the next owners. Their agents move on a run at least a day from now.
  const told: string[] = [];
  let noticeBudget = perDay - (await deps.store.countNoticesSince(dayAgo));
  const fresh = candidates
    .filter((row) => !Number.isFinite(noticeAt(row)))
    .sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? "") || a.id.localeCompare(b.id));
  for (const row of fresh) {
    if (noticeBudget <= 0) break;
    await deps.store.setNotice(row, nowIso);
    noticeBudget -= 1;
    told.push(row.id);
    const mail = await deps.sendNotice({
      userId: row.user_id,
      agentName: row.name,
      moveAfter: new Date(now.getTime() + MOVE_NOTICE_MS).toISOString(),
    }).catch((err) => ({ sent: false, reason: String(err).slice(0, 120) }));
    if (!mail.sent) log.warn("hermes move notice email not sent", { source: "hermes-move-wave", instanceId: row.id, reason: mail.reason });
  }

  if (queued.length || told.length || skipped.length) {
    log.info("hermes move wave ran", { source: "hermes-move-wave", queued: queued.length, told: told.length, busy, skipped: skipped.length });
  }
  return { state: "ran", queued, told, busy, skipped };
}
