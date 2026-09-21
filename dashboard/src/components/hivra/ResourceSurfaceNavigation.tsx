"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Download, MoreHorizontal } from "lucide-react";
import styles from "./ResourceSurfaceNavigation.module.css";
import { surfaceMenuLayout } from "./surface-navigation-layout";
import { SurfaceActions } from "./SurfaceActions";
import { useNativeWorkspaceSurfaces } from "@/components/layout/NativeWorkspaceBridge";

type Surface = { id: string; label: string; icon: ReactNode };
const PRIMARY = new Set(["chat", "aeon", "terminal", "desktop", "files", "manage"]);

/**
 * Organizes existing surfaces without owning or remounting their sessions.
 *
 * `identity` is an optional leading cluster. It exists so a caller can fold its
 * own header row (back button, name, status) into this bar instead of stacking a
 * separate 56px header above it — two rows that both named the same resource.
 */
export function ResourceSurfaceNavigation<T extends string>({
  surfaces, active, onSelect, exportHref, identity, actionSurface,
}: {
  surfaces: (Surface & { id: T })[];
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
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
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
