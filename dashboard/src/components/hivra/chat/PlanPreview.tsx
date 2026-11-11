"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// The agent's plan (its ExitPlanMode call) as MonoCode's plan card: the plan's
// title and first lines, a button that opens the whole plan in place, and a
// Build button that tells the agent to go ahead. MonoCode opens a plan in a
// side pane and builds from a target picker; here the plan opens inline and
// Build sends one plain message.

import { useId, useState } from "react";
import { Lightbulb, Play, ChevronDown } from "lucide-react";
import { AssistantMarkdown } from "./AgentMarkdown";
import { planSummary, planTitle } from "./toolInput";
import styles from "./chat.module.css";

export const BUILD_PLAN_MESSAGE = "The plan looks good. Go ahead and build it.";

export function PlanPreview({ text, busy = false, onBuild }: { text: string; busy?: boolean; onBuild?: () => void }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const title = planTitle(text);
  const summary = planSummary(text);
  return (
    <div className={styles.plan} data-plan-preview>
      <div className={styles.planHead}>
        <Lightbulb size={16} strokeWidth={1.75} aria-hidden className={styles.planIcon} />
        <div className={styles.planMain}>
          <span className={styles.planTitle} title={title}>{title}</span>
          {summary && !open ? <p className={styles.planSummary}>{summary}</p> : null}
          <div className={styles.planActions}>
            <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)} className={styles.planButton}>
              <ChevronDown size={12} aria-hidden className={open ? styles.planChevronOpen : undefined} />
              {open ? "Hide plan" : "Open plan"}
            </button>
            {onBuild ? (
              <button type="button" title="Tell the agent to build this plan" disabled={busy} onClick={onBuild} className={`${styles.planButton} ${styles.planBuild}`}>
                <Play size={12} aria-hidden /> Build
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {open ? (
        <div id={bodyId} className={styles.planBody}>
          <AssistantMarkdown text={text} />
        </div>
      ) : null}
    </div>
  );
}
