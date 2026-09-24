"use client";

// Manage → Computer: the agent and its computer as one linked pair, and what
// Hivra has told the agent about that computer (the Computer Contract).
//
// Observed state only. A revision reads "Delivered" only after the computer
// read back the exact bytes; before that it is "Update pending". A DigitalOcean
// note is only ever "Sent in chat". Every change of what the agent is told is
// the owner's own button, and a DigitalOcean send says it costs a little usage.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bot, Link2, Loader2, RefreshCw, RotateCcw, Send } from "lucide-react";

import { agentComputerPairLabel } from "@/lib/agent-computers/agent-surfaces";
import type { ComputerContractStatus } from "@/lib/agent-computers/computer-contract-status";
import { fetchComputerContract, runComputerContractAction, type ComputerContractAction } from "@/lib/hivra/computer-contract-client";

import styles from "./ComputerContractPanel.module.css";

export interface ComputerContractPanelAgent {
  id: string;
  name: string;
  status: string;
  deployment_mode?: string | null;
  computer_substrate?: string | null;
  cpu?: number | null;
  ram?: number | null;
}

/** "12:04" today, "Sep 23, 12:04" before. */
export function formatContractTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "unknown time";
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

const ERROR_COPY: Record<string, string> = {
  unreachable: "Hivra couldn't reach the computer.",
  unsafe_file: "The instructions file on the computer isn't a plain file Hivra can safely update.",
  no_instruction_file: "The computer has no instructions file for Hivra to update.",
  readback_mismatch: "The computer's copy didn't match after writing, so Hivra didn't count it.",
  unrecognized_output: "The computer gave an answer Hivra couldn't read.",
  send_failed: "DigitalOcean didn't accept the setup note.",
};

function StateTag({ state, children }: { state: string; children: React.ReactNode }) {
  return <span className={styles.state} data-state={state}>{children}</span>;
}

export function ComputerContractPanel({ agent, runtimeName }: { agent: ComputerContractPanelAgent; runtimeName: string }) {
  const [status, setStatus] = useState<ComputerContractStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acting, setActing] = useState<ComputerContractAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const [reload, setReload] = useState(0);
  const running = agent.status === "running";

  useEffect(() => {
    const controller = new AbortController();
    fetchComputerContract(agent.id, controller.signal)
      .then((next) => { setStatus(next); setLoadError(null); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Couldn't load this.");
      });
    return () => controller.abort();
  }, [agent.id, agent.name, agent.status, agent.cpu, agent.ram, reload]);

  const act = useCallback(async (action: ComputerContractAction) => {
    setActing(action);
    setActionError(null);
    try {
      setStatus(await runComputerContractAction(agent.id, action));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "That didn't go through. Nothing changed.");
    } finally {
      setActing(null);
    }
  }, [agent.id]);

  const button = (action: ComputerContractAction, label: string, icon: React.ReactNode, primary = false) => (
    <button type="button" className={primary ? styles.primary : styles.button} disabled={acting !== null} onClick={() => void act(action)}>
      {acting === action ? <Loader2 size={13} className={styles.spinner} aria-hidden /> : icon}{label}
    </button>
  );
  const title = `What ${agent.name} knows about its computer`;

  let meta: React.ReactNode = null;
  let body: React.ReactNode = null;
  let actions: React.ReactNode = null;
  let text: string | null = null;
  let details: React.ReactNode = null;

  if (loadError && !status) {
    meta = <StateTag state="unavailable">Couldn&apos;t check</StateTag>;
    body = <p className={styles.body}>{loadError} Hivra doesn&apos;t claim anything until this loads.</p>;
    actions = <button type="button" className={styles.button} onClick={() => setReload((value) => value + 1)}><RefreshCw size={13} aria-hidden />Check again</button>;
  } else if (!status) {
    meta = <span className={styles.meta}><Loader2 size={12} className={styles.spinner} aria-hidden />Checking…</span>;
  } else if (status.kind === "not_applicable") {
    body = <p className={styles.body}>{runtimeName} uses its own instructions. Hivra doesn&apos;t add notes about its computer to them yet.</p>;
  } else if (status.kind === "unavailable") {
    meta = <StateTag state="unavailable">Couldn&apos;t check</StateTag>;
    body = <p className={styles.body}>Hivra couldn&apos;t load what it told {agent.name}. Nothing is shown as delivered until it can.</p>;
    actions = <button type="button" className={styles.button} onClick={() => setReload((value) => value + 1)}><RefreshCw size={13} aria-hidden />Check again</button>;
  } else if (status.kind === "not_deliverable") {
    meta = <StateTag state="pending">Not delivered</StateTag>;
    body = <p className={styles.body}>Hivra can&apos;t send notes to computers in your own cloud yet. You can read what it would say, and paste it into a chat yourself.</p>;
    text = status.preview;
  } else if (status.kind === "not_started") {
    if (status.channel === "do-setup-message") {
      meta = <StateTag state="pending">Not sent yet</StateTag>;
      body = <p className={styles.body}>{agent.name} hasn&apos;t had Hivra&apos;s setup note: where it runs, its /workspace and how you see its work. Sending it adds one visible message to the chat and uses a little of your DigitalOcean and model usage.</p>;
      actions = running || agent.status === "stopped" ? button("send", "Send setup note", <Send size={13} aria-hidden />, true) : null;
    } else {
      meta = <StateTag state="pending">Update pending</StateTag>;
      body = <p className={styles.body}>Hivra sends it once the computer is running.</p>;
    }
  } else {
    const digitalOcean = status.channel === "do-setup-message";
    const revision = `rev ${status.revision}`;
    text = status.content;
    const previous = status.lastDelivered
      ? <p className={styles.body}>{digitalOcean ? "Last sent" : "Last delivered"}: rev {status.lastDelivered.revision} at {formatContractTime(status.lastDelivered.deliveredAt)}.</p>
      : null;
    const failure = status.lastError && ERROR_COPY[status.lastError] && status.lastAttemptAt
      ? <p className={styles.body}>{ERROR_COPY[status.lastError]} Last try {formatContractTime(status.lastAttemptAt)}.</p>
      : null;
    if (status.state === "delivered" && status.deliveredAt) {
      meta = <><span>{revision}</span><span aria-hidden>·</span><StateTag state="delivered">Delivered {formatContractTime(status.deliveredAt)}</StateTag></>;
      body = <>
        <p className={styles.body}>The computer confirmed this text is in the instructions {agent.name} reads. It applies to new chats.</p>
        {status.checkedAt && status.checkedAt !== status.deliveredAt ? <p className={styles.body}>Checked again {formatContractTime(status.checkedAt)}.</p> : null}
      </>;
      actions = running ? button("check", "Check again", <RefreshCw size={13} aria-hidden />) : null;
      details = <p>Reported by software on this computer. {agent.name} runs there with administrator access, so Hivra can&apos;t check it independently. Changes made on the computer show up when you check again.</p>;
    } else if (status.state === "sent" && status.deliveredAt) {
      meta = <><span>{revision}</span><span aria-hidden>·</span><StateTag state="sent">Sent in chat {formatContractTime(status.deliveredAt)}</StateTag></>;
      body = <p className={styles.body}>Sent as a visible Hivra setup message. DigitalOcean accepted it; that doesn&apos;t prove {agent.name} read it.</p>;
    } else if (status.state === "conflict") {
      meta = <><span>{revision}</span><span aria-hidden>·</span><StateTag state="conflict">Changed on the computer</StateTag></>;
      body = <>
        <p className={styles.body}>Hivra&apos;s section in {agent.name}&apos;s instructions was changed on the computer, so Hivra didn&apos;t overwrite it. Restore puts back revision {status.revision}.</p>
        {status.deliveredAt ? <p className={styles.body}>Revision {status.revision} was delivered {formatContractTime(status.deliveredAt)}.</p> : previous}
      </>;
      actions = running ? <>{button("restore", "Restore", <RotateCcw size={13} aria-hidden />, true)}{button("check", "Check again", <RefreshCw size={13} aria-hidden />)}</> : null;
    } else if (digitalOcean) {
      meta = <><span>{revision}</span><span aria-hidden>·</span><StateTag state="pending">{status.lastDelivered ? "Update not sent" : "Not sent yet"}</StateTag></>;
      body = <>
        <p className={styles.body}>{status.lastDelivered
          ? `What Hivra would tell ${agent.name} changed after the last setup note.`
          : `${agent.name} hasn't had Hivra's setup note yet.`} Sending it adds one visible message to the chat and uses a little of your DigitalOcean and model usage.</p>
        {failure}{previous}
      </>;
      actions = button("send", status.lastDelivered ? `Send update to ${agent.name}` : "Send setup note", <Send size={13} aria-hidden />, true);
    } else {
      meta = <><span>{revision}</span><span aria-hidden>·</span><StateTag state="pending">Update pending</StateTag></>;
      body = <>
        <p className={styles.body}>{running
          ? `Hivra sends revision ${status.revision} the next time it reaches the computer.`
          : `Hivra sends revision ${status.revision} once the computer is running.`}</p>
        {failure}{previous}
      </>;
      actions = running && status.lastError ? button("deliver", "Try again", <RefreshCw size={13} aria-hidden />) : null;
    }
  }

  return (
    <section className={styles.section} aria-labelledby={`computer-${agent.id}`}>
      <h3 id={`computer-${agent.id}`} className={styles.heading}>Computer</h3>
      <div className={styles.panel}>
        <p className={styles.pair}>
          <Link2 size={14} aria-hidden />
          <span><strong>{agent.name}</strong> runs {agentComputerPairLabel(agent)}.</span>
        </p>
        <hr className={styles.divider} />
        <div>
          <h4 className={styles.title}>{title}</h4>
          {meta ? <div className={styles.meta}>{meta}</div> : null}
        </div>
        {body}
        {actionError ? <p className={styles.error} role="alert"><AlertTriangle size={12} aria-hidden /> {actionError}</p> : null}
        {actions || text ? <div className={styles.actions}>
          {actions}
          {text ? <button type="button" className={styles.button} aria-expanded={showText} onClick={() => setShowText((value) => !value)}>
            {showText ? "Hide text" : "Show text"}
          </button> : null}
        </div> : null}
        {text && showText ? <pre className={styles.text} aria-label={`Text Hivra gives ${agent.name}`}>{text}</pre> : null}
        {details ? <details className={styles.details}><summary>Who confirmed this</summary>{details}</details> : null}
      </div>
    </section>
  );
}

/**
 * A computer without an agent: an honest Agent slot. Adding an agent to a
 * computer you already have (attach) is not available yet, so the only offer
 * is to launch an agent, which gets its own computer.
 */
export function ComputerAgentSlot() {
  return (
    <section className={styles.section} aria-labelledby="computer-agent-slot">
      <h3 id="computer-agent-slot" className={styles.heading}>Agent</h3>
      <div className={styles.panel}>
        <p className={styles.pair}>
          <Bot size={14} aria-hidden />
          <span><strong>No agent works on this computer.</strong> Adding an agent to a computer you already have isn&apos;t available yet. Launch an agent and it gets its own computer.</span>
        </p>
        <div className={styles.actions}>
          <Link className={styles.button} href="/dashboard/launch?kind=agent&start=1"><Bot size={13} aria-hidden />Launch an agent</Link>
        </div>
      </div>
    </section>
  );
}
