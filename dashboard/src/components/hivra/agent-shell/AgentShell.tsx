"use client";

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useMediaQuery } from "@/lib/client/media-query";
import { useAppShell } from "@/components/layout/AppShellContext";
import { AgentChatListSlotContext } from "./AgentChatListSlot";
import { AgentSidebar } from "./AgentSidebar";
import { AgentPill, type AgentPillSetting, type AgentPillSuggestion, type AgentPillView } from "./AgentPill";
import { groupedSurfaceLabel, useAgentSurfaceNav, type AgentShellGroup, type AgentShellSurface } from "./useAgentSurfaceNav";
import styles from "./AgentShell.module.css";

const COLLAPSED_STORAGE_KEY = "hivra:agent-sidebar-collapsed";
// A page with no Hivra chat (a dashboard agent like Hermes or OpenClaw, or a computer)
// starts with the sidebar hidden, and remembers that choice on its own.
const COLLAPSED_NO_CHAT_STORAGE_KEY = "hivra:agent-sidebar-collapsed:no-chat";
const DRAWER_QUERY = "(max-width: 767px)";

function storageKey(hasChat: boolean): string {
  return hasChat ? COLLAPSED_STORAGE_KEY : COLLAPSED_NO_CHAT_STORAGE_KEY;
}

function readCollapsed(hasChat: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(storageKey(hasChat));
    if (stored === "true") return true;
    if (stored === "false") return false;
    return !hasChat;
  } catch {
    return !hasChat; // A display preference cannot block the page.
  }
}

function writeCollapsed(hasChat: boolean, value: boolean): void {
  try {
    window.localStorage.setItem(storageKey(hasChat), String(value));
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
  /** Beside the status in the pill's dropdown header (the software update chip). */
  titleExtras?: ReactNode;
  surfaces: AgentShellSurface<T>[];
  groups?: AgentShellGroup<T>[];
  active: T;
  onSelect: (id: T) => void;
  /** The surface a chat opened from the sidebar shows. */
  chatSurface: T;
  panelId: string;
  exportHref?: string;
  /** A small note in the pill's dropdown for the active surface (e.g. "View only"). */
  surfaceNote?: Partial<Record<string, string>>;
  /** What the back button calls the first group's view (the agent's own UI goes by the agent's name). */
  homeLabel?: string;
  /** Rows under "Quick settings" in the pill's dropdown. */
  quickSettings?: AgentPillSetting[];
  /** A word for what is running right now ("Updating"), shown on the pill. */
  busy?: string | null;
  /** One suggested next step, shown in the dropdown and as a dot on the pill. */
  suggestion?: AgentPillSuggestion | null;
  children: ReactNode;
}

/**
 * The agent view's frame: sidebar | column (the floating pill over the page's content).
 *
 * It owns the shell state (collapsed sidebar, the drawer on phones, which view
 * each group last showed) and the chat-list slot, and nothing about the
 * surfaces themselves: the page still mounts and retains every surface.
 */
export function AgentShell<T extends string>({
  name, status, nameTitle, switcher, titleExtras, surfaces, groups, active, onSelect, chatSurface, panelId,
  exportHref, surfaceNote, homeLabel, quickSettings, busy, suggestion, children,
}: AgentShellProps<T>) {
  const sidebarId = useId();
  const drawerMode = useMediaQuery(DRAWER_QUERY);
  const appShell = useAppShell();
  const hasChat = surfaces.some((surface) => surface.id === chatSurface);
  const [collapsed, setCollapsed] = useState(!hasChat);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chatList, setChatList] = useState<HTMLElement | null>(null);
  const nav = useAgentSurfaceNav({ surfaces, groups, active, onSelect });

  useEffect(() => {
    // The remembered preference is browser state; read it once the page is on screen.
    setCollapsed(readCollapsed(hasChat));
  }, [hasChat]);
  // Leaving phone width closes the drawer, so it is not open when the page widens.
  useEffect(() => {
    if (!drawerMode) setDrawerOpen(false);
  }, [drawerMode]);

  const closeSidebar = useCallback(() => {
    if (drawerMode) { setDrawerOpen(false); return; }
    setCollapsed(true);
    writeCollapsed(hasChat, true);
  }, [drawerMode, hasChat]);
  const openSidebar = useCallback(() => {
    if (drawerMode) { setDrawerOpen(true); return; }
    setCollapsed(false);
    writeCollapsed(hasChat, false);
  }, [drawerMode, hasChat]);

  const chatSlot = useMemo(() => ({
    element: chatList,
    onChatOpened: () => {
      onSelect(chatSurface);
      setDrawerOpen(false);
    },
  }), [chatList, onSelect, chatSurface]);

  const activeGroupId = nav.activeGroup?.id ?? null;
  // Away from the agent's own view (Computer, Browser, Settings), the pill
  // always offers the way back, so it never depends on the sidebar being open.
  const homeGroup = nav.visibleGroups[0] ?? null;
  const back = homeGroup && activeGroupId && activeGroupId !== homeGroup.id
    ? { label: homeLabel || homeGroup.label, onClick: () => nav.openGroup(homeGroup) }
    : undefined;

  // One quick button per place to go: a group with one view is one button, a
  // group with several shows each of its views, and a computer (no groups) one per surface.
  const views: AgentPillView[] = nav.visibleGroups.length > 0
    ? nav.visibleGroups.flatMap((group): AgentPillView[] => {
      if (group.surfaces.length === 1) {
        return [{ key: group.id, label: group.label, icon: group.icon, active: group.id === activeGroupId, onSelect: () => nav.openGroup(group) }];
      }
      return group.surfaces.flatMap((id): AgentPillView[] => {
        const surface = surfaces.find((candidate) => candidate.id === id);
        return surface
          ? [{ key: id, label: groupedSurfaceLabel(surface), icon: surface.icon, active: id === active, onSelect: () => nav.choose(group, id) }]
          : [];
      });
    })
    : surfaces.map((surface) => ({
      key: surface.id, label: groupedSurfaceLabel(surface), icon: surface.icon, active: surface.id === active, onSelect: () => onSelect(surface.id),
    }));
  const sidebarShown = drawerMode ? drawerOpen : !collapsed;

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
        <AgentPill
          name={name}
          status={status}
          nameTitle={nameTitle}
          busy={busy}
          note={surfaceNote?.[active]}
          extras={titleExtras}
          views={views}
          panelId={panelId}
          quickSettings={quickSettings}
          suggestion={suggestion}
          actionSurface={active}
          exportHref={activeGroupId === "manage" ? exportHref : undefined}
          sidebar={{ shown: sidebarShown, onToggle: sidebarShown ? closeSidebar : openSidebar, controlsId: sidebarId }}
          onSwitchAgent={appShell?.openSwitcher}
          back={back}
        />
        <AgentChatListSlotContext.Provider value={chatSlot}>
          {children}
        </AgentChatListSlotContext.Provider>
      </div>
    </div>
  );
}
