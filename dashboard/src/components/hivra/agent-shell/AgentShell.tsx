"use client";

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useMediaQuery } from "@/lib/client/media-query";
import { AgentChatListSlotContext } from "./AgentChatListSlot";
import { AgentSidebar } from "./AgentSidebar";
import { AgentTitleBar } from "./AgentTitleBar";
import { useAgentSurfaceNav, type AgentShellGroup, type AgentShellSurface } from "./useAgentSurfaceNav";
import styles from "./AgentShell.module.css";

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

export interface AgentShellProps<T extends string> {
  /** The agent's name, with its emoji where it has one. */
  name: string;
  status: string;
  /** A tooltip on the name: where the agent's computer runs and how big it is. */
  nameTitle?: string;
  /** The agent's name and switcher, drawn at the top of the sidebar. */
  switcher: ReactNode;
  /** Beside the status in the title bar (the software update chip). */
  titleExtras?: ReactNode;
  surfaces: AgentShellSurface<T>[];
  groups?: AgentShellGroup<T>[];
  active: T;
  onSelect: (id: T) => void;
  /** The surface a chat opened from the sidebar shows. */
  chatSurface: T;
  panelId: string;
  exportHref?: string;
  /** A small note in the title bar for the active surface (e.g. "View only"). */
  surfaceNote?: Partial<Record<string, string>>;
  children: ReactNode;
}

/**
 * The agent view's frame: sidebar | column (title bar, then the page's content).
 *
 * It owns the shell state (collapsed sidebar, the drawer on phones, which view
 * each group last showed) and the chat-list slot, and nothing about the
 * surfaces themselves: the page still mounts and retains every surface.
 */
export function AgentShell<T extends string>({
  name, status, nameTitle, switcher, titleExtras, surfaces, groups, active, onSelect, chatSurface, panelId,
  exportHref, surfaceNote, children,
}: AgentShellProps<T>) {
  const sidebarId = useId();
  const drawerMode = useMediaQuery(DRAWER_QUERY);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chatList, setChatList] = useState<HTMLElement | null>(null);
  const nav = useAgentSurfaceNav({ surfaces, groups, active, onSelect });

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

  const chatSlot = useMemo(() => ({
    element: chatList,
    onChatOpened: () => {
      onSelect(chatSurface);
      setDrawerOpen(false);
    },
  }), [chatList, onSelect, chatSurface]);

  const hasChat = surfaces.some((surface) => surface.id === chatSurface);
  const activeGroupId = nav.activeGroup?.id ?? null;

  return (
    <div className={styles.shell}>
      <AgentSidebar
        id={sidebarId}
        switcher={switcher}
        surfaces={surfaces}
        groups={nav.visibleGroups}
        activeGroupId={activeGroupId}
        active={active}
        onOpenGroup={nav.openGroup}
        onSelectSurface={onSelect}
        hasChat={hasChat}
        chatSlotRef={setChatList}
        mode={drawerMode ? "drawer" : "inline"}
        collapsed={collapsed}
        open={drawerOpen}
        onClose={closeSidebar}
      />
      <div className={styles.column}>
        <AgentTitleBar
          name={name}
          status={status}
          nameTitle={nameTitle}
          extras={titleExtras}
          groupLabel={nav.activeGroup?.label}
          surfaces={nav.subSurfaces}
          active={active}
          onSelect={(id) => (nav.activeGroup ? nav.choose(nav.activeGroup, id) : onSelect(id))}
          panelId={panelId}
          actionSurface={active}
          note={surfaceNote?.[active]}
          exportHref={activeGroupId === "manage" ? exportHref : undefined}
          sidebarToggle={drawerMode || collapsed ? { onClick: openSidebar, controlsId: sidebarId, expanded: drawerMode && drawerOpen } : undefined}
        />
        <AgentChatListSlotContext.Provider value={chatSlot}>
          {children}
        </AgentChatListSlotContext.Provider>
      </div>
    </div>
  );
}
