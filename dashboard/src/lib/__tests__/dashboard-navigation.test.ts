import {
  DASHBOARD_LAUNCH_NAVIGATION,
  DASHBOARD_MOBILE_MORE_GROUPS,
  DASHBOARD_MOBILE_MORE_NAVIGATION,
  DASHBOARD_MOBILE_NAVIGATION,
  DASHBOARD_PRIMARY_NAVIGATION,
  DASHBOARD_SECONDARY_NAVIGATION,
  DASHBOARD_UTILITY_NAVIGATION,
  filterDashboardNavigation,
  isDashboardNavigationItemActive,
  isRuntimeDetailPath,
  labelForNavigationItem,
  mobileNavigationCopy,
} from "@/lib/dashboard-navigation";
import { MARKETING_COPY } from "@/lib/i18n";

describe("dashboard navigation", () => {
  it("hides hosted billing from the mobile and desktop manage navigation in local auth mode", () => {
    const previous = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "local";
    try {
      expect(filterDashboardNavigation(DASHBOARD_MOBILE_MORE_NAVIGATION, true).some(item => item.id === "billing")).toBe(false);
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

  it("builds the phone bar from the shared configuration with Launch centered between the inventories", () => {
    expect(DASHBOARD_MOBILE_NAVIGATION.map((item) => item.id)).toEqual([
      "home",
      "agents",
      "launch",
      "computers",
    ]);
    expect(DASHBOARD_MOBILE_NAVIGATION[2]).toBe(DASHBOARD_LAUNCH_NAVIGATION);
    expect(
      filterDashboardNavigation(DASHBOARD_MOBILE_NAVIGATION, false).map((item) => item.id),
    ).toEqual(["home", "agents", "launch", "computers"]);
  });

  it("puts every destination that is not on the phone bar in exactly one More group", () => {
    expect(DASHBOARD_MOBILE_MORE_GROUPS.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([
      ["manage", ["activity", "infrastructure", "settings", "billing"]],
      ["help", ["applications", "help"]],
    ]);
    expect(DASHBOARD_MOBILE_MORE_NAVIGATION.map((item) => item.id)).toEqual([
      "activity", "infrastructure", "settings", "billing", "applications", "help",
    ]);
    // The same item objects as the sidebar, so a destination cannot drift.
    expect(DASHBOARD_MOBILE_MORE_NAVIGATION).toContain(DASHBOARD_SECONDARY_NAVIGATION[0]);
    const everyDestination = [
      ...DASHBOARD_PRIMARY_NAVIGATION, ...DASHBOARD_SECONDARY_NAVIGATION, DASHBOARD_LAUNCH_NAVIGATION, ...DASHBOARD_UTILITY_NAVIGATION,
    ].map((item) => item.id).sort();
    const phone = [...DASHBOARD_MOBILE_NAVIGATION, ...DASHBOARD_MOBILE_MORE_NAVIGATION].map((item) => item.id);
    expect([...phone].sort()).toEqual(everyDestination);
    expect(new Set(phone).size).toBe(phone.length);
  });

  it("localizes labels in one place", () => {
    const billing = DASHBOARD_SECONDARY_NAVIGATION.find((item) => item.id === "billing")!;
    expect(labelForNavigationItem(billing, MARKETING_COPY.en)).toBe("Billing");
    expect(labelForNavigationItem(DASHBOARD_PRIMARY_NAVIGATION[0], MARKETING_COPY["zh-CN"])).toBe("首页");
  });

  it("localizes the More-sheet destinations and phone strings once a locale provides them", () => {
    const zh = MARKETING_COPY["zh-CN"];
    // Keys the locale does not carry yet keep their English labels.
    expect(labelForNavigationItem(DASHBOARD_UTILITY_NAVIGATION[1], zh)).toBe("Help");
    expect(mobileNavigationCopy(zh)).toMatchObject({ more: "More", signOut: "Sign out", close: "关闭菜单" });

    const localized = {
      ...zh,
      dashboard: {
        ...zh.dashboard,
        nav: { ...zh.dashboard.nav, activity: "动态", billing: "账单", applications: "应用", help: "帮助", more: "更多" },
        mobileNav: { signOut: "退出登录", manage: "管理" },
      },
    };
    expect(DASHBOARD_MOBILE_MORE_NAVIGATION.map((item) => labelForNavigationItem(item, localized)))
      .toEqual(["动态", "基础设施", "设置", "账单", "应用", "帮助"]);
    expect(mobileNavigationCopy(localized)).toMatchObject({ more: "更多", signOut: "退出登录", manage: "管理", account: "Account" });
  });

  it("recognises runtime detail routes only", () => {
    expect(isRuntimeDetailPath("/dashboard/agent/abc")).toBe(true);
    expect(isRuntimeDetailPath("/dashboard/instances/inst_1/console")).toBe(true);
    expect(isRuntimeDetailPath("/dashboard/agents")).toBe(false);
    expect(isRuntimeDetailPath("/dashboard")).toBe(false);
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

  it("gives Billing its own label and icon, distinct from Settings", () => {
    const settings = DASHBOARD_SECONDARY_NAVIGATION.find((item) => item.id === "settings")!;
    const billing = DASHBOARD_SECONDARY_NAVIGATION.find((item) => item.id === "billing")!;
    // One name for the route everywhere (copy.dashboard.nav.billing is "Billing").
    expect(billing).toMatchObject({ label: "Billing", href: "/dashboard/billing" });
    // Two identical gears side by side in the collapsed rail were indistinguishable.
    expect(billing.icon).not.toBe(settings.icon);
  });

  it("highlights Billing, not Settings, on the wallet page", () => {
    const settings = DASHBOARD_SECONDARY_NAVIGATION.find((item) => item.id === "settings")!;
    const billing = DASHBOARD_SECONDARY_NAVIGATION.find((item) => item.id === "billing")!;
    for (const path of ["/dashboard/wallet", "/dashboard/wallet/withdraw"]) {
      expect(isDashboardNavigationItemActive(billing, path)).toBe(true);
      expect(isDashboardNavigationItemActive(settings, path)).toBe(false);
    }
    expect(isDashboardNavigationItemActive(billing, "/dashboard/wallet-not-real")).toBe(false);
  });

  describe("exactly one active item per route", () => {
    // Every item the sidebar renders, in its groups.
    const everyItem = [
      DASHBOARD_LAUNCH_NAVIGATION,
      ...DASHBOARD_PRIMARY_NAVIGATION,
      ...DASHBOARD_SECONDARY_NAVIGATION,
      ...DASHBOARD_UTILITY_NAVIGATION,
    ];
    const activeIds = (pathname: string, workspaceShellEnabled: boolean) =>
      everyItem
        .filter((item) => isDashboardNavigationItemActive(item, pathname, null, workspaceShellEnabled))
        .map((item) => item.id);

    it.each([
      ["/dashboard/settings/help", "help"],
      ["/dashboard/settings/applications", "applications"],
      ["/dashboard/settings", "settings"],
      ["/dashboard/settings/memory", "settings"],
      ["/dashboard/settings/referral", "settings"],
      ["/dashboard/vault", "settings"],
      ["/dashboard/wallet", "billing"],
      ["/dashboard/billing", "billing"],
      ["/dashboard/billing/activity", "billing"],
    ])("%s highlights only %s", (pathname, expected) => {
      expect(activeIds(pathname, false)).toEqual([expected]);
      expect(activeIds(pathname, true)).toEqual([expected]);
    });

    it("keeps Settings active on a settings route that merely starts like Help", () => {
      const settings = DASHBOARD_SECONDARY_NAVIGATION.find((item) => item.id === "settings")!;
      expect(isDashboardNavigationItemActive(settings, "/dashboard/settings/helpers")).toBe(true);
      expect(activeIds("/dashboard/settings/helpers", false)).toEqual(["settings"]);
    });

    describe("self-hosted (local auth), where Billing is filtered out", () => {
      const previous = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
      beforeEach(() => {
        process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "local";
      });
      afterEach(() => {
        if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
        else process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = previous;
      });

      // Only what the self-host sidebar actually renders.
      const renderedActiveIds = (pathname: string, workspaceShellEnabled: boolean) =>
        filterDashboardNavigation(everyItem, workspaceShellEnabled)
          .filter((item) => isDashboardNavigationItemActive(item, pathname, null, workspaceShellEnabled))
          .map((item) => item.id);

      it.each([
        // The wallet page and its PWA shortcut stay reachable without Billing.
        ["/dashboard/wallet", "settings"],
        ["/dashboard/wallet/withdraw", "settings"],
        ["/dashboard/settings", "settings"],
        ["/dashboard/vault", "settings"],
        ["/dashboard/settings/help", "help"],
        ["/dashboard/settings/applications", "applications"],
      ])("%s highlights only %s", (pathname, expected) => {
        expect(filterDashboardNavigation(everyItem, false).some((item) => item.id === "billing")).toBe(false);
        expect(renderedActiveIds(pathname, false)).toEqual([expected]);
        expect(renderedActiveIds(pathname, true)).toEqual([expected]);
      });

      it("does not let Settings claim a path that merely starts like the wallet", () => {
        expect(renderedActiveIds("/dashboard/wallet-not-real", false)).toEqual([]);
      });
    });

    it("leaves the wallet to Billing on hosted, even though Settings can hold it on self-host", () => {
      const settings = DASHBOARD_SECONDARY_NAVIGATION.find((item) => item.id === "settings")!;
      expect(isDashboardNavigationItemActive(settings, "/dashboard/wallet")).toBe(false);
    });
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
