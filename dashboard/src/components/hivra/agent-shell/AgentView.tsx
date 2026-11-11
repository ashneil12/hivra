"use client";

import { useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAppShell } from "@/components/layout/AppShellContext";
import { ResourceSurfaceNavigation } from "@/components/hivra/ResourceSurfaceNavigation";
import { AgentChatListSlotContext } from "./AgentChatListSlot";
import { AgentTitleBar } from "./AgentTitleBar";
import { AgentViewRows } from "./AgentViewRows";
import { useAgentSurfaceNav, type AgentShellGroup, type AgentShellSurface } from "./useAgentSurfaceNav";

export interface AgentViewProps<T extends string> {
  /** The agent's name, with its emoji where it has one. */
  name: string;
  status: string;
  /** A tooltip on the name: where the agent's computer runs and how big it is. */
  nameTitle?: string;
  /** Beside the status in the title bar (the software update chip). */
  titleExtras?: ReactNode;
  surfaces: AgentShellSurface<T>[];
  /** The rows under the open agent or computer in the sidebar, one per place to look. */
  rows: AgentShellGroup<T>[];
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
 * The agent page's side of the web shell.
 *
 * The sidebar and title bar belong to the dashboard layout. This puts the
 * page's own parts into them: the views as rows under the open agent or
 * computer, and the name, status and controls in the title bar. Both are
 * portals, so they run in the page's own React context (its lifted surface
 * actions, its state) while the layout owns where they sit on screen. It also
 * provides the chat-list slot, which sits under the Chat row.
 *
 * It owns nothing about the surfaces themselves: the page still mounts and
 * retains every one. Where the layout draws no shell (a desktop app that brings
 * its own navigation, or a page rendered on its own) the views fall back to the
 * flat surface bar.
 */
export function AgentView<T extends string>({
  name, status, nameTitle, titleExtras, surfaces, rows, active, onSelect, chatSurface, panelId, exportHref, surfaceNote, children,
}: AgentViewProps<T>) {
  const shell = useAppShell();
  const [chatList, setChatList] = useState<HTMLElement | null>(null);
  const nav = useAgentSurfaceNav({ surfaces, groups: rows, active, onSelect });
  const inShell = Boolean(shell?.chrome);
  const setTitleClaimed = shell?.setTitleClaimed;
  const closeNavigation = shell?.closeNavigation;

  // While this page fills the title bar, the layout's default title steps aside.
  useLayoutEffect(() => {
    if (!inShell || !setTitleClaimed) return;
    setTitleClaimed(true);
    return () => setTitleClaimed(false);
  }, [inShell, setTitleClaimed]);

  const chatSlot = useMemo(() => ({
    element: chatList,
    onChatOpened: () => {
      onSelect(chatSurface);
      closeNavigation?.();
    },
  }), [chatList, onSelect, chatSurface, closeNavigation]);

  const hasChat = surfaces.some((surface) => surface.id === chatSurface);
  const activeGroupId = nav.activeGroup?.id ?? null;
  const exportShown = activeGroupId === "settings" ? exportHref : undefined;

  return (
    <>
      {inShell ? (
        <>
          {shell?.viewsSlot ? createPortal(
            <AgentViewRows rows={nav.visibleGroups} activeRowId={activeGroupId} onOpenRow={nav.openGroup}
              onChoose={() => closeNavigation?.()} hasChat={hasChat} chatSlotRef={setChatList} />,
            shell.viewsSlot,
          ) : null}
          {shell?.titleSlot ? createPortal(
            <AgentTitleBar<T>
              name={name} status={status} nameTitle={nameTitle} extras={titleExtras}
              groupLabel={nav.activeGroup?.label} surfaces={nav.subSurfaces} active={active}
              onSelect={(id) => (nav.activeGroup ? nav.choose(nav.activeGroup, id) : onSelect(id))}
              panelId={panelId} actionSurface={active} note={surfaceNote?.[active]} exportHref={exportShown}
            />,
            shell.titleSlot,
          ) : null}
        </>
      ) : (
        <ResourceSurfaceNavigation surfaces={surfaces} groups={rows} panelId={panelId} active={active} onSelect={onSelect}
          exportHref={exportHref} actionSurface={active} />
      )}
      <AgentChatListSlotContext.Provider value={chatSlot}>
        {children}
      </AgentChatListSlotContext.Provider>
    </>
  );
}
