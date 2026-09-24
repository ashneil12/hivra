"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Download, MoreHorizontal } from "lucide-react";
import styles from "./ResourceSurfaceNavigation.module.css";
import { surfaceMenuLayout } from "./surface-navigation-layout";
import { SurfaceActions } from "./SurfaceActions";
import { useNativeWorkspaceSurfaces } from "@/components/layout/NativeWorkspaceBridge";

type Surface = { id: string; label: string; icon: ReactNode };
/**
 * A top-level destination and the surfaces it holds, in order. `home` is the
 * surface its button always opens; without one the button reopens the view
 * last used in the group (its first view the first time).
 */
export type SurfaceGroup<T extends string> = { id: string; label: string; icon: ReactNode; surfaces: T[]; home?: T };
const PRIMARY = new Set(["chat", "aeon", "terminal", "desktop", "files", "manage"]);
// Inside the Manage group its own pane is the settings, so its tab says so
// instead of repeating the group's name. The flat bar (computers) and native
// clients have no group around it and keep "Manage".
const GROUPED_LABEL: Partial<Record<string, string>> = { manage: "Settings" };

/**
 * Organizes existing surfaces without owning or remounting their sessions.
 *
 * `identity` is an optional leading cluster. It exists so a caller can fold its
 * own header row (back button, name, status) into this bar instead of stacking a
 * separate 56px header above it — two rows that both named the same resource.
 */
export function ResourceSurfaceNavigation<T extends string>({
  surfaces, groups, groupNotes, active, onSelect, exportHref, identity, actionSurface, panelId,
}: {
  surfaces: (Surface & { id: T })[];
  /**
   * Agent pages pass groups (Agent · Computer · Manage): the bar shows one
   * button per group and, when the active group holds more than one surface,
   * a second row for them. Without groups (computers) every surface stays in
   * one flat bar. Native clients always receive the flat list.
   */
  groups?: SurfaceGroup<T>[];
  /** The element the surfaces render into, for the sub-row's aria-controls. */
  panelId?: string;
  /** A short fact shown at the end of a group's row, keyed by group id. */
  groupNotes?: Record<string, ReactNode>;
  active: T;
  onSelect: (id: T) => void;
  exportHref?: string;
  identity?: ReactNode;
  /**
   * The slot whose lifted actions render here. Defaults to the active surface,
   * so a caller that publishes by surface id needs to pass nothing; the explicit
   * prop exists for the native branch, where the bar is not drawn.
   */
  actionSurface?: string;
}) {
  const nativeWorkspace = useNativeWorkspaceSurfaces(surfaces, active, onSelect);
  const [open, setOpen] = useState(false);
  const toolsId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const primary = surfaces.filter(surface => surface.id !== "manage" && (surfaces.length <= 5 || PRIMARY.has(surface.id)));
  const manage = surfaces.find(surface => surface.id === "manage");
  const tools = surfaces.filter(surface => surfaces.length > 5 && !PRIMARY.has(surface.id));
  const selectedTool = tools.find(surface => surface.id === active);

  useLayoutEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const header = document.querySelector('[data-testid="dashboard-mobile-header"]');
    const banner = document.querySelector('[data-testid="environment-banner"]');
    const bottomNav = document.querySelector('[data-testid="pwa-bottom-navigation"]');
    function position() {
      if (!root.current || !popover.current) return;
      let top = viewport?.offsetTop ?? 0;
      let bottom = top + (viewport?.height ?? window.innerHeight);
      for (const element of [header, banner]) {
        const rect = element?.getBoundingClientRect();
        if (rect && rect.height > 0) top = Math.max(top, rect.bottom);
      }
      const bottomRect = bottomNav?.getBoundingClientRect();
      if (bottomRect && bottomRect.height > 0) bottom = Math.min(bottom, bottomRect.top);
      const layout = surfaceMenuLayout(root.current.getBoundingClientRect(), { top, bottom });
      popover.current.style.maxHeight = `${layout.maxHeight}px`;
      popover.current.style.top = layout.placement === "below" ? "calc(100% + 8px)" : "auto";
      popover.current.style.bottom = layout.placement === "above" ? "calc(100% + 8px)" : "auto";
    }
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    for (const element of [root.current, header, banner, bottomNav]) if (element) observer?.observe(element);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    // A tap inside a Terminal, Desktop or Browser iframe never reaches this
    // document; the window losing focus to that frame is the only signal.
    function blurred() {
      setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", blurred);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("blur", blurred);
    };
  }, [open]);

  function select(id: T) {
    onSelect(id);
    setOpen(false);
    trigger.current?.focus();
  }

  // The slot is the active surface's own id, so a surface publishes under the
  // same key the bar is already reading — no separate mapping to keep in sync.
  const actions = <SurfaceActions surfaceId={actionSurface ?? active} />;

  if (nativeWorkspace) return <div className={styles.nativeActions}>
    {actions}
    {exportHref ? <a href={exportHref} title="Download chats and memory as JSON" className={styles.surface}>
      <Download size={14} aria-hidden="true" />Export data
    </a> : null}
  </div>;

  const visibleGroups = (groups ?? [])
    .map(group => ({ ...group, surfaces: group.surfaces.filter(id => surfaces.some(surface => surface.id === id)) }))
    .filter(group => group.surfaces.length > 0);
  if (visibleGroups.length > 0) {
    return <GroupedSurfaceNavigation surfaces={surfaces} groups={visibleGroups} active={active} onSelect={onSelect}
      exportHref={exportHref} identity={identity} actions={actions} panelId={panelId} notes={groupNotes} />;
  }

  return <nav aria-label="Resource surfaces" className={styles.navigation}>
    {identity}
    <div className={styles.primary}>
      {primary.map(surface => <button key={surface.id} type="button"
        aria-label={surface.label} aria-pressed={surface.id === active} onClick={() => { setOpen(false); onSelect(surface.id); }}
        className={styles.surface}>
        {surface.icon}<span>{(surface.id === "terminal" || (surface.id === "box" && surfaces.length <= 5)) ? "Terminal" : surface.label}</span>
      </button>)}
    </div>
    {actions}
    {(tools.length > 0 || exportHref) && <div className={styles.tools} ref={root}
      onKeyDown={event => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}>
      <button ref={trigger} type="button" className={styles.surface}
        title={selectedTool ? `Tools: ${selectedTool.label}` : "Tools"}
        aria-label={selectedTool ? `Tools: ${selectedTool.label}` : "Tools"}
        aria-expanded={open} aria-controls={open ? toolsId : undefined} aria-pressed={Boolean(selectedTool)}
        onClick={() => setOpen(value => !value)}>
        <MoreHorizontal className={styles.toolsIcon} size={18} aria-hidden="true" /><span className={styles.toolsLabel}>{selectedTool?.label ?? "Tools"}</span><ChevronDown className={styles.toolsChevron} size={13} aria-hidden="true" />
      </button>
      {/* Narrow panes: a transparent layer over the surface so the first tap
          outside the menu closes it instead of landing in an iframe. It closes
          on click, not pointerdown, so the whole tap lands here and no click
          falls through to the pill or frame underneath. */}
      {open && <div className={styles.catcher} aria-hidden="true" data-testid="surface-tools-catcher"
        onClick={() => setOpen(false)} />}
      {open && <div id={toolsId} ref={popover} className={styles.popover}>
        <span className={styles.label}>Tools & connections</span>
        {tools.map(surface => <button key={surface.id} type="button"
          aria-pressed={surface.id === active} onClick={() => select(surface.id)}>
          {surface.icon}<span>{surface.label}</span>
        </button>)}
        {exportHref && <a href={exportHref} title="Download chats and memory as JSON">
          <Download size={14} aria-hidden="true" />Export data
        </a>}
      </div>}
    </div>}
    {manage && <button type="button" className={`${styles.surface} ${styles.manage}`} aria-label={manage.label} title={manage.label}
      aria-pressed={active === manage.id} onClick={() => { setOpen(false); onSelect(manage.id); }}>{manage.icon}<span>{manage.label}</span></button>}
  </nav>;
}

/**
 * Agent · Computer (Terminal, Files, Browser, Git) · Manage.
 *
 * Agent and Manage open their home surface (Chat or the dashboard, Settings);
 * Computer reopens the view last used in it (Terminal first). The active
 * group's surfaces sit in their own row as tabs, so every surface stays one
 * tap away without an overflow menu. A group with a single surface has no
 * row: its button already opens it, and the row would only repeat its name.
 */
function GroupedSurfaceNavigation<T extends string>({
  surfaces, groups, active, onSelect, exportHref, identity, actions, panelId, notes,
}: {
  notes?: Record<string, ReactNode>;
  surfaces: (Surface & { id: T })[];
  groups: SurfaceGroup<T>[];
  active: T;
  onSelect: (id: T) => void;
  exportHref?: string;
  identity?: ReactNode;
  actions: ReactNode;
  panelId?: string;
}) {
  const [remembered, setRemembered] = useState<Record<string, T>>({});
  const activeGroup = groups.find(group => group.surfaces.includes(active)) ?? groups[0];
  const byId = new Map(surfaces.map(surface => [surface.id, surface]));
  const choose = (group: SurfaceGroup<T>, id: T) => {
    setRemembered(current => current[group.id] === id ? current : { ...current, [group.id]: id });
    onSelect(id);
  };
  const openGroup = (group: SurfaceGroup<T>) => {
    const home = group.home && group.surfaces.includes(group.home) ? group.home : undefined;
    const last = remembered[group.id];
    choose(group, home ?? (last && group.surfaces.includes(last) ? last : group.surfaces[0]));
  };
  const subSurfaces = activeGroup.surfaces.length > 1 ? activeGroup.surfaces : [];
  // Export sits with Manage: in its row, or in the bar when Manage has none.
  const showExport = Boolean(exportHref) && activeGroup.id === "manage";

  return <>
    <nav aria-label="Resource surfaces" className={styles.navigation} data-grouped="true">
      {identity}
      <div className={styles.primary}>
        {groups.map(group => <button key={group.id} type="button" data-surface-group={group.id}
          aria-label={group.label} aria-pressed={group.id === activeGroup.id} onClick={() => openGroup(group)}
          className={styles.surface}>
          {group.icon}<span>{group.label}</span>
        </button>)}
      </div>
      {actions}
      {showExport && subSurfaces.length === 0 ? <a href={exportHref} title="Download chats and memory as JSON" aria-label="Export data"
        className={`${styles.surface} ${styles.barExport}`}>
        <Download size={14} aria-hidden="true" /><span>Export data</span>
      </a> : null}
    </nav>
    {subSurfaces.length > 0 ? <div className={styles.subnav} role="tablist" aria-label={`${activeGroup.label} views`}>
      {subSurfaces.map(id => {
        const surface = byId.get(id);
        if (!surface) return null;
        return <button key={id} type="button" role="tab" aria-selected={id === active}
          aria-controls={id === active ? panelId : undefined} tabIndex={id === active ? 0 : -1}
          className={styles.subSurface} onClick={() => choose(activeGroup, id)}
          onKeyDown={event => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            const index = subSurfaces.indexOf(id);
            const next = subSurfaces[(index + (event.key === "ArrowRight" ? 1 : subSurfaces.length - 1)) % subSurfaces.length];
            choose(activeGroup, next);
            const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
            buttons?.[subSurfaces.indexOf(next)]?.focus();
          }}>
          {surface.icon}<span>{GROUPED_LABEL[id] ?? surface.label}</span>
        </button>;
      })}
      {showExport ? <a href={exportHref} title="Download chats and memory as JSON" className={styles.subExport}>
        <Download size={13} aria-hidden="true" />Export data
      </a> : null}
      {notes?.[activeGroup.id] ? <span className={styles.subNote}>{notes[activeGroup.id]}</span> : null}
    </div> : null}
  </>;
}
