"use client";

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useMediaQuery } from "@/lib/client/media-query";
import { AppShellContext } from "./AppShellContext";

const COLLAPSED_STORAGE_KEY = "hivra:agent-sidebar-collapsed";
const DRAWER_QUERY = "(max-width: 767px)";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false; // A display preference cannot block the page.
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(value));
  } catch { /* Keep the current view usable. */ }
}

/**
 * The state the web shell's sidebar and title bar share: whether the sidebar is
 * hidden (remembered in this browser), whether the phone drawer is open, and
 * the slots a page fills. It draws nothing; AppSidebar and AppTitleBar do.
 */
export function AppShellProvider({ openSwitcher, userName, chrome, children }: {
  openSwitcher: () => void;
  chrome: boolean;
  userName: string;
  children: ReactNode;
}) {
  const sidebarId = useId();
  const drawerMode = useMediaQuery(DRAWER_QUERY);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewsSlot, setViewsSlot] = useState<HTMLElement | null>(null);
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const [titleClaimed, setTitleClaimed] = useState(false);

  useEffect(() => {
    // The remembered preference is browser state; read it once the page is on screen.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(readCollapsed());
  }, []);
  // Leaving phone width closes the drawer, so it is not open when the page widens.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!drawerMode) setDrawerOpen(false);
  }, [drawerMode]);

  const closeSidebar = useCallback(() => {
    if (drawerMode) { setDrawerOpen(false); return; }
    setCollapsed(true);
    writeCollapsed(true);
  }, [drawerMode]);
  const openSidebar = useCallback(() => {
    if (drawerMode) { setDrawerOpen(true); return; }
    setCollapsed(false);
    writeCollapsed(false);
  }, [drawerMode]);
  const closeNavigation = useCallback(() => setDrawerOpen(false), []);

  const value = useMemo(() => ({
    openSwitcher, userName, chrome, viewsSlot, setViewsSlot, titleSlot, setTitleSlot, titleClaimed, setTitleClaimed,
    sidebarId, drawerMode, collapsed, drawerOpen, openSidebar, closeSidebar, closeNavigation,
  }), [openSwitcher, userName, chrome, viewsSlot, titleSlot, titleClaimed, sidebarId, drawerMode, collapsed, drawerOpen, openSidebar, closeSidebar, closeNavigation]);

  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>;
}
