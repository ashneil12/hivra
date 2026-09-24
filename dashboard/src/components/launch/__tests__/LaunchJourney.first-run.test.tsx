/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { LaunchJourney } from "../LaunchJourney";

// Launch is where a new account lands after sign-up: it turns the Free plan on
// with its own button, and it is where "Start from a template" begins.

const routerPushMock = jest.fn();
const fetchPlanStrictMock = jest.fn();
const createAgentMock = jest.fn();
const summaryMock = jest.fn();
const checkoutMock = jest.fn();
let searchParams: Record<string, string> = {};

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
  useSearchParams: () => ({
    get: (key: string) => searchParams[key] ?? null,
    getAll: (key: string) => (searchParams[key] ? [searchParams[key]] : []),
  }),
}));

jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  fetchPlanStrict: () => fetchPlanStrictMock(),
  createAgent: (input: unknown) => createAgentMock(input),
}));

jest.mock("@/lib/billing/client", () => ({
  ...jest.requireActual("@/lib/billing/client"),
  requestSubscriptionCheckout: (...args: unknown[]) => checkoutMock(...args),
}));

jest.mock("@/lib/billing/managed-venice-client", () => ({
  ...jest.requireActual("@/lib/billing/managed-venice-client"),
  requestManagedVeniceSummary: () => summaryMock(),
}));

jest.mock("@/lib/abuse/client-fingerprint", () => ({ getFingerprintRequestId: async () => null }));
jest.mock("@/hooks/useTokenGeoAccess", () => ({ useTokenGeoAccess: () => ({ status: "allowed", notice: null }) }));
jest.mock("@/components/billing/ManagedVeniceDepositModal", () => ({ ManagedVeniceDepositModal: () => null }));

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";

/** What fetchPlanStrict reads for an account billing reports no plan for. */
const NO_PLAN = {
  subscribed: false, name: "Free", key: "free", maxAgents: 1, maxCpuPerAgent: 0.5, maxRamPerAgent: 1,
  poolCpu: 0.5, poolRam: 1, needsActivation: true,
};
const FREE_PLAN = {
  subscribed: false, name: "Free", key: "free", maxAgents: 1, maxCpuPerAgent: 0.5, maxRamPerAgent: 1,
  poolCpu: 0.5, poolRam: 1, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
};
const PAID_PLAN = {
  subscribed: true, name: "Operator", key: "operator", maxAgents: 4, maxCpuPerAgent: 8, maxRamPerAgent: 16,
  poolCpu: 16, poolRam: 32, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
};

let templates: Array<Record<string, unknown>>;
let sharedTemplate: Record<string, unknown> | null;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/dashboard/launch");
  searchParams = {};
  templates = [];
  sharedTemplate = null;
  fetchPlanStrictMock.mockResolvedValue(NO_PLAN);
  summaryMock.mockResolvedValue({ ok: true, summary: { wallets: {
    card: { balanceMicroUsd: 0, availableMicroUsd: 0, reservedMicroUsd: 0 },
    hermesos: { tokenDisplay: "0", lockedValueMicroUsd: 0, availableMicroUsd: 0, reservedMicroUsd: 0 },
  } } });
  checkoutMock.mockResolvedValue({ ok: true, activated: true });
  createAgentMock.mockResolvedValue({ id: AGENT_ID, type: "claude-code", name: "Claude Code 1", status: "provisioning", cpu: 0.5, ram: 1 });
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/infrastructure/targets")) return json({ success: true, data: { targets: [] } });
    if (url === "/api/vault") return json({ success: true, data: [] });
    if (url === "/api/hivra/agents") return json({ success: true, data: { agents: [] } });
    if (url === "/api/instances?summary=true") return json({ success: true, data: [] });
    if (url === "/api/hivra/templates") return json({ success: true, data: { templates } });
    if (url.startsWith("/api/hivra/templates/shared/")) {
      return sharedTemplate ? json({ success: true, data: { template: sharedTemplate } }) : json({ success: false, error: "Template not found" }, 404);
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
});

const reviewButton = () => screen.getByTestId("launch-primary-action");

describe("a new account in Launch", () => {
  it("shows what fits Free before a plan exists, instead of a plan check that failed", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });

    expect(await screen.findByText(/The Free plan runs one agent or computer with 0\.5 CPU \/ 1 GB/)).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t check your plan/i)).not.toBeInTheDocument();
    const codex = screen.getByRole("button", { name: /^Codex/ });
    await waitFor(() => expect(codex).toHaveTextContent("Fits Free without a browser"));
    expect(screen.getByRole("button", { name: /^Claude Code/ })).toHaveTextContent("Fits Free without a browser");
    // Not "your" plan: nothing is active yet.
    expect(screen.queryByText(/Fits your Free plan/)).not.toBeInTheDocument();
  });

  it("turns the Free plan on only with its own button, then lets the launch go ahead", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));

    const blocker = await screen.findByText(/Turn on the Free plan to run Claude Code on Hivra Cloud/);
    expect(blocker).toHaveTextContent("Free includes 0.5 CPU / 1 GB for one agent and costs nothing.");
    expect(reviewButton()).toBeDisabled();
    expect(screen.getByText("Free plan · not turned on yet")).toBeInTheDocument();
    expect(screen.getByText("No charge. It runs on the Free plan, which you turn on before launching.")).toBeInTheDocument();
    // Nothing is activated by getting here.
    expect(checkoutMock).not.toHaveBeenCalled();

    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    fireEvent.click(screen.getByRole("button", { name: "Turn on Free" }));

    await waitFor(() => expect(checkoutMock).toHaveBeenCalledWith("free"));
    expect(await screen.findByText("Free is active.")).toBeInTheDocument();
    expect(screen.getByText("Free plan")).toBeInTheDocument();
    await waitFor(() => expect(reviewButton()).toBeEnabled());
    expect(screen.queryByText(/Turn on the Free plan/)).not.toBeInTheDocument();

    fireEvent.click(reviewButton());
    fireEvent.click(screen.getByRole("button", { name: "Launch Claude Code" }));
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(1));
    expect(createAgentMock.mock.calls[0][0]).toMatchObject({ type: "claude-code", deployment: { mode: "hivra-managed" } });
  });

  it("keeps the launch blocked and says why when the Free plan couldn't be turned on", async () => {
    checkoutMock.mockResolvedValue({ ok: false, reason: "unknown", message: "Failed to activate free plan" });
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Free" }));

    expect(await screen.findByText("Failed to activate free plan")).toBeInTheDocument();
    expect(screen.queryByText("Free is active.")).not.toBeInTheDocument();
    expect(reviewButton()).toBeDisabled();
    // The plan is never re-read as if it had changed.
    expect(fetchPlanStrictMock).toHaveBeenCalledTimes(1);
  });

  it("offers a paid plan, not Free, for a launch Free can't hold", async () => {
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Ubuntu Desktop/ }));

    expect(await screen.findByText(/Ubuntu Desktop needs a paid plan on Hivra Cloud/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on Free" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Upgrade to/ })).toHaveAttribute("href", expect.stringContaining("/dashboard/billing?from=launch&returnTo="));
  });

  it("goes straight to review for an account that already has a plan", async () => {
    fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    expect(screen.queryByText(/The Free plan runs one agent/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    await waitFor(() => expect(reviewButton()).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Turn on Free" })).not.toBeInTheDocument();
  });
});

describe("starting from a template", () => {
  it("opens the template's agent under its name, says so, and launches it from the template", async () => {
    fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
    templates = [{ id: TEMPLATE_ID, slug: "research-bot", name: "Research Bot", type: "claude-code", emoji: null }];
    searchParams = { template: TEMPLATE_ID, start: "1" };
    render(<LaunchJourney />);

    expect(await screen.findByRole("heading", { name: "Claude Code — here's the plan" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue("Research Bot");
    expect(screen.getByText("Starting from the template “Research Bot”. Its focus, personality and skills come with it.")).toBeInTheDocument();

    await waitFor(() => expect(reviewButton()).toBeEnabled());
    fireEvent.click(reviewButton());
    const review = within(screen.getByLabelText("Launch review"));
    expect(review.getByText("Research Bot", { selector: "dd" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch Claude Code" }));

    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(1));
    expect(createAgentMock.mock.calls[0][0]).toMatchObject({ type: "claude-code", name: "Research Bot", templateId: TEMPLATE_ID });
  });

  it("reads a template shared by link through its token", async () => {
    fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
    sharedTemplate = { id: TEMPLATE_ID, slug: "ops-helper", name: "Ops Helper", type: "openclaw" };
    searchParams = { template: TEMPLATE_ID, templateToken: "share_abc123", start: "1" };
    render(<LaunchJourney />);

    expect(await screen.findByRole("heading", { name: "OpenClaw — here's the plan" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue("Ops Helper");
    expect(global.fetch).toHaveBeenCalledWith("/api/hivra/templates/shared/share_abc123", expect.anything());
  });

  it("says a template is gone and lets the owner choose instead, without launching anything", async () => {
    fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
    searchParams = { template: TEMPLATE_ID, start: "1" };
    render(<LaunchJourney />);

    expect(await screen.findByText("This template is no longer available. Choose what to launch instead.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What do you want to launch?" })).toBeInTheDocument();
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it("drops the template when the owner picks another agent", async () => {
    fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
    templates = [{ id: TEMPLATE_ID, name: "Research Bot", type: "claude-code" }];
    searchParams = { template: TEMPLATE_ID, start: "1" };
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "Claude Code — here's the plan" });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Codex/ }));
    expect(await screen.findByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    expect(screen.queryByText(/Starting from the template/)).not.toBeInTheDocument();
  });

  it("links to saved templates from Choose", async () => {
    fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    expect(screen.getByRole("link", { name: "Start from a template" })).toHaveAttribute("href", "/dashboard/templates");
  });
});
