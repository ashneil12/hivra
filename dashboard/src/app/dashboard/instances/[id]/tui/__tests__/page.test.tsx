/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

const pushMock = jest.fn();
let mockResolvedTheme: "dark" | "light" = "dark";

jest.mock("next/navigation", () => ({
  useParams: () => ({
    id: "inst_123",
  }),
  useRouter: () => ({
    push: pushMock,
  }),
}));

jest.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: mockResolvedTheme,
  }),
}));

jest.mock("@/components/TerminalPanel", () => ({
  TerminalPanel: ({
    instanceId,
    sessionMode,
    surfaceKey,
  }: {
    instanceId: string;
    sessionMode?: string;
    surfaceKey?: string;
  }) => (
    <div>{`terminal:${instanceId}:${sessionMode || "shell"}:${surfaceKey || "none"}`}</div>
  ),
}));

jest.mock("@/lib/hooks/useProfiles", () => ({
  useProfiles: () => ({
    profiles: [
      { id: "profile-default", name: "default", display_name: "Atlas", status: "running" },
      { id: "profile-research", name: "research", display_name: "Research", status: "running" },
    ],
    isLoading: false,
  }),
}));

const DedicatedHermesTuiPage = jest.requireActual("../page").default as typeof import("../page").default;

describe("DedicatedHermesTuiPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolvedTheme = "dark";
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/api/instances/inst_123/browser-sessions")) {
        return {
          ok: true,
          json: async () => ({ status: "ok" }),
        } as Response;
      }

      if (url.includes("/api/instances/inst_123?no_sync=true")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              id: "inst_123",
              name: "Atlas",
              status: "running",
              provider: "openrouter",
              gateway_url: "https://agent.example.com",
              config: {
                model: "gpt-5.4",
              },
            },
          }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as jest.Mock;
  });

  it("renders the shared TerminalPanel as the dedicated Hermes TUI workspace", async () => {
    await act(async () => {
      render(<DedicatedHermesTuiPage params={Promise.resolve({ id: "inst_123" })} />);
    });

    expect(screen.getByTestId("dedicated-tui-shell")).toBeInTheDocument();
    expect((await screen.findAllByText(/hermes tui/i)).length).toBeGreaterThan(0);
    expect(screen.getByText("terminal:inst_123:tui:tui-fullpage")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open workspace details/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch to/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));
    expect(pushMock).toHaveBeenCalledWith("/dashboard/instances/inst_123?surface=chat");
  });

  it("keeps workspace details without a transport switch", async () => {
    await act(async () => {
      render(<DedicatedHermesTuiPage params={Promise.resolve({ id: "inst_123" })} />);
    });

    fireEvent.click(screen.getByRole("button", { name: /open workspace details/i }));
    const sidebar = document.querySelector('[data-tui-rail="sidebar"]') as HTMLElement;

    expect(sidebar).toHaveStyle({
      overflow: "auto",
      position: "absolute",
    });
    expect(within(sidebar).getByText(/^Connection$/i)).toBeInTheDocument();
    expect(within(sidebar).getByText(/terminal bridge/i)).toBeInTheDocument();
    expect(within(sidebar).getByText(/^Agent profiles$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reconnect terminal/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open live browser/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch to stable connection/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch to direct tui mode/i })).not.toBeInTheDocument();
  });

  it("adapts the workspace chrome to light mode", async () => {
    mockResolvedTheme = "light";

    await act(async () => {
      render(<DedicatedHermesTuiPage params={Promise.resolve({ id: "inst_123" })} />);
    });

    expect(screen.getByTestId("dedicated-tui-shell")).toHaveAttribute("data-color-mode", "light");
    expect(screen.getByTestId("dedicated-tui-shell")).toHaveStyle({
      color: "rgba(37, 28, 16, 0.96)",
    });
    expect(screen.getByTestId("dedicated-tui-terminal-card")).toHaveStyle({
      border: "1px solid rgba(154, 108, 5, 0.2)",
    });
  });

  it("renders the embedded terminal surface for WebUI-backed workspaces once the direct terminal socket is available", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/api/instances/inst_123/browser-sessions")) {
        return {
          ok: true,
          json: async () => ({ status: "ok" }),
        } as Response;
      }

      if (url.includes("/api/instances/inst_123?no_sync=true")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              id: "inst_123",
              name: "Atlas",
              status: "running",
              backend: "webui",
              provider: "openrouter",
              gateway_url: "https://webui.example.com",
              config: {
                model: "gpt-5.4",
              },
            },
          }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as jest.Mock;

    await act(async () => {
      render(<DedicatedHermesTuiPage params={Promise.resolve({ id: "inst_123" })} />);
    });

    expect(screen.getByText("terminal:inst_123:tui:tui-fullpage")).toBeInTheDocument();
    expect(screen.queryByText(/legacy webui runtime/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fast embedded hermes tui is disabled/i)).not.toBeInTheDocument();
  });

  it("offers Make default in the utility rail for narrow screens", async () => {
    await act(async () => {
      render(<DedicatedHermesTuiPage params={Promise.resolve({ id: "inst_123" })} />);
    });

    fireEvent.click(screen.getByRole("button", { name: /open workspace details/i }));
    const sidebar = document.querySelector('[data-tui-rail="sidebar"]') as HTMLElement;
    const makeDefault = within(sidebar).getByRole("button", { name: /make default/i });
    expect(makeDefault).toHaveClass("tui-rail-default");
    fireEvent.click(makeDefault);
    expect(within(sidebar).getByRole("button", { name: /default workspace/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Set as default workspace" })).toHaveAttribute("aria-pressed", "true");
  });

  it("marks the header chrome that phones collapse and the soft keyboard hides", async () => {
    await act(async () => {
      render(<DedicatedHermesTuiPage params={Promise.resolve({ id: "inst_123" })} />);
    });

    const header = screen.getByTestId("dedicated-tui-header");
    expect(header).toHaveClass("tui-header");
    expect(screen.getByTestId("dedicated-tui-workspace")).toHaveClass("tui-workspace");
    expect(screen.getByTestId("dedicated-tui-shell")).toHaveClass("tui-shell");
    // Runtime details repeat the utility rail, so phones drop them from the one-row header.
    expect(within(header).getByText("gpt-5.4").parentElement).toHaveClass("tui-header-meta");
    expect(within(header).getByText("Hermes TUI")).toHaveClass("tui-header-subtitle");
    const css = document.querySelector('[data-testid="dedicated-tui-shell"] style')?.textContent ?? "";
    expect(css).toContain('[data-keyboard-open="true"] .tui-header { display: none !important; }');
    expect(css).toContain('[data-keyboard-open="true"] .tui-workspace { grid-template-rows: minmax(0, 1fr) !important;');
  });
});
