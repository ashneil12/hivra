"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "@/components/ui/NavigationLink";
import { createPortal } from "react-dom";
import { Bot, Monitor, Search, X } from "lucide-react";
import { filterDashboardResources, resourceStatusLabel, type DashboardResource, type DashboardResourceSource } from "./dashboard-resources";
import styles from "./DashboardSidebar.module.css";

export interface DashboardResourceSwitcherProps {
  resources: DashboardResource[];
  loading: boolean;
  errors: Record<DashboardResourceSource, string | null>;
  onSelect: (resource: DashboardResource) => void;
  onClose: () => void;
  onBrowse?: () => void;
  onRefresh: () => void;
}

export function DashboardResourceSwitcher({ resources, loading, errors, onSelect, onClose, onBrowse, onRefresh }: DashboardResourceSwitcherProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const matches = useMemo(() => filterDashboardResources(resources, query), [resources, query]);
  const ordered = [...matches.filter((item) => item.kind === "agent"), ...matches.filter((item) => item.kind === "computer")];
  const active = Math.min(activeIndex, Math.max(0, ordered.length - 1));
  const hasError = Boolean(errors.hermes || errors.hivra);

  useEffect(() => {
    const previous = document.activeElement;
    const current = dialog.current;
    current?.showModal();
    input.current?.focus();
    return () => {
      current?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId]);

  return createPortal(
    <dialog ref={dialog} className={styles.switcher} aria-labelledby={`${listId}-title`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={styles.switcherSearch}>
        <Search size={18} aria-hidden />
        <label className={styles.srOnly} id={`${listId}-title`} htmlFor={`${listId}-input`}>Switch agent or computer</label>
        <input ref={input} id={`${listId}-input`} role="combobox" autoComplete="off" enterKeyHint="go"
          autoCapitalize="none" autoCorrect="off" spellCheck={false} value={query}
          placeholder="Find an agent or computer…" aria-expanded="true" aria-controls={listId}
          aria-autocomplete="list" aria-activedescendant={ordered.length ? `${listId}-${active}` : undefined}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex(ordered.length ? (active + (event.key === "ArrowDown" ? 1 : -1) + ordered.length) % ordered.length : 0);
            }
            if (event.key === "Enter" && ordered[active]) { event.preventDefault(); onSelect(ordered[active]); }
          }} />
        <button type="button" className={styles.iconButton} aria-label="Close switcher" onClick={onClose}><X size={17} /></button>
      </div>
      {hasError && <div className={styles.switcherNotice} role="status">
        {errors.hermes && <p>{errors.hermes}</p>}{errors.hivra && <p>{errors.hivra}</p>}
        {resources.some((item) => errors[item.source]) && <p>Some results show their last known status.</p>}
        <button type="button" onClick={onRefresh} disabled={loading}>Retry loading resources</button>
      </div>}
      <div id={listId} role="listbox" aria-label="Agents and computers" className={styles.switcherResults} aria-busy={loading}>
        {(["agent", "computer"] as const).map((kind) => {
          const group = ordered.filter((item) => item.kind === kind);
          if (!group.length) return null;
          return <div role="group" aria-label={kind === "agent" ? "Agents" : "Computers"} key={kind}>
            <h2 className={styles.groupHeading}>{kind === "agent" ? "Agents" : "Computers"}</h2>
            {group.map((item) => {
              const index = ordered.indexOf(item);
              const Icon = item.kind === "agent" ? Bot : Monitor;
              const duplicate = resources.some((other) => other.uid !== item.uid && other.name === item.name);
              const detail = duplicate ? `${item.description} · ${item.source} · ${item.id.slice(-8)}` : `${item.description} · ${item.kind === "agent" ? "Agent" : "Computer"}`;
              return <button type="button" id={`${listId}-${index}`} key={item.uid} role="option" aria-selected={index === active}
                className={styles.switcherResult} title={`${item.description} · ${item.uid}`} onClick={() => onSelect(item)}>
                <span className={`${styles.statusDot} ${styles.resultDot}`} data-state={item.status} aria-hidden />
                <Icon size={17} aria-hidden /><span className={styles.resourceCopy}><strong>{item.name}</strong>
                  <small>{detail}</small></span>
                <span className={styles.resultStatus}>{errors[item.source] ? "Last known: " : ""}{resourceStatusLabel(item.status)}</span>
              </button>;
            })}
          </div>;
        })}
      </div>
      {loading && <p className={styles.switcherEmpty} role="status">Loading resources…</p>}
      {!loading && !ordered.length && <p className={styles.switcherEmpty}>{query ? "No matching resources in the loaded sources." : hasError ? "Resource inventory is unavailable." : "No agents or computers yet."}</p>}
      <footer className={styles.switcherFooter}><Link href="/dashboard?runtimes=1" onClick={onBrowse ?? onClose}>All agents and computers</Link><span>↑ ↓ choose · Enter open · Esc close</span><button type="button" onClick={onRefresh} disabled={loading}>Refresh</button></footer>
    </dialog>, document.body,
  );
}
