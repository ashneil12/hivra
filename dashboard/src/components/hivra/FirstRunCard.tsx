"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AGENTS } from "@/lib/hivra/agent-catalog";
import { fetchPlanStrict, isFreePlanInfo, type PlanInfo } from "@/lib/hivra/agent-api";
import { FIRST_RUN_AGENTS } from "@/lib/hivra/first-run-agents";
import styles from "./HomeWorkspace.module.css";

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

  // Only a known Free plan is asked where its agent runs, and never an account whose paid plan is on hold.
  const showPlanLine = isFreePlanInfo(plan) && !plan?.onHold;

  return (
    <section className={styles.firstRun} aria-labelledby="first-run-title">
      <h1 id="first-run-title" className={styles.firstRunTitle}>What would you like to work on?</h1>
      <p className={styles.firstRunLead}>Choose an agent and we&apos;ll help you get it running on a computer of its own.</p>
      <ul className={styles.firstRunChoices}>
        {FIRST_RUN_AGENTS.map((starter) => {
          const agent = AGENTS.find(({ id }) => id === starter.id);
          if (!agent) return null;
          return (
            <li key={agent.id}>
              <Link href={`/dashboard/launch?profile=${agent.id}`} className={styles.firstRunChoice} aria-label={`Launch ${agent.name}`} aria-describedby={starter.hosting ? `first-run-${agent.id}-hosting` : undefined}>
                <span className={styles.firstRunName}>{starter.job}</span>
                <span className={styles.firstRunAgent}>
                  {starter.name}
                  {agent.id === "hermes" ? <span className={styles.firstRunBadge}>Recommended</span> : null}
                </span>
                <span className={styles.firstRunTagline}>{starter.description}</span>
                {starter.hosting ? <span id={`first-run-${agent.id}-hosting`} className={styles.firstRunTagline}>{starter.hosting}</span> : null}
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
