/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { HivraLaunchRejectedError } from "@/lib/hivra/agent-api";

import { LaunchJourney } from "../LaunchJourney";

// Launch is where a new account lands after sign-up: it turns the Free plan on
// with its own button, and it is where "Start from a template" begins.

const routerPushMock = jest.fn();
const fetchPlanStrictMock = jest.fn();
const createAgentMock = jest.fn();
const summaryMock = jest.fn();
const checkoutMock = jest.fn();
const captureMock = jest.fn();
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

jest.mock("@/lib/telemetry/posthog-client", () => ({
  ...jest.requireActual("@/lib/telemetry/posthog-client"),
  captureClient: (...args: unknown[]) => captureMock(...args),
}));

jest.mock("@/lib/abuse/client-fingerprint", () => ({ getFingerprintRequestId: async () => null }));
jest.mock("@/components/billing/FreeTierCardVerification", () => ({ FreeTierCardVerification: () => null }));
jest.mock("@/hooks/useTokenGeoAccess", () => ({ useTokenGeoAccess: () => ({ status: "allowed", notice: null }) }));
jest.mock("@/components/billing/ManagedVeniceDepositModal", () => ({ ManagedVeniceDepositModal: () => null }));

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";

/** What fetchPlanStrict reads for an account billing reports no plan for,
 * running nothing on Hivra Cloud. */
const NO_PLAN = {
  subscribed: false, name: "Free", key: "free", maxAgents: 1, maxCpuPerAgent: 0.5, maxRamPerAgent: 1,
  poolCpu: 0.5, poolRam: 1, needsActivation: true, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
};
/** A Pro subscription in dunning: billing reports no plan and names the one
 * that holds the account. */
const PRO_ON_HOLD = {
  subscribed: false, name: "Free", key: "free", maxAgents: 1, maxCpuPerAgent: 0.5, maxRamPerAgent: 1,
  poolCpu: 0.5, poolRam: 1, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
  onHold: { key: "operator", name: "Pro", reason: "payment_overdue", billingPortal: true },
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
    // The billing client's words are about checkout; this step takes no payment.
    checkoutMock.mockResolvedValue({ ok: false, reason: null, status: 500, message: "Failed to start checkout. Please try again." });
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Free" }));

    expect(await screen.findByText("Couldn't turn on the Free plan. Nothing was charged. Try again in a moment.")).toBeInTheDocument();
    expect(screen.queryByText(/checkout/i)).not.toBeInTheDocument();
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

describe("a paying customer whose plan is on hold", () => {
  const billingLink = (name: string) => screen.getByRole("link", { name });

  it("says the paid plan needs its payment settled in Billing, and never offers Free over it", async () => {
    fetchPlanStrictMock.mockResolvedValue(PRO_ON_HOLD);
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });

    expect(await screen.findByText("Your Pro plan is on hold because a payment didn't go through. Update your payment in Billing to launch on Hivra Cloud.")).toBeInTheDocument();
    expect(billingLink("Update payment")).toHaveAttribute("href", expect.stringMatching(/^\/dashboard\/billing\?tab=overview&returnTo=%2Fdashboard%2Flaunch%3Fdraft%3D/));
    expect(screen.getByRole("button", { name: /^Claude Code/ })).toHaveTextContent("Pro plan on hold");
    expect(screen.queryByText(/The Free plan runs one agent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fits Free/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    expect(await screen.findByText("Your Pro plan is on hold because a payment didn't go through. Update your payment in Billing to run Claude Code on Hivra Cloud.")).toBeInTheDocument();
    expect(screen.getByText("Pro plan · on hold")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on Free" })).not.toBeInTheDocument();
    expect(screen.queryByText(/not turned on yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No charge\. It runs on the Free plan/)).not.toBeInTheDocument();
    expect(screen.getByText("Uses your Pro plan allowance once the plan is active again.")).toBeInTheDocument();
    expect(billingLink("Set up your own capacity")).toBeInTheDocument();
    expect(reviewButton()).toBeDisabled();
    expect(checkoutMock).not.toHaveBeenCalled();
  });

  it("says a paid plan needs attention when turning Free on finds one billing didn't report", async () => {
    // The reported dead end: billing shows no plan, Free is refused because a
    // lapsed paid subscription holds the account, and the plan reads the same.
    checkoutMock.mockResolvedValue({ ok: false, reason: "ACTIVE_SUBSCRIPTION", message: "You already have an active subscription.", status: 400 });
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Free" }));

    expect(await screen.findByText("Your account has a paid plan that isn't active right now, so Free can't be turned on. Check your plan in Billing to run Claude Code on Hivra Cloud.")).toBeInTheDocument();
    expect(fetchPlanStrictMock).toHaveBeenCalledTimes(2);
    expect(billingLink("Open Billing")).toHaveAttribute("href", expect.stringMatching(/^\/dashboard\/billing\?tab=overview&/));
    expect(screen.queryByRole("button", { name: "Turn on Free" })).not.toBeInTheDocument();
    expect(screen.queryByText(/is active\./)).not.toBeInTheDocument();
    expect(screen.getByText("Paid plan · not active")).toBeInTheDocument();
    expect(reviewButton()).toBeDisabled();
  });

  it("shows the plan on hold, and how to settle it, once the plan is read again", async () => {
    checkoutMock.mockResolvedValue({ ok: false, reason: "ACTIVE_SUBSCRIPTION", message: "You already have an active subscription.", status: 400 });
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    fetchPlanStrictMock.mockResolvedValue(PRO_ON_HOLD);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Free" }));

    expect(await screen.findByText(/Your Pro plan is on hold because a payment didn't go through/)).toBeInTheDocument();
    expect(billingLink("Update payment")).toBeInTheDocument();
    expect(reviewButton()).toBeDisabled();
  });

  it("goes ahead when turning Free on finds a paid plan that is active after all", async () => {
    checkoutMock.mockResolvedValue({ ok: false, reason: "ACTIVE_SUBSCRIPTION", message: "You already have an active subscription.", status: 400 });
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Free" }));

    expect(await screen.findByText("Operator is active.")).toBeInTheDocument();
    await waitFor(() => expect(reviewButton()).toBeEnabled());
    expect(screen.queryByText(/Free can't be turned on/)).not.toBeInTheDocument();
  });
});

describe("an account without a plan that already runs something", () => {
  it("says it couldn't check, instead of assuming nothing runs, when billing couldn't read it", async () => {
    fetchPlanStrictMock.mockResolvedValue({ ...NO_PLAN, usage: undefined });
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });

    expect(await screen.findByText("We couldn't check your plan, so we can't show what fits it yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Hermes/ })).toHaveTextContent("Couldn't check your plan");
    expect(screen.queryByText(/Fits Free/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    expect(await screen.findByText("Managed capacity could not be verified.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on Free" })).not.toBeInTheDocument();
  });

  it("says Free would have no room for it, from what billing observed", async () => {
    fetchPlanStrictMock.mockResolvedValue({ ...NO_PLAN, usage: { agentCount: 1, usedCpu: 0.5, usedRam: 1 } });
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    expect(screen.getByRole("button", { name: /^Hermes/ })).toHaveTextContent("Needs Pro");
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));

    expect(await screen.findByText("The Free plan runs one agent or computer on Hivra Cloud, and your account already has 1 there.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on Free" })).not.toBeInTheDocument();
    expect(reviewButton()).toBeDisabled();
  });
});

describe("the first-run funnel", () => {
  const events = (name: string) => captureMock.mock.calls.filter(([event]) => event === name).map(([, properties]) => properties);

  it("records the activation page, and Free turned on with its own button", async () => {
    fetchPlanStrictMock.mockResolvedValue(NO_PLAN);
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(events("activation_page_viewed")).toHaveLength(1));
    expect(events("activation_page_viewed")[0]).toMatchObject({ source: "launch-journey", route: "/dashboard/launch", plan: "free" });

    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Free" }));
    await screen.findByText("Free is active.");

    expect(events("activation_started")).toEqual([expect.objectContaining({ plan: "free" })]);
    expect(events("activation_dashboard_reached")).toEqual([expect.objectContaining({ plan: "free", outcome: "free_plan_activated" })]);
    // Seen once per visit, however often the plan is read.
    expect(events("activation_page_viewed")).toHaveLength(1);
  });

  it("records a Free activation that failed, in the fields the first-run audit reads", async () => {
    checkoutMock.mockResolvedValue({ ok: false, reason: null, status: 500, message: "Failed to start checkout. Please try again." });
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on Free" }));
    await screen.findByText(/Couldn't turn on the Free plan/);

    expect(events("activation_failed")).toEqual([expect.objectContaining({
      stage: "free_plan_activation", failureType: "subscribe_request_failed", errorCategory: "server", recoverable: true,
    })]);
    expect(events("activation_dashboard_reached")).toHaveLength(0);
  });

  it("records a launch request and its acceptance, without the launch's name", async () => {
    fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    await waitFor(() => expect(reviewButton()).toBeEnabled());
    fireEvent.click(reviewButton());
    fireEvent.click(screen.getByRole("button", { name: "Launch Claude Code" }));
    await waitFor(() => expect(routerPushMock).toHaveBeenCalled());

    const [requested] = events("activation_instance_requested");
    expect(requested).toMatchObject({
      source: "launch-journey", profile: "claude-code", agentType: "claude-code", resourceKind: "agent",
      deploymentMode: "hivra-managed", resumed: false, fromTemplate: false,
    });
    expect(events("launch_request_accepted")).toEqual([expect.objectContaining({
      profile: "claude-code", agentId: AGENT_ID, acceptedStatus: "provisioning", outcome: "accepted",
      launchRequestId: requested.launchRequestId,
    })]);
    // Hivra agents report readiness from the server, not from here.
    expect(events("activation_instance_ready")).toHaveLength(0);
    expect(JSON.stringify(captureMock.mock.calls)).not.toContain("Claude Code 1");
  });

  it("records a refused launch as a failure the first-run audit can read, with secrets redacted", async () => {
    fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
    createAgentMock.mockRejectedValue(new HivraLaunchRejectedError("Provision kickoff failed for sk-live-abcdefghijklmnop", 502, "provision_kickoff_failed"));
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    await waitFor(() => expect(reviewButton()).toBeEnabled());
    fireEvent.click(reviewButton());
    fireEvent.click(screen.getByRole("button", { name: "Launch Claude Code" }));
    await waitFor(() => expect(events("activation_failed")).toHaveLength(1));

    expect(events("activation_failed")[0]).toMatchObject({
      stage: "hivra_box_launch", failureType: "launch_rejected", errorCategory: "rejected",
      status: 502, serverFailureType: "provision_kickoff_failed", recoverable: true,
    });
    expect(String(events("activation_failed")[0].errorMessage)).not.toContain("abcdefghijklmnop");
    expect(events("launch_request_accepted")).toHaveLength(0);
  });

  it("records Hermes' card check and its readiness step the way the welcome flow did", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    let hermesResponse: unknown = { success: false, reason: "card_required", error: "A quick card check first." };
    const baseFetch = global.fetch as jest.Mock;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/instances" && init?.method === "POST") {
        const body = hermesResponse as { success: boolean };
        return json(body, body.success ? 200 : 402);
      }
      return baseFetch(input, init);
    }) as unknown as typeof fetch;
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Hermes/ }));
    await waitFor(() => expect(reviewButton()).toBeEnabled());
    fireEvent.click(reviewButton());
    fireEvent.click(screen.getByRole("button", { name: "Launch Hermes" }));
    await waitFor(() => expect(events("activation_card_required")).toHaveLength(1));

    expect(events("activation_card_required")[0]).toMatchObject({ profile: "hermes", agentType: "hermes" });
    expect(events("paywall_viewed")).toEqual(expect.arrayContaining([expect.objectContaining({ paywall: "card_required" })]));
    expect(events("activation_failed")).toHaveLength(0);

    hermesResponse = { success: true, data: { id: AGENT_ID, name: "Hermes 1", status: "provisioning" } };
    fireEvent.click(await screen.findByRole("button", { name: "Launch Hermes" }));
    await waitFor(() => expect(events("activation_instance_ready")).toHaveLength(1));
    expect(events("activation_instance_ready")[0]).toMatchObject({ profile: "hermes", outcome: "created_instance", hasInstanceId: true });
  });

  it("records a plan paywall once per launch, and the upgrade it leads to", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Ubuntu Desktop/ }));
    await screen.findByText(/Ubuntu Desktop needs a paid plan on Hivra Cloud/);
    // Editing the launch re-renders the blocker; the moment is still one.
    fireEvent.change(screen.getByRole("textbox", { name: /name/i }), { target: { value: "Desk" } });
    await waitFor(() => expect(events("paywall_viewed")).toHaveLength(1));
    expect(events("paywall_viewed")[0]).toMatchObject({ paywall: "paid_profile", from_plan: "free", profile: "ubuntu-desktop" });

    const upgrade = screen.getByRole("link", { name: /Upgrade to/ });
    // jsdom can't navigate; the click is what's measured.
    upgrade.addEventListener("click", event => event.preventDefault());
    fireEvent.click(upgrade);
    expect(events("upgrade_clicked")).toEqual([expect.objectContaining({ via: "plan_blocker", paywall: "paid_profile", from_plan: "free" })]);
  });

  it("records a Free account out of agent slots as the free-limit moment", async () => {
    fetchPlanStrictMock.mockResolvedValue({ ...FREE_PLAN, usage: { agentCount: 1, usedCpu: 0.5, usedRam: 1 } });
    render(<LaunchJourney />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    fireEvent.click(screen.getByRole("button", { name: /^Claude Code/ }));
    await screen.findByText("Your current plan has no open agent slots.");

    await waitFor(() => expect(events("free_limit_hit")).toHaveLength(1));
    expect(events("free_limit_hit")[0]).toMatchObject({ limit_type: "agents", from_plan: "free" });
    expect(events("paywall_viewed")).toEqual([expect.objectContaining({ paywall: "agent_limit" })]);
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
