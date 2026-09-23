/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TasksPanel } from "../TasksPanel";

// TaskModal renders a marker only while open, so a click that opens the create
// modal is observable. It stays pure here — we only care that it was opened.
jest.mock("../TaskModal", () => ({
  __esModule: true,
  TaskModal: ({ isOpen, agentName }: { isOpen: boolean; agentName?: string }) =>
    isOpen ? <div data-testid="task-modal-open">{agentName}</div> : null,
}));

// The paywall renders a marker whenever it is mounted (the panel only mounts it
// when paywallOpen is true).
jest.mock("@/components/billing/UpgradePaywallModal", () => ({
  __esModule: true,
  UpgradePaywallModal: ({ feature }: { feature: string }) => (
    <div data-testid="paywall-open">{feature}</div>
  ),
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

function mockCronList(jobs: unknown[]) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/cron?profile=all")) {
      return Promise.resolve({ ok: true, json: async () => jobs });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }) as jest.Mock;
}

async function renderPanel(props: { isFreePlan: boolean }) {
  await act(async () => {
    render(
      <TasksPanel
        instanceId="inst_1"
        agentName="Atlas"
        agentStatus="running"
        isFreePlan={props.isFreePlan}
        currentPlan={props.isFreePlan ? "free" : "operator"}
      />
    );
  });
  // Let the initial job-load settle out of the loading state.
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /new task/i })).toBeInTheDocument()
  );
}

describe("TasksPanel — Free keeps one standing task", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("lets a Free user with 0 jobs open the create modal (no paywall)", async () => {
    mockCronList([]);
    await renderPanel({ isFreePlan: true });

    fireEvent.click(screen.getByRole("button", { name: /new task/i }));

    expect(screen.getByTestId("task-modal-open")).toBeInTheDocument();
    expect(screen.queryByTestId("paywall-open")).not.toBeInTheDocument();
  });

  it("shows the paywall when a Free user with 1 job clicks New task", async () => {
    mockCronList([
      { id: "job-1", name: "Daily digest", enabled: true, prompt: "x" },
    ]);
    await renderPanel({ isFreePlan: true });

    fireEvent.click(screen.getByRole("button", { name: /new task/i }));

    expect(screen.getByTestId("paywall-open")).toHaveTextContent("cron");
    expect(screen.queryByTestId("task-modal-open")).not.toBeInTheDocument();
  });

  it("lets a Pro user create even when they already have a job (no paywall)", async () => {
    mockCronList([
      { id: "job-1", name: "Daily digest", enabled: true, prompt: "x" },
    ]);
    await renderPanel({ isFreePlan: false });

    fireEvent.click(screen.getByRole("button", { name: /new task/i }));

    expect(screen.getByTestId("task-modal-open")).toBeInTheDocument();
    expect(screen.queryByTestId("paywall-open")).not.toBeInTheDocument();
  });

  it("lets a Free user with 0 jobs open the create modal from the empty state", async () => {
    mockCronList([]);
    await renderPanel({ isFreePlan: true });

    fireEvent.click(screen.getByRole("button", { name: /create your first task/i }));

    expect(screen.getByTestId("task-modal-open")).toBeInTheDocument();
    expect(screen.queryByTestId("paywall-open")).not.toBeInTheDocument();
  });

  it("names the agent in the task modal", async () => {
    mockCronList([]);
    await renderPanel({ isFreePlan: false });

    fireEvent.click(screen.getByRole("button", { name: /new task/i }));

    expect(screen.getByTestId("task-modal-open")).toHaveTextContent("Atlas");
  });

  it("wraps a long unbroken run error instead of scrolling the panel sideways", async () => {
    const longError = "E".repeat(240);
    mockCronList([
      { id: "job-1", name: "Daily digest", enabled: true, prompt: "x", last_error: longError },
    ]);
    await renderPanel({ isFreePlan: false });

    const error = screen.getByText(longError, { exact: false });
    expect(error).toHaveStyle({ flexBasis: "100%", minWidth: "0", overflowWrap: "anywhere" });
    expect(screen.getByRole("button", { name: /delete/i }).parentElement).toHaveClass("task-actions");
  });
});
