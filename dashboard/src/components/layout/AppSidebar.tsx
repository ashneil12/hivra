"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { UserButton } from "@clerk/nextjs";
import { Bot, MoreHorizontal, Monitor, PanelLeftClose, Plus, Search, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import Link from "@/components/ui/NavigationLink";
import { ThemeToggle } from "@/components/theme-toggle";
import { useLocale } from "@/components/i18n/LocaleProvider";
import {
  DASHBOARD_LAUNCH_NAVIGATION,
  DASHBOARD_PRIMARY_NAVIGATION,
  DASHBOARD_RUNTIME_LIST_HREF,
  DASHBOARD_SECONDARY_NAVIGATION,
  DASHBOARD_UTILITY_NAVIGATION,
  filterDashboardNavigation,
  isDashboardNavigationItemActive,
  isRuntimeDetailPath,
  labelForNavigationItem,
  type DashboardNavigationItem,
} from "@/lib/dashboard-navigation";
import { isWorkspaceShellNavigationEnabled } from "@/lib/flags/workspace-shell";
import { buildLaunchHref } from "@/lib/hivra/launch-navigation";
import { recentHref } from "@/lib/workspace/recents";
import { StatusText } from "@/components/ui/StatusText";
import { useAppShell } from "./AppShellContext";
import { resourceMatchesPath, type DashboardResource } from "./dashboard-resources";
import { sidebarStatus } from "./app-sidebar-status";
import { useDashboardResources } from "./useDashboardResources";
import styles from "./AppSidebar.module.css";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const AGENT_ROUTE = /^\/dashboard\/agent\/[^/]+\/?$/;

function navItem(items: readonly DashboardNavigationItem[], id: DashboardNavigationItem["id"]): DashboardNavigationItem {
  const found = items.find((item) => item.id === id);
  if (!found) throw new Error(`Missing navigation item ${id}`);
  return found;
}

export interface AppSidebarProps {
  /** The account whose agents and computers are listed. */
  owner: string;
  /** The account code the server setup script shows (XXXX-XXXX). */
  accountCode?: string | null;
}

/**
 * The web dashboard's sidebar, on every page: search, Home and a new agent,
 * the owner's agents and computers (the open one expanded into its own views,
 * which its page fills through the shell's slot), and the rest of the
 * destinations at the foot with the account.
 *
 * It owns no navigation state of its own beyond the "More" menu. Below 768px
 * it is a focus-trapped drawer opened from the title bar.
 */
export function AppSidebar({ owner, accountCode }: AppSidebarProps) {
  const shell = useAppShell();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { copy } = useLocale();
  const { resources, loading, errors, refresh } = useDashboardResources(owner, pathname);
  const aside = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const drawer = Boolean(shell?.drawerMode);
  const drawerOpen = Boolean(shell?.drawerOpen);
  const hidden = drawer ? !drawerOpen : Boolean(shell?.collapsed);

  useEffect(() => {
    // Account controls render after mount, as the old sidebar's did.
    setMounted(true);
  }, []);

  // A new page closes the More menu.
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [moreOpen]);

  // Opening the drawer moves focus into it; closing returns it to what opened it.
  useEffect(() => {
    if (!drawer || !drawerOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    aside.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [drawer, drawerOpen]);

  const openRow = useRef<HTMLAnchorElement | null>(null);
  const openUid = resources.find((item) => resourceMatchesPath(item, pathname))?.uid ?? null;
  // The open agent or computer stays in view as the list scrolls.
  useEffect(() => {
    openRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [openUid, hidden]);

  if (!shell) return null;

  const workspaceShell = isWorkspaceShellNavigationEnabled();
  const onResourcePage = isRuntimeDetailPath(pathname);
  const active = (item: DashboardNavigationItem) =>
    !onResourcePage && isDashboardNavigationItemActive(item, pathname, null, workspaceShell);
  const label = (item: DashboardNavigationItem) => labelForNavigationItem(item, copy);

  const home = navItem(DASHBOARD_PRIMARY_NAVIGATION, "home");
  const agents = navItem(DASHBOARD_PRIMARY_NAVIGATION, "agents");
  const computers = navItem(DASHBOARD_PRIMARY_NAVIGATION, "computers");
  const activity = navItem(DASHBOARD_PRIMARY_NAVIGATION, "activity");
  const settings = navItem(DASHBOARD_SECONDARY_NAVIGATION, "settings");
  const more = [
    ...filterDashboardNavigation(DASHBOARD_SECONDARY_NAVIGATION, workspaceShell).filter((item) => item.id !== "settings"),
    ...DASHBOARD_UTILITY_NAVIGATION,
  ];
  // Home is the list. From inside an agent or computer the link asks for it
  // explicitly as well; the legacy page ignores ?runtimes=1.
  const homeHref = onResourcePage ? DASHBOARD_RUNTIME_LIST_HREF : home.href;

  const agentRows = resources.filter((item) => item.kind === "agent");
  const computerRows = resources.filter((item) => item.kind === "computer");
  const failed = Boolean(errors.hermes || errors.hivra);
  const afterChoice = shell.closeNavigation;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!drawer || !drawerOpen) return;
    if (event.key === "Escape") {
      // The More menu closes on Escape first; only a bare Escape closes the drawer.
      if (event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      shell.closeSidebar();
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

  // Each resource reopens on the surface you last left it on.
  const openResource = (event: MouseEvent<HTMLAnchorElement>, item: DashboardResource) => {
    afterChoice();
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.push(recentHref(item.uid, item.href));
  };

  const globalRow = (item: DashboardNavigationItem, text: string, href = item.href) => {
    const Icon = item.icon;
    const current = active(item);
    return (
      <Link key={item.id} href={href} className={styles.row} aria-current={current ? "page" : undefined} onClick={afterChoice}>
        <Icon size={16} strokeWidth={1.75} aria-hidden="true" /><span>{text}</span>
      </Link>
    );
  };

  const resourceRow = (item: DashboardResource) => {
    const open = item.uid === openUid;
    const status = sidebarStatus(item);
    const Icon = item.kind === "computer" ? Monitor : Bot;
    return (
      <li key={item.uid} className={styles.item}>
        <Link ref={open ? openRow : undefined} href={item.href} className={styles.resource} data-open={open ? "" : undefined}
          aria-current={open ? "page" : undefined} onClick={(event) => openResource(event, item)}>
          <span className={styles.avatar} aria-hidden="true">
            <Icon size={15} strokeWidth={1.75} />
            <i className={styles.dot} data-tone={status.tone} />
          </span>
          <span className={styles.copy}>
            <strong>{item.name}</strong>
            <small data-tone={status.tone}><StatusText value={status.label} /></small>
          </span>
        </Link>
        {open ? <div ref={shell.setViewsSlot} className={styles.views} data-open-views="" /> : null}
      </li>
    );
  };

  const section = (id: "agents" | "computers", item: DashboardNavigationItem, rows: DashboardResource[], launchKind: "agent" | "computer") => {
    const showSkeleton = loading && resources.length === 0;
    const heading = `${label(item)}`;
    // An agent page whose agent the list has not read yet still shows its views.
    const placeholder = id === "agents" && AGENT_ROUTE.test(pathname) && !openUid;
    return (
      <section className={styles.section} aria-labelledby={`${shell.sidebarId}-${id}`}>
        <div className={styles.sectionHead}>
          <Link id={`${shell.sidebarId}-${id}`} href={item.href} className={styles.sectionLink}
            aria-current={active(item) ? "page" : undefined} onClick={afterChoice}>{heading}</Link>
          <Link href={buildLaunchHref({ kind: launchKind })} className={styles.iconButton} onClick={afterChoice}
            aria-label={launchKind === "agent" ? "Launch an agent" : "Launch a computer"}
            title={launchKind === "agent" ? "Launch an agent" : "Launch a computer"}>
            <Plus size={15} strokeWidth={1.75} aria-hidden="true" />
          </Link>
        </div>
        <ul className={styles.list}>
          {placeholder ? (
            <li className={styles.item}>
              <div className={styles.resource} data-open="" aria-current="page">
                <span className={styles.avatar} aria-hidden="true"><Bot size={15} strokeWidth={1.75} /></span>
                <span className={styles.copy}><strong>This agent</strong></span>
              </div>
              <div ref={shell.setViewsSlot} className={styles.views} data-open-views="" />
            </li>
          ) : null}
          {rows.map(resourceRow)}
        </ul>
        {showSkeleton ? <div className={styles.skeleton} aria-hidden="true"><i /><i /></div> : null}
        {!showSkeleton && !loading && rows.length === 0 && !placeholder && !failed
          ? <p className={styles.empty}>{id === "agents" ? "No agents yet" : "No computers yet"}</p> : null}
      </section>
    );
  };

  return (
    <>
      {drawer && drawerOpen ? <div className={styles.backdrop} data-testid="app-sidebar-backdrop" aria-hidden="true" onClick={shell.closeSidebar} /> : null}
      <aside
        ref={aside}
        id={shell.sidebarId}
        data-web-chrome
        className={styles.sidebar}
        data-mode={drawer ? "drawer" : "inline"}
        hidden={hidden}
        role={drawer ? "dialog" : undefined}
        aria-modal={drawer ? true : undefined}
        aria-label="Workspace navigation"
        onKeyDown={onKeyDown}
      >
        <div className={styles.top}>
          <Link href={homeHref} aria-label="Hivra home" className={styles.brand} onClick={afterChoice}>H.<span>Hivra</span></Link>
          <button type="button" className={styles.iconButton} onClick={shell.closeSidebar}
            aria-label={drawer ? "Close navigation" : "Hide sidebar"} title={drawer ? "Close" : "Hide sidebar"}>
            {drawer ? <X size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
          </button>
        </div>

        <div className={styles.scroll}>
          <button type="button" className={styles.search} aria-label="Switch agent or computer" aria-haspopup="dialog"
            onClick={() => { shell.openSwitcher(); afterChoice(); }}>
            <Search size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>Search</span>
            <kbd aria-hidden="true">⌘K</kbd>
          </button>

          <nav aria-label="Primary" className={styles.nav}>
            {globalRow(home, label(home), homeHref)}
            {globalRow(DASHBOARD_LAUNCH_NAVIGATION, "New agent")}
          </nav>

          {section("agents", agents, agentRows, "agent")}
          {section("computers", computers, computerRows, "computer")}
          {failed ? (
            <p className={styles.empty}>Some of your list could not load. <button type="button" className={styles.retry} onClick={refresh}>Try again</button></p>
          ) : null}
        </div>

        <div className={styles.footer}>
          <nav aria-label="Manage" className={styles.nav}>
            {globalRow(activity, label(activity))}
            {globalRow(settings, label(settings))}
            <div ref={moreRef} className={styles.more}
              onKeyDown={(event) => {
                if (event.key === "Escape" && moreOpen) {
                  event.preventDefault();
                  setMoreOpen(false);
                  moreRef.current?.querySelector<HTMLElement>("button")?.focus();
                }
              }}>
              <button type="button" className={styles.row} aria-haspopup="menu" aria-expanded={moreOpen}
                onClick={() => setMoreOpen((current) => !current)}>
                <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden="true" /><span>More</span>
              </button>
              {moreOpen ? (
                <div role="menu" aria-label="More" className={styles.menu}>
                  {more.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link key={item.id} href={item.href} role="menuitem" className={styles.row}
                        aria-current={active(item) ? "page" : undefined}
                        onClick={() => { setMoreOpen(false); afterChoice(); }}>
                        <Icon size={16} strokeWidth={1.75} aria-hidden="true" /><span>{label(item)}</span>
                      </Link>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </nav>
          <div className={styles.account}>
            {mounted ? <UserButton /> : <span className={styles.avatarPlaceholder} />}
            <span className={styles.accountName}>
              <strong>{shell.userName}</strong>
              {accountCode ? <small title="Hivra's server setup command shows this code">Account code {accountCode}</small> : null}
            </span>
            <ThemeToggle />
          </div>
        </div>
      </aside>
    </>
  );
}
