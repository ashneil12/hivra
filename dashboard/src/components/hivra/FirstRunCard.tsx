"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AGENTS, type AgentId } from "@/lib/hivra/agent-catalog";
import { fetchPlanStrict, isFreePlanInfo, type PlanInfo } from "@/lib/hivra/agent-api";
import styles from "./HomeWorkspace.module.css";

/** The three agents a new person is offered. The rest are one link away. */
const FIRST_RUN_AGENTS: readonly AgentId[] = ["hermes", "claude-code", "codex"];

/**
 * What each first-run choice does, in Ash's words (12 Nov 2026), used word for
 * word: the job first, the agent's name under it.
 */
const FIRST_RUN_JOBS: Partial<Record<AgentId, { job: string; agent: string; line: string; badge?: string }>> = {
  hermes: { job: "Research and automation", agent: "Hermes Agent", badge: "Recommended", line: "Research, browse, write, use tools and automate recurring work." },
  "claude-code": { job: "Build and code with Claude", agent: "Claude Code", line: "Build software, fix bugs, run tests and work on coding projects." },
  codex: { job: "Build and code with Codex", agent: "OpenAI Codex", line: "Write, review and test code in a dedicated computer environment." },
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
  // Only a known Free plan is asked where its agent runs, and never an account whose paid plan is on hold.
  const showPlanLine = isFreePlanInfo(plan) && !plan?.onHold;

  return (
    <section className={styles.firstRun} aria-labelledby="first-run-title">
      <h1 id="first-run-title" className={styles.firstRunTitle}>What would you like to work on?</h1>
      <p className={styles.firstRunLead}>Choose an agent and we&apos;ll help you get it running on a computer of its own.</p>
      <ul className={styles.firstRunChoices}>
        {choices.map((agent) => {
          const job = FIRST_RUN_JOBS[agent.id];
          return (
            <li key={agent.id}>
              <Link href={`/dashboard/launch?profile=${agent.id}`} className={styles.firstRunChoice} aria-label={`Launch ${agent.name}`}>
                <span className={styles.firstRunName}>{job?.job ?? agent.name}</span>
                {job ? (
                  <span className={styles.firstRunAgent}>
                    {job.agent}
                    {job.badge ? <span className={styles.firstRunBadge}>{job.badge}</span> : null}
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
          <h2 className={styles.firstRunWaysTitle}>Choose where your agent runs</h2>
          <p className={styles.firstRunWaysLead}>Every agent needs a computer. Choose how you&apos;d like to run yours.</p>
          <ul className={styles.firstRunWays}>
            <li>
              <strong>Hivra Cloud</strong>
              <em>From $9.99/month</em>
              <span>We provide and maintain the computer for you. There&apos;s no server to set up, and you can access your agent from your browser.</span>
              <span>Includes supported managed agents.</span>
              <span>7-day money-back guarantee on card payments.</span>
              <Link href="/dashboard/billing">Use Hivra Cloud</Link>
            </li>
            <li>
              <strong>Your own server</strong>
              <em>No Hivra hosting charge</em>
              <span>Connect a supported Proxmox VE server you control and use it to run compatible agents.</span>
              <span>Claude Code and Codex are supported on eligible owner-managed infrastructure. Hermes currently requires Hivra Cloud.</span>
              <span>You provide the server and cover its running costs.</span>
              <Link href="/dashboard/infrastructure">Connect my server</Link>
            </li>
          </ul>
        </div>
      ) : null}
      <Link href="/dashboard/launch" className={styles.firstRunMore}>Browse every agent and computer</Link>
    </section>
  );
}
