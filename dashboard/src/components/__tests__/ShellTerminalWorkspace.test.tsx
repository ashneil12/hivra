/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { getTerminalWorkspaceStorageKey } from "@/lib/terminal-workspace-state";

const terminalPanelMock = jest.fn(
  ({
    surfaceKey,
    isActive,
  }: {
    surfaceKey?: string;
    isActive: boolean;
  }) => <div data-testid={`terminal-panel-${surfaceKey}`}>{`${surfaceKey}:${isActive ? "active" : "idle"}`}</div>
);

jest.mock("@/components/TerminalPanel", () => ({
  TerminalPanel: (props: {
    instanceId: string;
    isActive: boolean;
    sessionMode?: "shell" | "tui";
    surfaceKey?: string;
  }) => terminalPanelMock(props),
}));

const { ShellTerminalWorkspace } = jest.requireActual("../ShellTerminalWorkspace") as typeof import("../ShellTerminalWorkspace");

describe("ShellTerminalWorkspace", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it("lazy-mounts tabs and keeps visited tabs mounted when switching", async () => {
    window.localStorage.setItem(
      getTerminalWorkspaceStorageKey("inst_123"),
      JSON.stringify({
        panelHeight: 280,
        terminalCounter: 2,
        activeTabId: "tab_1",
        tabs: [
          { id: "tab_1", title: "Terminal 1", status: "active" },
          { id: "tab_2", title: "Terminal 2", status: "idle" },
        ],
      })
    );

    render(<ShellTerminalWorkspace instanceId="inst_123" isActive />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-panel-tab_1")).toHaveTextContent("tab_1:active");
    });

    expect(screen.queryByTestId("terminal-panel-tab_2")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^terminal 2$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("terminal-panel-tab_2")).toHaveTextContent("tab_2:active");
    });

    expect(screen.getByTestId("terminal-panel-tab_1")).toHaveTextContent("tab_1:idle");
    const surfaceKeys = terminalPanelMock.mock.calls.map(([props]) => props.surfaceKey);
    expect(surfaceKeys).toContain("tab_1");
    expect(surfaceKeys).toContain("tab_2");
  });

  it("opens a new tab and persists the workspace state per instance", async () => {
    render(<ShellTerminalWorkspace instanceId="inst_123" isActive />);

    await waitFor(() => {
      expect(screen.getByTestId("shell-terminal-workspace")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /open another terminal tab/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^terminal 2$/i })).toBeInTheDocument();
    });

    const storedState = JSON.parse(
      window.localStorage.getItem(getTerminalWorkspaceStorageKey("inst_123")) || "null"
    ) as {
      activeTabId: string;
      terminalCounter: number;
      tabs: Array<{ id: string; title: string }>;
    } | null;

    expect(storedState).not.toBeNull();
    expect(storedState?.terminalCounter).toBe(2);
    expect(storedState?.tabs).toHaveLength(2);
    expect(storedState?.tabs.map((tab) => tab.title)).toEqual(["Terminal 1", "Terminal 2"]);
    expect(storedState?.activeTabId).toBe(storedState?.tabs[1]?.id);
  });
});
