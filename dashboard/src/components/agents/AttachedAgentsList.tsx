"use client";

// Agents → the owner's agents that were added to one of their computers, each
// as its own row: "Codex on MY_UBUNTU_DESKTOP", opening that computer's Chat
// tab (design 5.1, 5.8). The rows are the shared agents list's own
// (unifyAttached), the same ones Home and the agent switcher show. Shown only
// where attach is offered, with the entry to put another agent on a computer.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { fetchOwnerAttachedAgents } from "@/lib/agent-computers/attach-client";
import { fleetEntryHref } from "@/lib/hivra/fleet-sections";
import { unifyAttached, unifiedStateLabel, type UnifiedAgent } from "@/lib/hivra/unified-agent";
import { AttachEntryLink } from "@/components/launch/AttachEntryLink";
import styles from "./AttachedAgentsList.module.css";

export function attachedAgentHref(row: { computerId: string; phase: "claimed" | "dispatched" | "attached" }): string {
  return fleetEntryHref(unifyAttached({ id: "", agentName: "", computerName: "", computerStatus: null, ...row }));
}

function rowDetail(agent: UnifiedAgent): string {
  if (agent.attachment?.phase !== "attached") return "Being added · shows each step as it is confirmed";
  return agent.state === "running" ? "Ready · opens the computer's Chat tab" : `${unifiedStateLabel(agent.state)} · runs while its computer runs`;
}

export function AttachedAgentsList() {
  const [rows, setRows] = useState<UnifiedAgent[] | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void fetchOwnerAttachedAgents().then((result) => {
      if (!alive) return;
      if (!result) { setFailed(true); return; }
      setEnabled(result.enabled);
      setRows(result.enabled ? result.agents.map(unifyAttached) : []);
    });
    return () => { alive = false; };
  }, []);
  if (failed) return <p className={styles.note} role="status">Agents added to your computers couldn&apos;t be loaded.</p>;
  if (!enabled) return null;
  return (
    <section className={styles.section} aria-labelledby="attached-agents-heading">
      <h2 id="attached-agents-heading" className={styles.heading}>Added to your computers</h2>
      {rows?.length ? <ul className={styles.list}>
        {rows.map((agent) => (
          <li key={agent.uid}>
            <Link className={styles.row} href={fleetEntryHref(agent)}>
              <span className={styles.dot} data-state={agent.attachment?.phase === "attached" && agent.state === "running" ? "ready" : "working"} aria-hidden />
              <span className={styles.identity}>
                <strong>{agent.name}</strong>
                <small>{rowDetail(agent)}</small>
              </span>
              <ArrowRight size={15} aria-hidden />
            </Link>
          </li>
        ))}
      </ul> : null}
      <AttachEntryLink className={styles.entry} offered />
    </section>
  );
}
