"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AGENTS, type AgentId } from "@/lib/hivra/agent-catalog";
import { fetchPlanStrict, isFreePlanInfo, type PlanInfo } from "@/lib/hivra/agent-api";
import styles from "./HomeWorkspace.module.css";

/** The three agents a new person is offered. The rest are one link away. */
const FIRST_RUN_AGENTS: readonly AgentId[] = ["hermes", "claude-code", "codex"];

/**
 * What each first-run choice does, in plain words. A new person picks by the job
 * they want done; the agent's name sits under it (UTAUT2 review, 12 Nov 2026).
 */
const FIRST_RUN_JOBS: Partial<Record<AgentId, { job: string; line: string; badge?: string }>> = {
  hermes: { job: "Research and everyday tasks", line: "Looks things up, writes and runs repeat jobs for you.", badge: "Recommended" },
  "claude-code": { job: "Code, with Claude", line: "Writes, fixes and tests software. Hivra credits or your Claude login." },
  codex: { job: "Code, with ChatGPT", line: "Writes, fixes and tests software. Hivra credits or your ChatGPT login." },
};

/** What Home shows before there is anything to show: one question, three taps.
 * Each choice opens Launch with that agent already picked (`?profile=`). */
export function FirstRunCard() {
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchPlanStrict().then((next) => {
      if (alive) setPlan(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  const choices = FIRST_RUN_AGENTS.flatMap((id) => AGENTS.find((agent) => agent.id === id) ?? []);
  // Only a known Free plan gets the line, and never an account whose paid plan is on hold.
  const showPlanLine = isFreePlanInfo(plan) && !plan?.onHold;

  return (
    <section className={styles.firstRun} aria-labelledby="first-run-title">
      <h1 id="first-run-title" className={styles.firstRunTitle}>Launch your first agent</h1>
      <p className={styles.firstRunLead}>Pick what it should do. Hivra sets up its computer, then you just talk to it.</p>
      <ul className={styles.firstRunChoices}>
        {choices.map((agent) => {
          const job = FIRST_RUN_JOBS[agent.id];
          return (
            <li key={agent.id}>
              <Link href={`/dashboard/launch?profile=${agent.id}`} className={styles.firstRunChoice} aria-label={`Launch ${agent.name}`}>
                {job?.badge ? <span className={styles.firstRunBadge}>{job.badge}</span> : null}
                <span className={styles.firstRunName}>{job?.job ?? agent.name}</span>
                <span className={styles.firstRunTagline}>{job?.line ?? agent.tagline}</span>
                {job ? <span className={styles.firstRunAgent}>{agent.name}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
      {showPlanLine ? (
        <div className={styles.firstRunPlan} data-testid="first-run-plan">
          <p>Your account is free. An agent needs a computer to run on, so pick one of two ways:</p>
          <ul className={styles.firstRunWays}>
            <li>
              <Link href="/dashboard/billing">Hivra Cloud, from $9.99 a month</Link>
              <span>We run the computer. Every agent, nothing to set up, money-back guarantee.</span>
            </li>
            <li>
              <Link href="/dashboard/infrastructure">Your own server, free</Link>
              <span>Connect a Proxmox VE server you run. Claude Code and Codex work there; Hermes needs Hivra Cloud.</span>
            </li>
          </ul>
        </div>
      ) : null}
      <Link href="/dashboard/launch" className={styles.firstRunMore}>Browse every agent and computer</Link>
    </section>
  );
}
