import { useRef, useState } from "react";
import {
  contextRatio,
  contextTooltip,
  formatTokens,
  type ContextUsage,
} from "../model/contextUsage";
import { Popover } from "../../../shared/ui/Popover";

const SIZE = 14;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Ring turns amber then red as the window fills. */
function ringClass(ratio: number): string {
  if (ratio >= 0.9) return "text-red-400";
  if (ratio >= 0.75) return "text-amber-400";
  return "text-content/45";
}

/**
 * Circular gauge for how full the model context window is.
 *
 * Renders nothing until the harness reports both halves — Cursor's ACP stream
 * carries no usage at all, and a ring guessing at a number is worse than no
 * ring. A conversation with nothing in it yet is the exception: its context
 * is known to be empty, so `empty` shows a bare ring.
 */
export function ContextMeter({
  usage,
  onCompact,
  compactDisabled = false,
  empty = false,
  ceiling,
}: {
  usage?: ContextUsage;
  onCompact?: () => void;
  compactDisabled?: boolean;
  /** The conversation has no messages yet. */
  empty?: boolean;
  /** Size the provider compacts at, when it is below the window (Settings > Compact long chats at). */
  ceiling?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const ratio = contextRatio(usage);
  if (!usage || ratio === null) {
    const label = empty ? "No context used yet" : usage
      ? `${contextTooltip(usage).detail}; context window not reported`
      : "Context usage has not been reported by this provider";
    return <span title={label} className="grid shrink-0" data-context-unknown={!empty || undefined}>
      {empty ? <MeterRing ratio={0} label={label} /> : <span role="img" aria-label={label} className="grid size-3.5 place-items-center rounded-full border border-content/25 text-[9px] leading-none text-content/50">?</span>}
    </span>;
  }

  const { headline, detail, note } = contextTooltip(usage);
  const actionsOpen = open && onCompact != null;

  return (
    <div
      ref={root}
      className="relative shrink-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {onCompact ? (
        <button
          type="button"
          title="Context usage"
          aria-label={`${headline}, ${detail}. Open context actions`}
          aria-expanded={actionsOpen}
          onClick={() => setOpen((value) => !value)}
          className="-m-1 grid rounded-sm p-1 outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <MeterRing ratio={ratio} />
        </button>
      ) : (
        <MeterRing ratio={ratio} label={`${headline}, ${detail}`} />
      )}
      {hovered || actionsOpen ? (
        <Popover
          anchor={root}
          side="top"
          align="end"
          onDismiss={onCompact ? () => setOpen(false) : undefined}
          className={`w-max px-2.5 py-1.5 ${actionsOpen ? "" : "pointer-events-none"}`}
        >
          <div className="text-[12px] leading-4 text-content">{headline}</div>
          <div className="text-[11px] leading-4 text-content/50">{detail}</div>
          <div className="text-[11px] leading-4 text-content/50">Last reported by the provider</div>
          {ceiling && usage.window && ceiling < usage.window ? (
            <div className="text-[11px] leading-4 text-content/50" data-context-ceiling>
              Compacts at {formatTokens(ceiling)}
            </div>
          ) : null}
          {note ? (
            <div className="max-w-[15rem] text-[11px] leading-4 text-content/50">
              {note}
            </div>
          ) : null}
          {actionsOpen ? (
            <button
              type="button"
              disabled={compactDisabled}
              title={
                compactDisabled
                  ? "Wait for the current operation to finish"
                  : "Compact this conversation's context"
              }
              onClick={() => {
                setOpen(false);
                onCompact?.();
              }}
              className="mt-1.5 w-full rounded-md bg-content/10 px-2 py-1 text-[11px] text-content hover:bg-content/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Compact now
            </button>
          ) : null}
        </Popover>
      ) : null}
    </div>
  );
}

function MeterRing({ ratio, label }: { ratio: number; label?: string }) {
  // The ring is geometry: a reading past the window still draws as a full
  // ring, while `ratio` itself stays unclamped for the number in the tooltip.
  const filled = Math.min(1, ratio);
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className={ringClass(filled)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        className="opacity-25"
      />
      {/* A round cap would leave a dot on an empty ring. */}
      {filled > 0 ? (
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - filled)}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      ) : null}
    </svg>
  );
}
