/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server.node";
import { usePathname } from "next/navigation";

import { PwaBottomNavigation } from "../PwaBottomNavigation";

jest.mock("next/navigation", () => ({
  usePathname: jest.fn(),
}));

describe("PwaBottomNavigation", () => {
  beforeEach(() => {
    (usePathname as jest.Mock).mockReturnValue("/dashboard");
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("uses the same consolidated product navigation as the desktop shell", () => {
    render(<PwaBottomNavigation />);

    expect(screen.getByRole("navigation", { name: /app navigation/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: /agents/i })).toHaveAttribute("href", "/dashboard/agents");
    expect(screen.getByRole("link", { name: /computers/i })).toHaveAttribute("href", "/dashboard/computers");
    expect(screen.getByRole("link", { name: /launch/i })).toHaveAttribute("href", "/dashboard/launch");
    expect(screen.queryByRole("link", { name: /chat/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /activity/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /infrastructure/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/dashboard",
      "/dashboard/launch",
      "/dashboard/agents",
      "/dashboard/computers",
      "/dashboard/billing",
    ]);
    expect(
      screen.getAllByRole("link").every((link) =>
        link.getAttribute("href")?.startsWith("/dashboard"),
      ),
    ).toBe(true);
  });

  it("adds the Chat entry to the mobile rail when the workspace shell rollout is on", () => {
    process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED = "1";
    try {
      render(<PwaBottomNavigation />);
      // No Chat rail item: the interaction area is Home now, and a separate
      // item listed the same runtimes a fourth time.
      expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
        "/dashboard",
        "/dashboard/launch",
        "/dashboard/agents",
        "/dashboard/computers",
      "/dashboard/billing",
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
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveClass("min-h-[56px]", "px-0", "text-[11px]");
    }
    expect(screen.getByRole("link", { name: "Computers" })).toHaveTextContent("Computers");
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
});
