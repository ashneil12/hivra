import { isLocalAuthMode } from "@/lib/self-host/config";
import {
  Activity,
  Bot,
  CircleHelp,
  Download,
  LayoutDashboard,
  MonitorUp,
  Plus,
  ServerCog,
  Settings,
  type LucideIcon,
} from "lucide-react";

type DashboardNavigationId =
  | "home"
  | "chat"
  | "computers"
  | "agents"
  | "activity"
  | "infrastructure"
  | "collaboration"
  | "settings"
  | "billing"
  | "applications"
  | "help"
  | "launch";

export type DashboardNavigationItem = {
  id: DashboardNavigationId;
  label: string;
  href: string;
  icon: LucideIcon;
  exactPaths?: readonly string[];
  routePrefixes?: readonly string[];
  /** Held back until the workspace shell rollout flag is enabled for this environment. */
  requiresWorkspaceShell?: boolean;
};

export const DASHBOARD_PRIMARY_NAVIGATION: readonly DashboardNavigationItem[] = [
  {
    id: "home",
    label: "Home",
    href: "/dashboard",
    icon: LayoutDashboard,
    exactPaths: ["/dashboard"],
    routePrefixes: ["/dashboard/command", "/dashboard/ops", "/dashboard/insights"],
  },
  {
    id: "computers",
    label: "Computers",
    href: "/dashboard/computers",
    icon: MonitorUp,
    routePrefixes: ["/dashboard/computers", "/dashboard/computer"],
  },
  {
    id: "agents",
    label: "Agents",
    href: "/dashboard/agents",
    icon: Bot,
    routePrefixes: [
      "/dashboard/agents",
      "/dashboard/agent",
      "/dashboard/instances",
      "/dashboard/chat",
      "/dashboard/runtimes",
    ],
  },
  {
    id: "activity",
    label: "Activity",
    href: "/dashboard/activity",
    icon: Activity,
    routePrefixes: ["/dashboard/activity", "/dashboard/usage"],
  },
];

export const DASHBOARD_SECONDARY_NAVIGATION: readonly DashboardNavigationItem[] = [
  {
    id: "infrastructure",
    label: "Infrastructure",
    href: "/dashboard/infrastructure",
    icon: ServerCog,
    routePrefixes: ["/dashboard/infrastructure"],
  },
  {
    id: "settings",
    label: "Settings",
    href: "/dashboard/settings",
    icon: Settings,
    routePrefixes: [
      "/dashboard/settings",
      "/dashboard/wallet",
      "/dashboard/vault",
      "/dashboard/tools",
      "/dashboard/library",
      "/dashboard/templates",
    ],
  },
  {
    id: "billing",
    label: "Billing & Access",
    href: "/dashboard/billing",
    icon: Settings,
    routePrefixes: ["/dashboard/billing"],
  },
];

export const DASHBOARD_LAUNCH_NAVIGATION: DashboardNavigationItem = {
  id: "launch",
  label: "Launch",
  href: "/dashboard/launch",
  icon: Plus,
  routePrefixes: ["/dashboard/launch", "/dashboard/welcome"],
};

/** Infrequent access/help destinations stay reachable without competing with work. */
export const DASHBOARD_UTILITY_NAVIGATION: readonly DashboardNavigationItem[] = [
  {
    id: "applications",
    label: "Applications",
    href: "/dashboard/settings/applications",
    icon: Download,
    routePrefixes: ["/dashboard/settings/applications"],
  },
  {
    id: "help",
    label: "Help",
    href: "/dashboard/settings/help",
    icon: CircleHelp,
    routePrefixes: ["/dashboard/settings/help"],
  },
];

const PRIMARY_NAVIGATION_BY_ID = Object.fromEntries(
  DASHBOARD_PRIMARY_NAVIGATION.map((item) => [item.id, item]),
) as Record<string, DashboardNavigationItem>;

/** Labels for the 72px touch rail, where the full label cannot fit. */
export const DASHBOARD_RAIL_SHORT_LABELS: Partial<Record<DashboardNavigationId, string>> = {
  infrastructure: "Infra",
  billing: "Billing",
  applications: "Apps",
};

/** Phone bottom bar: the two inventories flank Launch; everything else lives in More. */
export const DASHBOARD_MOBILE_NAVIGATION: readonly DashboardNavigationItem[] = [
  PRIMARY_NAVIGATION_BY_ID.home,
  PRIMARY_NAVIGATION_BY_ID.agents,
  DASHBOARD_LAUNCH_NAVIGATION,
  PRIMARY_NAVIGATION_BY_ID.computers,
];

/** Group headings come from mobileNavigationCopy under the same id. */
export type DashboardNavigationGroup = {
  id: "manage" | "help";
  items: readonly DashboardNavigationItem[];
};

/** Phone More sheet, in display order. Every destination not on the bar. */
export const DASHBOARD_MOBILE_MORE_GROUPS: readonly DashboardNavigationGroup[] = [
  { id: "manage", items: [PRIMARY_NAVIGATION_BY_ID.activity, ...DASHBOARD_SECONDARY_NAVIGATION] },
  { id: "help", items: DASHBOARD_UTILITY_NAVIGATION },
];

export const DASHBOARD_MOBILE_MORE_NAVIGATION: readonly DashboardNavigationItem[] =
  DASHBOARD_MOBILE_MORE_GROUPS.flatMap((group) => group.items);

/** Runtime list. Home under the workspace shell otherwise resumes the last runtime. */
export const DASHBOARD_RUNTIME_LIST_HREF = "/dashboard?runtimes=1";

type MobileNavigationCopyKey =
  | "switchOrSearch" | "needsAttention" | "manage" | "help" | "account" | "manageAccount"
  | "signOut" | "signingOut" | "themeDark" | "themeLight" | "switchToDark" | "switchToLight";

/**
 * The optional keys are not in src/lib/i18n.ts yet; each surface falls back to
 * English until a locale provides them.
 */
type DashboardNavigationCopy = {
  nav?: { closeMobileMenu?: string };
  dashboard: {
    nav: Record<"home" | "chat" | "computers" | "agents" | "infrastructure" | "settings" | "launch", string>
      & Partial<Record<"activity" | "billingAccess" | "applications" | "help" | "more", string>>;
    mobileNav?: Partial<Record<MobileNavigationCopyKey, string>>;
  };
};

/** One localization for every navigation surface (sidebar, bottom bar, More sheet). */
export function labelForNavigationItem(
  item: DashboardNavigationItem,
  copy: DashboardNavigationCopy,
): string {
  const nav = copy.dashboard.nav;
  const labels: Partial<Record<DashboardNavigationId, string>> = {
    home: nav.home, chat: nav.chat, computers: nav.computers, agents: nav.agents,
    infrastructure: nav.infrastructure, settings: nav.settings, launch: nav.launch,
    activity: nav.activity, billing: nav.billingAccess, applications: nav.applications, help: nav.help,
  };
  return labels[item.id] ?? item.label;
}

const MOBILE_NAVIGATION_COPY: Record<MobileNavigationCopyKey, string> = {
  switchOrSearch: "Switch or search", needsAttention: "Needs attention", manage: "Manage", help: "Help",
  account: "Account", manageAccount: "Manage account", signOut: "Sign out", signingOut: "Signing out…",
  themeDark: "Theme: Dark", themeLight: "Theme: Light", switchToDark: "Switch to dark", switchToLight: "Switch to light",
};

/** Strings the phone bar and More sheet add on top of the item labels. */
export function mobileNavigationCopy(copy: DashboardNavigationCopy) {
  return {
    ...MOBILE_NAVIGATION_COPY,
    ...copy.dashboard.mobileNav,
    more: copy.dashboard.nav.more ?? "More",
    close: copy.nav?.closeMobileMenu ?? "Close menu",
  };
}

/**
 * Hides navigation that depends on a rollout flag that is off for this
 * environment, so a hidden destination can never become a dead link.
 */
export function filterDashboardNavigation(
  items: readonly DashboardNavigationItem[],
  workspaceShellEnabled: boolean,
): DashboardNavigationItem[] {
  return items.filter((item) =>
    (!item.requiresWorkspaceShell || workspaceShellEnabled) &&
    (item.id !== "billing" || !isLocalAuthMode())
  );
}

function matchesRoutePrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Routes that render a single runtime.
 *
 * Both families live behind one detail route — a Hivra box at
 * `/dashboard/agent/<id>`, a Hermes instance at `/dashboard/instances/<id>` —
 * so a pathname alone cannot say which family a runtime belongs to. Every
 * runtime detail page is one surface to the nav.
 */
export function isRuntimeDetailPath(pathname: string): boolean {
  return (
    pathname.startsWith("/dashboard/agent/") ||
    pathname.startsWith("/dashboard/instances/")
  );
}

export function isDashboardNavigationItemActive(
  item: DashboardNavigationItem,
  pathname: string | null,
  resourceKind?: "agent" | "computer" | null,
  workspaceShellEnabled = false,
): boolean {
  if (!pathname) return false;

  if (workspaceShellEnabled) {
    // Under the workspace shell, Home is the runtime home, so opening a runtime
    // is still being home. Agents and Computers used to claim this route, which
    // meant Home could not highlight while you were inside the box you reached
    // from it — the item naming the place you came from lost to the one naming
    // its kind. Those two still own their inventory routes.
    if (item.id === "home" && isRuntimeDetailPath(pathname)) return true;
    if (item.id === "agents" || item.id === "computers") {
      return (
        item.routePrefixes?.some(
          (prefix) =>
            prefix !== "/dashboard/agent" &&
            prefix !== "/dashboard/instances" &&
            matchesRoutePrefix(pathname, prefix),
        ) ?? false
      );
    }
  } else if (
    (item.id === "agents" || item.id === "computers") &&
    pathname.startsWith("/dashboard/agent/")
  ) {
    // Legacy shell (prod): Agents and desktop computers share the detail route;
    // an unresolved kind stays neutral.
    return resourceKind != null && item.id === `${resourceKind}s`;
  }

  if (item.exactPaths?.includes(pathname)) return true;
  return item.routePrefixes?.some((prefix) => matchesRoutePrefix(pathname, prefix)) ?? false;
}
