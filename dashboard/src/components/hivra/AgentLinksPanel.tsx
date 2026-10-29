"use client";

// Manage: which of the owner's agents may use which of the owner's computers,
// from either end. On an agent's page it lists that agent's computers and says
// whether the agent has been told about them; on a computer's page it lists
// the agents that may use it. Links are many to many and take effect at the
// agent's next command; nothing is installed on the computer itself.

import { useCallback, useEffect, useState } from "react";
import { Bot, Link2, Loader2, Monitor, RefreshCw, Trash2 } from "lucide-react";

import { addLink, fetchLinks, removeLink, resendKit, type KitState, type LinksLoad, type LinksViewData } from "@/lib/agent-links/client";
import { formatContractTime } from "@/components/hivra/ComputerContractPanel";

import styles from "./ComputerAgentsPanel.module.css";

/** While the agent is being told about its computers, read again this often. */
export const LINKS_POLL_MS = 5_000;

const KIT_LINE: Record<KitState, string> = {
  delivered: "The agent knows about these computers. It uses them with the hivra-computers command.",
  pending: "Telling the agent about its computers…",
  failed: "The agent hasn't been told about its computers yet.",
  waiting_for_agent: "The agent will be told about its computers when it's running.",
  not_needed: "",
  not_supported: "",
};

type Candidate = LinksViewData["candidates"][number];

const STATUS_WORD: Record<string, string> = { running: "running", stopped: "stopped", provisioning: "starting", error: "needs attention" };

/** Two choices with one name also show whether each is running and the start of its id. */
export function optionLabel(candidate: Candidate, choices: Candidate[]): string {
  const shared = choices.filter((choice) => choice.name === candidate.name).length > 1;
  if (!shared) return `${candidate.name} (${candidate.kind})`;
  const status = candidate.status ? STATUS_WORD[candidate.status] ?? candidate.status : null;
  return `${candidate.name} (${[candidate.kind, status, candidate.id.slice(0, 8)].filter(Boolean).join(", ")})`;
}

export function AgentLinksPanel({ subjectId, subjectName }: { subjectId: string; subjectName: string }) {
  const [load, setLoad] = useState<LinksLoad | { state: "loading" }>({ state: "loading" });
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => { setLoad(await fetchLinks(subjectId)); }, [subjectId]);

  useEffect(() => {
    let alive = true;
    void fetchLinks(subjectId).then((result) => { if (alive) setLoad(result); });
    return () => { alive = false; };
  }, [subjectId]);

  const view = load.state === "ready" ? load.view : null;
  const kitPending = view?.kit?.state === "pending";
  // One read at a time, and none while the tab is hidden.
  useEffect(() => {
    if (!kitPending) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        if (!document.hidden) await refresh();
      } finally {
        if (alive) timer = window.setTimeout(tick, LINKS_POLL_MS);
      }
    };
    timer = window.setTimeout(tick, LINKS_POLL_MS);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [kitPending, refresh]);

  if (load.state === "not_offered") return null;
  if (load.state === "loading") {
    return <section className={styles.section} aria-busy="true"><p className={styles.note}><Loader2 size={13} className={styles.spinner} aria-hidden /> Loading links…</p></section>;
  }
  if (load.state === "unavailable") {
    return <section className={styles.section}><p className={styles.note} role="status">{load.message}</p>
      <div className={styles.actions}><button type="button" className={styles.button} onClick={() => void refresh()}><RefreshCw size={13} aria-hidden /> Try again</button></div></section>;
  }

  const { subject, links, candidates, kit } = load.view;
  const onAgent = subject.kind === "agent";
  const heading = onAgent ? "Computers this agent can use" : "Agents that can use this computer";
  const open = candidates.filter((candidate) => candidate.available && !candidate.linked);
  const closed = candidates.filter((candidate) => !candidate.available);
  const selected = open.some((candidate) => candidate.id === choice) ? choice : open[0]?.id ?? "";

  async function run(action: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    setBusy(true); setError(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) setError(result.message);
    await refresh();
  }
  const link = (otherId: string) => run(() => addLink(onAgent ? { agentId: subject.id, computerId: otherId, from: "agent" }
    : { agentId: otherId, computerId: subject.id, from: "computer" }));
  const linkAll = () => run(() => addLink(onAgent ? { agentId: subject.id, all: true, from: "agent" } : { computerId: subject.id, all: true, from: "computer" }));

  return <section className={styles.section} aria-labelledby={`links-${subjectId}`}>
    <h3 id={`links-${subjectId}`} className={styles.heading}>{heading}</h3>
    <div className={styles.panel}>
      {!subject.available ? <p className={styles.body}>{subject.reason}</p> : <>
        <p className={styles.body}>{onAgent
          ? `${subjectName || "This agent"} can run commands, copy files and take screenshots on the computers you link here, as each computer's own user. Remove a link and it loses that computer at once.`
          : `The agents you link here can run commands, copy files and take screenshots on ${subjectName || "this computer"}, as its own user. Remove a link and that agent loses it at once.`}</p>

        {links.length > 0 ? <ul className={styles.rows}>
          {links.map((item) => <li key={item.id} className={styles.row}>
            <div className={styles.rowHead}>
              <span className={styles.agentRow}>
                {onAgent ? <Monitor size={16} aria-hidden /> : <Bot size={16} aria-hidden />}
                <span><strong>{onAgent ? item.computerName : item.agentName}</strong>
                  <span className={styles.note}>{onAgent ? ` · ${item.computerKind}` : ""}{item.lastUsedAt
                    ? ` · last used ${formatContractTime(item.lastUsedAt)}` : " · not used yet"}</span></span>
              </span>
              <button type="button" className={styles.button} disabled={busy} aria-label={`Remove ${onAgent ? item.computerName : item.agentName}`}
                onClick={() => void run(() => removeLink(item.id))}><Trash2 size={13} aria-hidden /> Remove</button>
            </div>
          </li>)}
        </ul> : <p className={styles.note}>{onAgent ? "No computers linked yet." : "No agents linked yet."}</p>}

        {open.length > 0 ? <div className={styles.actions}>
          <select value={selected} disabled={busy} onChange={(event) => setChoice(event.target.value)}
            aria-label={onAgent ? "Computer to link" : "Agent to link"} className={styles.button}>
            {open.map((candidate) => <option key={candidate.id} value={candidate.id}>{optionLabel(candidate, open)}</option>)}
          </select>
          <button type="button" className={styles.primary} disabled={busy || !selected} onClick={() => void link(selected)}>
            {busy ? <Loader2 size={13} className={styles.spinner} aria-hidden /> : <Link2 size={13} aria-hidden />} Link</button>
          {open.length > 1 ? <button type="button" className={styles.button} disabled={busy} onClick={() => void linkAll()}>
            {onAgent ? "Link all my computers" : "Link all my agents"}</button> : null}
        </div> : links.length === 0 ? <p className={styles.note}>{onAgent
          ? "You have no computers agents can use yet. Launch an Ubuntu desktop, Omarchy desktop or Linux sandbox."
          : "You have no agents that can use computers yet."}</p> : null}

        {onAgent && kit && KIT_LINE[kit.state] ? <div className={styles.contract}>
          <p className={styles.meta}><span className={styles.state} data-state={kit.state === "delivered" ? "delivered" : "pending"}>{KIT_LINE[kit.state]}</span></p>
          {kit.message && kit.state !== "delivered" ? <p className={styles.note}>{kit.message}</p> : null}
          {kit.state === "failed" || kit.state === "delivered" ? <div className={styles.actions}>
            <button type="button" className={styles.button} disabled={busy} onClick={() => void run(() => resendKit(subject.id))}>
              <RefreshCw size={13} aria-hidden /> {kit.state === "failed" ? "Send now" : "Send again"}</button>
          </div> : null}
        </div> : null}

        {closed.length > 0 ? <details className={styles.details}>
          <summary>{onAgent ? "Computers agents can't use yet" : "Agents that can't use computers yet"} ({closed.length})</summary>
          {closed.map((candidate) => <p key={candidate.id}><strong>{candidate.name}</strong>: {candidate.reason}</p>)}
        </details> : null}
      </>}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </div>
  </section>;
}
