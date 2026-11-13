/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { useWorkspaceAgents } from "@/components/workspace/useWorkspaceAgents";
import type { UnifiedAgent } from "@/lib/hivra/unified-agent";

import { FleetControlPane } from "../FleetControlPane";

jest.mock("@/components/workspace/useWorkspaceAgents", () => ({ useWorkspaceAgents: jest.fn() }));
jest.mock("@/components/dashboard/OnboardingChecklist", () => ({ OnboardingChecklist: () => null }));
jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  fetchPlanStrict: async () => null,
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn(), prefetch: jest.fn() }) }));
jest.mock("@/lib/workspace/app-open", () => ({ isAppOpenAtHome: () => false, markHomeOpened: () => undefined }));

const mockedUseWorkspaceAgents = jest.mocked(useWorkspaceAgents);

function agent(uid: string, name: string, extra: Partial<UnifiedAgent> = {}): UnifiedAgent {
  return {
    uid, kind: "hivra", id: uid.slice(2), name, statusRaw: "running", state: "running", dot: "#22c55e",
    vendor: "OpenAI", typeLabel: "Codex", ...extra,
  };
}

function home(agents: UnifiedAgent[]) {
  mockedUseWorkspaceAgents.mockReturnValue({
    agents, loading: false, hermesError: null, hivraError: null, attachedError: null, lastRefreshedAt: null,
    retryHermes: jest.fn(async () => undefined), retryHivra: jest.fn(async () => undefined), retryAll: jest.fn(async () => undefined),
  } as never);
  render(<FleetControlPane />);
}

const codex = agent("x-codex", "My Codex", { agentType: "codex" });
const desktop = agent("x-ubuntu", "My desktop", { resourceKind: "computer", typeLabel: "Ubuntu Desktop" });

const tryNext = () => screen.queryByRole("region", { name: "Try next" });

describe("Home's Try next", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG = "1";
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG;
  });

  it("is not shown while the catalog view of Launch is off", () => {
    delete process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG;
    home([codex]);
    expect(tryNext()).not.toBeInTheDocument();
  });

  it("suggests agents the owner does not run, starting with one for the same job", () => {
    home([codex, desktop]);
    const section = within(tryNext()!);
    const links = section.getAllByRole("link").filter(link => link.getAttribute("href")?.includes("about="));
    expect(links.map(link => link.getAttribute("href"))).toEqual([
      "/dashboard/launch?start=1&about=claude-code",
      "/dashboard/launch?start=1&about=deepseek-harness",
    ]);
    expect(links[0]).toHaveTextContent("Claude Code");
    expect(links[0]).toHaveTextContent("Coding · Because you run Codex");
    expect(section.getByRole("link", { name: "See everything you can launch" })).toHaveAttribute("href", "/dashboard/launch?start=1");
    expect(section.queryByText("Codex", { selector: "span.block" })).not.toBeInTheDocument();
  });

  it("stays out of a search", () => {
    home([codex, desktop, agent("x-two", "Second Codex", { agentType: "codex" }), agent("x-three", "Third Codex", { agentType: "codex" })]);
    expect(tryNext()).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "codex" } });
    expect(tryNext()).not.toBeInTheDocument();
  });

  it("suggests nothing to an owner who runs no agent", () => {
    home([desktop]);
    expect(tryNext()).not.toBeInTheDocument();
  });
});
