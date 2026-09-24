import type { RecentVisit } from "./recents";

/**
 * The order every place that lists "your agents and computers" for switching
 * shares: the ⌘K switcher, the switcher under an agent's name, and Home's
 * Recent row. They used to disagree (one alphabetical, one running-first, none
 * by recency), so the thing you were just using could be anywhere.
 */

/** How many recent resources a switcher lists above the rest. */
export const SWITCHER_RECENT_LIMIT = 5;

/**
 * Whether a switcher's 1–9 keys open Recent entries: only where their hints
 * are shown. With a touch screen as the main pointer the hints are hidden (the
 * same `pointer: coarse` rule), and a digit typed there is the start of a
 * search, such as a name like "2nd brain" or part of an id.
 */
export function recentShortcutsShown(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return !window.matchMedia("(pointer: coarse)").matches;
}

export interface RecentEntry<T> {
  item: T;
  visit: RecentVisit;
}

/**
 * The `items` that were opened recently, most recent first, each with its
 * visit. Anything remembered that is not in `items` (deleted, or from a list
 * that failed to load) is left out rather than invented.
 */
export function inRecentOrder<T extends { uid: string }>(
  items: readonly T[],
  recents: readonly RecentVisit[],
): RecentEntry<T>[] {
  const byUid = new Map(items.map((item) => [item.uid, item]));
  const entries: RecentEntry<T>[] = [];
  for (const visit of recents) {
    const item = byUid.get(visit.uid);
    if (item) entries.push({ item, visit });
  }
  return entries;
}

export type SwitcherGroupKey = "recent" | "agent" | "computer";

export interface SwitcherGroup<T> {
  key: SwitcherGroupKey;
  label: string;
  items: T[];
}

/**
 * Recent, then Agents, then Computers.
 *
 * Recent holds what you opened in this browser, most recent first, without the
 * resource you are on (switching to where you already are is not a switch), so
 * its first entry is the one you were in before this. A resource appears once:
 * a recent one is not repeated in its kind's group, which keeps the incoming
 * order. Empty groups are dropped. Filter `items` before calling, so a search
 * narrows every group alike.
 */
export function switcherGroups<T extends { uid: string }>(
  items: readonly T[],
  options: {
    recents: readonly RecentVisit[];
    currentUid: string | null;
    isComputer: (item: T) => boolean;
    limit?: number;
  },
): SwitcherGroup<T>[] {
  const recent = inRecentOrder(items, options.recents)
    .map((entry) => entry.item)
    .filter((item) => item.uid !== options.currentUid)
    .slice(0, options.limit ?? SWITCHER_RECENT_LIMIT);
  const shown = new Set(recent.map((item) => item.uid));
  const rest = items.filter((item) => !shown.has(item.uid));
  const groups: SwitcherGroup<T>[] = [
    { key: "recent", label: "Recent", items: recent },
    { key: "agent", label: "Agents", items: rest.filter((item) => !options.isComputer(item)) },
    { key: "computer", label: "Computers", items: rest.filter((item) => options.isComputer(item)) },
  ];
  return groups.filter((group) => group.items.length > 0);
}
