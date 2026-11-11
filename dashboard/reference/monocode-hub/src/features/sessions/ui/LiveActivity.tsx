// The live step line under a working reply ("Reading app.tsx · 14s", grey "No activity for 1 min" once nothing has
// happened for a minute), with the little MonoCode pinned right after the timer until the reply lands. Shared by the
// hub's rooms (RoomMessage) and the chats' transcript (AgentTranscript).
import { useEffect, useMemo, useRef, useState } from "react";
import { noteLiveLine, readLiveLine } from "../model/verifyLiveLines";
import { projectKey, projectName } from "../../../shared/lib/paths";
import { loadTabGroupMascots, resolveTabGroupMascot } from "../../workspace/model/tabGroups";
import { ProjectMascot } from "../../projects/ui/ProjectMascot";
import { loadComposerRunner } from "../../settings/model/settings";
import { activityLine, trackActivity, workerProgress, type LiveActivity, type LiveStep, type StepDetail } from "../model/liveActivity";
import type { Block } from "../model/session";

/** The clock now, re-rendering once a second while something reads it (a new step shows its real time at once). */
export function useNow(everyMs = 1000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return Date.now();
}

/** Who runs along the line: the project's (or the Mono's) MonoCode. */
export type RunnerLook = { cwd?: string; mascot?: { name: string; mascot: string } };

/**
 * The step and one timer (Critiquito, 29 Oct: one line, one clock), and the runner pinned right after the timer. A stall
 * keeps the grey dot; its words are #8a8a8a (about 5.2:1 on the dark ground) so they stay readable.
 */
export function LiveActivityLine({
  activity,
  className = "",
  runner,
  who,
}: {
  activity: LiveActivity;
  className?: string;
  runner?: RunnerLook;
  /** A name before the step, on a room's status line ("frank · Reading app.tsx · 12s"). */
  who?: string;
}) {
  const now = useNow();
  const { text: step, stalled } = activityLine(activity, now);
  const text = who ? `${who} · ${step}` : step;
  const line = useRef<HTMLDivElement>(null);
  // The verify bench's record of what the line showed (a no-op outside hub:verify-live).
  useEffect(() => {
    if (line.current) noteLiveLine(readLiveLine(line.current, activity.key));
  }, [activity.key, text, runner]);
  return (
    <div
      ref={line}
      data-live-activity={activity.key}
      data-live-activity-stalled={stalled || undefined}
      role="status"
      aria-live="polite"
      className={`flex min-w-0 items-center gap-1.5 font-sans text-xs leading-5 ${stalled ? "text-[#8a8a8a]" : "text-content/70"} ${className}`}
    >
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${stalled ? "border border-content/40" : "bg-content/60 motion-safe:animate-pulse"}`}
      />
      {/* Screen readers hear the step when it changes, not the timer every second. */}
      <span className="sr-only">{stalled ? text : who ? `${who} · ${activity.label}` : activity.label}</span>
      <span aria-hidden data-live-activity-text className="min-w-0 truncate tabular-nums">
        {text}
      </span>
      {runner ? <LiveRunner {...runner} stalled={stalled} /> : null}
    </div>
  );
}

/**
 * The project's (or the Mono's) MonoCode, in the text colour like the maze sprites, pinned to the status line right
 * after the timer. It moves in place while the turn works, stands still on a stall and for reduced motion. Off with
 * the Composer mascot setting.
 */
export function LiveRunner({ cwd, mascot, stalled = false }: RunnerLook & { stalled?: boolean }) {
  const look = useMemo(() => {
    if (mascot) return { project: mascot.name, name: mascot.mascot || undefined };
    const project = cwd ? projectName(cwd) : "MonoCode";
    return { project, name: cwd ? resolveTabGroupMascot(projectKey(cwd), loadTabGroupMascots()) : undefined };
  }, [cwd, mascot]);
  if (!loadComposerRunner()) return null;
  return (
    <span aria-hidden data-live-runner data-live-runner-stalled={stalled || undefined} className="live-runner pointer-events-none inline-flex size-4 shrink-0 text-content/85">
      <ProjectMascot project={look.project} name={look.name} className="size-4" active={!stalled} />
    </span>
  );
}

/**
 * A transcript turn's activity, tracked across renders (and remounts) by the turn's id. `sessionId`: the chat, so a
 * step waiting on its worker says what the worker does (workerProgress).
 */
export function useTurnActivity(
  id: string,
  blocks: readonly Block[],
  cwd?: string,
  startedAt?: number,
  override?: LiveStep,
  options: { detail?: StepDetail; sessionId?: string; clock?: "step" | "turn" } = {},
): LiveActivity {
  const key = override?.key;
  const label = override?.label;
  const now = useNow();
  const worker = workerProgress(options.sessionId);
  const workerKey = worker ? `${worker.label}|${worker.lastEventAt}` : "";
  const detail = options.detail;
  const turnClock = options.clock === "turn";
  const activity = useMemo(
    () =>
      trackActivity(id, blocks, Date.now(), cwd, startedAt, key && label ? { key, label } : undefined, {
        detail,
        worker: workerKey ? worker : undefined,
      }),
    // The clock only matters for a worker's progress, which arrives without new blocks here.
    [id, blocks, cwd, startedAt, key, label, detail, workerKey, workerKey ? now : 0],
  );
  // A coding chat's one line (Critiquito, 29 Oct): the step, timed from when the turn began, not two clocks.
  return turnClock && startedAt && startedAt <= activity.since ? { ...activity, since: startedAt } : activity;
}

/** The step line for a live transcript turn, with the runner after its timer when `runner` is given. */
export function TurnActivityLine({
  id,
  blocks,
  cwd,
  startedAt,
  override,
  className,
  detail,
  sessionId,
  runner,
  clock,
}: {
  id: string;
  blocks: readonly Block[];
  cwd?: string;
  startedAt?: number;
  override?: LiveStep;
  className?: string;
  detail?: StepDetail;
  sessionId?: string;
  runner?: RunnerLook;
  /** "turn": the timer counts the whole turn (a coding chat's single line); otherwise the current step. */
  clock?: "step" | "turn";
}) {
  const activity = useTurnActivity(id, blocks, cwd, startedAt, override, { detail, sessionId, clock });
  return <LiveActivityLine activity={activity} className={className} runner={runner} />;
}
