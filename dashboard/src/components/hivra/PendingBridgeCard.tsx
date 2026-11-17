"use client";

// A small, calm card: "Waiting for your OK". It shows the commands your agents
// asked to run on your own computer, wherever you are in the dashboard (the home
// page and every agent page), so a request never waits unseen. It reads the same
// list as the Manage panel and answers with the same buttons. It renders nothing
// when nothing is waiting, and nothing at all where the bridge isn't offered
// (the server answers 404 while HIVRA_LOCAL_BRIDGE_ENABLED is off, and then it
// stops asking). It reads again every few seconds only while the tab is visible.

import { useCallback, useEffect, useRef, useState } from "react";

import styles from "./ComputerAgentsPanel.module.css";
import { BRIDGE_CHANGED_EVENT, BRIDGE_POLL_MS, PendingRequests, load, post, type BridgeView } from "./LocalBridgePanel";

export function PendingBridgeCard() {
  const [view, setView] = useState<BridgeView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offered = useRef(true);

  const refresh = useCallback(async () => {
    if (!offered.current) return;
    const result = await load();
    if (result.state === "not_offered") { offered.current = false; setView(null); return; }
    // A hiccup keeps what is on screen; the next read tries again.
    if (result.state === "ready") setView(result.view);
  }, []);

  useEffect(() => {
    // The first read, and then one every few seconds while the tab is visible.
    const first = window.setTimeout(() => { void refresh(); }, 0);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, BRIDGE_POLL_MS);
    const again = () => { void refresh(); };
    const visible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener(BRIDGE_CHANGED_EVENT, again);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener(BRIDGE_CHANGED_EVENT, again);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  const pending = view?.requests.filter((request) => request.status === "pending") ?? [];
  if (!view || pending.length === 0) return null;

  async function decide(requestId: string, decision: "approve" | "deny" | "allow_hour") {
    setBusy(true); setError(null);
    const result = await post({ action: "decide", requestId, decision });
    setBusy(false);
    if (!result.ok) setError(result.message);
    await refresh();
    window.dispatchEvent(new Event(BRIDGE_CHANGED_EVENT));
  }

  return <section className={styles.section} aria-labelledby="pending-bridge-heading" data-testid="pending-bridge-card"
    style={{ margin: "12px 16px 0", flex: "none" }}>
    <div className={styles.panel}>
      <h3 id="pending-bridge-heading" className={styles.heading} style={{ margin: 0 }}>Waiting for your OK</h3>
      {error ? <p className={styles.note} role="alert">{error}</p> : null}
      <PendingRequests requests={pending} agents={view.agents} computers={view.computers} busy={busy} onDecide={(id, decision) => void decide(id, decision)} />
    </div>
  </section>;
}
