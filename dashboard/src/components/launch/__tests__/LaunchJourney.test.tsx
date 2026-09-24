/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LaunchJourney } from "../LaunchJourney";

const routerPushMock = jest.fn();
const searchParamsGetMock = jest.fn();
const fetchPlanStrictMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
  useSearchParams: () => ({ get: searchParamsGetMock, getAll: () => [] }),
}));

jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  fetchPlanStrict: () => fetchPlanStrictMock(),
}));

const PAID_PLAN = {
  subscribed: true,
  name: "Operator",
  key: "operator",
  maxAgents: 4,
  maxCpuPerAgent: 8,
  maxRamPerAgent: 16,
  poolCpu: 16,
  poolRam: 32,
  usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
};

const TOUCH_QUERY = "(max-width: 640px), (max-width: 1023px) and (pointer: coarse)";

function mockMatchMedia(matchingQuery: string | null) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn((query: string) => ({
      matches: query === matchingQuery,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
}

function historyStage() {
  return new URLSearchParams(window.location.search).get("stage");
}

describe("LaunchJourney", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/dashboard/launch");
    searchParamsGetMock.mockReturnValue(null);
    fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, data: { targets: [] } }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  function renderAtCapacity() {
    searchParamsGetMock.mockImplementation((key: string) => ({
      kind: "computer",
      profile: "ubuntu-desktop",
      start: "1",
    } as Record<string, string>)[key] ?? null);
    render(<LaunchJourney />);
  }

  it.each([
    ["phones and touch tablets", TOUCH_QUERY],
    ["desktop", null],
  ])("keeps the reserved and maximum pickers behind Customize on %s", async (_label, query) => {
    mockMatchMedia(query);
    renderAtCapacity();

    await screen.findByRole("heading", { name: "Ubuntu Desktop — here's the plan" });
    expect(screen.queryByLabelText("Reserved CPU")).not.toBeInTheDocument();
    const customize = screen.getByRole("button", { name: "Customize" });
    expect(customize).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(customize);
    expect(customize).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Reserved CPU")).toBeVisible();
    expect(screen.getByLabelText("Maximum memory")).toBeVisible();
  });

  it("describes reserved memory without VM jargon", async () => {
    renderAtCapacity();

    await screen.findByRole("heading", { name: "Ubuntu Desktop — here's the plan" });
    expect(screen.getByText(/Reserved memory is always kept for this computer/)).toBeInTheDocument();
    expect(screen.queryByText(/balloon floor/)).not.toBeInTheDocument();
  });

  it("gives each forward step a history entry so system back steps back through the journey", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });

    fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
    expect(screen.getByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    expect(historyStage()).toBe("plan");
    expect(window.history.state).toEqual(expect.objectContaining({ hivraLaunchStage: "plan", hivraLaunchPushed: true }));

    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(screen.getByRole("heading", { name: "Review and launch Codex 1" })).toBeInTheDocument();
    expect(historyStage()).toBe("review");

    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument());
    expect(historyStage()).toBe("plan");

    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: "What do you want to launch?" })).toBeInTheDocument());
    expect(historyStage()).toBe("choose");
  });

  it("keeps a second quick Back instead of bouncing to the step the first Back's history pop lands on", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(screen.getByRole("heading", { name: "Review and launch Codex 1" })).toBeInTheDocument();

    // Two Backs before the first one's history traversal has landed.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 20)); });
    expect(screen.getByRole("heading", { name: "What do you want to launch?" })).toBeInTheDocument();
  });

  it("links agents that still set up on their own page with a way back to Launch", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });

    expect(screen.getByRole("link", { name: /^Claude Code/ })).toHaveAttribute(
      "href",
      "/dashboard/welcome?step=deploy&agentType=claude-code&from=launch",
    );
    expect(screen.queryByRole("link", { name: /Browse every agent/i })).not.toBeInTheDocument();
  });

  it("closes the keyboard when return is pressed in the name field", async () => {
    renderAtCapacity();
    const name = await screen.findByRole("textbox", { name: "Computer name" });
    expect(name).toHaveAttribute("enterkeyhint", "done");
    expect(name).toHaveAttribute("autocapitalize", "none");

    name.focus();
    expect(name).toHaveFocus();
    fireEvent.keyDown(name, { key: "Enter" });
    expect(name).not.toHaveFocus();
  });
});
