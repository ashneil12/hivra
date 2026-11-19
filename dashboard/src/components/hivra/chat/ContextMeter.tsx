"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// A small ring for how full the model's context window is. It turns amber and
// then red as the window fills. It draws nothing until the agent's stream has
// reported both halves (the level and the window): a ring guessing at a number
// is worse than no ring. MonoCode's "Compact now" action is left out: the
// agent CLI compacts on its own.

import { useRef, useState } from "react";
import { contextRatio, contextTooltip, type ContextUsage } from "./contextUsage";
import { Popover } from "./Popover";
import styles from "./chat.module.css";

const SIZE = 14;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function ringClass(ratio: number): string {
  if (ratio >= 0.9) return styles.ringBad;
  if (ratio >= 0.75) return styles.ringWarn;
  return styles.ringCalm;
}

export function ContextMeter({ usage }: { usage?: ContextUsage }) {
  const [hovered, setHovered] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const ratio = contextRatio(usage);
  if (!usage || ratio === null) return null;
  const { headline, detail, note } = contextTooltip(usage);
  const filled = Math.min(1, ratio);
  return (
    <span
      ref={root}
      className={styles.meter}
      data-context-meter
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      tabIndex={0}
      role="img"
      aria-label={`${headline}, ${detail}`}
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className={ringClass(filled)} aria-hidden>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="currentColor" strokeWidth={STROKE} opacity={0.25} />
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
      {hovered ? (
        <Popover anchor={root} side="top" align="end" className={styles.meterTip}>
          <div className={styles.meterHeadline}>{headline}</div>
          <div className={styles.meterDetail}>{detail}</div>
          <div className={styles.meterDetail}>Last reported by the agent</div>
          {note ? <div className={styles.meterDetail}>{note}</div> : null}
        </Popover>
      ) : null}
    </span>
  );
}
