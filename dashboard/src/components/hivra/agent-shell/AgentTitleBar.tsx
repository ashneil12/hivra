"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, Download, PanelLeft } from "lucide-react";
import { StatusText } from "@/components/ui/StatusText";
import { statusTone } from "@/components/hivra/ResourceSwitcher";
import { SurfaceActions } from "@/components/hivra/SurfaceActions";
import { groupedSurfaceLabel, type AgentShellSurface } from "./useAgentSurfaceNav";
import styles from "./AgentTitleBar.module.css";

export interface AgentTitleBarProps<T extends string> {
  name: string;
  /** The status as a plain word ("Running", "setting up"). */
  status: string;
  /** A fact about where the agent runs, shown as a tooltip on the name. */
  nameTitle?: string;
  /** Beside the status: the software update chip. */
  extras?: ReactNode;
  /** The active group's name, for the segmented control's label. */
  groupLabel?: string;
  /** The active group's surfaces. Fewer than two draws no control. */
  surfaces: AgentShellSurface<T>[];
  active: T;
  onSelect: (id: T) => void;
  /** The element the surfaces render into, for aria-controls. */
  panelId: string;
  /** Whose lifted actions (Open in new tab) show at the right. */
  actionSurface: string;
  /** A small muted note beside the status, e.g. the live browser being view-only. */
  note?: string;
  exportHref?: string;
  /** The button that brings the sidebar back: when it is collapsed, or a drawer. */
  sidebarToggle?: { onClick: () => void; controlsId: string; expanded: boolean };
  /** The way back to the agent's own view (its chat or its web UI) from Computer, Browser or Settings. */
  back?: { label: string; onClick: () => void };
}

/**
 * One 44px row over the work pane. At the left the name and a muted status
 * word; at the right the active group's views as a quiet segmented control,
 * the active surface's lifted actions, and the export link where it exists.
 *
 * It replaces the three rows (identity, group buttons, view tabs) the page
 * used to stack. The views keep tablist semantics: arrow keys move between
 * them and the selected one names the pane it controls.
 */
export function AgentTitleBar<T extends string>({
  name, status, nameTitle, extras, groupLabel, surfaces, active, onSelect, panelId, actionSurface,
  note, exportHref, sidebarToggle, back,
}: AgentTitleBarProps<T>) {
  const tablist = useRef<HTMLDivElement>(null);
  const showViews = surfaces.length > 1;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: T) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = surfaces.findIndex((surface) => surface.id === id);
    const next = surfaces[(index + (event.key === "ArrowRight" ? 1 : surfaces.length - 1)) % surfaces.length];
    onSelect(next.id);
    tablist.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[surfaces.indexOf(next)]?.focus();
  };

  return (
    <header className={styles.bar}>
      {sidebarToggle ? (
        <button type="button" className={styles.iconButton} onClick={sidebarToggle.onClick}
          aria-label="Show sidebar" title="Show sidebar" aria-controls={sidebarToggle.controlsId} aria-expanded={sidebarToggle.expanded}>
          <PanelLeft size={16} aria-hidden="true" />
        </button>
      ) : null}
      {back ? (
        <button type="button" className={styles.back} onClick={back.onClick} aria-label={`Back to ${back.label}`} title={`Back to ${back.label}`}>
          <ChevronLeft size={15} aria-hidden="true" /><span>{back.label}</span>
        </button>
      ) : null}

      <div className={styles.identity}>
        <span className={styles.name} title={nameTitle}>{name}</span>
        <span className={styles.status} data-tone={statusTone(status)}><StatusText value={status} /></span>
        {note ? <span className={styles.pill}>{note}</span> : null}
        {extras}
      </div>

      <div className={styles.right}>
        {showViews ? (
          <div ref={tablist} role="tablist" aria-label={`${groupLabel ?? "Surface"} views`} className={styles.segments}>
            {surfaces.map((surface) => {
              const selected = surface.id === active;
              const label = groupedSurfaceLabel(surface);
              return (
                <button key={surface.id} type="button" role="tab" aria-selected={selected} aria-label={label}
                  aria-controls={selected ? panelId : undefined} tabIndex={selected ? 0 : -1}
                  className={styles.segment} onClick={() => onSelect(surface.id)} onKeyDown={(event) => onKeyDown(event, surface.id)}>
                  {surface.icon}<span>{label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <SurfaceActions surfaceId={actionSurface} className={styles.actions} buttonClassName={styles.iconButton} />
        {exportHref ? (
          <a href={exportHref} className={styles.iconButton} aria-label="Export data" title="Download chats and memory as JSON">
            <Download size={15} aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </header>
  );
}
