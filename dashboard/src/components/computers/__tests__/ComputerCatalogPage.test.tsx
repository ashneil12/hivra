/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  });

  it("keeps Omarchy's prepared path while presenting Windows as customer capacity", async () => {
    render(<ComputerCatalogPage />);

    await screen.findByText("No computers yet");
    fireEvent.click(screen.getByText("Browse operating systems"));
    expect(
      screen.getByRole("heading", { name: "Ubuntu Desktop" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Omarchy" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Canary ready · operating system"),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/prepared Canary computer/i)).toHaveLength(1);
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
    expect(windowsCard).toHaveTextContent("Connect compatible customer-owned or self-hosted capacity to continue.");
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

  it("keeps infrastructure and agent inventories as separate destinations", async () => {
    render(<ComputerCatalogPage />);

    await screen.findByText("No computers yet");
    expect(
      screen.getByRole("link", { name: /Infrastructure/i }),
    ).toHaveAttribute("href", "/dashboard/infrastructure");
    expect(
      screen.getByText(/Those are agent runtimes, not operating systems/i),
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
