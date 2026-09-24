/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { LaunchJourney } from "../LaunchJourney";

const routerPushMock = jest.fn();
const fetchPlanStrictMock = jest.fn();
const createAgentMock = jest.fn();
const summaryMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
  useSearchParams: () => ({ get: () => null, getAll: () => [] }),
}));

jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  fetchPlanStrict: () => fetchPlanStrictMock(),
  createAgent: (input: unknown) => createAgentMock(input),
}));

jest.mock("@/lib/billing/managed-venice-client", () => ({
  ...jest.requireActual("@/lib/billing/managed-venice-client"),
  requestManagedVeniceSummary: () => summaryMock(),
}));

jest.mock("@/lib/abuse/client-fingerprint", () => ({ getFingerprintRequestId: async () => null }));

let tokenGeoStatus: "allowed" | "blocked" = "allowed";
jest.mock("@/hooks/useTokenGeoAccess", () => ({
  useTokenGeoAccess: () => tokenGeoStatus === "allowed"
    ? { status: "allowed", notice: null }
    : { status: "blocked", notice: "Token features aren't available where you are." },
}));

jest.mock("@/components/billing/ManagedVeniceDepositModal", () => ({
  ManagedVeniceDepositModal: () => <div role="dialog" aria-label="Add Hivra credit" />,
}));

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const VENICE_KEY = { id: "44444444-4444-4444-8444-444444444444", provider: "venice", name: "Venice AI", key_preview: "venice...3f2a" };
const HONCHO_KEY = { id: "55555555-5555-4555-8555-555555555555", provider: "honcho", name: "Honcho", key_preview: "honcho...9d1c" };

const FREE_PLAN = {
  subscribed: false, name: "Free", key: "free", maxAgents: 1, maxCpuPerAgent: 0.5, maxRamPerAgent: 1,
  poolCpu: 0.5, poolRam: 1, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
};
const PAID_PLAN = {
  subscribed: true, name: "Operator", key: "operator", maxAgents: 4, maxCpuPerAgent: 8, maxRamPerAgent: 16,
  poolCpu: 16, poolRam: 32, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
};

function balance(cardUsd: number, tokenUsd = 0) {
  return { ok: true, summary: { wallets: {
    card: { balanceMicroUsd: cardUsd * 1_000_000, availableMicroUsd: cardUsd * 1_000_000, reservedMicroUsd: 0 },
    hermesos: { tokenDisplay: "0", lockedValueMicroUsd: 0, availableMicroUsd: tokenUsd * 1_000_000, reservedMicroUsd: 0 },
  } } };
}

let savedKeys: Array<typeof VENICE_KEY>;
let instanceBodies: Array<Record<string, unknown>>;
let workspaceReady: boolean;
let resolveInstance: ((response: Response) => void) | null;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/dashboard/launch");
  savedKeys = [];
  instanceBodies = [];
  workspaceReady = false;
  resolveInstance = null;
  tokenGeoStatus = "allowed";
  fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
  summaryMock.mockResolvedValue(balance(4.25));
  createAgentMock.mockResolvedValue({ id: AGENT_ID, type: "claude-code", name: "Claude Code 1", status: "provisioning", cpu: 0.5, ram: 1 });
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/infrastructure/targets")) return json({ success: true, data: { targets: [] } });
    if (url === "/api/vault") return json({ success: true, data: savedKeys });
    if (url === "/api/hivra/agents") return json({ success: true, data: { agents: [] } });
    if (url === "/api/instances?summary=true") return json({ success: true, data: [] });
    if (url === "/api/instances" && init?.method === "POST") {
      instanceBodies.push(JSON.parse(String(init.body)));
      if (resolveInstance === null) return json({ success: true, data: { id: AGENT_ID, name: "Hermes 1", status: "provisioning" } });
      return new Promise<Response>(resolve => { resolveInstance = resolve; });
    }
    if (url === `/api/instances/${AGENT_ID}/webui-login-url`) {
      return workspaceReady ? json({ url: "https://hermes.example.test/login" }) : json({ retryAfterMs: 2500 }, 202);
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
});

async function chooseAgent(name: string) {
  render(<LaunchJourney />);
  await screen.findByRole("heading", { name: "What do you want to launch?" });
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
  expect(screen.getByRole("heading", { name: `${name} — here's the plan` })).toBeInTheDocument();
}

const modelChoice = (name: RegExp) => within(screen.getByRole("group", { name: "Model access" })).getByRole("button", { name });

async function reviewLaunch() {
  await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
  fireEvent.click(screen.getByTestId("launch-primary-action"));
  return within(screen.getByLabelText("Launch review"));
}

describe("every catalog agent launches in the Launch journey", () => {
  it("starts Hermes on Hivra credits when there are some, launches it, and waits for its workspace to answer", async () => {
    await chooseAgent("Hermes");
    await waitFor(() => expect(modelChoice(/^Hivra credits/)).toHaveAttribute("aria-pressed", "true"));
    expect(modelChoice(/^Hivra credits/)).toHaveTextContent("$4.25 available");

    const review = await reviewLaunch();
    expect(review.getByText(/^Hivra credits \(\$4\.25 available\) · DeepSeek V4 Flash/)).toBeInTheDocument();
    expect(review.getByText("Chat, a terminal, files and skills on its own computer.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch Hermes" }));

    await screen.findByRole("heading", { name: "Hermes 1 has its own computer and is starting." });
    expect(instanceBodies).toHaveLength(1);
    expect(instanceBodies[0]).toMatchObject({
      name: "Hermes 1", provider: "venice", model: "deepseek-v4-flash", apiKey: "",
      managedVenice: { enabled: true, walletType: "card" },
    });
    // Nothing on this screen advances on a timer; it waits for the workspace.
    expect(screen.queryByText(/Each step happens live/)).not.toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toHaveTextContent("Open Hermes 1 now");
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("shows Start chatting as the primary action once the Hermes workspace answers", async () => {
    workspaceReady = true;
    await chooseAgent("Hermes");
    await waitFor(() => expect(modelChoice(/^Hivra credits/)).toHaveAttribute("aria-pressed", "true"));
    await reviewLaunch();
    fireEvent.click(screen.getByRole("button", { name: "Launch Hermes" }));

    const start = await screen.findByRole("link", { name: /Start chatting/ });
    expect(start).toHaveAttribute("href", `/dashboard/instances/${AGENT_ID}?surface=chat&welcome=1`);
    expect(start).toHaveAttribute("data-testid", "launch-primary-action");
    expect(screen.getByRole("link", { name: "Also chat from Telegram" }))
      .toHaveAttribute("href", `/dashboard/instances/${AGENT_ID}?surface=chat&welcome=1&connect=telegram`);
  });

  it("starts Hermes set up inside itself at $0, with credits disabled and a way to add some", async () => {
    summaryMock.mockResolvedValue(balance(0));
    await chooseAgent("Hermes");
    await waitFor(() => expect(modelChoice(/^Hivra credits/)).toBeDisabled());
    expect(modelChoice(/^Set up inside Hermes after it opens/)).toHaveAttribute("aria-pressed", "true");
    expect(modelChoice(/^Hivra credits/)).toHaveTextContent("You have $0 in Hivra credits.");

    fireEvent.click(within(screen.getByRole("group", { name: "Model access" })).getByRole("button", { name: "Add credit" }));
    expect(screen.getByRole("dialog", { name: "Add Hivra credit" })).toBeInTheDocument();

    const review = await reviewLaunch();
    expect(review.getByText("Choose a model provider inside Hermes after it opens.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch Hermes" }));
    await waitFor(() => expect(instanceBodies).toHaveLength(1));
    expect(instanceBodies[0]).toMatchObject({ unconfigured: true });
    expect(instanceBodies[0]).not.toHaveProperty("provider");
  });

  it("lets the owner choose which funded wallet pays, and bills it", async () => {
    summaryMock.mockResolvedValue(balance(1, 2));
    await chooseAgent("Hermes");
    await waitFor(() => expect(modelChoice(/^Hivra credits/)).toHaveAttribute("aria-pressed", "true"));
    const wallet = screen.getByRole("combobox", { name: "Pay from" });
    fireEvent.change(wallet, { target: { value: "hermesos" } });
    const review = await reviewLaunch();
    expect(review.getByText(/^Hivra credits \(\$2\.00 available\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch Hermes" }));
    await waitFor(() => expect(instanceBodies).toHaveLength(1));
    expect(instanceBodies[0]).toMatchObject({ managedVenice: { enabled: true, walletType: "hermesos" } });
  });

  it("offers only card credits to a viewer the token geo-policy blocks", async () => {
    tokenGeoStatus = "blocked";
    summaryMock.mockResolvedValue(balance(0, 7));
    await chooseAgent("Hermes");
    await waitFor(() => expect(modelChoice(/^Hivra credits/)).toBeDisabled());
    expect(modelChoice(/^Hivra credits/)).toHaveTextContent("You have $0 in Hivra credits.");
    expect(modelChoice(/^Set up inside Hermes after it opens/)).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("combobox", { name: "Pay from" })).not.toBeInTheDocument();
  });

  it("shows only observed launch state while a Hermes launch is being confirmed", async () => {
    resolveInstance = () => undefined;
    await chooseAgent("Hermes");
    await waitFor(() => expect(modelChoice(/^Hivra credits/)).toHaveAttribute("aria-pressed", "true"));
    await reviewLaunch();
    fireEvent.click(screen.getByRole("button", { name: "Launch Hermes" }));

    expect(await screen.findByRole("heading", { name: "Confirming your launch…" })).toBeInTheDocument();
    expect(screen.getByText(/Sent to Hivra\. It answers once the computer is created/)).toHaveTextContent(/Sent 0:\d\d ago/);
    expect(screen.queryByText(/Installing|Waking|Creating a private, secure workspace/)).not.toBeInTheDocument();
  });

  it("sends the saved Honcho memory key only when the owner ticks it for this launch", async () => {
    savedKeys = [HONCHO_KEY];
    await chooseAgent("Hermes");
    const memory = await screen.findByRole("checkbox", { name: /Send my saved Honcho key ••9d1c to Hermes 1's computer/ });
    expect(memory).not.toBeChecked();

    let review = await reviewLaunch();
    expect(review.queryByText(/Honcho/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Send my saved Honcho key/ }));
    review = await reviewLaunch();
    expect(review.getByText("Honcho, with your saved key ••9d1c, sent to Hermes 1's computer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Launch Hermes" }));
    await waitFor(() => expect(instanceBodies).toHaveLength(1));
    expect(instanceBodies[0]).toMatchObject({ honchoVaultKeyId: HONCHO_KEY.id });
  });

  it("launches Claude Code on Free without a browser and opens its terminal", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    await chooseAgent("Claude Code");
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Browser for Claude Code/ })).not.toBeChecked());
    expect(modelChoice(/^Sign in inside Claude Code after it opens/)).toHaveAttribute("aria-pressed", "true");
    expect(modelChoice(/^Use my API key/)).toBeDisabled();

    const review = await reviewLaunch();
    expect(review.getByText("Sign in with your Anthropic account inside Claude Code after it opens.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch Claude Code" }));

    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(1));
    expect(createAgentMock).toHaveBeenCalledWith({
      type: "claude-code", name: "Claude Code 1", cpu: 0.5, ram: 1, browser: false, deployment: { mode: "hivra-managed" },
    });
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith(`/dashboard/agent/${AGENT_ID}?welcome=1&tab=terminal`));
  });

  it("sends Codex a saved Vault key only after the per-launch consent, then opens its model settings", async () => {
    savedKeys = [VENICE_KEY];
    createAgentMock.mockResolvedValue({ id: AGENT_ID, type: "codex", name: "Codex 1", status: "provisioning", cpu: 1.5, ram: 3 });
    await chooseAgent("Codex");
    await waitFor(() => expect(modelChoice(/^Use my API key/)).toBeEnabled());
    fireEvent.click(modelChoice(/^Use my API key/));

    expect(screen.getByRole("button", { name: "Use my saved key ••3f2a" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeDisabled());
    fireEvent.click(screen.getByRole("checkbox", { name: /Send this key to Codex 1's computer/ }));

    const review = await reviewLaunch();
    expect(review.getByText("Your saved Venice AI key ••3f2a, sent to Codex 1's computer · DeepSeek V4 Pro (via Venice)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch Codex" }));

    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(1));
    expect(createAgentMock.mock.calls[0][0]).toMatchObject({
      type: "codex",
      llm: { provider: "venice", mode: "byok", model: "deepseek-v4-pro", vaultKeyId: VENICE_KEY.id },
    });
    expect(createAgentMock.mock.calls[0][0].llm).not.toHaveProperty("apiKey");
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith(`/dashboard/agent/${AGENT_ID}?welcome=1&tab=manage#model-settings`));
  });

  it("keeps a pasted key out of the saved draft", async () => {
    await chooseAgent("Codex");
    await waitFor(() => expect(modelChoice(/^Use my API key/)).toBeEnabled());
    fireEvent.click(modelChoice(/^Use my API key/));
    fireEvent.change(screen.getByLabelText("Venice AI API key"), { target: { value: "synthetic-venice-key" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Save it in my Vault for next time" }));
    await reviewLaunch();

    const stored = Object.keys(window.localStorage).map(key => window.localStorage.getItem(key)).join("");
    expect(stored).not.toContain("synthetic-venice-key");
    expect(stored).toContain("\"mode\":\"api-key\"");
  });

  it("launches OpenClaw on Hivra credits exactly as its form did", async () => {
    createAgentMock.mockResolvedValue({ id: AGENT_ID, type: "openclaw", name: "OpenClaw 1", status: "provisioning", cpu: 1, ram: 2 });
    await chooseAgent("OpenClaw");
    await waitFor(() => expect(modelChoice(/^Hivra credits/)).toBeEnabled());
    fireEvent.click(modelChoice(/^Hivra credits/));
    const review = await reviewLaunch();
    expect(review.getByText("Hivra credits ($4.25 available)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch OpenClaw" }));

    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(1));
    expect(createAgentMock).toHaveBeenCalledWith({
      type: "openclaw", name: "OpenClaw 1", cpu: 1, ram: 2, browser: false, managedVenice: true,
      llm: { provider: "venice", mode: "managed", walletType: "card" }, deployment: { mode: "hivra-managed" },
    });
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith(`/dashboard/agent/${AGENT_ID}?welcome=1&tab=aeon`));
  });
});
