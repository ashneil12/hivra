'use client';

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import styles from "./Tabs.module.css";

/**
 * Accessible tabs (WAI-ARIA tabs pattern, automatic activation).
 *
 * - role=tablist / tab / tabpanel, aria-selected, aria-controls,
 *   aria-labelledby.
 * - Roving tabindex: only the selected tab is in the Tab order.
 * - ArrowLeft / ArrowRight move between tabs (wrapping), Home / End jump to
 *   the first / last tab. Moving focus selects the tab.
 *
 * The component is controlled: the parent owns `value`, so tab state survives
 * anything that remounts the panels. Pair it with <TabPanel> for each tab id;
 * the panel renders its children only while active.
 */

export interface TabItem<T extends string = string> {
  id: T;
  label: string;
}

export function tabDomId(idPrefix: string, id: string): string {
  return `${idPrefix}-tab-${id}`;
}

export function tabPanelDomId(idPrefix: string, id: string): string {
  return `${idPrefix}-panel-${id}`;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  idPrefix,
  label,
  className,
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Prefix for tab and panel DOM ids; must match the TabPanels'. */
  idPrefix: string;
  /** Accessible name of the tablist. */
  label: string;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = items.findIndex((item) => item.id === value);

  // Keep the selected tab inside the (horizontally scrolling) list on narrow
  // screens. Only the list scrolls; the page never jumps.
  useEffect(() => {
    const list = listRef.current;
    const tab = tabRefs.current[selectedIndex];
    if (!list || !tab) return;
    const start = tab.offsetLeft;
    const end = start + tab.offsetWidth;
    if (start < list.scrollLeft) {
      list.scrollLeft = Math.max(0, start - 16);
    } else if (end > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = end - list.clientWidth + 32;
    }
  }, [selectedIndex]);

  function select(index: number) {
    const item = items[index];
    if (!item) return;
    tabRefs.current[index]?.focus();
    if (item.id !== value) onChange(item.id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = items.length;
    if (count === 0) return;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % count;
    else if (event.key === "ArrowLeft") next = (index - 1 + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    if (next === null) return;
    event.preventDefault();
    select(next);
  }

  return (
    <div className={[styles.bar, className].filter(Boolean).join(" ")}>
      <div ref={listRef} role="tablist" aria-label={label} aria-orientation="horizontal" className={styles.list}>
        {items.map((item, index) => {
          const selected = item.id === value;
          const focusable = selected || (selectedIndex === -1 && index === 0);
          return (
            <button
              key={item.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={tabDomId(idPrefix, item.id)}
              aria-selected={selected}
              aria-controls={tabPanelDomId(idPrefix, item.id)}
              tabIndex={focusable ? 0 : -1}
              className={styles.tab}
              onClick={() => select(index)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TabPanel({
  idPrefix,
  id,
  active,
  children,
  className,
}: {
  idPrefix: string;
  id: string;
  active: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tabpanel"
      id={tabPanelDomId(idPrefix, id)}
      aria-labelledby={tabDomId(idPrefix, id)}
      hidden={!active}
      tabIndex={active ? 0 : -1}
      className={[styles.panel, className].filter(Boolean).join(" ")}
    >
      {active ? children : null}
    </div>
  );
}
