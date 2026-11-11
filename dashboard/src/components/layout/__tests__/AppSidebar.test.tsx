/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { AppShellProvider } from "../AppShell";
import { AppSidebar } from "../AppSidebar";
import { useDashboardResources } from "../useDashboardResources";
import type { DashboardResource } from "../dashboard-resources";

const pushMock = jest.fn();
jest.mock("next/navigation", () => ({
  usePathname: jest.fn(),
  useRouter: () => ({ push: pushMock }),
}));
jest.mock("../useDashboardResources", () => ({ useDashboardResources: jest.fn() }));
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark", setTheme: jest.fn() }) }));

const resources: DashboardResource[] = [
  { uid: "x-a", id: "a", source: "hivra", kind: "agent", name: "Site Builder", description: "Claude Code", status: "running", href: "/dashboard/agent/a" },
  { uid: "x-b", id: "b", source: "hivra", kind: "agent", name: "Researcher", description: "Codex", status: "provisioning", href: "/dashboard/agent/b" },
  { uid: "h-w", id: "w", source: "hermes", kind: "agent", name: "Writer", description: "Hermes", status: "running", attention: "approval", href: "/dashboard/instances/w" },
  { uid: "x-c", id: "c", source: "hivra", kind: "computer", name: "Ubuntu desktop", description: "Ubuntu", status: "running", href: "/dashboard/agent/c?tab=desktop" },
  { uid: "x-d", id: "d", source: "hivra", kind: "computer", name: "Build machine", description: "Ubuntu", status: "stopped", href: "/dashboard/agent/d?tab=desktop" },
];

function mockResources(overrides: Partial<ReturnType<typeof useDashboardResources>> = {}) {
  (useDashboardResources as jest.Mock).mockReturnValue({
    resources, loading: false, errors: { hermes: null, hivra: null }, refresh: jest.fn(), ...overrides,
  });
}

function mockViewport(narrow: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: narrow && query === "(max-width: 767px)", media: query, onchange: null,
      addListener: jest.fn(), removeListener: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn(), dispatchEvent: jest.fn(),
    }),
  });
}

function shell(openSwitcher = jest.fn()) {
  return (
    <AppShellProvider openSwitcher={openSwitcher} userName="Ash" chrome>
      <AppSidebar owner="owner" accountCode="ABCD-1234" />
    </AppShellProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  pushMock.mockClear();
  mockViewport(false);
  mockResources();
  (usePathname as jest.Mock).mockReturnValue("/dashboard");
});

describe("AppSidebar", () => {
  it("keeps every global destination reachable", () => {
    render(shell());
    const sidebar = within(screen.getByRole("complementary", { name: "Workspace navigation" }));
    expect(sidebar.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/dashboard");
    expect(sidebar.getByRole("link", { name: "New agent" })).toHaveAttribute("href", "/dashboard/launch");
    expect(sidebar.getByRole("link", { name: "Agents" })).toHaveAttribute("href", "/dashboard/agents");
    expect(sidebar.getByRole("link", { name: "Computers" })).toHaveAttribute("href", "/dashboard/computers");
    expect(sidebar.getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/dashboard/activity");
    expect(sidebar.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/dashboard/settings");
    expect(sidebar.getByRole("link", { name: "Launch an agent" })).toHaveAttribute("href", "/dashboard/launch?kind=agent");
    expect(sidebar.getByRole("link", { name: "Launch a computer" })).toHaveAttribute("href", "/dashboard/launch?kind=computer");

    // The rest sit one click away in More.
    expect(sidebar.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(sidebar.getByRole("button", { name: "More" }));
    const menu = within(sidebar.getByRole("menu", { name: "More" }));
    expect(menu.getAllByRole("menuitem").map((item) => [item.textContent, item.getAttribute("href")])).toEqual([
      ["Billing", "/dashboard/billing"],
      ["Servers", "/dashboard/infrastructure"],
      ["Applications", "/dashboard/settings/applications"],
      ["Help", "/dashboard/settings/help"],
    ]);
    fireEvent.keyDown(sidebar.getByRole("menu"), { key: "Escape" });
    expect(sidebar.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("marks the page you are on, and only that one", () => {
    (usePathname as jest.Mock).mockReturnValue("/dashboard/settings");
    render(shell());
    const sidebar = within(screen.getByRole("complementary", { name: "Workspace navigation" }));
    expect(sidebar.getAllByRole("link", { current: "page" }).map((link) => link.textContent)).toEqual(["Settings"]);
  });

  it("lists agents and computers with a plain status word each", () => {
    render(shell());
    const agents = within(screen.getByRole("region", { name: "Agents" }));
    expect(agents.getAllByRole("link").filter((link) => link.getAttribute("href")?.includes("/dashboard/") && !/agents|launch/.test(link.getAttribute("href") ?? "")).map((link) => link.textContent))
      .toEqual(["Site BuilderRunning", "ResearcherStarting", "WriterNeeds you"]);
    const computers = within(screen.getByRole("region", { name: "Computers" }));
    expect(computers.getByRole("link", { name: /Ubuntu desktop/ })).toHaveTextContent("Running");
    expect(computers.getByRole("link", { name: /Build machine/ })).toHaveTextContent("Stopped");
  });

  it("opens a resource on the surface it was last left on", () => {
    render(shell());
    fireEvent.click(screen.getByRole("link", { name: /Site Builder/ }));
    expect(pushMock).toHaveBeenCalledWith("/dashboard/agent/a");
    // A modified click is the browser's own.
    pushMock.mockClear();
    fireEvent.click(screen.getByRole("link", { name: /Researcher/ }), { metaKey: true });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("expands the open agent into a slot its page fills, and no other", () => {
    (usePathname as jest.Mock).mockReturnValue("/dashboard/agent/a");
    const view = render(shell());
    const open = screen.getByRole("link", { name: /Site Builder/ });
    expect(open).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Researcher/ })).not.toHaveAttribute("aria-current");
    expect(document.querySelectorAll("[data-open-views]")).toHaveLength(1);
    expect(open.parentElement?.querySelector("[data-open-views]")).toBeInTheDocument();
    // Another page: nothing is expanded, and Home is not marked as inside an agent.
    (usePathname as jest.Mock).mockReturnValue("/dashboard/billing");
    view.rerender(shell());
    expect(document.querySelectorAll("[data-open-views]")).toHaveLength(0);
  });

  it("keeps the views slot for an agent the list has not read yet", () => {
    (usePathname as jest.Mock).mockReturnValue("/dashboard/agent/new");
    render(shell());
    expect(screen.getByText("This agent")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-open-views]")).toHaveLength(1);
  });

  it("says so while loading, when empty and when a list could not be read", () => {
    mockResources({ resources: [], loading: true });
    const view = render(shell());
    expect(document.querySelectorAll("[aria-hidden='true'] > i").length).toBeGreaterThan(0);
    mockResources({ resources: [], loading: false });
    view.rerender(shell());
    expect(screen.getByText("No agents yet")).toBeInTheDocument();
    expect(screen.getByText("No computers yet")).toBeInTheDocument();
    const refresh = jest.fn();
    mockResources({ resources: [], loading: false, errors: { hermes: "x", hivra: null }, refresh });
    view.rerender(shell());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("opens the switcher from Search", () => {
    const openSwitcher = jest.fn();
    render(shell(openSwitcher));
    fireEvent.click(screen.getByRole("button", { name: "Switch agent or computer" }));
    expect(openSwitcher).toHaveBeenCalled();
  });

  it("shows the account with its code, and the theme switch", () => {
    render(shell());
    const sidebar = within(screen.getByRole("complementary", { name: "Workspace navigation" }));
    expect(sidebar.getByText("Ash")).toBeInTheDocument();
    expect(sidebar.getByText("Account code ABCD-1234")).toBeInTheDocument();
    expect(sidebar.getByTestId("mock-user-button")).toBeInTheDocument();
  });

  it("hides, and the title bar's toggle brings it back, remembered across visits", () => {
    const view = render(shell());
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(document.querySelector("aside")).toHaveAttribute("hidden");
    expect(window.localStorage.getItem("hivra:agent-sidebar-collapsed")).toBe("true");
    view.unmount();
    render(shell());
    expect(document.querySelector("aside")).toHaveAttribute("hidden");
  });

  describe("as a phone drawer", () => {
    beforeEach(() => mockViewport(true));

    it("is closed until opened, traps focus, and closes on Escape, the backdrop or a choice", () => {
      function Opener() {
        // The title bar's menu button, reduced to what the drawer needs.
        const { useAppShell } = jest.requireActual<typeof import("../AppShellContext")>("../AppShellContext");
        const shellValue = useAppShell();
        return <button type="button" onClick={shellValue?.openSidebar}>Menu</button>;
      }
      render(
        <AppShellProvider openSwitcher={jest.fn()} userName="Ash" chrome>
          <Opener />
          <AppSidebar owner="owner" />
        </AppShellProvider>,
      );
      expect(screen.queryByRole("dialog", { name: "Workspace navigation" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
      const drawer = screen.getByRole("dialog", { name: "Workspace navigation" });
      expect(drawer).toHaveAttribute("aria-modal", "true");
      expect(drawer.contains(document.activeElement)).toBe(true);

      fireEvent.keyDown(drawer, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Workspace navigation" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
      fireEvent.click(screen.getByTestId("app-sidebar-backdrop"));
      expect(screen.queryByRole("dialog", { name: "Workspace navigation" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "Workspace navigation" })).getByRole("link", { name: "Settings" }));
      expect(screen.queryByRole("dialog", { name: "Workspace navigation" })).not.toBeInTheDocument();
    });

    it("keeps Tab inside the open drawer", () => {
      function Opener() {
        const { useAppShell } = jest.requireActual<typeof import("../AppShellContext")>("../AppShellContext");
        return <button type="button" onClick={useAppShell()?.openSidebar}>Menu</button>;
      }
      render(
        <AppShellProvider openSwitcher={jest.fn()} userName="Ash" chrome>
          <Opener />
          <AppSidebar owner="owner" />
        </AppShellProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
      const drawer = screen.getByRole("dialog", { name: "Workspace navigation" });
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
      focusable[focusable.length - 1].focus();
      fireEvent.keyDown(drawer, { key: "Tab" });
      expect(document.activeElement).toBe(focusable[0]);
      fireEvent.keyDown(drawer, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    });
  });
});
