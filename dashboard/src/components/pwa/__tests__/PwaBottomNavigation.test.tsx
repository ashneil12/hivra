/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server.node";
import { usePathname } from "next/navigation";

import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { PwaBottomNavigation } from "../PwaBottomNavigation";

jest.mock("next/navigation", () => ({
  usePathname: jest.fn(),
}));
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark", setTheme: jest.fn() }) }));

describe("PwaBottomNavigation", () => {
  beforeEach(() => {
    (usePathname as jest.Mock).mockReturnValue("/dashboard");
    window.localStorage.clear();
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("uses the same consolidated product navigation as the desktop shell", () => {
    render(<PwaBottomNavigation />);

    expect(screen.getByRole("navigation", { name: /app navigation/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute("href", "/dashboard?runtimes=1");
    expect(screen.getByRole("link", { name: /agents/i })).toHaveAttribute("href", "/dashboard/agents");
    expect(screen.getByRole("link", { name: /computers/i })).toHaveAttribute("href", "/dashboard/computers");
    expect(screen.getByRole("link", { name: /launch/i })).toHaveAttribute("href", "/dashboard/launch");
    expect(screen.queryByRole("link", { name: /chat/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /activity/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /infrastructure/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
    // Billing left the bar for More; the fifth slot is the More button.
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/dashboard?runtimes=1",
      "/dashboard/agents",
      "/dashboard/launch",
      "/dashboard/computers",
    ]);
    expect(screen.getByRole("button", { name: "More" })).toHaveAttribute("aria-haspopup", "dialog");
    expect(
      screen.getAllByRole("link").every((link) =>
        link.getAttribute("href")?.startsWith("/dashboard"),
      ),
    ).toBe(true);
  });

  // /dashboard resumes the last runtime when the server shell flag is on, and
  // self-host builds strip the client copy of that flag, so the client flag
  // cannot decide. The legacy page ignores ?runtimes=1.
  it("sends Home to the runtime list from a runtime even when the client shell flag is off", () => {
    (usePathname as jest.Mock).mockReturnValue("/dashboard/agent/abc-123");
    render(<PwaBottomNavigation />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/dashboard?runtimes=1");
  });

  it("sends Home to the runtime list under the workspace shell so it cannot resume the runtime you are in", () => {
    process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED = "1";
    (usePathname as jest.Mock).mockReturnValue("/dashboard/agent/abc-123");
    try {
      render(<PwaBottomNavigation />);
      // No Chat rail item: the interaction area is Home now, and a separate
      // item listed the same runtimes a fourth time.
      expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
        "/dashboard?runtimes=1",
        "/dashboard/agents",
        "/dashboard/launch",
        "/dashboard/computers",
      ]);
      expect(screen.queryByRole("link", { name: /chat/i })).not.toBeInTheDocument();
    } finally {
      delete process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED;
    }
  });

  it("marks Home active inside a runtime when the shell is on", () => {
    process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED = "1";
    (usePathname as jest.Mock).mockReturnValue("/dashboard/agent/abc-123");
    try {
      render(<PwaBottomNavigation />);
      expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("link", { name: /agents/i })).not.toHaveAttribute("aria-current");
    } finally {
      delete process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED;
    }
  });

  it("keeps the workspace route neutral while the shell rollout is off", () => {
    (usePathname as jest.Mock).mockReturnValue("/dashboard/workspace");
    window.localStorage.setItem("server-state-sentinel", "unchanged");

    render(<PwaBottomNavigation />);

    expect(screen.queryByRole("link", { current: "page" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("server-state-sentinel")).toBe("unchanged");
  });

  it("keeps full narrow-screen labels and touch targets inside a consistent bar height", () => {
    render(<PwaBottomNavigation />);
    const navigation = screen.getByRole("navigation", { name: "App navigation" });
    // JSDOM drops env() in inline lengths; verify React's emitted browser CSS.
    expect(renderToStaticMarkup(<PwaBottomNavigation />)).toContain("height:calc(64px + env(safe-area-inset-bottom, 0px))");
    expect(navigation.querySelector("style")).toHaveTextContent("padding-bottom: calc(64px + env(safe-area-inset-bottom, 0px))");
    for (const tab of [...screen.getAllByRole("link"), screen.getByRole("button", { name: "More" })]) {
      expect(tab).toHaveClass("min-h-[56px]", "px-0", "text-[11px]");
    }
    expect(screen.getByRole("link", { name: "Computers" })).toHaveTextContent("Computers");
  });

  it("marks exactly one tab, and Launch is an action rather than a permanent selection", () => {
    const { container } = render(<PwaBottomNavigation />);
    const marked = container.querySelectorAll('[data-active="true"]');
    expect([...marked]).toEqual([screen.getByRole("link", { name: "Home" })]);
    const launch = screen.getByRole("link", { name: "Launch" });
    expect(launch).toHaveAttribute("data-active", "false");
    expect(launch.querySelector(".hermes-pwa-bottom-nav__icon--launch")).not.toBeNull();
    expect(screen.getByRole("navigation").querySelector("style")).toHaveTextContent(".hermes-pwa-bottom-nav :is(a, button):active");
  });

  it.each([
    "/dashboard/settings",
    "/dashboard/settings/applications",
    "/dashboard/billing",
    "/dashboard/usage",
    "/dashboard/infrastructure",
    "/dashboard/vault",
  ])("marks More as the location for %s", (pathname) => {
    (usePathname as jest.Mock).mockReturnValue(pathname);
    const { container } = render(<PwaBottomNavigation />);
    expect([...container.querySelectorAll('[data-active="true"]')]).toEqual([screen.getByRole("button", { name: "More" })]);
    expect(screen.queryByRole("link", { current: "page" })).not.toBeInTheDocument();
  });

  it("badges More with the attention count", () => {
    render(<PwaBottomNavigation attentionCount={3} />);
    const more = screen.getByRole("button", { name: "More, 3 need attention" });
    expect(more).toHaveTextContent("3");
  });

  it("opens the More sheet and closes it when the route changes", () => {
    const onOpenSwitcher = jest.fn();
    const view = render(<PwaBottomNavigation attentionCount={2} userName="Ash" userEmail="ash@example.com" onOpenSwitcher={onOpenSwitcher} />);
    const more = screen.getByRole("button", { name: "More, 2 need attention" });
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    const sheet = screen.getByRole("dialog", { name: "More" });
    expect(within(sheet).getByRole("link", { name: "2 agents or computers need attention" })).toHaveAttribute("href", "/dashboard?runtimes=1&attention=1");

    (usePathname as jest.Mock).mockReturnValue("/dashboard/settings");
    view.rerender(<PwaBottomNavigation attentionCount={2} userName="Ash" userEmail="ash@example.com" onOpenSwitcher={onOpenSwitcher} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More, 2 need attention" })).toHaveAttribute("aria-expanded", "false");

    // Returning to the route it was opened on does not reopen it.
    (usePathname as jest.Mock).mockReturnValue("/dashboard");
    view.rerender(<PwaBottomNavigation attentionCount={2} userName="Ash" userEmail="ash@example.com" onOpenSwitcher={onOpenSwitcher} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("hands Switch or search to the shell switcher and closes the sheet first", () => {
    const onOpenSwitcher = jest.fn();
    render(<PwaBottomNavigation onOpenSwitcher={onOpenSwitcher} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Switch or search" }));
    expect(onOpenSwitcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("treats instance WebUI routes as part of Agents", () => {
    (usePathname as jest.Mock).mockReturnValue("/dashboard/instances/inst_123");

    render(<PwaBottomNavigation />);

    expect(screen.getByRole("link", { name: /agents/i })).toHaveAttribute("aria-current", "page");
  });

  it.each([
    ["computer", "Computers"],
    ["agent", "Agents"],
  ] as const)("uses the loaded %s kind on shared detail routes", (resourceKind, active) => {
    (usePathname as jest.Mock).mockReturnValue("/dashboard/agent/resource_123");
    render(<PwaBottomNavigation resourceKind={resourceKind} />);
    expect(screen.getAllByRole("link", { current: "page" })).toEqual([screen.getByRole("link", { name: active })]);
  });

  it("keeps a shared detail route neutral until its resource kind is known", () => {
    (usePathname as jest.Mock).mockReturnValue("/dashboard/agent/resource_123");
    render(<PwaBottomNavigation />);
    expect(screen.queryByRole("link", { current: "page" })).not.toBeInTheDocument();
  });

  it("leaves Activity out of the mobile rail while the shared navigation still maps its routes", () => {
    (usePathname as jest.Mock).mockReturnValue("/dashboard/usage");

    render(<PwaBottomNavigation />);

    expect(screen.queryByRole("link", { name: /activity/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { current: "page" })).not.toBeInTheDocument();
  });

  it("localizes the bar labels like the sidebar", () => {
    render(<LocaleProvider initialLocale="zh-CN"><PwaBottomNavigation /></LocaleProvider>);
    expect(screen.getByRole("link", { name: "首页" })).toHaveAttribute("href", "/dashboard?runtimes=1");
    expect(screen.getByRole("link", { name: "智能体" })).toHaveAttribute("href", "/dashboard/agents");
  });
});
