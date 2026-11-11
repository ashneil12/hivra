"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.

import { Menu, PanelLeft } from "lucide-react";
import { usePathname } from "next/navigation";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { StatusText } from "@/components/ui/StatusText";
import {
  DASHBOARD_LAUNCH_NAVIGATION,
  DASHBOARD_PRIMARY_NAVIGATION,
  DASHBOARD_SECONDARY_NAVIGATION,
  DASHBOARD_UTILITY_NAVIGATION,
  isDashboardNavigationItemActive,
  labelForNavigationItem,
} from "@/lib/dashboard-navigation";
import { isWorkspaceShellNavigationEnabled } from "@/lib/flags/workspace-shell";
import { useAppShell } from "./AppShellContext";
import { resourceMatchesPath } from "./dashboard-resources";
import { sidebarStatus } from "./app-sidebar-status";
import { useDashboardResources } from "./useDashboardResources";
import styles from "./AppTitleBar.module.css";

/** Pages that draw their own resource bar: a second title above it would only repeat it. */
const OWN_HEADER_ROUTE = /^\/dashboard\/(?:instances|workspace)(?:\/|$)|\/(?:chat|console)(?:\/|$)/;
const FULLSCREEN_TUI_ROUTE = /^\/dashboard\/instances\/[^/]+\/tui(?:\/|$)/;
const ALL_NAVIGATION = [DASHBOARD_LAUNCH_NAVIGATION, ...DASHBOARD_PRIMARY_NAVIGATION, ...DASHBOARD_SECONDARY_NAVIGATION, ...DASHBOARD_UTILITY_NAVIGATION];

/**
 * The one row over every page's content. A page with views of its own (the
 * agent page) fills it through the shell's title slot; every other page gets
 * its name here. It is also where the sidebar comes back from: when it is
 * hidden on a wide screen, and as the menu button on a phone.
 */
export function AppTitleBar({ owner }: { owner: string }) {
  const shell = useAppShell();
  const pathname = usePathname() ?? "";
  const { copy } = useLocale();
  const { resources } = useDashboardResources(owner, pathname);
  if (!shell) return null;
  const { drawerMode, drawerOpen, collapsed, sidebarId, openSidebar, setTitleSlot, titleClaimed } = shell;

  const showToggle = drawerMode || collapsed;
  // The runtime pages carry their own bar; the title bar stays only to bring the sidebar back.
  if (FULLSCREEN_TUI_ROUTE.test(pathname)) return null;
  if (OWN_HEADER_ROUTE.test(pathname) && !showToggle) return null;

  const resource = resources.find((item) => resourceMatchesPath(item, pathname));
  const workspaceShell = isWorkspaceShellNavigationEnabled();
  const item = ALL_NAVIGATION.find((candidate) => isDashboardNavigationItemActive(candidate, pathname, null, workspaceShell));
  const title = resource?.name
    ?? (item?.id === "launch" ? "New agent" : item ? labelForNavigationItem(item, copy) : null)
    ?? (pathname.startsWith("/dashboard/agent/") || pathname.startsWith("/dashboard/instances/") ? "Agent" : "Hivra");
  const status = resource ? sidebarStatus(resource).label : null;
  const Toggle = drawerMode ? Menu : PanelLeft;

  return (
    <header className={styles.bar} data-web-chrome data-testid="app-title-bar">
      <div className={styles.inner}>
        {showToggle ? (
          <button type="button" className={styles.iconButton} onClick={openSidebar}
            aria-label={drawerMode ? "Open navigation" : "Show sidebar"} title={drawerMode ? "Open navigation" : "Show sidebar"}
            aria-controls={sidebarId} aria-expanded={drawerMode && drawerOpen}>
            <Toggle size={16} aria-hidden="true" />
          </button>
        ) : null}
        <div ref={setTitleSlot} className={styles.slot} />
        {titleClaimed ? null : (
          <div className={styles.identity}>
            <span className={styles.title}>{title}</span>
            {status ? <span className={styles.status}><StatusText value={status} /></span> : null}
          </div>
        )}
      </div>
    </header>
  );
}
