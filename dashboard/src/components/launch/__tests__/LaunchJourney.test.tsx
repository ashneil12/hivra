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

describe("LaunchJourney on touch layouts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
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

  it("starts with Resources collapsed on phones and touch tablets", async () => {
    mockMatchMedia(TOUCH_QUERY);
    renderAtCapacity();

    await screen.findByRole("heading", { name: "Where should Ubuntu Desktop run?" });
    expect(screen.getByText("Resources").closest("details")).not.toHaveAttribute("open");
  });

  it("keeps Resources open on desktop", async () => {
    mockMatchMedia(null);
    renderAtCapacity();

    await screen.findByRole("heading", { name: "Where should Ubuntu Desktop run?" });
    expect(screen.getByText("Resources").closest("details")).toHaveAttribute("open");
    expect(screen.getByLabelText("Reserved CPU")).toBeVisible();
  });

  it("describes reserved memory without VM jargon", async () => {
    renderAtCapacity();

    await screen.findByRole("heading", { name: "Where should Ubuntu Desktop run?" });
    expect(screen.getByText(/Reserved memory is always kept for this computer/)).toBeInTheDocument();
    expect(screen.queryByText(/balloon floor/)).not.toBeInTheDocument();
  });

  it("gives each forward step a history entry so system back steps back through the journey", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });

    fireEvent.click(screen.getByRole("button", { name: /^Agent\b/ }));
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(screen.getByRole("heading", { name: "Choose an agent" })).toBeInTheDocument();
    expect(historyStage()).toBe("profile");
    expect(window.history.state).toEqual(expect.objectContaining({ hivraLaunchStage: "profile", hivraLaunchPushed: true }));

    fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(screen.getByRole("heading", { name: "Where should Codex run?" })).toBeInTheDocument();
    expect(historyStage()).toBe("capacity");

    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose an agent" })).toBeInTheDocument());
    expect(historyStage()).toBe("profile");
  });

  it("links the full agent catalog with a way back to Launch", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Agent\b/ }));
    fireEvent.click(screen.getByTestId("launch-primary-action"));

    expect(screen.getByRole("link", { name: /Browse every agent/i })).toHaveAttribute(
      "href",
      "/dashboard/welcome?step=agent-type&from=launch",
    );
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
