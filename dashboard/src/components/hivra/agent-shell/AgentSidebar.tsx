"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { UserButton } from "@clerk/nextjs";
import { House, PanelLeftClose, Search, X } from "lucide-react";
import Link from "@/components/ui/NavigationLink";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAppShell } from "@/components/layout/AppShellContext";
import { groupedSurfaceLabel, type AgentShellGroup, type AgentShellSurface } from "./useAgentSurfaceNav";
import styles from "./AgentSidebar.module.css";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface AgentSidebarProps<T extends string> {
  id: string;
  /** The agent's name and its switcher (a ResourceSwitcher in its "sidebar" look). */
  switcher: ReactNode;
  /** Every surface the page has: the rows of a computer, which has no groups. */
  surfaces: AgentShellSurface<T>[];
  /** The groups the agent has, one row each. Empty for a computer. */
  groups: AgentShellGroup<T>[];
  activeGroupId: string | null;
  active: T;
  onOpenGroup: (group: AgentShellGroup<T>) => void;
  onSelectSurface: (id: T) => void;
  /** Whether the agent has a chat, so the Chats section may show. */
  hasChat: boolean;
  /** Receives the element the chat portals its list into (see AgentChatListSlot). */
  chatSlotRef: (element: HTMLElement | null) => void;
  /**
   * "inline": a column beside the page, hidden when `collapsed`.
   * "drawer": a focus-trapped overlay, shown while `open`.
   */
  mode: "inline" | "drawer";
  collapsed: boolean;
  open: boolean;
  /** The collapse button: hides the column, or closes the drawer. */
  onClose: () => void;
}

/**
 * The agent view's sidebar: the agent's name and switcher, search, one row per
 * group of surfaces and the chat list (a slot the chat fills). On a wide screen
 * it sits beside the global icon rail, which carries Home, computers and the
 * account. As a phone drawer, where there is no rail, it adds the Hivra mark,
 * the way back home and the account.
 *
 * It owns no navigation state. The page decides which surface is open; this
 * only draws the rows and reports the choice.
 */
export function AgentSidebar<T extends string>({
  id, switcher, surfaces, groups, activeGroupId, active, onOpenGroup, onSelectSurface,
  hasChat, chatSlotRef, mode, collapsed, open, onClose,
}: AgentSidebarProps<T>) {
  const shell = useAppShell();
  const aside = useRef<HTMLElement>(null);
  const [mounted, setMounted] = useState(false);
  const drawer = mode === "drawer";
  const hidden = drawer ? !open : collapsed;

  useEffect(() => {
    // Account controls render after mount, as the global sidebar's do.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // Opening the drawer moves focus into it; closing returns it to what opened it.
  useEffect(() => {
    if (!drawer || !open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    aside.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [drawer, open]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!drawer || !open) return;
    if (event.key === "Escape") {
      // The switcher's own menu closes on Escape first; only a bare Escape closes the drawer.
      if (event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(aside.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((element) => !element.closest("[hidden]"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (event.shiftKey && (current === first || !aside.current?.contains(current))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (current === last || !aside.current?.contains(current))) {
      event.preventDefault();
      first.focus();
    }
  };

  // A drawer closes behind a choice; the inline column stays put.
  const afterChoice = () => { if (drawer) onClose(); };

  return (
    <>
      {drawer && open ? <div className={styles.backdrop} data-testid="agent-sidebar-backdrop" aria-hidden="true" onClick={onClose} /> : null}
      <aside
        ref={aside}
        id={id}
        className={styles.sidebar}
        data-mode={mode}
        hidden={hidden}
        role={drawer ? "dialog" : undefined}
        aria-modal={drawer ? true : undefined}
        aria-label="Agent navigation"
        onKeyDown={onKeyDown}
      >
        <div className={styles.top}>
          {drawer ? <Link href="/dashboard" aria-label="Hivra home" className={styles.brand}>H.</Link> : null}
          <div className={styles.switcher}>{switcher}</div>
          <button type="button" className={styles.iconButton} onClick={onClose}
            aria-label={drawer ? "Close navigation" : "Hide sidebar"} title={drawer ? "Close" : "Hide sidebar"}>
            {drawer ? <X size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
          </button>
        </div>

        <div className={styles.scroll}>
          {shell ? (
            <button type="button" className={styles.search} aria-label="Search agents and computers" aria-haspopup="dialog"
              onClick={() => { shell.openSwitcher(); afterChoice(); }}>
              <Search size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>Search</span>
              <kbd aria-hidden="true">⌘K</kbd>
            </button>
          ) : null}

          <nav aria-label="Resource surfaces" className={styles.nav}>
            {groups.length > 0
              ? groups.map((group) => (
                <button key={group.id} type="button" data-surface-group={group.id} className={styles.row}
                  aria-label={group.label} aria-current={group.id === activeGroupId ? "page" : undefined}
                  onClick={() => { onOpenGroup(group); afterChoice(); }}>
                  {group.icon}<span>{group.label}</span>
                </button>
              ))
              : surfaces.map((surface) => (
                <button key={surface.id} type="button" className={styles.row}
                  aria-label={groupedSurfaceLabel(surface)} aria-current={surface.id === active ? "page" : undefined}
                  onClick={() => { onSelectSurface(surface.id); afterChoice(); }}>
                  {surface.icon}<span>{groupedSurfaceLabel(surface)}</span>
                </button>
              ))}
          </nav>

          {hasChat ? (
            <section className={styles.chats} aria-label="Chats">
              <h2 className={styles.chatsHeading}>Chats</h2>
              <div ref={chatSlotRef} className={styles.chatSlot} data-agent-chat-list="" />
            </section>
          ) : null}
        </div>

        {drawer ? (
          <div className={styles.footer}>
            <Link href="/dashboard" className={styles.row} onClick={afterChoice}>
              <House size={16} strokeWidth={1.75} aria-hidden="true" /><span>Home</span>
            </Link>
            <div className={styles.account}>
              {mounted ? <UserButton /> : <span className={styles.avatarPlaceholder} />}
              <span className={styles.accountName}>{shell?.userName ?? ""}</span>
              <ThemeToggle />
            </div>
          </div>
        ) : null}
      </aside>
    </>
  );
}
