/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { useWorkspaceAgents } from "@/components/workspace/useWorkspaceAgents";
import type { AgentSurfaceId } from "@/lib/agent-computers/agent-surfaces";
import { recordVisit } from "@/lib/workspace/recents";
import type { UnifiedAgent } from "@/lib/hivra/unified-agent";

import { FleetControlPane } from "../FleetControlPane";

jest.mock("@/components/workspace/useWorkspaceAgents", () => ({
  useWorkspaceAgents: jest.fn(),
}));

const replace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: jest.fn(), prefetch: jest.fn() }),
}));

let appOpenAtHome = false;
const markHomeOpened = jest.fn();
jest.mock("@/lib/workspace/app-open", () => ({
  isAppOpenAtHome: () => appOpenAtHome,
  markHomeOpened: () => markHomeOpened(),
}));

const mockedUseWorkspaceAgents = jest.mocked(useWorkspaceAgents);

/** Records visits oldest first, so the last one named is the most recent. */
function opened(...visits: Array<[uid: string, tab: AgentSurfaceId, minutesAgo?: number]>) {
  for (const [uid, tab, minutesAgo = 1] of visits) {
    recordVisit(uid, tab, { now: Date.now() - minutesAgo * 60_000 });
  }
}

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

const codex = agent("x-codex", "CODEX_AGENT", { agentType: "codex" });
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
    window.localStorage.clear();
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
  it("shows the list led by where you left off when Home is reached inside the app", () => {
    opened(["x-codex", "chat"]);
    render(<FleetControlPane />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Where will you work?" })).toBeInTheDocument();
    expect(screen.getByTestId("home-continue")).toHaveAttribute("href", "/dashboard/agent/codex?tab=chat");
    expect(markHomeOpened).toHaveBeenCalled();
  });

  // Opening the app at Home continues where you left off: `lastSelection` is
  // the agent or computer you opened yourself.
  it("continues into the last agent you were in when the app is opened at Home", () => {
    appOpenAtHome = true;
    opened(["x-codex", "chat"]);
    render(<FleetControlPane />);
    expect(replace).toHaveBeenCalledWith("/dashboard/agent/codex?tab=chat");
    expect(screen.queryByRole("heading", { name: "Where will you work?" })).not.toBeInTheDocument();
  });

  it("resumes the surface, not just the agent", () => {
    appOpenAtHome = true;
    opened(["x-ubuntu", "desktop"]);
    render(<FleetControlPane />);
    expect(replace).toHaveBeenCalledWith("/dashboard/agent/ubuntu?tab=desktop");
  });

  // Computer › Terminal and the agent's own session used to be stored as the
  // same word, so resuming the computer's shell opened the agent's session.
  it("resumes Computer › Terminal, not the agent's session", () => {
    appOpenAtHome = true;
    opened(["x-codex", "box"]);
    render(<FleetControlPane />);
    expect(replace).toHaveBeenCalledWith("/dashboard/agent/codex?tab=box");
  });

  it("shows the list when the remembered runtime is not usable", () => {
    // A stopped box is not a place to resume into — the resume link already
    // guards on this, and the redirect must agree with it or arriving would
    // strand you somewhere that cannot open.
    appOpenAtHome = true;
    opened(["x-codex", "chat"]);
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
    opened(["x-codex", "chat"]);
    mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [], loading: true }));
    render(<FleetControlPane />);
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not resume from a partial list while sources are loading", () => {
    appOpenAtHome = true;
    opened(["x-codex", "chat"]);
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
    opened(["x-codex", "chat"]);
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
    opened(["x-codex", "chat"]);
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
    opened(['x-codex', 'chat']);
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

  describe("Pick up where you left off", () => {
    const writer = agent("x-writer", "WRITER", { agentType: "claude-code", resourceKind: "agent" });
    const sandbox = agent("x-sandbox", "SANDBOX", { resourceKind: "computer", agentType: "linux-terminal" });
    const stoppedDesk = agent("x-desk", "OLD_DESK", { resourceKind: "computer", state: "stopped", statusRaw: "stopped", dot: "var(--text-muted)" });

    it("shows nothing until something has been opened in this browser", () => {
      render(<FleetControlPane requested />);
      expect(screen.queryByTestId("home-continue")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Recent" })).not.toBeInTheDocument();
    });

    it("offers the last resource with the surface you were on and when, in one click", () => {
      opened(["x-codex", "box", 5]);
      render(<FleetControlPane requested />);
      const card = screen.getByTestId("home-continue");
      expect(card).toHaveAttribute("href", "/dashboard/agent/codex?tab=box");
      expect(card).toHaveTextContent("Pick up where you left off");
      expect(card).toHaveTextContent("CODEX_AGENT");
      expect(card).toHaveTextContent("Running");
      expect(card).toHaveTextContent("Computer › Terminal");
      expect(card).toHaveTextContent("opened 5 min ago");
      expect(card).not.toHaveTextContent("Open to respond");
    });

    it.each([
      ["terminal", "Codex session"],
      ["chat", "Chat"],
      ["skills", "Manage › Skills"],
    ] as const)("names the %s surface the way the agent page does (%s)", (tab, label) => {
      opened(["x-codex", tab]);
      render(<FleetControlPane requested />);
      expect(screen.getByTestId("home-continue")).toHaveTextContent(label);
    });

    it("lists the rest in the order you used them, and nothing you have not opened", () => {
      mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [codex, ubuntu, hermes, writer, sandbox] }));
      opened(["x-sandbox", "manage", 50], ["h-one", "chat", 40], ["x-ubuntu", "files", 30], ["x-codex", "chat", 2]);
      render(<FleetControlPane requested />);

      expect(screen.getByTestId("home-continue")).toHaveTextContent("CODEX_AGENT");
      const recent = screen.getByRole("region", { name: "Recent" });
      const links = within(recent).getAllByRole("link");
      expect(links.map((link) => link.textContent)).toEqual([
        expect.stringContaining("MY_UBUNTU_DESKTOP"),
        expect.stringContaining("Hermes One"),
        expect.stringContaining("SANDBOX"),
      ]);
      expect(links[0]).toHaveAttribute("href", "/dashboard/agent/ubuntu?tab=files");
      expect(links[0]).toHaveTextContent("opened 30 min ago");
      expect(links[0]).toHaveTextContent("Files");
      expect(links[1]).toHaveAttribute("href", "/dashboard/instances/one");
      expect(links[1]).toHaveTextContent("Chat");
      expect(links[2]).toHaveAttribute("href", "/dashboard/agent/sandbox?tab=manage");
      expect(within(recent).queryByText("WRITER")).not.toBeInTheDocument();
    });

    it("keeps Recent to five", () => {
      const many = Array.from({ length: 8 }, (_, index) => agent(`x-a${index}`, `AGENT_${index}`));
      mockedUseWorkspaceAgents.mockReturnValue(state({ agents: many }));
      opened(...many.map((item, index) => [item.uid, "chat", 10 - index] as [string, AgentSurfaceId, number]));
      render(<FleetControlPane requested />);
      expect(screen.getByTestId("home-continue")).toHaveTextContent("AGENT_7");
      expect(within(screen.getByRole("region", { name: "Recent" })).getAllByRole("link")).toHaveLength(5);
    });

    it("does not offer a stopped resource as the one to continue", () => {
      mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [codex, stoppedDesk] }));
      opened(["x-codex", "chat", 20], ["x-desk", "desktop", 3]);
      render(<FleetControlPane requested />);

      expect(screen.getByTestId("home-continue")).toHaveTextContent("CODEX_AGENT");
      const stopped = within(screen.getByRole("region", { name: "Recent" })).getByRole("link", { name: /OLD_DESK/ });
      expect(stopped).toHaveTextContent("Stopped");
      expect(stopped).toHaveTextContent("View details");
      expect(stopped).toHaveAttribute("href", "/dashboard/agent/desk?tab=desktop");
    });

    it("offers no card when the only recent resource is stopped, but still lists it", () => {
      mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [codex, stoppedDesk] }));
      opened(["x-desk", "desktop"]);
      render(<FleetControlPane requested />);
      expect(screen.queryByTestId("home-continue")).not.toBeInTheDocument();
      expect(within(screen.getByRole("region", { name: "Recent" })).getByRole("link", { name: /OLD_DESK.*View details/ })).toBeVisible();
    });

    it("does not offer a resource whose list could not be refreshed", () => {
      mockedUseWorkspaceAgents.mockReturnValue(state({ hivraError: "Unavailable" }));
      opened(["x-codex", "chat"]);
      render(<FleetControlPane requested />);
      expect(screen.queryByTestId("home-continue")).not.toBeInTheDocument();
      const cached = within(screen.getByRole("region", { name: "Recent" })).getByRole("link", { name: /CODEX_AGENT/ });
      expect(cached).toHaveTextContent("Last known: Running");
      expect(cached).toHaveTextContent("View details");
    });

    it("says when the one to continue is waiting on you", () => {
      mockedUseWorkspaceAgents.mockReturnValue(state({ agents: [codex, { ...hermes, attention: "approval" }] }));
      opened(["h-one", "chat"]);
      render(<FleetControlPane requested />);
      const card = screen.getByTestId("home-continue");
      expect(card).toHaveTextContent("Open to respond");
      expect(card).toHaveAttribute("href", "/dashboard/instances/one");
    });

    it("carries over the single remembered selection once, without claiming when it was", () => {
      window.localStorage.setItem("hivra.workspace.last-selection", JSON.stringify({ version: 1, uid: "x-codex", surface: "terminal" }));
      render(<FleetControlPane requested />);
      const card = screen.getByTestId("home-continue");
      // Its "terminal" could have meant either terminal: resume the primary view.
      expect(card).toHaveAttribute("href", "/dashboard/agent/codex?tab=chat");
      expect(card).not.toHaveTextContent("opened");
      expect(window.localStorage.getItem("hivra.workspace.last-selection")).toBeNull();
    });

    it("steps aside while searching", () => {
      opened(["x-codex", "chat"]);
      render(<FleetControlPane requested />);
      fireEvent.change(screen.getByRole("searchbox", { name: "Search agents and computers" }), { target: { value: "ubuntu" } });
      expect(screen.queryByTestId("home-continue")).not.toBeInTheDocument();
    });
  });
});
