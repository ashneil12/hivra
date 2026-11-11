"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AGENTS, type AgentId } from "@/lib/hivra/agent-catalog";
import { fetchPlanStrict, isFreePlanInfo, type PlanInfo } from "@/lib/hivra/agent-api";
import styles from "./HomeWorkspace.module.css";

/** The three agents a new person is offered. The rest are one link away. */
const FIRST_RUN_AGENTS: readonly AgentId[] = ["hermes", "claude-code", "codex"];

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
      <p className={styles.firstRunLead}>Pick one and you&apos;ll be chatting in a couple of minutes.</p>
      <ul className={styles.firstRunChoices}>
        {choices.map((agent) => (
          <li key={agent.id}>
            <Link href={`/dashboard/launch?profile=${agent.id}`} className={styles.firstRunChoice}>
              <span className={styles.firstRunName}>{agent.name}</span>
              <span className={styles.firstRunTagline}>{agent.tagline}</span>
            </Link>
          </li>
        ))}
      </ul>
      {showPlanLine ? (
        <p className={styles.firstRunPlan} data-testid="first-run-plan">
          Hivra Cloud is part of a paid plan, from $9.99 a month. On Free you can run agents on a computer you connect.{" "}
          <Link href="/dashboard/billing">See plans</Link>
        </p>
      ) : null}
      <Link href="/dashboard/launch" className={styles.firstRunMore}>Browse every agent and computer</Link>
    </section>
  );
}
