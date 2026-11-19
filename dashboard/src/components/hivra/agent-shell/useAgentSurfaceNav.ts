"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";

/** One surface the agent page can show: its id, plain label and icon. */
export type AgentShellSurface<T extends string = string> = { id: T; label: string; icon: ReactNode };

/**
 * A top-level destination and the surfaces it holds, in order. `home` is the
 * surface its row always opens; without one the row reopens the view last used
 * in the group (its `start` view, else its first, the first time).
 */
export type AgentShellGroup<T extends string = string> = {
  id: string;
  label: string;
  icon: ReactNode;
  surfaces: T[];
  home?: T;
  start?: T;
};

/** The surface rows a group shows inside it. The settings pane says "Settings" there, not "Manage". */
const GROUPED_LABEL: Partial<Record<string, string>> = { manage: "Settings" };

export function groupedSurfaceLabel(surface: { id: string; label: string }): string {
  return GROUPED_LABEL[surface.id] ?? surface.label;
}

/**
 * The page's group navigation, shared by the sidebar (one row per group) and
 * the title bar (the active group's surfaces). It owns only which view each
 * group last showed; the page still owns which surface is open.
 */
export function useAgentSurfaceNav<T extends string>({
  surfaces, groups, active, onSelect,
}: {
  surfaces: AgentShellSurface<T>[];
  groups?: AgentShellGroup<T>[];
  active: T;
  onSelect: (id: T) => void;
}) {
  const [remembered, setRemembered] = useState<Record<string, T>>({});
  const visibleGroups = useMemo(
    () => (groups ?? [])
      .map((group) => ({ ...group, surfaces: group.surfaces.filter((id) => surfaces.some((surface) => surface.id === id)) }))
      .filter((group) => group.surfaces.length > 0),
    [groups, surfaces],
  );
  const activeGroup = visibleGroups.find((group) => group.surfaces.includes(active)) ?? visibleGroups[0] ?? null;

  const choose = useCallback((group: AgentShellGroup<T>, id: T) => {
    setRemembered((current) => (current[group.id] === id ? current : { ...current, [group.id]: id }));
    onSelect(id);
  }, [onSelect]);

  const openGroup = useCallback((group: AgentShellGroup<T>) => {
    const home = group.home && group.surfaces.includes(group.home) ? group.home : undefined;
    const last = remembered[group.id];
    const start = group.start && group.surfaces.includes(group.start) ? group.start : undefined;
    choose(group, home ?? (last && group.surfaces.includes(last) ? last : start ?? group.surfaces[0]));
  }, [choose, remembered]);

  // A group with a single surface has no switcher: its row already opens it.
  const subSurfaces = activeGroup && activeGroup.surfaces.length > 1
    ? activeGroup.surfaces
        .map((id) => surfaces.find((surface) => surface.id === id))
        .filter((surface): surface is AgentShellSurface<T> => Boolean(surface))
    : [];

  return { visibleGroups, activeGroup, openGroup, choose, subSurfaces };
}
