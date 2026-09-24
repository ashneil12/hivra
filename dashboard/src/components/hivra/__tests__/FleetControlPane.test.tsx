/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { useWorkspaceAgents } from "@/components/workspace/useWorkspaceAgents";
import { restoreWorkspaceSelection } from "@/lib/workspace/workspace-persistence";
import type { UnifiedAgent } from "@/lib/hivra/unified-agent";

import { FleetControlPane } from "../FleetControlPane";

jest.mock("@/components/workspace/useWorkspaceAgents", () => ({
  useWorkspaceAgents: jest.fn(),
}));

const replace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: jest.fn(), prefetch: jest.fn() }),
}));

jest.mock("@/lib/workspace/workspace-persistence", () => ({
  restoreWorkspaceSelection: jest.fn(() => null),
}));

let appOpenAtHome = false;
const markHomeOpened = jest.fn();
jest.mock("@/lib/workspace/app-open", () => ({
  isAppOpenAtHome: () => appOpenAtHome,
  markHomeOpened: () => markHomeOpened(),
}));

const mockedUseWorkspaceAgents = jest.mocked(useWorkspaceAgents);
const mockedRestore = jest.mocked(restoreWorkspaceSelection);

function agent(uid: string, name: string, extra: Partial<UnifiedAgent> = {}): UnifiedAgent {
  const kind = uid.startsWith("h-") ? "hermes" : "hivra";
  return {
    uid,
    kind,
    id: uid.slice(2),
    name,
    statusRaw: "running",
    state: "running",
    dot: "#22c55e",
    vendor: kind === "hermes" ? "Hermes" : "OpenAI",
    typeLabel: kind === "hermes" ? "Hermes" : "Codex",
    ...extra,
  };
}

const codex = agent("x-codex", "CODEX_AGENT");
const ubuntu = agent("x-ubuntu", "MY_UBUNTU_DESKTOP", {
  resourceKind: "computer",
  typeLabel: "Ubuntu Desktop",
});
const hermes = agent("h-one", "Hermes One");

function state(overrides: Record<string, unknown> = {}) {
  return {
    agents: [codex, ubuntu, hermes],
    loading: false,
    hermesError: null,
    hivraError: null,
    attachedError: null,
    lastRefreshedAt: null,
    retryHermes: jest.fn(async () => undefined),
    retryHivra: jest.fn(async () => undefined),
    retryAll: jest.fn(async () => undefined),
    ...overrides,
  } as never;
}

/**
 * The Chat control pane. It exists because the route used to auto-open an
 * arbitrary resource — so "Chat" teleported you somewhere and could never show
 * itself as where you were — or dead-ended entirely for an owner with only Hivra
 * agents. These specs pin that it is a real, useful place instead.
 */
describe("FleetControlPane", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseWorkspaceAgents.mockReturnValue(state());
    mockedRestore.mockReturnValue(null);
    appOpenAtHome = false;
  });

  it("lists BOTH families, so a Hivra-only owner sees their runtimes", () => {
    render(<FleetControlPane />);

    expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Computers" })).toBeInTheDocument();
    expect(screen.getByText("CODEX_AGENT")).toBeInTheDocument();
    expect(screen.getByText("MY_UBUNTU_DESKTOP")).toBeInTheDocument();
    expect(screen.getByText("Hermes One")).toBeInTheDocument();
  });

  it("links a computer to its desktop and an agent to its conversation", () => {
    render(<FleetControlPane />);

    expect(screen.getByRole("link", { name: /CODEX_AGENT/ })).toHaveAttribute(
      "href",
      "/dashboard/agent/codex?tab=chat",
    );
    // A computer has no conversation; sending it to one is the original bug.
    expect(screen.getByRole("link", { name: /MY_UBUNTU_DESKTOP/ })).toHaveAttribute(
      "href",
      "/dashboard/agent/ubuntu?tab=desktop",
    );
    // A Hermes instance is a different route under a different shell.
    expect(screen.getByRole("link", { name: /Hermes One/ })).toHaveAttribute(
      "href",
      "/dashboard/instances/one",
    );
  });

  it("shows each agent with the computer it runs on, and nothing of the kind for a computer (ATT-11)", () => {
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [
      agent("x-codex", "CODEX_AGENT", { resourceKind: "agent", computerPair: { relation: "On its own computer", placement: "Hivra Cloud", size: "1.5 CPU / 3 GB" } }),
      ubuntu,
    ] }));
    render(<FleetControlPane />);
    const pairs = screen.getAllByTestId("fleet-computer-pair");
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toHaveTextContent("On its own computer · Hivra Cloud · 1.5 CPU / 3 GB");
    expect(screen.getByRole("link", { name: /CODEX_AGENT/ })).toContainElement(pairs[0]);
  });

  it("filters across both families as you type", () => {
    render(<FleetControlPane />);
    const search = screen.getByRole("searchbox", { name: "Search agents and computers" });

    fireEvent.change(search, { target: { value: "ubuntu" } });
    expect(screen.getByText("MY_UBUNTU_DESKTOP")).toBeInTheDocument();
    expect(screen.queryByText("CODEX_AGENT")).not.toBeInTheDocument();
    // The group heading survives with its member; the other group drops away.
    expect(screen.getByRole("heading", { name: "Computers" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Agents" })).not.toBeInTheDocument();
  });

  it("distinguishes between empty and no-results honestly", () => {
    // "No runtimes yet" is wrong when a search simply matched nothing — that
    // tells someone their machines are gone.
    render(<FleetControlPane />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search agents and computers" }), {
      target: { value: "zzzz" },
    });
    expect(screen.getByText("Nothing matches that search.")).toBeInTheDocument();

    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [] }));
    render(<FleetControlPane />);
    expect(screen.getByRole("link", { name: /Start with an agent/ })).toBeInTheDocument();
  });

  it("says loading rather than 'none' while the fleet is in flight", () => {
    mockedUseWorkspaceAgents.mockReturnValue(state({ loading: true }));
    render(<FleetControlPane />);
    expect(screen.getByText("Loading your agents and computers…")).toBeInTheDocument();
    expect(screen.queryByText(/No agents or computers yet/)).not.toBeInTheDocument();
  });

  it("keeps the other family listed when one source fails, and offers retry", () => {
    const retryHermes = jest.fn(async () => undefined);
    const retryHivra = jest.fn(async () => undefined);
    mockedUseWorkspaceAgents.mockReturnValue(
      state({ hermesError: "boom", retryHermes, retryHivra, agents: [codex, ubuntu] }),
    );
    render(<FleetControlPane />);

    // One message in product words: never how Hivra stores an agent (FTUE-03).
    expect(screen.getByText("Some agents and computers couldn't be loaded. The rest are listed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry (Hermes|Hivra)/ })).not.toBeInTheDocument();
    // The rest must still be usable.
    expect(screen.getByText("CODEX_AGENT")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryHermes).toHaveBeenCalledTimes(1);
    expect(retryHivra).not.toHaveBeenCalled();
  });

  it("offers one retry that re-reads every list that failed", () => {
    const retryHermes = jest.fn(async () => undefined);
    const retryHivra = jest.fn(async () => undefined);
    mockedUseWorkspaceAgents.mockReturnValue(state({ hermesError: "a", hivraError: "b", retryHermes, retryHivra }));
    render(<FleetControlPane />);
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryHermes).toHaveBeenCalledTimes(1);
    expect(retryHivra).toHaveBeenCalledTimes(1);
  });

  it("keeps every other agent and computer current when only the list of added agents failed", () => {
    const retryHivra = jest.fn(async () => undefined);
    const added = agent("a-attach", "Codex on MY_UBUNTU_DESKTOP", { id: "ubuntu",
      attachment: { id: "attach", computerId: "ubuntu", computerName: "MY_UBUNTU_DESKTOP", phase: "attached" } });
    mockedUseWorkspaceAgents.mockReturnValue(state({ attachedError: "x", retryHivra,
      agents: [{ ...ubuntu, state: "error", attention: "error" }, added] }));
    render(<FleetControlPane />);
    // The computer's own attention is still current; only the added agent is shown as last known.
    expect(screen.getByText("1 needs attention")).toBeInTheDocument();
    expect(screen.getByText(/Last known: Running/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryHivra).toHaveBeenCalledTimes(1);
  });

  it("marks duplicate names so two same-named boxes are tellable apart", () => {
    const twin = agent("x-ubuntu2", "MY_UBUNTU_DESKTOP", { resourceKind: "computer" });
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [ubuntu, twin] }));
    render(<FleetControlPane />);

    const links = screen.getAllByRole("link", { name: /MY_UBUNTU_DESKTOP/ });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.textContent).toMatch(/#\w{4}/);
    }
  });

  it("shows the list rather than navigating when there is no last runtime", () => {
    render(<FleetControlPane />);
    expect(screen.getByRole("heading", { name: "Where will you work?" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Launch an agent or computer/ })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  // Home reached from inside the app (the Home link, the logo) is the list.
  // It used to follow the saved selection, so Home from inside an agent
  // bounced straight back into that agent.
  it("shows the list with a Continue link when Home is reached inside the app", () => {
    mockedRestore.mockReturnValue({ uid: "x-codex", surface: "conversation" });
    render(<FleetControlPane />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Where will you work?" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Continue\s*CODEX_AGENT/ })).toHaveAttribute("href", "/dashboard/agent/codex?tab=chat");
    expect(markHomeOpened).toHaveBeenCalled();
  });

  // Opening the app at Home continues where you left off: `lastSelection` is
  // the agent or computer you opened yourself.
  it("continues into the last agent you were in when the app is opened at Home", () => {
    appOpenAtHome = true;
    mockedRestore.mockReturnValue({ uid: "x-codex", surface: "conversation" });
    render(<FleetControlPane />);
    expect(replace).toHaveBeenCalledWith("/dashboard/agent/codex?tab=chat");
    expect(screen.queryByRole("heading", { name: "Where will you work?" })).not.toBeInTheDocument();
  });

  it("resumes the surface, not just the agent", () => {
    appOpenAtHome = true;
    mockedRestore.mockReturnValue({ uid: "x-ubuntu", surface: "desktop" });
    render(<FleetControlPane />);
    expect(replace).toHaveBeenCalledWith("/dashboard/agent/ubuntu?tab=desktop");
  });

  it("shows the list when the remembered runtime is not usable", () => {
    // A stopped box is not a place to resume into — the resume link already
    // guards on this, and the redirect must agree with it or arriving would
    // strand you somewhere that cannot open.
    appOpenAtHome = true;
    mockedRestore.mockReturnValue({ uid: "x-codex", surface: "conversation" });
    const stopped = { ...codex, state: "stopped" as const };
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [stopped] }));
    render(<FleetControlPane />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Where will you work?" })).toBeInTheDocument();
  });

  it("does not redirect when the list is still loading", () => {
    // Redirecting before the fleet confirms would open a runtime that may have
    // stopped since, so the decision waits for the list.
    appOpenAtHome = true;
    mockedRestore.mockReturnValue({ uid: "x-codex", surface: "conversation" });
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [], loading: true }));
    render(<FleetControlPane />);
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not resume from a partial list while sources are loading", () => {
    appOpenAtHome = true;
    mockedRestore.mockReturnValue({ uid: "x-codex", surface: "conversation" });
    mockedUseWorkspaceAgents.mockReturnValue(state({ loading: true }));
    const view = render(<FleetControlPane />);
    expect(replace).not.toHaveBeenCalled();
    mockedUseWorkspaceAgents.mockReturnValue(state());
    view.rerender(<FleetControlPane />);
    expect(replace).toHaveBeenCalledWith("/dashboard/agent/codex?tab=chat");
  });

  it("makes the opening action explicit and does not call a stopped resource open", () => {
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [codex, ubuntu, { ...hermes, state: "stopped" }] }));
    render(<FleetControlPane requested />);
    expect(screen.getByRole("link", { name: /CODEX_AGENT/ })).toHaveTextContent("Open agent");
    expect(screen.getByRole("link", { name: /MY_UBUNTU_DESKTOP/ })).toHaveTextContent("Open desktop");
    expect(screen.getByRole("link", { name: /Hermes One/ })).toHaveTextContent("View details");
  });

  it("stays put when the navigation asked for the list explicitly", () => {
    appOpenAtHome = true;
    mockedRestore.mockReturnValue({ uid: "x-codex", surface: "conversation" });
    render(<FleetControlPane requested />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Where will you work?" })).toBeInTheDocument();
  });
  it("shows two explicit starting choices for an empty account", () => {
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [] }));
    render(<FleetControlPane />);
    expect(screen.getByRole("link", { name: /Start with an agent/ })).toHaveAttribute("href", "/dashboard/launch?kind=agent&start=1");
    expect(screen.getByRole("link", { name: /Start with a computer/ })).toHaveAttribute("href", "/dashboard/launch?kind=computer&start=1");
  });

  it("opens attention without redirecting and includes approvals, not healthy resources", () => {
    mockedRestore.mockReturnValue({ uid: "x-codex", surface: "conversation" });
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [codex, { ...hermes, attention: "approval" }] }));
    render(<FleetControlPane attentionRequested />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Needs your attention" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Hermes One.*Needs approval.*Open to respond/ })).toBeVisible();
    expect(screen.queryByRole("link", { name: /^CODEX_AGENT/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all agents and computers" }));
    expect(screen.getByRole("link", { name: /^CODEX_AGENT/ })).toBeVisible();
  });

  it.each([['hermes', hermes], ['hivra', codex]] as const)(
    'does not treat cached %s attention as current after a source failure', (kind, resource) => {
      mockedUseWorkspaceAgents.mockReturnValue(state({
        agents: [{ ...resource, attention: 'approval' }, { ...ubuntu, state: 'error', attention: 'error' }],
      }));
      const view = render(<FleetControlPane requested attentionRequested />);
      expect(screen.getByText('Needs your attention')).toBeVisible();
      mockedUseWorkspaceAgents.mockReturnValue(state({
        agents: [{ ...resource, attention: 'approval' }, { ...ubuntu, state: 'error', attention: 'error' }],
        [`${kind}Error`]: 'Unavailable',
      }));
      view.rerender(<FleetControlPane requested attentionRequested />);
      expect(screen.queryByRole('link', { name: new RegExp(resource.name) })).not.toBeInTheDocument();
      if (kind === 'hermes') expect(screen.getByRole('link', { name: /MY_UBUNTU_DESKTOP/ })).toBeVisible();
      else expect(screen.queryByText('Nothing needs attention.')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Show all agents and computers' }));
      const cached = screen.getByRole('link', { name: new RegExp(resource.name) });
      expect(cached).not.toHaveTextContent('Needs approval');
      expect(cached).not.toHaveTextContent('Open to respond');
      expect(cached).toHaveTextContent('Last known: Running');
    },
  );

  it('does not resume a cached resource from an unavailable source', () => {
    appOpenAtHome = true;
    mockedRestore.mockReturnValue({ uid: 'x-codex', surface: 'conversation' });
    mockedUseWorkspaceAgents.mockReturnValue(state({ hivraError: 'Unavailable' }));
    render(<FleetControlPane />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  it('distinguishes an attention search with no matches from no attention', () => {
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [{ ...hermes, attention: 'approval' }] }));
    render(<FleetControlPane requested attentionRequested />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
    expect(screen.getByText('Nothing matches that search.')).toBeVisible();
    expect(screen.queryByText('Nothing needs attention.')).not.toBeInTheDocument();
  });

});
