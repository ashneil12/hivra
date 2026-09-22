"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowRight, Bot, Monitor } from "lucide-react";
import styles from "./launch-section.module.css";

type Mode = "agents" | "computers";
const MODES: Mode[] = ["agents", "computers"];
function modeForHash(hash: string): Mode | null {
  return hash === "#agents" ? "agents" : hash === "#computers" ? "computers" : null;
}

export default function LaunchSection({ agents, computers }: { agents: ReactNode; computers: ReactNode }) {
  const [mode, setMode] = useState<Mode>("agents");
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const syncHash = () => {
      const next = modeForHash(window.location.hash);
      if (next) setMode(next);
      else if (!window.location.hash) setMode("agents");
    };
    // Next links can push a hash without emitting hashchange. Select the panel
    // before its normal anchor scroll, including clicks in the header/footer.
    const syncLink = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      if (!link || link.target === "_blank") return;
      const url = new URL(link.href, window.location.href);
      if (url.origin === window.location.origin && url.pathname === window.location.pathname) {
        const next = modeForHash(url.hash);
        if (next) setMode(next);
      }
    };
    const frame = requestAnimationFrame(syncHash);
    window.addEventListener("hashchange", syncHash);
    window.addEventListener("popstate", syncHash);
    document.addEventListener("click", syncLink, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", syncHash);
      window.removeEventListener("popstate", syncHash);
      document.removeEventListener("click", syncLink, true);
    };
  }, []);

  function select(next: Mode) {
    setMode(next);
    if (window.location.hash !== `#${next}`) window.history.pushState(null, "", `#${next}`);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") next = 1 - index;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 1;
    else return;
    event.preventDefault();
    select(MODES[next]);
    tabs.current[next]?.focus();
  }

  return <section id="launch" className={styles.section} aria-labelledby="launch-heading">
    <span id="agents" className={styles.anchor} aria-hidden="true" />
    <span id="computers" className={styles.anchor} aria-hidden="true" />
    <header className={styles.heading}>
      <h2 id="launch-heading">Start with an agent.<br /><em>Or a computer.</em></h2>
      <p>Give an agent room to work, or open a computer and make it yours.</p>
    </header>
    <div role="tablist" aria-label="Choose your starting point" className={styles.tabs}>
      {MODES.map((item, index) => {
        const Icon = item === "agents" ? Bot : Monitor;
        return <button key={item} ref={node => { tabs.current[index] = node; }} type="button" role="tab"
          id={`launch-${item}-tab`} aria-controls={`launch-${item}-panel`} aria-selected={mode === item}
          tabIndex={mode === item ? 0 : -1} onClick={() => select(item)} onKeyDown={event => onKeyDown(event, index)}>
          <Icon size={27} strokeWidth={1.5} aria-hidden="true" />
          <span>{item === "agents" ? "Start with an agent" : "Start with a computer"}<small>{item === "agents" ? "Choose who does the work" : "Use the workspace yourself"}</small></span>
          <ArrowRight className={styles.arrow} size={22} aria-hidden="true" />
        </button>;
      })}
    </div>
    <div role="tabpanel" id="launch-agents-panel" aria-labelledby="launch-agents-tab" hidden={mode !== "agents"} className={styles.panel}>{agents}</div>
    <div role="tabpanel" id="launch-computers-panel" aria-labelledby="launch-computers-tab" hidden={mode !== "computers"} className={styles.panel}>{computers}</div>
  </section>;
}
