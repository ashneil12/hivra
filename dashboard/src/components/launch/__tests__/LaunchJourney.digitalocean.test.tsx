/** @jest-environment jsdom */
// Slice 9 (INF-15, F12, FTUE-04): a connected DigitalOcean Managed Agents team
// is a place a Launch agent runs, reviewed and launched like any other.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { DigitalOceanDeploymentTargetDtoSchema, DIGITALOCEAN_MANAGED_AGENTS_ADAPTER_VERSION } from "@/lib/infrastructure/contracts";
import { LaunchJourney } from "../LaunchJourney";

const routerPushMock = jest.fn();
const fetchPlanStrictMock = jest.fn();
const summaryMock = jest.fn();
let targetParams: string[] = [];

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
  useSearchParams: () => ({
    get: (key: string) => (key === "start" && targetParams.length ? "1" : null),
    getAll: (key: string) => (key === "targetId" ? targetParams : []),
  }),
}));

jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  fetchPlanStrict: () => fetchPlanStrictMock(),
}));

jest.mock("@/lib/billing/managed-venice-client", () => ({
  ...jest.requireActual("@/lib/billing/managed-venice-client"),
  requestManagedVeniceSummary: () => summaryMock(),
}));

jest.mock("@/lib/abuse/client-fingerprint", () => ({ getFingerprintRequestId: async () => null }));
jest.mock("@/hooks/useTokenGeoAccess", () => ({ useTokenGeoAccess: () => ({ status: "allowed", notice: null }) }));
jest.mock("@/components/billing/ManagedVeniceDepositModal", () => ({ ManagedVeniceDepositModal: () => null }));

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const OPENAI_KEY = "sk-test-openai-key-for-launch-0000";
const DO_MODEL_KEY = "do-model-access-key-for-launch-000";
const SAVED_OPENAI_ID = "44444444-4444-4444-8444-444444444444";
const SAVED_NOW_ID = "55555555-5555-4555-8555-555555555555";

const TEAM = DigitalOceanDeploymentTargetDtoSchema.parse({
  id: TARGET_ID,
  connectionId: CONNECTION_ID,
  evidenceConnectionRevision: 3,
  externalId: "do-harness-runtime",
  displayName: "Studio team",
  status: "ready",
  capacity: { model: "serverless-sessions", sizes: [
    { slug: "mars-1vcpu-1gb", vcpus: 1, memoryMb: 1024 },
    { slug: "mars-2vcpu-4gb", vcpus: 2, memoryMb: 4096 },
  ] },
  capabilities: {
    kind: "digitalocean-managed-agents", launchReady: true,
    adapter: { version: DIGITALOCEAN_MANAGED_AGENTS_ADAPTER_VERSION },
    harnesses: ["claude-code", "codex", "hermes"], sizes: ["mars-1vcpu-1gb", "mars-2vcpu-4gb"],
    access: { chat: "hivra-relay-v1", approvals: "hivra-relay-v1", terminal: false, publicPorts: false },
    desktop: false, windows: false,
  },
  supportedIsolationDrivers: ["do-harness-microvm"],
  isolationClass: "provider-microvm",
  lastPreflightAt: "2026-09-24T10:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-09-24T10:00:00.000Z",
  updatedAt: "2026-09-24T10:00:00.000Z",
});

const PAID_PLAN = {
  subscribed: true, name: "Operator", key: "operator", maxAgents: 4, maxCpuPerAgent: 8, maxRamPerAgent: 16,
  poolCpu: 16, poolRam: 32, usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
};

let launchBodies: Array<Record<string, unknown>>;
let balanceState: "ok" | "blocked";
let doModels: string[];
let vaultKeys: Array<{ id: string; provider: string; name: string; key_preview: string | null }>;
let vaultSaves: Array<Record<string, unknown>>;
let loseNextLaunchAnswer: boolean;
let vaultListed: Promise<void>;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/dashboard/launch");
  targetParams = [];
  launchBodies = [];
  balanceState = "ok";
  doModels = ["llama3.3-70b-instruct", "openai-gpt-oss-120b"];
  vaultKeys = [];
  vaultSaves = [];
  loseNextLaunchAnswer = false;
  vaultListed = Promise.resolve();
  fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
  summaryMock.mockResolvedValue({ ok: true, summary: { wallets: {
    card: { balanceMicroUsd: 0, availableMicroUsd: 0, reservedMicroUsd: 0 },
    hermesos: { tokenDisplay: "0", lockedValueMicroUsd: 0, availableMicroUsd: 0, reservedMicroUsd: 0 },
  } } });
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/infrastructure/targets")) return json({ success: true, data: { targets: [] } });
    if (url === "/api/vault" && init?.method === "POST") {
      vaultSaves.push(JSON.parse(String(init.body)));
      return json({ success: true, data: { id: SAVED_NOW_ID } });
    }
    if (url === "/api/vault") {
      await vaultListed;
      return json({ success: true, data: vaultKeys });
    }
    if (url === "/api/hivra/agents") return json({ success: true, data: { agents: [] } });
    if (url === "/api/instances?summary=true") return json({ success: true, data: [] });
    if (url === "/api/hivra/managed-sessions" && (!init?.method || init.method === "GET")) {
      return json({ success: true, data: { sessions: [], targets: [TEAM] } });
    }
    if (url === "/api/hivra/managed-sessions" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      launchBodies.push(body);
      if (loseNextLaunchAnswer) {
        loseNextLaunchAnswer = false;
  vaultListed = Promise.resolve();
        throw new TypeError("Failed to fetch");
      }
      return json({ success: true, data: { session: {
        agentId: AGENT_ID, name: body.name, harness: body.harness, size: body.size, status: "provisioning",
        providerStatus: null, pauseReason: null, sessionId: null, connectionId: CONNECTION_ID, error: null,
        createdAt: "2026-09-24T10:05:00.000Z",
      } } }, 201);
    }
    if (url.endsWith(`/connections/${CONNECTION_ID}/digitalocean/balance`)) {
      return json({ success: true, data: { balance: { state: balanceState, balance: balanceState === "ok" ? "25.00" : "0.00", autoPrepay: false, checkedAt: "2026-09-24T10:00:00.000Z" } } });
    }
    if (url.endsWith(`/connections/${CONNECTION_ID}/digitalocean/models`)) return json({ success: true, data: { models: doModels } });
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
});

async function chooseAgent(name: string) {
  render(<LaunchJourney />);
  await screen.findByRole("heading", { name: "What do you want to launch?" });
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
  expect(screen.getByRole("heading", { name: `${name} — here's the plan` })).toBeInTheDocument();
}

async function chooseTeam() {
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  fireEvent.click(await screen.findByRole("button", { name: /^DigitalOcean · Studio team/ }));
}

const modelChoice = (name: RegExp) => within(screen.getByRole("group", { name: "Model access" })).getByRole("button", { name });

it("runs Codex on the owner's DigitalOcean team: its sizes, a vendor key, what DigitalOcean bills, and one review", async () => {
  await chooseAgent("Codex");
  await chooseTeam();

  // Where it runs says so, and it is the pressed choice.
  expect(screen.getAllByText("DigitalOcean · Studio team")).toHaveLength(2);
  expect(screen.getByRole("button", { name: /^Hivra Cloud/ })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: /^DigitalOcean · Studio team/ })).toHaveAttribute("aria-pressed", "true");
  const size = screen.getByLabelText("Sandbox size");
  expect(size).toHaveValue("mars-2vcpu-4gb");
  expect(within(size).getAllByRole("option").map(option => option.textContent)).toEqual(["1 vCPU / 1 GB", "2 vCPU / 4 GB"]);
  expect(modelChoice(/^Use my OpenAI API key/)).toHaveAttribute("aria-pressed", "true");
  expect(modelChoice(/^Sign in after it opens, or Hivra credits/)).toBeDisabled();
  expect(screen.getByText("DigitalOcean bills this sandbox per second while it runs, to your team.")).toBeInTheDocument();
  expect(await screen.findByText(/Prepaid balance \$25\.00/)).toBeInTheDocument();
  // No Hivra plan, host size or browser applies to a DigitalOcean sandbox.
  expect(screen.queryByRole("checkbox", { name: /Browser for Codex/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Size" })).not.toBeInTheDocument();

  // A key is needed first; it stays in the page and never in the saved draft.
  expect(screen.getByText("Paste your OpenAI API key for Codex.")).toBeInTheDocument();
  expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
  fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: OPENAI_KEY } });
  fireEvent.change(size, { target: { value: "mars-1vcpu-1gb" } });
  // The setup note Hivra sends first costs a reply, so it is disclosed before launch.
  expect(screen.getByText(/Hivra first sends Codex 1 a short setup note as a visible chat message/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("First task (optional)"), { target: { value: "Summarize the repo" } });
  await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
  expect(JSON.stringify({ ...window.localStorage })).not.toContain(OPENAI_KEY);
  fireEvent.click(screen.getByTestId("launch-primary-action"));

  const review = within(screen.getByLabelText("Launch review"));
  expect(review.getByText(/DigitalOcean · Studio team/)).toBeInTheDocument();
  expect(review.getByText("1 vCPU / 1 GB DigitalOcean sandbox")).toBeInTheDocument();
  expect(review.getByText("Your OpenAI API key, sent to DigitalOcean for this sandbox")).toBeInTheDocument();
  expect(review.getByText(/Creates one DigitalOcean sandbox on Studio team and starts it\. DigitalOcean bills from now\. Hivra sends it a short setup note/)).toBeInTheDocument();
  expect(review.getByText("Summarize the repo")).toBeInTheDocument();
  const launch = screen.getByTestId("launch-primary-action");
  expect(launch).toHaveTextContent("Launch and start billing");
  fireEvent.click(launch);

  await waitFor(() => expect(launchBodies).toHaveLength(1));
  expect(launchBodies[0]).toEqual({
    launchRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    connectionId: CONNECTION_ID,
    targetId: TARGET_ID,
    harness: "codex",
    size: "mars-1vcpu-1gb",
    name: "Codex 1",
    model: { mode: "vendor", apiKey: OPENAI_KEY },
    firstTask: "Summarize the repo",
  });
  await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith(`/dashboard/agent/${AGENT_ID}`));
  expect(JSON.stringify({ ...window.localStorage })).not.toContain(OPENAI_KEY);
});

it("takes the team a DigitalOcean card handed over for the agent the owner picks", async () => {
  targetParams = [TARGET_ID];
  await chooseAgent("Claude Code");
  expect(await screen.findByText("DigitalOcean · Studio team")).toBeInTheDocument();
  expect(modelChoice(/^Use my Anthropic API key/)).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText("Anthropic API key")).toBeInTheDocument();
});

it("stops before Review while DigitalOcean is blocking new sessions for the team", async () => {
  balanceState = "blocked";
  await chooseAgent("Codex");
  await chooseTeam();
  fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: OPENAI_KEY } });
  expect(await screen.findByText(/DigitalOcean is blocking new sessions for this team/)).toBeInTheDocument();
  expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
});

it("runs Hermes on DigitalOcean Inference only, with DigitalOcean's model list", async () => {
  await chooseAgent("Hermes");
  await chooseTeam();
  expect(modelChoice(/^Use my provider key/)).toBeDisabled();
  expect(modelChoice(/^DigitalOcean Inference/)).toHaveAttribute("aria-pressed", "true");
  fireEvent.change(screen.getByLabelText("DigitalOcean model access key"), { target: { value: DO_MODEL_KEY } });
  const model = await screen.findByRole("combobox", { name: "DigitalOcean model" });
  expect(screen.getByText("Choose the DigitalOcean model it uses.")).toBeInTheDocument();
  fireEvent.change(model, { target: { value: "openai-gpt-oss-120b" } });
  await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
  fireEvent.click(screen.getByTestId("launch-primary-action"));
  fireEvent.click(screen.getByTestId("launch-primary-action"));

  await waitFor(() => expect(launchBodies).toHaveLength(1));
  expect(launchBodies[0]).toMatchObject({
    harness: "hermes", size: "mars-2vcpu-4gb",
    model: { mode: "digitalocean-inference", apiKey: DO_MODEL_KEY, model: "openai-gpt-oss-120b" },
  });
  // Hermes on DigitalOcean opens its DigitalOcean chat, not the Hivra Cloud workspace wait.
  await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith(`/dashboard/agent/${AGENT_ID}`));
});

it("lets the owner type a model slug when DigitalOcean's list is unavailable", async () => {
  doModels = [];
  await chooseAgent("Hermes");
  await chooseTeam();
  const model = await screen.findByRole("textbox", { name: "DigitalOcean model" });
  fireEvent.change(model, { target: { value: "llama3.3-70b-instruct" } });
  fireEvent.change(screen.getByLabelText("DigitalOcean model access key"), { target: { value: DO_MODEL_KEY } });
  await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
});

it("never offers DigitalOcean to an agent it can't run", async () => {
  await chooseAgent("OpenClaw");
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/hivra/managed-sessions", expect.anything()));
  expect(screen.queryByRole("button", { name: /^DigitalOcean ·/ })).not.toBeInTheDocument();
});

// INF-16: every DigitalOcean launch asked for the provider key again, and the
// owner's Vault was never offered.
describe("a provider key saved in the Vault", () => {
  beforeEach(() => {
    vaultKeys = [
      { id: "66666666-6666-4666-8666-666666666666", provider: "codex", name: "ChatGPT", key_preview: null },
      { id: SAVED_OPENAI_ID, provider: "openai", name: "OpenAI", key_preview: "sk-abc...3f2a" },
    ];
  });

  it("is offered first, sent only once confirmed for this launch, and named in Review", async () => {
    await chooseAgent("Codex");
    await chooseTeam();

    const which = await screen.findByRole("group", { name: "Which key" });
    expect(within(which).getByRole("button", { name: "Use my saved key ••3f2a" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText("OpenAI API key")).not.toBeInTheDocument();
    // Offering the key sends nothing: it needs its own tick, every launch.
    const consent = screen.getByRole("checkbox", { name: /Send this key to DigitalOcean for Codex 1/ });
    expect(consent).not.toBeChecked();
    expect(screen.getByText("Confirm that your saved OpenAI API key can be sent to DigitalOcean for this sandbox.")).toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toBeDisabled();

    fireEvent.click(consent);
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    const review = within(screen.getByLabelText("Launch review"));
    expect(review.getByText("Your saved OpenAI API key ••3f2a, sent to DigitalOcean for this sandbox")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));

    await waitFor(() => expect(launchBodies).toHaveLength(1));
    expect(launchBodies[0].model).toEqual({ mode: "vendor", vaultKeyId: SAVED_OPENAI_ID });
    expect(vaultSaves).toEqual([]);
  });

  it("can be replaced by a pasted key, saved to the Vault for next time only when the owner asks", async () => {
    await chooseAgent("Codex");
    await chooseTeam();
    fireEvent.click(within(await screen.findByRole("group", { name: "Which key" })).getByRole("button", { name: "Paste a new key" }));
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: OPENAI_KEY } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Save it in my Vault for next time, replacing your saved key ••3f2a" }));
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(within(screen.getByLabelText("Launch review"))
      .getByText("Your OpenAI API key, sent to DigitalOcean for this sandbox and saved in your Vault, replacing ••3f2a")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));

    await waitFor(() => expect(launchBodies).toHaveLength(1));
    expect(vaultSaves).toEqual([{ name: "OpenAI API key", provider: "openai", key: OPENAI_KEY }]);
    // The launch names the key just saved, so a resend never needs it typed again.
    expect(launchBodies[0].model).toEqual({ mode: "vendor", vaultKeyId: SAVED_NOW_ID });
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(OPENAI_KEY);
  });

  it("resends a launch whose answer was lost with the same saved key, after a reload, without asking for it", async () => {
    loseNextLaunchAnswer = true;
    await chooseAgent("Codex");
    await chooseTeam();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Send this key to DigitalOcean for Codex 1/ }));
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(await screen.findByRole("heading", { name: "Launch could not be confirmed." })).toBeInTheDocument();

    cleanup();
    render(<LaunchJourney />);
    expect(await screen.findByRole("heading", { name: "Launch could not be confirmed." })).toBeInTheDocument();
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));

    await waitFor(() => expect(launchBodies).toHaveLength(2));
    expect(launchBodies[1]).toEqual(launchBodies[0]);
    expect(launchBodies[1].model).toEqual({ mode: "vendor", vaultKeyId: SAVED_OPENAI_ID });
  });

  it("asks for a pasted key again before resending a lost launch after a reload", async () => {
    vaultKeys = [];
    loseNextLaunchAnswer = true;
    await chooseAgent("Codex");
    await chooseTeam();
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: OPENAI_KEY } });
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(await screen.findByRole("heading", { name: "Launch could not be confirmed." })).toBeInTheDocument();

    cleanup();
    render(<LaunchJourney />);
    expect(await screen.findByRole("heading", { name: "Launch could not be confirmed." })).toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: OPENAI_KEY } });
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    await waitFor(() => expect(launchBodies).toHaveLength(2));
    expect(launchBodies[1]).toEqual(launchBodies[0]);
  });

  it("never takes over a key the owner already typed when the Vault list arrives late", async () => {
    let list = () => undefined as void;
    vaultListed = new Promise<void>(resolve => { list = resolve; });
    await chooseAgent("Codex");
    await chooseTeam();
    fireEvent.change(await screen.findByLabelText("OpenAI API key"), { target: { value: OPENAI_KEY } });
    list();

    const which = await screen.findByRole("group", { name: "Which key" });
    expect(within(which).getByRole("button", { name: "Paste a new key" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("OpenAI API key")).toHaveValue(OPENAI_KEY);
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
  });

  it("isn't offered for DigitalOcean Inference, and a key typed for one choice never carries into another", async () => {
    await chooseAgent("Codex");
    await chooseTeam();
    fireEvent.click(within(await screen.findByRole("group", { name: "Which key" })).getByRole("button", { name: "Paste a new key" }));
    fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: OPENAI_KEY } });
    fireEvent.click(modelChoice(/^DigitalOcean Inference/));

    expect(screen.queryByRole("group", { name: "Which key" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Save it in my Vault/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("DigitalOcean model access key")).toHaveValue("");
  });
});
