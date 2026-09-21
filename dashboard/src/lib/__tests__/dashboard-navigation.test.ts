import {
  DASHBOARD_LAUNCH_NAVIGATION,
  DASHBOARD_MOBILE_NAVIGATION,
  DASHBOARD_PRIMARY_NAVIGATION,
  DASHBOARD_SECONDARY_NAVIGATION,
  DASHBOARD_UTILITY_NAVIGATION,
  filterDashboardNavigation,
  isDashboardNavigationItemActive,
} from "@/lib/dashboard-navigation";

describe("dashboard navigation", () => {
  it("hides hosted billing from the mobile and desktop manage navigation in local auth mode", () => {
    const previous = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "local";
    try {
      expect(filterDashboardNavigation(DASHBOARD_MOBILE_NAVIGATION, true).some(item => item.id === "billing")).toBe(false);
      expect(filterDashboardNavigation(DASHBOARD_SECONDARY_NAVIGATION, true).some(item => item.id === "billing")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
      else process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = previous;
    }
  });
  it("keeps daily work, launch, and management in explicit groups", () => {
    expect(DASHBOARD_PRIMARY_NAVIGATION.map((item) => item.id)).toEqual([
      "home",
      "computers",
      "agents",
      "activity",
    ]);
    // No "chat" item: the interaction area IS home now, and a separate item
    // listed the same runtimes a fourth time (Agents and Computers already
    // list them).
    expect(
      DASHBOARD_PRIMARY_NAVIGATION.some((item) => item.id === "chat"),
    ).toBe(false);
    expect(DASHBOARD_SECONDARY_NAVIGATION.map((item) => item.id)).toEqual([
      "infrastructure",
      "settings",
      "billing",
    ]);
    expect(DASHBOARD_LAUNCH_NAVIGATION).toMatchObject({
      id: "launch",
      href: "/dashboard/launch",
    });
  });

  it("is active on the landing page that now holds the workspace", () => {
    // "/dashboard" is the landing route, and the workspace view renders there
    // when the shell flag is on — so Home is the active item, not a separate
    // Chat entry pointing somewhere else.
    const home = DASHBOARD_PRIMARY_NAVIGATION.find((item) => item.id === "home");
    expect(home).toMatchObject({ href: "/dashboard", exactPaths: ["/dashboard"] });
    expect(home && isDashboardNavigationItemActive(home, "/dashboard")).toBe(true);

    // The nav no longer gates anything on the shell flag.
    expect(
      filterDashboardNavigation(DASHBOARD_PRIMARY_NAVIGATION, false).map((item) => item.id),
    ).toEqual(["home", "computers", "agents", "activity"]);
    expect(
      filterDashboardNavigation(DASHBOARD_PRIMARY_NAVIGATION, true).map((item) => item.id),
    ).toEqual(["home", "computers", "agents", "activity"]);
  });

  it("builds the mobile rail from the shared configuration with Launch centered", () => {
    expect(DASHBOARD_MOBILE_NAVIGATION.map((item) => item.id)).toEqual([
      "home",
      "launch",
      "agents",
      "computers",
      "billing",
    ]);
    expect(DASHBOARD_MOBILE_NAVIGATION[1]).toBe(DASHBOARD_LAUNCH_NAVIGATION);
    expect(
      filterDashboardNavigation(DASHBOARD_MOBILE_NAVIGATION, false).map((item) => item.id),
    ).toEqual(["home", "launch", "agents", "computers", "billing"]);
  });

  it("preserves applications and help under their own secondary destinations", () => {
    expect(DASHBOARD_UTILITY_NAVIGATION.map(({ id, href }) => ({ id, href }))).toEqual([
      { id: "applications", href: "/dashboard/settings/applications" },
      { id: "help", href: "/dashboard/settings/help" },
    ]);
    expect(isDashboardNavigationItemActive(DASHBOARD_UTILITY_NAVIGATION[0], "/dashboard/settings/applications")).toBe(true);
    expect(isDashboardNavigationItemActive(DASHBOARD_UTILITY_NAVIGATION[1], "/dashboard/settings/applications")).toBe(false);
  });

  it("matches legacy work routes without accepting path-prefix collisions", () => {
    const agents = DASHBOARD_PRIMARY_NAVIGATION.find((item) => item.id === "agents");
    const activity = DASHBOARD_PRIMARY_NAVIGATION.find((item) => item.id === "activity");
    const settings = DASHBOARD_SECONDARY_NAVIGATION.find((item) => item.id === "settings");
    const billing = DASHBOARD_SECONDARY_NAVIGATION.find((item) => item.id === "billing");

    expect(agents).toBeDefined();
    expect(activity).toBeDefined();
    expect(settings).toBeDefined();
    expect(billing).toBeDefined();
    expect(isDashboardNavigationItemActive(agents!, "/dashboard/instances/inst_123/tui")).toBe(true);
    expect(isDashboardNavigationItemActive(agents!, "/dashboard/agents-not-real")).toBe(false);
    expect(isDashboardNavigationItemActive(activity!, "/dashboard/usage")).toBe(true);
    expect(isDashboardNavigationItemActive(settings!, "/dashboard/vault")).toBe(true);
    expect(isDashboardNavigationItemActive(billing!, "/dashboard/billing")).toBe(true);
    expect(isDashboardNavigationItemActive(settings!, "/dashboard/settings-not-real")).toBe(false);
  });

  it.each(["agent", "computer", null] as const)("classifies shared detail routes using the resolved %s kind", (kind) => {
    const agents = DASHBOARD_PRIMARY_NAVIGATION.find((item) => item.id === "agents")!;
    const computers = DASHBOARD_PRIMARY_NAVIGATION.find((item) => item.id === "computers")!;
    expect(isDashboardNavigationItemActive(agents, "/dashboard/agent/shared", kind)).toBe(kind === "agent");
    expect(isDashboardNavigationItemActive(computers, "/dashboard/agent/shared", kind)).toBe(kind === "computer");
    expect(isDashboardNavigationItemActive(agents, "/dashboard/agents", kind)).toBe(true);
    expect(isDashboardNavigationItemActive(computers, "/dashboard/computers", kind)).toBe(true);
  });

  describe("workspace shell (Home is the runtime home)", () => {
    const home = DASHBOARD_PRIMARY_NAVIGATION.find((item) => item.id === "home")!;
    const agents = DASHBOARD_PRIMARY_NAVIGATION.find((item) => item.id === "agents")!;
    const computers = DASHBOARD_PRIMARY_NAVIGATION.find((item) => item.id === "computers")!;
    const shell = true;

    // The complaint this fixes: opening a runtime from Home highlighted Agents,
    // so the item naming the place you came from lost to the one naming its kind.
    it.each(["agent", "computer", null] as const)(
      "keeps Home active inside a runtime, whatever kind resolves (%s)",
      (kind) => {
        expect(isDashboardNavigationItemActive(home, "/dashboard/agent/shared", kind, shell)).toBe(true);
        expect(isDashboardNavigationItemActive(home, "/dashboard/instances/inst_1", kind, shell)).toBe(true);
        expect(isDashboardNavigationItemActive(agents, "/dashboard/agent/shared", kind, shell)).toBe(false);
        expect(isDashboardNavigationItemActive(computers, "/dashboard/agent/shared", kind, shell)).toBe(false);
      },
    );

    it("leaves the inventory routes to Agents and Computers", () => {
      expect(isDashboardNavigationItemActive(agents, "/dashboard/agents", "agent", shell)).toBe(true);
      expect(isDashboardNavigationItemActive(computers, "/dashboard/computers", "computer", shell)).toBe(true);
      expect(isDashboardNavigationItemActive(home, "/dashboard/agents", null, shell)).toBe(false);
      expect(isDashboardNavigationItemActive(home, "/dashboard/computers", null, shell)).toBe(false);
      // An inventory path that merely starts with a claimed prefix is not one.
      expect(isDashboardNavigationItemActive(agents, "/dashboard/agents-not-real", null, shell)).toBe(false);
    });

    it("keeps Home's other destinations working", () => {
      for (const path of ["/dashboard", "/dashboard/command", "/dashboard/ops", "/dashboard/insights"]) {
        expect(isDashboardNavigationItemActive(home, path, null, shell)).toBe(true);
      }
    });

    it("does not change the legacy shell, where Agents still owns the detail route", () => {
      expect(isDashboardNavigationItemActive(home, "/dashboard/agent/shared", "agent", false)).toBe(false);
      expect(isDashboardNavigationItemActive(agents, "/dashboard/agent/shared", "agent", false)).toBe(true);
    });
  });
});
