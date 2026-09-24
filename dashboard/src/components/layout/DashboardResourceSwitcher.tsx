"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "@/components/ui/NavigationLink";
import { createPortal } from "react-dom";
import { Bot, Monitor, Search, X } from "lucide-react";
import { recentShortcutsShown, switcherGroups } from "@/lib/workspace/recent-order";
import { listRecents } from "@/lib/workspace/recents";
import { filterDashboardResources, resourceStatusLabel, type DashboardResource, type DashboardResourceSource } from "./dashboard-resources";
import styles from "./DashboardSidebar.module.css";

export interface DashboardResourceSwitcherProps {
  resources: DashboardResource[];
  /** The resource on screen: marked, and left out of Recent. */
  currentUid?: string | null;
  loading: boolean;
  errors: Record<DashboardResourceSource, string | null>;
  onSelect: (resource: DashboardResource) => void;
  onClose: () => void;
  onBrowse?: () => void;
  onRefresh: () => void;
}

/**
 * ⌘K: Recent first, then Agents, then Computers. The highlight starts on the
 * resource you were in before this one, so ⌘K then Enter goes back to it and
 * pressing it again returns: two agents, one shortcut. With nothing typed,
 * 1–9 open that Recent entry, except on a touch screen, where no hint shows
 * them and a digit types.
 */
export function DashboardResourceSwitcher({ resources, currentUid = null, loading, errors, onSelect, onClose, onBrowse, onRefresh }: DashboardResourceSwitcherProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // Read once per open: the order must not shift under the keyboard.
  const [recents] = useState(listRecents);
  const [shortcuts] = useState(recentShortcutsShown);
  const listId = useId();
  const matches = useMemo(() => filterDashboardResources(resources, query), [resources, query]);
  const groups = useMemo(
    () => switcherGroups(matches, { recents, currentUid, isComputer: (item) => item.kind === "computer" }),
    [matches, recents, currentUid],
  );
  const ordered = groups.flatMap((group) => group.items);
  const recent = groups.find((group) => group.key === "recent")?.items ?? [];
  const active = Math.min(activeIndex, Math.max(0, ordered.length - 1));
  const activeItem = ordered[active];
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
            // Only while nothing is typed, and only for an entry that exists,
            // so a search that starts with a digit still types.
            if (shortcuts && !query && /^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
              const pick = recent[Number(event.key) - 1];
              if (pick) { event.preventDefault(); onSelect(pick); return; }
            }
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
        {groups.map((group) => <div role="group" aria-label={group.label} key={group.key}>
          <h2 className={styles.groupHeading}>{group.label}</h2>
          {group.items.map((item, position) => {
            const index = ordered.indexOf(item);
            const Icon = item.kind === "agent" ? Bot : Monitor;
            const duplicate = resources.some((other) => other.uid !== item.uid && other.name === item.name);
            const detail = duplicate ? `${item.description} · ${item.source} · ${item.id.slice(-8)}` : `${item.description} · ${item.kind === "agent" ? "Agent" : "Computer"}`;
            const shortcut = shortcuts && group.key === "recent" && !query && position < 9 ? String(position + 1) : undefined;
            const current = item.uid === currentUid;
            return <button type="button" id={`${listId}-${index}`} key={item.uid} role="option" aria-selected={index === active}
              aria-current={current ? "true" : undefined} aria-keyshortcuts={shortcut}
              className={styles.switcherResult} title={`${item.description} · ${item.uid}`} onClick={() => onSelect(item)}>
              <span className={`${styles.statusDot} ${styles.resultDot}`} data-state={item.status} aria-hidden />
              <Icon size={17} aria-hidden /><span className={styles.resourceCopy}><strong>{item.name}</strong>
                <small>{detail}</small></span>
              {current && <span className={styles.resultCurrent}>You&apos;re here</span>}
              <span className={styles.resultStatus}>{errors[item.source] ? "Last known: " : ""}{resourceStatusLabel(item.status)}</span>
              {shortcut && <kbd className={styles.resultKey} aria-hidden>{shortcut}</kbd>}
            </button>;
          })}
        </div>)}
      </div>
      {loading && <p className={styles.switcherEmpty} role="status">Loading resources…</p>}
      {!loading && !ordered.length && <p className={styles.switcherEmpty}>{query ? "No matching resources in the loaded sources." : hasError ? "Resource inventory is unavailable." : "No agents or computers yet."}</p>}
      <footer className={styles.switcherFooter}><Link href="/dashboard?runtimes=1" onClick={onBrowse ?? onClose}>All agents and computers</Link><span>↑ ↓ choose · {activeItem && recent.includes(activeItem) ? `↵ back to ${activeItem.name}` : "Enter open"}{shortcuts && !query && recent.length > 0 ? ` · 1–${Math.min(recent.length, 9)} recent` : ""} · Esc close</span><button type="button" onClick={onRefresh} disabled={loading}>Refresh</button></footer>
    </dialog>, document.body,
  );
}
