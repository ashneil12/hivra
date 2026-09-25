"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { TabPanel, Tabs, type TabsOrientation } from "@/components/ui/Tabs";
import { MANAGE_SECTION_LABEL, type ManageSectionId } from "@/lib/hivra/manage-sections";
import styles from "./ManageLayout.module.css";

// One settings shell for every computer and agent: a header, a section nav
// (a side nav when the pane is at least 760px wide, a sticky strip below
// that) and the sections, which stay mounted so unsaved edits survive
// switching between them.

export const MANAGE_ID_PREFIX = "manage";
/** Where the nav turns from a strip above the content into a side nav. */
export const MANAGE_SIDE_NAV_MIN_WIDTH = 760;

/** What a section is doing or what went wrong there, for a banner while it is closed. */
export type ManageFeedback = { kind: "status" | "alert"; message: string } | null;

/**
 * Reports a section's feedback to Manage whenever it changes, and clears it
 * when the reporter goes away.
 */
export function useReportManageFeedback(onFeedbackChange: ((feedback: ManageFeedback) => void) | undefined, feedback: ManageFeedback) {
  const kind = feedback?.kind ?? null;
  const message = feedback?.message ?? null;
  const report = useRef(onFeedbackChange);
  useEffect(() => { report.current = onFeedbackChange; }, [onFeedbackChange]);
  useEffect(() => {
    report.current?.(kind && message ? { kind, message } : null);
  }, [kind, message]);
  useEffect(() => () => report.current?.(null), []);
}

/** False while this section is hidden, so its children can pause polling. */
const ManageVisibleContext = createContext(true);
export function useManageSectionVisible(): boolean {
  return useContext(ManageVisibleContext);
}

export interface ManageNavItem {
  id: ManageSectionId;
  /** Unsaved edits in this section: a dot on the tab and a spoken description. */
  unsaved?: boolean;
}

function useSideNav(): [React.RefObject<HTMLDivElement | null>, TabsOrientation] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [orientation, setOrientation] = useState<TabsOrientation>("horizontal");
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = (width: number) => setOrientation(width >= MANAGE_SIDE_NAV_MIN_WIDTH ? "vertical" : "horizontal");
    measure(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, orientation];
}

export function ManageLayout({
  label,
  header,
  notice,
  sections,
  selected,
  onSelect,
  children,
}: {
  /** Accessible name of the section nav, e.g. "Computer settings". */
  label: string;
  header: ReactNode;
  /** Banners about work in a section that isn't open. */
  notice?: ReactNode;
  sections: readonly ManageNavItem[];
  selected: ManageSectionId;
  onSelect: (section: ManageSectionId) => void;
  children: ReactNode;
}) {
  const [rootRef, orientation] = useSideNav();
  return (
    <div ref={rootRef} className={styles.root} data-nav={orientation === "vertical" ? "side" : "strip"}>
      <div className={styles.inner}>
        <header className={styles.header}>{header}</header>
        <div className={styles.workspace}>
          <div className={styles.nav}>
            <Tabs
              idPrefix={MANAGE_ID_PREFIX}
              label={label}
              orientation={orientation}
              value={selected}
              onChange={onSelect}
              items={sections.map((section) => ({
                id: section.id,
                label: MANAGE_SECTION_LABEL[section.id],
                dot: section.unsaved,
                description: section.unsaved ? `${MANAGE_SECTION_LABEL[section.id]} has unsaved changes` : undefined,
              }))}
            />
          </div>
          <div className={styles.content}>
            {notice ? <div className={styles.notices}>{notice}</div> : null}
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One section. It stays mounted while hidden, keeping its drafts. */
export function ManagePanel({
  id,
  selected,
  title,
  children,
}: {
  id: ManageSectionId;
  selected: ManageSectionId;
  /** Shown at the top of the section; defaults to its nav label. */
  title?: string;
  children: ReactNode;
}) {
  const active = id === selected;
  return (
    <TabPanel idPrefix={MANAGE_ID_PREFIX} id={id} active={active} keepMounted className={styles.panel}>
      <ManageVisibleContext.Provider value={active}>
        <h2 className={styles.sectionTitle}>{title ?? MANAGE_SECTION_LABEL[id]}</h2>
        {children}
      </ManageVisibleContext.Provider>
    </TabPanel>
  );
}

/** A banner for feedback from a section that isn't open, with a way to open it. */
export function ManageNotice({
  kind,
  message,
  section,
  onOpen,
}: {
  kind: "status" | "alert";
  message: string;
  section: ManageSectionId;
  onOpen: (section: ManageSectionId) => void;
}) {
  return (
    <div role={kind} className={styles.notice} data-kind={kind}>
      <span>{message}</span>
      <button type="button" onClick={() => onOpen(section)}>Open {MANAGE_SECTION_LABEL[section]}</button>
    </div>
  );
}

export { styles as manageLayoutStyles };
