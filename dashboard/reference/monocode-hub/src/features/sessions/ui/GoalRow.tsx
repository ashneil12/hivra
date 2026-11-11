import { CheckCircle, CircleDot, CircleX, Pause } from "../../../shared/ui/icons";
import type { SessionGoal } from "../model/session";

/**
 * Claude Code's /goal in a worker's chat (H5): the finish line, how many checks so far, and the last one. Sits above
 * the composer in the same strip style as the usage-limit notice and the message queue.
 */
export function goalLine(goal: SessionGoal): { label: string; detail: string } {
  const checks = goal.checks === 1 ? "1 check" : `${goal.checks} checks`;
  switch (goal.status) {
    case "met":
      return { label: "Goal met", detail: checks };
    case "paused":
      return { label: "Goal waiting for the next turn", detail: checks };
    case "stopped":
      return { label: "Goal stopped", detail: `${checks}, the most a goal gets` };
    case "cleared":
      return { label: "Goal cleared", detail: checks };
    default:
      return { label: "Working toward", detail: goal.checks ? checks : "not checked yet" };
  }
}

export function GoalRow({ goal }: { goal: SessionGoal }) {
  const { label, detail } = goalLine(goal);
  const Icon =
    goal.status === "met" ? CheckCircle : goal.status === "paused" ? Pause : goal.status === "active" ? CircleDot : CircleX;
  const tone =
    goal.status === "met"
      ? "text-emerald-400"
      : goal.status === "active"
        ? "text-sky-400"
        : "text-amber-400";
  return (
    <div className="px-2 text-content/55" data-goal-row role="status">
      <div className="relative z-0 flex min-h-8 flex-col justify-center gap-0.5 rounded-t-[10px] border border-b-0 border-content/10 bg-content/[0.04] px-2 py-1 text-[12px]">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={`size-3.5 shrink-0 ${tone}`} />
          <span className="shrink-0 text-content/85">{label}</span>
          <span className="min-w-0 flex-1 truncate" title={goal.objective}>
            {goal.objective}
          </span>
          <span className="shrink-0 tabular-nums">{detail}</span>
        </div>
        {goal.lastCheck && goal.status !== "met" ? (
          <div className="truncate pl-5.5 text-content/45" title={goal.lastCheck}>
            Last check: {goal.lastCheck}
          </div>
        ) : null}
      </div>
    </div>
  );
}
