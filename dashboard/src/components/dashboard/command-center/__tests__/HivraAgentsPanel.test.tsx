/** @jest-environment jsdom */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { HivraAgentsPanel } from "../HivraAgentsPanel";

const pushMock = jest.fn();
const listAgentsResultMock = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
jest.mock("@/lib/hivra/agent-api", () => ({
  listAgentsResult: () => listAgentsResultMock(),
}));
const codeAgent = {
  id: "agent-1",
  name: "Code Agent",
  type: "codex",
  status: "running",
  cpu: 2,
  ram: 4,
};

describe("HivraAgentsPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listAgentsResultMock.mockResolvedValue({ agents: [], error: null });
    global.fetch = jest.fn().mockResolvedValue({ ok: false });
  });

  it("shows a true empty state without another deployment action", async () => {
    render(<HivraAgentsPanel />);
    expect(
      await screen.findByRole("heading", { name: "No agents yet" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /deploy|launch/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps computers and deleted resources out of the agent inventory", async () => {
    listAgentsResultMock.mockResolvedValue({
      agents: [
        codeAgent,
        {
          id: "computer-1",
          name: "Ubuntu Workstation",
          type: "linux-desktop",
          status: "running",
          cpu: 2,
          ram: 4,
        },
        {
          ...codeAgent,
          id: "deleted",
          name: "Deleted agent",
          status: "deleted",
        },
      ],
      error: null,
    });
    render(<HivraAgentsPanel />);
    expect(await screen.findByText("Code Agent")).toBeInTheDocument();
    expect(screen.queryByText("Ubuntu Workstation")).not.toBeInTheDocument();
    expect(screen.queryByText("Deleted agent")).not.toBeInTheDocument();
  });

  it("searches owned names and runtime labels and clears a no-results state", async () => {
    listAgentsResultMock.mockResolvedValue({
      agents: [
        codeAgent,
        {
          ...codeAgent,
          id: "writer",
          name: "Writer",
          type: "claude-code",
          status: "stopped",
        },
      ],
      error: null,
    });
    render(<HivraAgentsPanel />);
    await screen.findByText("Code Agent");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents" }), {
      target: { value: "CLAUDE" },
    });
    expect(screen.getByText("Writer")).toBeInTheDocument();
    expect(screen.queryByText("Code Agent")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents" }), {
      target: { value: "missing" },
    });
    expect(
      screen.getByRole("heading", { name: "No matching agents" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Clear search and filters" }),
    );
    expect(screen.getByText("Code Agent")).toBeInTheDocument();
  });

  it("filters normalized running, attention, and stopped states across both projections", async () => {
    listAgentsResultMock.mockResolvedValue({
      agents: [
        codeAgent,
        { ...codeAgent, id: "bad", name: "Needs repair", status: "error" },
      ],
      error: null,
    });
    render(
      <HivraAgentsPanel
        hermesInstances={[
          { id: "paused", name: "Paused Hermes", status: "paused" },
        ]}
      />,
    );
    await screen.findByText("Code Agent");
    fireEvent.click(screen.getByRole("button", { name: "Stopped" }));
    expect(screen.getByText("Paused Hermes")).toBeInTheDocument();
    expect(screen.queryByText("Code Agent")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    expect(screen.getByText("Needs repair")).toBeInTheDocument();
    expect(screen.queryByText("Paused Hermes")).not.toBeInTheDocument();
  });

  it("preserves resource identity, native tools routes, and the Hivra query", async () => {
    listAgentsResultMock.mockResolvedValue({
      agents: [codeAgent],
      error: null,
    });
    render(<HivraAgentsPanel hivraQuery="?hivra=1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Open Code Agent/ }),
    );
    expect(pushMock).toHaveBeenCalledWith("/dashboard/agent/agent-1?hivra=1");
    fireEvent.click(screen.getByText("Actions"));
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(pushMock).toHaveBeenCalledWith(
      "/dashboard/agent/agent-1?tab=manage&tools=1&hivra=1",
    );
  });

  it("preserves the Hermes detail, console, and verified browser entry points", async () => {
    const onOpen = jest.fn();
    const onConsole = jest.fn();
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });
    render(
      <HivraAgentsPanel
        hermesInstances={[
          { id: "hermes-1", name: "Research", status: "running" },
        ]}
        onOpenInstance={onOpen}
        onOpenConsole={onConsole}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Open Research/ }),
    );
    expect(onOpen).toHaveBeenCalledWith("hermes-1");
    fireEvent.click(screen.getByText("Actions"));
    fireEvent.click(screen.getByRole("button", { name: "Console" }));
    expect(onConsole).toHaveBeenCalledWith("hermes-1");
    fireEvent.click(await screen.findByRole("button", { name: "Browser" }));
    expect(open).toHaveBeenCalledWith(
      "/api/instances/hermes-1/browser-stream",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });

  it("retains last successful rows after refresh failure and never turns an error into empty state", async () => {
    listAgentsResultMock
      .mockResolvedValueOnce({ agents: [codeAgent], error: null })
      .mockResolvedValue({ agents: [], error: "Inventory offline" });
    render(<HivraAgentsPanel />);
    await screen.findByText("Code Agent");
    fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Inventory offline",
    );
    expect(screen.getByText("Code Agent")).toBeInTheDocument();
    expect(screen.queryByText("No agents yet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(listAgentsResultMock).toHaveBeenCalledTimes(3));
  });

  it("waits for both inventories before declaring the workspace empty", async () => {
    const { rerender } = render(<HivraAgentsPanel hermesLoading />);
    await waitFor(() => expect(listAgentsResultMock).toHaveBeenCalled());
    expect(screen.getByRole("status")).toHaveTextContent("Loading agents");
    expect(screen.queryByText("No agents yet")).not.toBeInTheDocument();
    rerender(<HivraAgentsPanel hermesError="Hermes inventory unavailable" />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Hermes inventory unavailable",
    );
    expect(screen.queryByText("No agents yet")).not.toBeInTheDocument();
  });
});
