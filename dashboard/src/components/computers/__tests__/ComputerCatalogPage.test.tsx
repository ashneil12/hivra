/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { ComputerCatalogPage } from "../ComputerCatalogPage";

const mockSearchParamsGet = jest.fn();
const mockSearchParamsGetAll = jest.fn();
const mockRouterReplace = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockRouterReplace }),
  useSearchParams: () => ({
    get: mockSearchParamsGet,
    getAll: mockSearchParamsGetAll,
  }),
}));

describe("ComputerCatalogPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsGet.mockReturnValue(null);
    mockSearchParamsGetAll.mockReturnValue([]);
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/hivra/agents")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { agents: [] } }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  it("routes both computer launch actions through the unified journey", async () => {
    render(<ComputerCatalogPage />);

    await screen.findByText("No computers yet");
    expect(
      screen.getByRole("link", { name: /^Launch computer$/i }),
    ).toHaveAttribute("href", "/dashboard/launch?kind=computer&start=1");
    fireEvent.click(screen.getByText("Browse operating systems"));
    expect(
      screen.getByRole("link", { name: /Launch Ubuntu Desktop/i }),
    ).toHaveAttribute(
      "href",
      "/dashboard/launch?kind=computer&start=1&profile=ubuntu-desktop",
    );
    // Linux Sandbox is launchable from the catalog, not only from Launch.
    expect(
      screen.getByRole("link", { name: /Launch Linux Sandbox/i }),
    ).toHaveAttribute(
      "href",
      "/dashboard/launch?kind=computer&start=1&profile=linux-terminal",
    );
    expect(screen.getByText(/Add one in Capacity first/i, { selector: "article#linux-sandbox p" })).toBeInTheDocument();
  });

  it("brings an opened OS catalog below the fold to the top under its heading", async () => {
    const scroll = jest.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      render(<ComputerCatalogPage />);
      await screen.findByText("No computers yet");
      const details = screen
        .getByText("Browse operating systems")
        .closest("details") as HTMLDetailsElement;
      const grid = details.querySelector("article")?.parentElement as HTMLElement;
      const top = jest.spyOn(grid, "getBoundingClientRect");

      // Opened with its first card already on screen: the page stays put.
      top.mockReturnValue({ top: 200 } as DOMRect);
      details.open = true;
      fireEvent(details, new Event("toggle"));
      expect(scroll).not.toHaveBeenCalled();

      // Opened at the bottom edge: the heading goes to the top, not the grid,
      // so the tapped summary and its collapse control stay visible.
      details.open = false;
      fireEvent(details, new Event("toggle"));
      top.mockReturnValue({ top: window.innerHeight - 40 } as DOMRect);
      details.open = true;
      fireEvent(details, new Event("toggle"));
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenCalledWith({ block: "start" });
      expect(scroll.mock.instances[0]).toBe(details);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("brings a linked profile card into view when the catalog opens", async () => {
    const scroll = jest.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    window.history.replaceState(null, "", "#omarchy");
    try {
      render(<ComputerCatalogPage />);
      await screen.findByText("No computers yet");
      const details = screen
        .getByText("Browse operating systems")
        .closest("details") as HTMLDetailsElement;
      expect(details.open).toBe(true);
      fireEvent(details, new Event("toggle"));
      expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
      expect(scroll.mock.instances.at(-1)).toBe(details.querySelector("#omarchy"));
    } finally {
      window.history.replaceState(null, "", window.location.pathname);
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("keeps Omarchy's prepared path while presenting Windows as needing your own server", async () => {
    render(<ComputerCatalogPage />);

    await screen.findByText("No computers yet");
    fireEvent.click(screen.getByText("Browse operating systems"));
    expect(
      screen.getByRole("heading", { name: "Ubuntu Desktop" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Omarchy" }),
    ).toBeInTheDocument();
    const omarchyCard = screen
      .getByRole("heading", { name: "Omarchy" })
      .closest("article") as HTMLElement;
    expect(within(omarchyCard).getByText("Preview")).toBeInTheDocument();
    expect(
      within(omarchyCard).getByText("Full Linux desktop in your browser"),
    ).toBeInTheDocument();
    // Substrate details stay available, but behind a collapsed disclosure.
    expect(screen.getAllByText(/^Prepared computer\.$/i)).toHaveLength(1);
    expect(screen.getByText(/^Prepared computer\.$/i)).not.toBeVisible();
    fireEvent.click(within(omarchyCard).getByText("Technical details"));
    expect(screen.getByText(/^Prepared computer\.$/i)).toBeVisible();
    expect(omarchyCard).not.toHaveTextContent(/Canary ready/);
    expect(
      screen.getByRole("link", { name: /Launch Omarchy/i }),
    ).toHaveAttribute(
      "href",
      "/dashboard/launch?kind=computer&start=1&profile=omarchy",
    );
    expect(
      screen.getByRole("heading", { name: "Windows" }),
    ).toBeInTheDocument();
    const windowsCard = screen.getByRole("heading", { name: "Windows" }).closest("article");
    expect(windowsCard).toHaveTextContent("Needs your own server that can run Windows. Add one in Capacity first.");
    expect(windowsCard).not.toHaveTextContent(/Canary ready|prepared Canary|evaluation/i);
    expect(
      screen.getByRole("link", { name: /Launch Windows/i }),
    ).toHaveAttribute(
      "href",
      "/dashboard/launch?kind=computer&start=1&profile=windows",
    );
    expect(
      screen.getByRole("heading", { name: "Windows" }).closest("article"),
    ).toHaveAttribute("id", "windows");
  });

  it("preserves an infrastructure target handoff in the unified launch link", async () => {
    mockSearchParamsGetAll.mockImplementation((key: string) =>
      key === "targetId" ? ["22222222-2222-4222-8222-222222222222"] : [],
    );
    render(<ComputerCatalogPage />);

    await screen.findByText("No computers yet");
    expect(
      screen.getByRole("link", { name: /^Launch computer$/i }),
    ).toHaveAttribute(
      "href",
      "/dashboard/launch?kind=computer&start=1&targetId=22222222-2222-4222-8222-222222222222",
    );
  });

  it("redirects the old inline-launch deep link into the unified journey", async () => {
    mockSearchParamsGet.mockImplementation((key: string) =>
      key === "launch" ? "1" : null,
    );
    mockSearchParamsGetAll.mockImplementation((key: string) =>
      key === "targetId" ? ["22222222-2222-4222-8222-222222222222"] : [],
    );
    render(<ComputerCatalogPage />);

    await waitFor(() =>
      expect(mockRouterReplace).toHaveBeenCalledWith(
        "/dashboard/launch?kind=computer&start=1&targetId=22222222-2222-4222-8222-222222222222",
      ),
    );
  });

  it("shows only canonical computer resources and does not relabel Hermes agents", async () => {
    (global.fetch as jest.Mock).mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/hivra/agents")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                agents: [
                  {
                    id: "agent-1",
                    type: "codex",
                    name: "Code Agent",
                    status: "running",
                    cpu: 2,
                    ram: 4,
                  },
                  {
                    id: "computer-1",
                    type: "linux-desktop",
                    computer_profile: "ubuntu-desktop",
                    name: "Ubuntu Workstation",
                    status: "running",
                    cpu: 2,
                    ram: 4,
                  },
                ],
              },
            }),
          } as Response;
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );

    render(<ComputerCatalogPage />);

    expect(await screen.findByText("Ubuntu Workstation")).toBeInTheDocument();
    expect(screen.queryByText("Code Agent")).not.toBeInTheDocument();
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([input]) =>
        String(input).includes("/api/instances"),
      ),
    ).toBe(false);
  });

  it("keeps capacity and agent inventories as separate destinations", async () => {
    render(<ComputerCatalogPage />);

    await screen.findByText("No computers yet");
    expect(
      screen.getByRole("link", { name: /Capacity/i }),
    ).toHaveAttribute("href", "/dashboard/infrastructure");
    expect(
      // An agent's computer is its own: point there instead of calling agents
      // "not operating systems" (ATT-11).
      screen.getByText("Agents run on their own computer. Open them, and their computer, from Agents."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Agents/i })).toHaveAttribute(
      "href",
      "/dashboard/agents",
    );
  });
  it("searches operating systems, filters status, and keeps each native desktop route", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          agents: [
            {
              id: "arch",
              type: "linux-desktop",
              computer_profile: "omarchy",
              name: "Design workstation",
              status: "running",
              cpu: 4,
              ram: 8,
            },
            {
              id: "win",
              type: "linux-desktop",
              computer_profile: "windows",
              name: "Test machine",
              status: "stopped",
              cpu: 4,
              ram: 8,
            },
            {
              id: "broken",
              type: "linux-desktop",
              computer_profile: "ubuntu-desktop",
              name: "Needs repair",
              status: "error",
              cpu: 2,
              ram: 4,
            },
          ],
        },
      }),
    });
    render(<ComputerCatalogPage />);
    await screen.findByText("Design workstation");
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search computers" }),
      { target: { value: "omarchy" } },
    );
    expect(
      screen.getByRole("link", { name: /Design workstation/ }),
    ).toHaveAttribute("href", "/dashboard/agent/arch?tab=desktop");
    expect(screen.queryByText("Test machine")).not.toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search computers" }),
      { target: { value: "" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Stopped" }));
    expect(screen.getByRole("link", { name: /Test machine/ })).toHaveAttribute(
      "href",
      "/dashboard/agent/win?tab=desktop&open=fast",
    );
    expect(screen.queryByText("Design workstation")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.getByText("Needs repair")).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search computers" }),
      { target: { value: "missing" } },
    );
    expect(screen.getByText("No matching computers")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Clear search and filters" }),
    );
    expect(screen.getByText("Design workstation")).toBeInTheDocument();
  });

  it("keeps the operating-system catalog out of daily inventory until requested", async () => {
    render(<ComputerCatalogPage />);
    await screen.findByText("No computers yet");
    expect(
      screen.getByRole("link", { name: /Launch Ubuntu Desktop/i }),
    ).not.toBeVisible();
    expect(
      screen.getByRole("link", { name: /^Launch computer$/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Browse operating systems"));
    expect(
      screen.getByRole("link", { name: /Launch Ubuntu Desktop/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Launch Omarchy/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Launch Windows/i }),
    ).toBeInTheDocument();
  });

  it("labels rows with the shared status words and filters starting computers", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          agents: [
            {
              id: "new",
              type: "linux-desktop",
              computer_profile: "ubuntu-desktop",
              name: "Fresh desktop",
              status: "provisioning",
              cpu: 2,
              ram: 4,
            },
            {
              id: "broken",
              type: "linux-desktop",
              computer_profile: "ubuntu-desktop",
              name: "Needs repair",
              status: "error",
              cpu: 2,
              ram: 4,
            },
            {
              id: "on",
              type: "linux-desktop",
              computer_profile: "ubuntu-desktop",
              name: "Daily driver",
              status: "running",
              cpu: 2,
              ram: 4,
            },
          ],
        },
      }),
    });
    render(<ComputerCatalogPage />);
    const fresh = await screen.findByRole("link", { name: /Fresh desktop/ });
    expect(fresh).toHaveTextContent("Starting");
    expect(fresh).not.toHaveTextContent(/provisioning/i);
    expect(
      screen.getByRole("link", { name: /Needs repair/ }),
    ).toHaveTextContent("Needs attention");
    expect(
      screen.getByRole("link", { name: /Daily driver/ }),
    ).toHaveTextContent("Running");
    fireEvent.click(screen.getByRole("button", { name: "Starting" }));
    expect(screen.getByText("Fresh desktop")).toBeInTheDocument();
    expect(screen.queryByText("Daily driver")).not.toBeInTheDocument();
    expect(screen.queryByText("Needs repair")).not.toBeInTheDocument();
  });

  it("shows a recoverable inventory error without claiming there are no computers", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ success: false, error: "Inventory unavailable" }),
    });
    render(<ComputerCatalogPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Inventory unavailable",
    );
    expect(screen.queryByText("No computers yet")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
