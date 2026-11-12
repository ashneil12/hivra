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
 * they want done; the agent's name sits under it (Ash's wording, 12 Nov 2026).
 */
const FIRST_RUN_JOBS: Partial<Record<AgentId, { job: string; line: string; badge?: string }>> = {
  hermes: { job: "Research and everyday tasks", line: "Research, compare, write, use tools and run repeat jobs.", badge: "Recommended" },
  "claude-code": { job: "Code with Claude", line: "Write, fix, test and work through software projects with Claude." },
  codex: { job: "Code with Codex", line: "Use Codex on a computer dedicated to your coding work." },
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
      <h1 id="first-run-title" className={styles.firstRunTitle}>What do you want your agent to do?</h1>
      <p className={styles.firstRunLead}>Choose a job and Hivra will set up a computer for the agent to run on.</p>
      <ul className={styles.firstRunChoices}>
        {choices.map((agent) => {
          const job = FIRST_RUN_JOBS[agent.id];
          return (
            <li key={agent.id}>
              <Link href={`/dashboard/launch?profile=${agent.id}`} className={styles.firstRunChoice} aria-label={`Launch ${agent.name}`}>
                <span className={styles.firstRunName}>{job?.job ?? agent.name}</span>
                {job ? (
                  <span className={styles.firstRunAgent}>
                    {job.badge ? <span className={styles.firstRunBadge}>{job.badge}</span> : null}
                    {agent.name}
                  </span>
                ) : null}
                <span className={styles.firstRunTagline}>{job?.line ?? agent.tagline}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      {showPlanLine ? (
        <div className={styles.firstRunPlan} data-testid="first-run-plan">
          <h2 className={styles.firstRunWaysTitle}>Choose where your agent&apos;s computer runs</h2>
          <ul className={styles.firstRunWays}>
            <li>
              <Link href="/dashboard/billing">Hivra Cloud · From $9.99/month</Link>
              <span>We run and maintain the computer for you. Nothing to install. Includes supported agents and a 7-day money-back guarantee on card payments.</span>
            </li>
            <li>
              <Link href="/dashboard/infrastructure">Your own server · Free</Link>
              <span>Connect a supported Proxmox VE server you run. Claude Code and Codex can run there. Hermes currently requires Hivra Cloud.</span>
            </li>
          </ul>
        </div>
      ) : null}
      <Link href="/dashboard/launch" className={styles.firstRunMore}>Browse every agent and computer</Link>
    </section>
  );
}
