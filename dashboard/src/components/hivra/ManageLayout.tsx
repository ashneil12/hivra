"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Activity, Cpu, KeyRound, Settings2, ShieldCheck, Wrench } from "lucide-react";
import styles from "./ManageLayout.module.css";

export type ManageFeedback = { kind: "status" | "alert"; message: string } | null;

export type ManageSection = "overview" | "resources" | "access" | "agent" | "recovery" | "advanced";
const titles: Record<ManageSection, string> = { overview: "Overview", resources: "Resources", access: "Access", agent: "Agent settings", recovery: "Recovery", advanced: "Advanced" };
const icons = { overview: Activity, resources: Cpu, access: KeyRound, agent: Wrench, recovery: ShieldCheck, advanced: Settings2 };

export function useManageSection(sections: ManageSection[]) {
  const [selected, setSelected] = useState<ManageSection>("overview");
  const key = sections.join(",");
  useEffect(() => {
    let frame: number | undefined;
    const sync = () => {
      const url = new URL(window.location.href);
      if (url.hash === "#resources#resources") {
        url.hash = "resources";
        window.history.replaceState(window.history.state, "", url);
      }
      const fragment = url.hash.slice(1);
      const owner: Record<string, ManageSection> = { "model-settings": "agent", "private-access": "access" };
      const requested = owner[fragment] || fragment || (url.searchParams.get("tools") === "1" ? "agent" : "overview");
      const valid = key.split(",").includes(requested);
      setSelected(valid ? requested as ManageSection : "overview");
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (valid && fragment) frame = window.requestAnimationFrame(() => {
        const target = document.getElementById(fragment);
        if (target && !target.closest("[hidden]")) target.scrollIntoView?.({ block: "start" });
      });
    };
    sync();
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => { if (frame !== undefined) window.cancelAnimationFrame(frame); window.removeEventListener("hashchange", sync); window.removeEventListener("popstate", sync); };
  }, [key]);
  const select = (section: ManageSection) => {
    const url = new URL(window.location.href);
    url.hash = section;
    window.history.pushState(window.history.state, "", url);
    setSelected(section);
  };
  return { selected, select };
}

export function ManageLayout({ header, sections, selected, onSelect, notice, children }: {
  header: ReactNode; sections: ManageSection[]; selected: ManageSection; onSelect: (section: ManageSection) => void; notice?: ReactNode; children: ReactNode;
}) {
  return <div className={styles.root}>
    <div className={styles.inner}>
      <header className={styles.header}>{header}</header>
      {notice}
      <div className={styles.workspace}>
        <div className={styles.navigation} role="tablist" aria-label="Manage settings">
          {sections.map((section, index) => {
            const Icon = icons[section];
            return <button key={section} id={`manage-tab-${section}`} role="tab" type="button" aria-selected={selected === section}
              aria-controls={`manage-panel-${section}`} tabIndex={selected === section ? 0 : -1}
              onClick={() => onSelect(section)} onKeyDown={event => {
                const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % sections.length
                  : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + sections.length - 1) % sections.length
                    : event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : null;
                if (next === null) return;
                event.preventDefault(); onSelect(sections[next]); document.getElementById(`manage-tab-${sections[next]}`)?.focus();
              }}><Icon size={15} aria-hidden="true" />{titles[section]}</button>;
          })}
        </div>
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  </div>;
}

export function ManagePanel({ section, selected, children }: { section: ManageSection; selected: ManageSection; children: ReactNode }) {
  // Keep mounted: model, access and resize forms must retain unsaved edits.
  return <section id={`manage-panel-${section}`} role="tabpanel" aria-labelledby={`manage-tab-${section}`}
    hidden={selected !== section} tabIndex={0} className={styles.panel}>{children}</section>;
}

export { styles as manageStyles };
