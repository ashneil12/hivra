/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

    await screen.findByRole("heading", { name: "Review and launch Ubuntu Desktop 1" });
    expect(screen.queryByLabelText("Reserved CPU")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change size" }));
    const customize = screen.getByRole("button", { name: "Customize" });
    expect(customize).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(customize);
    expect(customize).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Reserved CPU")).toBeVisible();
    expect(screen.getByLabelText("Maximum memory")).toBeVisible();
  });

  it("marks its Launch label as web chrome, since a desktop app's toolbar already names Launch", async () => {
    renderAtCapacity();
    await screen.findByRole("heading", { name: "Review and launch Ubuntu Desktop 1" });
    const label = within(screen.getByTestId("launch-journey").querySelector("header")!).getByText("Launch");
    expect(label).toHaveAttribute("data-web-chrome");
  });

  it("describes reserved memory without VM jargon", async () => {
    renderAtCapacity();

    await screen.findByRole("heading", { name: "Review and launch Ubuntu Desktop 1" });
    fireEvent.click(screen.getByRole("button", { name: "Change size" }));
    expect(screen.getByText(/Reserved memory is always kept for this computer/)).toBeInTheDocument();
    expect(screen.queryByText(/balloon floor/)).not.toBeInTheDocument();
  });

  it("gives the forward step a history entry so system back steps back through the journey", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });

    fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
    expect(screen.getByRole("heading", { name: "Review and launch Codex 1" })).toBeInTheDocument();
    expect(historyStage()).toBe("review");
    expect(window.history.state).toEqual(expect.objectContaining({ hivraLaunchStage: "review", hivraLaunchPushed: true }));
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());

    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: "What do you want to launch?" })).toBeInTheDocument());
    expect(historyStage()).toBe("choose");
  });

  it("has two steps, Choose and Review", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    const steps = screen.getByRole("list", { name: "Launch steps" });
    expect(within(steps).getAllByRole("listitem").map(item => item.textContent)).toEqual(["1Choose", "2Review"]);
    fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
    expect(screen.getByRole("heading", { name: "Review and launch Codex 1" })).toBeInTheDocument();
    expect(within(steps).getByText("Review").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("keeps a quick Back, then forward, on the step the history pop lands on", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    expect(screen.getByRole("heading", { name: "Review and launch Codex 1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 20)); });
    expect(screen.getByRole("heading", { name: "What do you want to launch?" })).toBeInTheDocument();
    // The history ends on the step shown, so system back and forward still
    // step through the journey.
    await waitFor(() => expect(historyStage()).toBe("choose"));
    expect(window.history.state).toEqual(expect.objectContaining({ hivraLaunchStage: "choose" }));
    await act(async () => {
      window.history.forward();
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Review and launch Codex 1" })).toBeInTheDocument());
    expect(historyStage()).toBe("review");
  });

  it("opens a plain Launch link on Choose even when an earlier choice was saved", async () => {
    window.localStorage.setItem("hivra.launch-draft.v1:user_123", JSON.stringify({
      schemaVersion: 1, launchRequestId: "55555555-5555-4555-8555-555555555555", stage: "review", resourceKind: "agent", profileId: "openclaw",
      name: "OpenClaw 1", resources: { cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8, source: "recommended" },
      capacity: { mode: "hivra-managed", targetId: null }, launchState: "idle",
    }));
    render(<LaunchJourney />);
    expect(await screen.findByRole("heading", { name: "What do you want to launch?" })).toBeInTheDocument();
    expect(screen.getByTestId("launch-journey")).toHaveAttribute("data-stage", "choose");
    expect(screen.queryByRole("heading", { name: /Review and launch/ })).not.toBeInTheDocument();
  });

  it("still restores the saved step on a reload inside the journey", async () => {
    window.history.replaceState(null, "", "/dashboard/launch?stage=review");
    window.localStorage.setItem("hivra.launch-draft.v1:user_123", JSON.stringify({
      schemaVersion: 1, launchRequestId: "55555555-5555-4555-8555-555555555555", stage: "review", resourceKind: "agent", profileId: "openclaw",
      name: "OpenClaw 1", resources: { cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8, source: "recommended" },
      capacity: { mode: "hivra-managed", targetId: null }, launchState: "idle",
    }));
    render(<LaunchJourney />);
    expect(await screen.findByRole("heading", { name: "Review and launch OpenClaw 1" })).toBeInTheDocument();
  });

  it("opens Choose again when a plain Launch link is followed from inside the journey", async () => {
    const view = render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^OpenClaw/ }));
    await screen.findByRole("heading", { name: "Review and launch OpenClaw 1" });
    searchParamsGetMock.mockImplementation((key: string) => (key === "stage" ? "review" : null));
    view.rerender(<LaunchJourney />);
    searchParamsGetMock.mockReturnValue(null);
    view.rerender(<LaunchJourney />);
    expect(await screen.findByRole("heading", { name: "What do you want to launch?" })).toBeInTheDocument();
  });

  it("opens a draft saved at the old Plan step on Review", async () => {
    window.history.replaceState(null, "", "/dashboard/launch?stage=plan");
    const draftId = "44444444-4444-4444-8444-444444444444";
    window.localStorage.setItem("hivra.launch-draft.v1:user_123", JSON.stringify({
      schemaVersion: 1, launchRequestId: draftId, stage: "plan", resourceKind: "agent", profileId: "codex",
      name: "Codex 1", resources: { cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8, source: "recommended" },
      capacity: { mode: "hivra-managed", targetId: null }, launchState: "idle",
    }));
    render(<LaunchJourney />);
    expect(await screen.findByRole("heading", { name: "Review and launch Codex 1" })).toBeInTheDocument();
    expect(screen.getByTestId("launch-journey")).toHaveAttribute("data-stage", "review");
  });

  it("lists each setting with its own Change button, and opens only that one", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
    await screen.findByRole("heading", { name: "Review and launch Hermes 1" });

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByText("Recommended settings")).not.toBeInTheDocument();
    expect(screen.queryByText("When you launch")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Cost", { selector: "dl" })).toBeInTheDocument();
    const settings = within(screen.getByRole("group", { name: "Launch settings" }));
    for (const label of ["Where it runs", "Size", "Model access", "Memory"]) expect(settings.getByText(label)).toBeInTheDocument();
    expect(settings.getByText("Hivra Cloud")).toBeInTheDocument();
    // Size stays collapsed until its own Change is pressed; Model access choices are one click.
    expect(screen.queryByRole("group", { name: "Size" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Model access" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Change model access/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide advanced" })).not.toBeInTheDocument();

    // Size opens on its own.
    const size = screen.getByRole("button", { name: "Change size" });
    expect(size).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(size);
    expect(size).toHaveAttribute("aria-expanded", "true");
    expect(size).toHaveTextContent("Done");
    expect(screen.getByRole("group", { name: "Size" })).toBeInTheDocument();

    // Model access choices are always visible in their row, with no Change step.
    expect(screen.getByRole("group", { name: "Model access" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Size" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Reserved CPU")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done with size" }));
    expect(screen.queryByRole("group", { name: "Size" })).not.toBeInTheDocument();
    // Where it runs was never opened.
    expect(screen.getByRole("button", { name: "Change where it runs" })).toHaveAttribute("aria-expanded", "false");
  });

  it("switches model access to your own key in one click, and back to credits", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
    await screen.findByRole("heading", { name: "Review and launch Codex 1" });

    const group = within(screen.getByRole("group", { name: "Model access" }));
    expect(screen.queryByLabelText(/API key$/)).not.toBeInTheDocument();
    fireEvent.click(group.getByRole("button", { name: /^Use my/ }));
    expect(await screen.findByLabelText(/API key$/)).toBeInTheDocument();
    fireEvent.click(group.getByRole("button", { name: /^Hivra credits/ }));
    expect(screen.queryByLabelText(/API key$/)).not.toBeInTheDocument();
  });

  it("turns the browser on or off with one click, and Memory has no browser switch", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
    await screen.findByRole("heading", { name: "Review and launch Codex 1" });

    const browser = await screen.findByRole("switch", { name: "Browser for Codex" });
    const before = browser.getAttribute("aria-checked");
    fireEvent.click(browser);
    expect(screen.getByRole("switch", { name: "Browser for Codex" })).toHaveAttribute("aria-checked", before === "true" ? "false" : "true");
    fireEvent.click(screen.getByRole("switch", { name: "Browser for Codex" }));
    expect(screen.getByRole("switch", { name: "Browser for Codex" })).toHaveAttribute("aria-checked", before);
    expect(screen.queryByRole("switch", { name: /Honcho/ })).not.toBeInTheDocument();
  });

  it("fills the name in and lets it be edited inline in Review", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
    const name = await screen.findByRole("textbox", { name: "Agent name" });
    expect(name).toHaveValue("Codex 1");
    fireEvent.change(name, { target: { value: "Reviewer" } });
    expect(screen.getByRole("heading", { name: "Review and launch Reviewer" })).toBeInTheDocument();
  });

  it("fits a restored Ubuntu size to a plan that loaded before the signed-in owner did", async () => {
    const clerk = jest.requireMock("@clerk/nextjs") as { useAuth: () => unknown };
    const signedIn = clerk.useAuth();
    let authLoaded = false;
    const useAuth = jest.spyOn(clerk, "useAuth").mockImplementation(() => authLoaded ? signedIn : { isLoaded: false, userId: null });
    const draftId = "33333333-3333-4333-8333-333333333333";
    window.localStorage.setItem("hivra.launch-draft.v1:user_123", JSON.stringify({
      schemaVersion: 1, launchRequestId: draftId, stage: "plan", resourceKind: "computer", profileId: "ubuntu-desktop",
      name: "Ubuntu Desktop 1", resources: { cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8, source: "recommended" },
      capacity: { mode: "hivra-managed", targetId: null }, launchState: "idle",
    }));
    fetchPlanStrictMock.mockResolvedValue({ ...PAID_PLAN, name: "Pro", maxCpuPerAgent: 2, maxRamPerAgent: 4, poolCpu: 2, poolRam: 4 });
    searchParamsGetMock.mockImplementation((key: string) => ({ draft: draftId, upgraded: "operator" } as Record<string, string>)[key] ?? null);
    const view = render(<LaunchJourney />);
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    authLoaded = true;
    view.rerender(<LaunchJourney />);
    expect(await screen.findByText("Pro is active. Continue your Ubuntu Desktop launch.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Small · 2 CPU / 4 GB")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    useAuth.mockRestore();
  });

  it.each([
    ["Claude Code", "Review and launch Claude Code 1"],
    ["Hermes", "Review and launch Hermes 1"],
    ["OpenClaw", "Review and launch OpenClaw 1"],
    ["Agent Zero", "Review and launch Agent Zero 1"],
    ["Aeon", "Review and launch Aeon 1"],
  ])("launches %s in this journey instead of sending it to the welcome page", async (tile, heading) => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });

    expect(screen.queryByRole("link", { name: new RegExp(`^${tile}`) })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Browse every agent/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${tile}`) }));
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Model access" })).toBeInTheDocument();
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

  it("does not offer the prepared desktop computer where this deployment has no slot", async () => {
    // Production shape before a slot is configured: choosing this one here
    // could only end at a 503.
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });

    expect(screen.queryByRole("button", { name: /^Omarchy/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Ubuntu Desktop/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Windows/ })).toBeInTheDocument();
  });

  it("keeps the choices a Windows setup must make open, with no Change for where it runs", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Windows/ }));
    await screen.findByRole("heading", { name: /^Review and launch Windows/ });

    expect(screen.getByRole("heading", { name: "Your launch" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Windows hosting destination" })).toBeInTheDocument();
    expect(screen.getByText("Installation media")).toBeInTheDocument();
    expect(screen.getByText("Rights")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change where it runs" })).not.toBeInTheDocument();
    expect(screen.queryByText("When you launch")).not.toBeInTheDocument();
  });

  it("offers the prepared desktop computer where this deployment holds a slot", async () => {
    render(<LaunchJourney preparedProfiles={["omarchy"]} />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });

    expect(await screen.findByRole("button", { name: /^Omarchy/ })).toBeInTheDocument();
  });
});
