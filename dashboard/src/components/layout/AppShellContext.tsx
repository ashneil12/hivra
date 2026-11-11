"use client";

import { createContext, useContext } from "react";

/**
 * What the dashboard layout offers a page that lives inside the web shell.
 *
 * The shell is one sidebar and one title bar for every dashboard page. A page
 * that has views of its own (the agent page) reaches both through the slots
 * here and portals its rows and title into them, so its state and its React
 * context stay with the page. The switcher dialog and the ⌘K handler that opens
 * it belong to the layout; a page opens them from here instead of mounting a
 * second dialog.
 */
export interface AppShell {
  /** Opens the layout's agent and computer switcher. */
  openSwitcher: () => void;
  /** The signed-in account's display name, for the sidebar's account row. */
  userName: string;
  /** Whether the web shell's sidebar and title bar are drawn (not a desktop app that brings its own). */
  chrome: boolean;
  /** Where the open agent or computer lists its views in the sidebar, or null until it has mounted. */
  viewsSlot: HTMLElement | null;
  setViewsSlot: (element: HTMLElement | null) => void;
  /** Where a page puts its own title and controls in the title bar, or null until it has mounted. */
  titleSlot: HTMLElement | null;
  setTitleSlot: (element: HTMLElement | null) => void;
  /** Whether a page has filled the title bar, so the default title steps aside. */
  titleClaimed: boolean;
  setTitleClaimed: (claimed: boolean) => void;
  /** The sidebar's element id, for the buttons that open it. */
  sidebarId: string;
  /** Phone width: the sidebar is a drawer. */
  drawerMode: boolean;
  /** The sidebar column is hidden (wide screens). */
  collapsed: boolean;
  /** The drawer is showing (phone). */
  drawerOpen: boolean;
  /** Brings the sidebar back: shows the column, or opens the drawer. */
  openSidebar: () => void;
  /** The sidebar's own button: hides the column, or closes the drawer. */
  closeSidebar: () => void;
  /** Closes the drawer behind a choice; the column stays as it is. */
  closeNavigation: () => void;
}

export const AppShellContext = createContext<AppShell | null>(null);

/** The layout's shell, or null where a page renders outside the dashboard layout. */
export function useAppShell(): AppShell | null {
  return useContext(AppShellContext);
}
