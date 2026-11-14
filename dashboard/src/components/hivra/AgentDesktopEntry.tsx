"use client";

// The Desktop entry on an agent's page. An agent runs on its own cloud
// computer and has no screen of its own; this says so in one sentence and
// routes to the two flows that already exist: connect a desktop computer the
// owner already has (agent links, see AgentLinksPanel), or launch a new Ubuntu
// Desktop. Nothing here talks to a new backend.

import { useCallback, useEffect, useState } from "react";
import { Monitor } from "lucide-react";

import { ThinkingOrb } from "@/components/ui/ThinkingOrb";
import { addLink, fetchLinks, type LinksLoad, type LinksViewData } from "@/lib/agent-links/client";

import styles from "./AgentDesktopEntry.module.css";

type Candidate = LinksViewData["candidates"][number];
type LinkedDesktop = LinksViewData["links"][number];

const isDesktopKind = (kind: string) => /desktop/i.test(kind);

export function AgentDesktopEntry({ agentId, agentName, onLaunch, onOpenComputer, onManage }: {
  agentId: string;
  agentName: string;
  /** Opens Launch with an Ubuntu Desktop selected. */
  onLaunch: () => void;
  /** Opens one of the owner's computers on its desktop. */
  onOpenComputer: (computerId: string) => void;
  onManage: () => void;
}) {
  const [load, setLoad] = useState<LinksLoad | { state: "loading" }>({ state: "loading" });
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const name = agentName || "this agent";

  const refresh = useCallback(async () => { setLoad(await fetchLinks(agentId)); }, [agentId]);
  useEffect(() => {
    let alive = true;
    void fetchLinks(agentId).then((result) => { if (alive) setLoad(result); });
    return () => { alive = false; };
  }, [agentId]);

  const view = load.state === "ready" ? load.view : null;
  const linkable = Boolean(view?.subject.available);
  const linked: LinkedDesktop[] = view ? view.links.filter((item) => isDesktopKind(item.computerKind)) : [];
  const open: Candidate[] = view && linkable ? view.candidates.filter((c) => c.available && !c.linked && isDesktopKind(c.kind)) : [];
  const blocked: Candidate[] = view && linkable ? view.candidates.filter((c) => !c.available && !c.linked && isDesktopKind(c.kind)) : [];
  const selected = open.some((candidate) => candidate.id === choice) ? choice : open[0]?.id ?? "";

  async function connect() {
    if (!selected || busy) return;
    const picked = open.find((candidate) => candidate.id === selected);
    setBusy(true);
    setError(null);
    setConnected(null);
    const result = await addLink({ agentId, computerId: selected, from: "agent" });
    setBusy(false);
    if (result.ok) setConnected(picked?.name ?? "the desktop");
    else setError(result.message);
    await refresh();
  }

  const intro = `A desktop lets ${name} use apps on a real screen that you can watch. Connect a desktop computer you already have, or launch a new Ubuntu Desktop.`;
  const launchLabel = "Launch a new Ubuntu Desktop";

  let body: React.ReactNode;
  if (load.state === "loading") {
    body = <p className={styles.status} role="status">
      <span aria-hidden="true"><ThinkingOrb size={20} state="searching" /></span>
      Checking your desktop computers…
    </p>;
  } else if (load.state === "not_offered") {
    body = <>
      <p className={styles.note}>Connecting a desktop to an agent isn’t available here yet. You can still launch an Ubuntu Desktop of your own and open it from your computers.</p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={onLaunch}>{launchLabel}</button>
      </div>
    </>;
  } else if (load.state === "unavailable") {
    body = <>
      <p className={styles.note} role="status">{load.message}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => { setLoad({ state: "loading" }); void refresh(); }}>Try again</button>
        <button type="button" className={styles.secondary} onClick={onLaunch}>{launchLabel}</button>
      </div>
    </>;
  } else if (!linkable) {
    body = <>
      <p className={styles.note}>{load.view.subject.reason || `${name} can’t be connected to a desktop yet.`} You can still launch an Ubuntu Desktop of your own.</p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={onLaunch}>{launchLabel}</button>
      </div>
    </>;
  } else {
    body = <>
      {linked.length > 0 ? <ul className={styles.rows} aria-label={`Desktops ${name} can use`}>
        {linked.map((item) => <li key={item.id} className={styles.row}>
          <span><strong>{item.computerName}</strong><span className={styles.muted}> · {item.computerKind}</span></span>
          <button type="button" className={styles.secondary} onClick={() => onOpenComputer(item.computerId)}
            aria-label={`Open ${item.computerName}`}>Open desktop</button>
        </li>)}
      </ul> : null}
      {connected ? <p className={styles.note} role="status">Connected to {connected}. {name} can use it from its next command. Remove it any time in{" "}
        <button type="button" className={styles.inline} onClick={onManage}>Manage</button>.</p> : null}
      {open.length > 0 ? <div className={styles.actions}>
        {open.length > 1 ? <select value={selected} disabled={busy} onChange={(event) => setChoice(event.target.value)}
          aria-label="Desktop to connect" className={styles.select}>
          {open.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} ({candidate.kind})</option>)}
        </select> : null}
        <button type="button" className={styles.primary} disabled={busy} aria-busy={busy || undefined} onClick={() => void connect()}>
          {busy ? "Connecting…" : open.length === 1 ? `Connect ${open[0].name}` : "Connect desktop"}
        </button>
        <button type="button" className={styles.secondary} onClick={onLaunch}>{launchLabel}</button>
      </div> : <div className={styles.actions}>
        <button type="button" className={linked.length > 0 ? styles.secondary : styles.primary} onClick={onLaunch}>
          {linked.length > 0 ? "Launch another Ubuntu Desktop" : launchLabel}
        </button>
      </div>}
      {open.length === 0 && linked.length === 0 && blocked.length === 0
        ? <p className={styles.note}>You don’t have a desktop computer to connect yet.</p> : null}
      {open.length === 0 && blocked.length > 0 ? <ul className={styles.blocked}>
        {blocked.map((candidate) => <li key={candidate.id}><strong>{candidate.name}</strong> can’t be connected yet: {candidate.reason || "it isn’t ready."}</li>)}
      </ul> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </>;
  }

  return <section className={styles.panel} aria-labelledby={`desktop-entry-${agentId}`}>
    <Monitor size={22} aria-hidden="true" className={styles.icon} />
    <h3 id={`desktop-entry-${agentId}`} className={styles.title}>Give {name} a desktop</h3>
    <p className={styles.intro}>{intro}</p>
    {body}
  </section>;
}
