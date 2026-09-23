import { isLocalAuthMode } from "@/lib/self-host/config";
import {
  Activity,
  Bot,
  CircleHelp,
  CreditCard,
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
  /**
   * Routes under one of this item's prefixes that another item owns. Scoped to
   * the item that declares it, so global prefix matching stays unchanged.
   */
  excludedPrefixes?: readonly string[];
  /**
   * Routes this item claims only in self-hosted (local auth) mode, where the
   * hosted-only item that owns them is filtered out of the nav but the route
   * stays reachable. Without this, those routes would highlight nothing.
   */
  selfHostRoutePrefixes?: readonly string[];
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

// Applications and Help live under /dashboard/settings for URL stability, but
// each has its own utility item, so Settings must not also claim them.
const APPLICATIONS_ROUTE = "/dashboard/settings/applications";
const HELP_ROUTE = "/dashboard/settings/help";
const WALLET_ROUTE = "/dashboard/wallet";

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
      "/dashboard/vault",
      "/dashboard/tools",
      "/dashboard/library",
      "/dashboard/templates",
    ],
    excludedPrefixes: [APPLICATIONS_ROUTE, HELP_ROUTE],
    // Billing owns the wallet, but self-host hides Billing while the wallet
    // page (and its PWA shortcut) stays reachable, so Settings holds it there.
    selfHostRoutePrefixes: [WALLET_ROUTE],
  },
  {
    id: "billing",
    label: "Billing",
    href: "/dashboard/billing",
    icon: CreditCard,
    // The wallet is where $HermesOS access is paid for and agent wallets are
    // funded, so it belongs with Billing, not Settings.
    routePrefixes: ["/dashboard/billing", WALLET_ROUTE],
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
    href: APPLICATIONS_ROUTE,
    icon: Download,
    routePrefixes: [APPLICATIONS_ROUTE],
  },
  {
    id: "help",
    label: "Help",
    href: HELP_ROUTE,
    icon: CircleHelp,
    routePrefixes: [HELP_ROUTE],
  },
];

const PRIMARY_NAVIGATION_BY_ID = Object.fromEntries(
  DASHBOARD_PRIMARY_NAVIGATION.map((item) => [item.id, item]),
) as Record<string, DashboardNavigationItem>;

export const DASHBOARD_MOBILE_NAVIGATION: readonly DashboardNavigationItem[] = [
  PRIMARY_NAVIGATION_BY_ID.home,
  DASHBOARD_LAUNCH_NAVIGATION,
  PRIMARY_NAVIGATION_BY_ID.agents,
  PRIMARY_NAVIGATION_BY_ID.computers,
  DASHBOARD_SECONDARY_NAVIGATION.find((item) => item.id === "billing")!,
];

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
function isRuntimeDetailPath(pathname: string): boolean {
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
  if (item.excludedPrefixes?.some((prefix) => matchesRoutePrefix(pathname, prefix))) return false;

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
  if (item.routePrefixes?.some((prefix) => matchesRoutePrefix(pathname, prefix))) return true;
  return Boolean(
    item.selfHostRoutePrefixes?.some((prefix) => matchesRoutePrefix(pathname, prefix)) &&
    isLocalAuthMode(),
  );
}
