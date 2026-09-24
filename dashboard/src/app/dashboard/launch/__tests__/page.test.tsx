/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import {
  PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
} from "@/lib/infrastructure/portable-provisioner-contract";
import {
  HivraLaunchCorrectableError,
  HivraLaunchRejectedError,
} from "@/lib/hivra/agent-api";
import LaunchPage from "../page";
import { createLaunchDraft, launchDraftStorageKey } from "@/lib/launch/draft-store";

const createAgentMock = jest.fn();
const findHivraLaunchReceiptMock = jest.fn();
const fetchPlanStrictMock = jest.fn();
const routerPushMock = jest.fn();
const searchParamsGetMock = jest.fn();
const searchParamsGetAllMock = jest.fn();
const mockedSearchParams = {
  get: searchParamsGetMock,
  getAll: searchParamsGetAllMock,
};

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
  useSearchParams: () => mockedSearchParams,
}));

jest.mock("@/lib/hivra/agent-api", () => ({
  ...jest.requireActual("@/lib/hivra/agent-api"),
  createAgent: (input: unknown) => createAgentMock(input),
  findHivraLaunchReceipt: (launchRequestId: string) => findHivraLaunchReceiptMock(launchRequestId),
  fetchPlanStrict: () => fetchPlanStrictMock(),
}));

const PROXMOX_TARGET: DeploymentTargetDto = {
  id: "22222222-2222-4222-8222-222222222222",
  connectionId: "11111111-1111-4111-8111-111111111111",
  evidenceConnectionRevision: 7,
  externalId: "pve-01",
  displayName: "Studio Proxmox / pve-01",
  status: "ready",
  capacity: {
    cpu: { totalCores: 6, utilizationRatio: 0.2 },
    memoryBytes: { total: 16 * 1024 ** 3, available: 8 * 1024 ** 3 },
    storageBytes: { total: 500 * 1024 ** 3, available: 350 * 1024 ** 3 },
  },
  capabilities: {
    proxmoxVersion: "pve-manager/8.4.1",
    launchReady: true,
    directRootAccess: true,
    kvmAvailable: true,
    bridges: ["vmbr1"],
    selectedBridge: "vmbr1",
    storages: ["local-lvm"],
    selectedStorage: "local-lvm",
    template: { vmid: 9000, exists: true, isTemplate: true, nameMatches: true, ready: true },
    provisioner: { configured: true, ready: true, version: PORTABLE_HIVRA_PROVISIONER_VERSION },
    runtimeCompatibility: {
      ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
      supportedCatalogRuntimeIds: ["codex", "linux-desktop"],
    },
    vmidRange: { start: 200, end: 399, freeCount: 180, firstAvailable: 200 },
    issues: [],
  },
  supportedIsolationDrivers: ["proxmox-kvm"],
  isolationClass: "hardware-vm",
  lastPreflightAt: "2026-09-04T12:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-09-04T12:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z",
};

// Holds browser-off Codex (0.5 CPU / 1 GB) but not the 1.5 CPU / 3 GB browser floor.
const SMALL_PROXMOX_TARGET: DeploymentTargetDto = {
  ...PROXMOX_TARGET,
  id: "44444444-4444-4444-8444-444444444444",
  externalId: "pve-02",
  displayName: "Small Proxmox / pve-02",
  capacity: {
    ...PROXMOX_TARGET.capacity,
    cpu: { totalCores: 1, utilizationRatio: 0.2 },
    memoryBytes: { total: 4 * 1024 ** 3, available: 2 * 1024 ** 3 },
  },
};

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

const FREE_PLAN = {
  subscribed: false,
  name: "Free",
  key: "free",
  maxAgents: 1,
  maxCpuPerAgent: 0.5,
  maxRamPerAgent: 1,
  poolCpu: 0.5,
  poolRam: 1,
  usage: { agentCount: 0, usedCpu: 0, usedRam: 0 },
};

const PROVIDER_TARGET: DeploymentTargetDto = {
  ...PROXMOX_TARGET,
  lastErrorCode: null,
  externalId: "164662066",
  displayName: "Owned provider computer",
  capacity: {
    cpu: { totalCores: 2, utilizationRatio: 0.1 },
    memoryBytes: { total: 4 * 1024 ** 3, available: Math.floor(3.32 * 1024 ** 3) },
    storageBytes: { total: 40 * 1024 ** 3, available: 35 * 1024 ** 3 },
  },
  capabilities: {
    kind: "provider-vm", provider: "hetzner-cloud",
    capacityOrderId: "55555555-5555-4555-8555-555555555555",
    enrollmentAttemptId: "66666666-6666-4666-8666-666666666666",
    hostIdentityDigest: "a".repeat(64), allocation: "exclusive-computer",
    launchReady: true,
    provisioner: { configured: true, ready: true, version: PORTABLE_HIVRA_PROVIDER_VM_PROVISIONER_VERSION,
      bundleSha256: "b".repeat(64), scopeSha256: "c".repeat(64) },
    runtimeCompatibility: null,
  },
  supportedIsolationDrivers: ["provider-vm"], isolationClass: "provider-vm",
};

const GVISOR_TARGET: DeploymentTargetDto = {
  ...PROXMOX_TARGET,
  externalId: `gvisor-${"a".repeat(24)}`,
  displayName: "Owned Linux host — gVisor",
  capabilities: {
    kind: "gvisor", launchReady: true, hostIdentityDigest: "a".repeat(64),
    adapter: { version: "2026.09.15.1", sha256: "b".repeat(64) },
    runtime: { path: "/usr/local/bin/runsc", sha256: "c".repeat(64) },
    runtimeCompatibility: { contractVersion: 1, supportedWorkloadKinds: ["linux-terminal"] },
    resourcePolicy: { reservationEqualsMaximum: true, aggregateAdmission: "serialized-host-headroom-v1" },
    access: { terminal: "owner-gated-command-v1", publicPorts: false }, desktop: false, windows: false,
  },
  supportedIsolationDrivers: ["gvisor-runsc"], isolationClass: "application-kernel",
  lastErrorCode: null,
};

// jest.setup signs every test in as user_123; drafts are saved per owner.
const DRAFT_KEY = launchDraftStorageKey("user_123");
const storedDraftJson = () => JSON.parse(window.localStorage.getItem(DRAFT_KEY) || "{}");

type TileName = "Codex" | "Ubuntu Desktop" | "Linux Sandbox" | "Windows" | "Omarchy";

/** Choose goes straight to the plan: there is no Continue step. */
function chooseTile(name: TileName) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
}

/** Where it runs is summarized until the owner asks to change it. */
function openWhereItRuns() {
  const change = screen.queryByRole("button", { name: "Change" });
  if (change) fireEvent.click(change);
}

function whereButton(name: RegExp) {
  openWhereItRuns();
  return screen.getByRole("button", { name });
}

async function findWhereButton(name: RegExp) {
  openWhereItRuns();
  return screen.findByRole("button", { name });
}

function readyHost() {
  openWhereItRuns();
  return screen.getByRole("combobox", { name: /Ready host/ });
}

/** Reserved and maximum pickers sit behind Customize. */
function customField(label: "Reserved CPU" | "Maximum CPU" | "Reserved memory" | "Maximum memory") {
  const toggle = screen.queryByRole("button", { name: "Customize" });
  if (toggle) fireEvent.click(toggle);
  return screen.getByLabelText(label);
}

function launchButton() {
  return screen.getByRole("button", { name: /^(Launch |Start Windows setup)/ });
}

function expectCurrentStep(label: "Choose" | "Plan" | "Review") {
  const steps = screen.getByRole("list", { name: "Launch steps" });
  expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
  expect(within(steps).getByText(label).closest("li")).toHaveAttribute("aria-current", "step");
}

const CODEX_BROWSER_SIZE = "Small · 1.5 CPU / 3 GB reserved · up to 2 CPU / 4 GB";
const CODEX_BASE_SIZE = "Small · 0.5 CPU / 1 GB reserved · up to 0.5 CPU / 1 GB";
const CODEX_CAN_USE_WITH_BROWSER = "Terminal, files and administrator access on its own computer. Browser: on.";
const CODEX_CAN_USE_WITHOUT_BROWSER = "Terminal, files and administrator access on its own computer. Browser: off.";

describe("LaunchPage", () => {
  let infrastructureTargets: DeploymentTargetDto[];
  let windowsIsoImages: Array<{ volume: string; name: string; sizeBytes: number; modifiedAtSeconds: number; fileIdentitySha256: string; source: "unknown" | "windows-11" | "windows-server-evaluation" }>;
  let windowsLaunchBody: Record<string, unknown> | null;
  let windowsDownloadBody: Record<string, unknown> | null;

  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
    infrastructureTargets = [];
    windowsIsoImages = [];
    windowsLaunchBody = null;
    windowsDownloadBody = null;
    searchParamsGetMock.mockReturnValue(null);
    searchParamsGetAllMock.mockReturnValue([]);
    fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
    findHivraLaunchReceiptMock.mockResolvedValue(null);
    createAgentMock.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      type: "codex",
      name: "MY_CODEX_AGENT",
      status: "provisioning",
      cpu: 1.5,
      ram: 3,
      maximumCpu: 2,
      maximumRam: 4,
    });
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/infrastructure/targets")) {
        return {
          ok: true,
          json: async () => ({ success: true, data: { targets: infrastructureTargets } }),
        } as Response;
      }
      if (url.includes("/api/hivra/windows/iso-images")) {
        return {
          ok: true,
          json: async () => ({ success: true, data: { images: windowsIsoImages, storages: [{ id: "local", label: "local" }] } }),
        } as Response;
      }
      if (url.includes("/api/hivra/windows/iso-downloads") && init?.method === "POST") {
        windowsDownloadBody = JSON.parse(String(init.body ?? "{}"));
        return {
          ok: true,
          status: 202,
          json: async () => ({ success: true, data: { taskId: "99999999-9999-4999-8999-999999999999", state: "queued", filename: "Win11.iso", storage: "local" } }),
        } as Response;
      }
      if (url.includes("/api/hivra/windows/launch")) {
        windowsLaunchBody = JSON.parse(String(init?.body ?? "{}"));
        return {
          ok: true,
          status: 202,
          json: async () => ({ success: true, data: { agent: {
            id: "88888888-8888-4888-8888-888888888888", type: "linux-desktop",
            computer_profile: "windows", name: "MY_WINDOWS_DESKTOP", status: "provisioning", cpu: 4, ram: 8,
          } } }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  it("launches Linux Sandbox through the canonical agent API with reserved limits equal to maxima", async () => {
    infrastructureTargets = [GVISOR_TARGET];
    createAgentMock.mockResolvedValue({ id: "77777777-7777-4777-8777-777777777777", type: "linux-terminal",
      computer_profile: "linux-terminal", computer_substrate: "gvisor", name: "MY_LINUX_SANDBOX", status: "running", cpu: 1, ram: 1 });
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Linux Sandbox");
    await waitFor(() => expect(whereButton(/My infrastructure/i)).toBeEnabled());
    fireEvent.click(whereButton(/My infrastructure/i));
    expect(screen.getByText(/1 CPU \/ 1 GB enforced limit/i)).toBeInTheDocument();
    customField("Reserved CPU");
    expect(screen.queryByLabelText("Maximum CPU")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(screen.getByText("gVisor application-kernel sandbox on your Linux host")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Launch review")).getByText(
      `Creates one Linux Sandbox on ${GVISOR_TARGET.displayName} with fixed CPU and memory limits. It doesn't create a desktop, public ports or host folders. Nothing is bought.`,
    )).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "linux-terminal", computerProfile: "linux-terminal", cpu: 1, ram: 1, maximumCpu: 1, maximumRam: 1,
      deployment: expect.objectContaining({ mode: "self-managed", targetId: GVISOR_TARGET.id }),
    })));
  });

  it("focuses each new step without stealing focus during name editing", async () => {
    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "What do you want to launch?" })).toHaveFocus();
    chooseTile("Ubuntu Desktop");
    expect(screen.getByRole("heading", { name: "Ubuntu Desktop — here's the plan" })).toHaveFocus();
    expect(screen.getByTestId("launch-journey")).toHaveAttribute("data-stage", "plan");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    const name = screen.getByRole("textbox", { name: "Computer name" });
    name.focus();
    fireEvent.change(name, { target: { value: "FOCUS_CHECK" } });
    expect(name).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "What do you want to launch?" })).toHaveFocus();
    expect(screen.getByRole("heading", { name: "What do you want to launch?" })).toHaveAttribute("tabindex", "-1");
  });

  it("shows agents and computers on one Choose screen and goes straight to the plan", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    render(<LaunchPage />);

    expect(await screen.findByRole("heading", { name: "What do you want to launch?" })).toBeInTheDocument();
    expectCurrentStep("Choose");
    // Picking a tile is the choice; there is no Continue button to press.
    expect(screen.queryByTestId("launch-primary-action")).not.toBeInTheDocument();
    const agents = screen.getByRole("region", { name: "An agent" });
    const computers = screen.getByRole("region", { name: "A computer" });
    expect(agents.compareDocumentPosition(computers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Fit badges come from the plan and target evidence the page loaded.
    await waitFor(() => expect(within(agents).getByRole("button", { name: /^Codex/ })).toHaveTextContent("Fits Free without a browser"));
    expect(within(computers).getByRole("button", { name: /^Ubuntu Desktop/ })).toHaveTextContent("Needs Pro or your own server");
    expect(within(computers).getByRole("button", { name: /^Linux Sandbox/ })).toHaveTextContent("Needs your own server");
    expect(within(computers).getByRole("button", { name: /^Windows/ })).toHaveTextContent("Needs your own server");
    expect(within(computers).getByRole("button", { name: /^Omarchy/ })).toHaveTextContent("Preview");

    // Every catalog agent launches here; none hands off to another page.
    expect(within(agents).queryAllByRole("link")).toHaveLength(0);
    expect(within(agents).getByRole("button", { name: /^Claude Code/ })).toHaveTextContent("Fits Free without a browser");
    expect(within(agents).getByRole("button", { name: /^Hermes/ })).toHaveTextContent("Fits your Free plan");
    expect(within(agents).getByRole("button", { name: /^OpenClaw/ })).toHaveTextContent("Needs Pro or your own server");
    expect(within(agents).getByRole("button", { name: /^Agent Zero/ })).toHaveTextContent("Needs Pro or your own server");
    expect(within(agents).getByRole("button", { name: /^Aeon/ })).toHaveTextContent("Fits your Free plan");
    expect(screen.queryByText(/Sets up on its own page/i)).not.toBeInTheDocument();

    chooseTile("Codex");
    expect(screen.getByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    expectCurrentStep("Plan");
  });

  it("marks a computer as ready on the owner's server when the plan cannot hold it", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    infrastructureTargets = [PROXMOX_TARGET];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Ubuntu Desktop/ })).toHaveTextContent("Ready on your server"));
    // A server without gVisor evidence is still not one Linux Sandbox can use.
    expect(screen.getByRole("button", { name: /^Linux Sandbox/ })).toHaveTextContent("Needs your own server");
  });

  it("puts computers first for a Start with a computer link", async () => {
    searchParamsGetMock.mockImplementation((key: string) => ({ kind: "computer", start: "1" } as Record<string, string>)[key] ?? null);
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    const agents = screen.getByRole("region", { name: "An agent" });
    const computers = screen.getByRole("region", { name: "A computer" });
    expect(computers.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lays out Codex as a plan card and reviews exactly what the launch does", async () => {
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");

    expect(screen.getByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    expectCurrentStep("Plan");
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    const card = screen.getByRole("group", { name: "Launch plan" });
    expect(within(card).getByRole("textbox", { name: "Agent name" })).toHaveValue("Codex 1");
    expect(within(card).getByText("Hivra Cloud")).toBeInTheDocument();
    expect(within(card).getByText("Operator plan")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Change" })).toHaveAttribute("aria-expanded", "false");
    // The size is a preset; the reserved and maximum pickers stay collapsed.
    const sizes = within(card).getByRole("group", { name: "Size" });
    expect(within(sizes).getByRole("button", { name: /^Small/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(sizes).getByRole("button", { name: /^Medium/ })).toHaveAttribute("aria-pressed", "false");
    expect(within(card).getByText(CODEX_BROWSER_SIZE)).toBeInTheDocument();
    expect(screen.queryByLabelText("Reserved CPU")).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Customize" })).toHaveAttribute("aria-expanded", "false");
    expect(within(card).getByRole("checkbox", { name: /Browser for Codex/ })).toBeChecked();
    // Codex signs in inside itself by default; a key or Hivra credits are the
    // other two choices, in the same control every agent uses.
    const modelAccess = within(card).getByRole("group", { name: "Model access" });
    expect(within(modelAccess).getByRole("button", { name: /^Sign in inside Codex after it opens/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(modelAccess).getByRole("button", { name: /^Use my API key/ })).toHaveAttribute("aria-pressed", "false");
    expect(within(modelAccess).getByRole("button", { name: /^Hivra credits/ })).toHaveAttribute("aria-pressed", "false");
    expect(within(card).getByText("No extra charge. Uses your Operator plan allowance.")).toBeInTheDocument();
    expect(within(card).getByText(CODEX_CAN_USE_WITH_BROWSER)).toBeInTheDocument();
    expect(screen.queryByText(/balloon|opportunistic|shared scheduling/i)).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Change" }));
    expect(whereButton(/Hivra Cloud/i)).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("launch-primary-action"));

    expect(screen.getByRole("heading", { name: "Review and launch Codex 1" })).toBeInTheDocument();
    expectCurrentStep("Review");
    const review = screen.getByLabelText("Launch review");
    expect(within(review).getByText("Hivra Cloud")).toBeInTheDocument();
    expect(within(review).getByText("Private virtual machine")).toBeInTheDocument();
    expect(within(review).getByText(CODEX_BROWSER_SIZE)).toBeInTheDocument();
    expect(within(review).getByText("Your agent can use")).toBeInTheDocument();
    expect(within(review).getByText(CODEX_CAN_USE_WITH_BROWSER)).toBeInTheDocument();
    // Where the owner watches it work, from the same decision as the agent
    // page's tabs and the note Hivra gives the agent (ATT-15).
    expect(within(review).getByText("You can see its work in").nextElementSibling).toHaveTextContent(
      "Chat, Codex session, Terminal, Files, Browser (view-only) and Git");
    expect(within(review).getByText("Sign in to ChatGPT inside Codex after it opens.")).toBeInTheDocument();
    expect(within(review).getByText("No extra charge. Uses your Operator plan allowance.")).toBeInTheDocument();
    expect(within(review).getByText("Creates one computer and installs Codex. Nothing is bought.")).toBeInTheDocument();
    expect(within(review).queryByText(/Proxmox|KVM|launch request/i)).not.toBeInTheDocument();
    const technical = screen.getByText("Technical details").closest("details") as HTMLElement;
    expect(technical).not.toHaveAttribute("open");
    expect(within(technical).getByText("Private virtual machine on Hivra Cloud (Proxmox KVM)")).toBeInTheDocument();
    expect(within(technical).getByText(storedDraftJson().launchRequestId)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Launch Codex" }));

    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(1));
    expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex",
      name: "Codex 1",
      cpu: 1.5,
      ram: 3,
      maximumCpu: 2,
      maximumRam: 4,
      browser: true,
      deployment: { mode: "hivra-managed" },
      launchRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }));
    expect(await screen.findByRole("heading", { name: "Codex is being created." })).toBeInTheDocument();
    expect(routerPushMock).toHaveBeenCalledWith(
      "/dashboard/agent/33333333-3333-4333-8333-333333333333?welcome=1&tab=terminal",
    );
    expect(screen.getByRole("link", { name: "Open Codex" })).toHaveAttribute(
      "href",
      "/dashboard/agent/33333333-3333-4333-8333-333333333333?welcome=1&tab=terminal",
    );
    expect(screen.getAllByTestId("launch-primary-action")).toHaveLength(1);
  });

  it("numbers the default name past the owner's existing agents and computers", async () => {
    const respond = (global.fetch as jest.Mock).getMockImplementation()!;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/hivra/agents"
      ? { ok: true, json: async () => ({ success: true, data: { agents: [{ name: "Codex 1" }, { name: "Codex 2" }, { name: "Ubuntu Desktop 1" }] } }) } as Response
      : respond(input, init));
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/hivra/agents", expect.anything()));
    await act(async () => { await Promise.resolve(); });
    chooseTile("Codex");
    expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue("Codex 3");
  });

  it("launches a chosen size preset and keeps presets the plan can't hold unavailable", async () => {
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Ubuntu Desktop");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    const sizes = screen.getByRole("group", { name: "Size" });
    fireEvent.click(within(sizes).getByRole("button", { name: /^Medium/ }));
    expect(within(sizes).getByRole("button", { name: /^Medium/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Medium · 4 CPU / 8 GB reserved · up to 8 CPU / 16 GB")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(within(screen.getByLabelText("Launch review")).getByText("Medium · 4 CPU / 8 GB reserved · up to 8 CPU / 16 GB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch Ubuntu Desktop" }));
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "linux-desktop", cpu: 4, ram: 8, maximumCpu: 8, maximumRam: 16,
    })));
  });

  it("shows which size presets are over a Free plan", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    chooseTile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    const sizes = screen.getByRole("group", { name: "Size" });
    expect(within(sizes).getByRole("button", { name: /^Small/ })).toBeEnabled();
    expect(within(sizes).getByRole("button", { name: /^Medium/ })).toBeDisabled();
    expect(within(sizes).getByRole("button", { name: /^Medium/ })).toHaveTextContent("Over your plan");
    expect(within(sizes).getByRole("button", { name: /^Large/ })).toBeDisabled();
    expect(within(sizes).getByRole("button", { name: /^Medium/ })).not.toHaveAttribute("aria-pressed", "true");
  });

  it("keeps reserved capacity within the free pool while allowing plan-bounded maxima", async () => {
    fetchPlanStrictMock.mockResolvedValue({
      ...PAID_PLAN,
      name: "Command",
      poolCpu: 24,
      poolRam: 128,
      usage: { agentCount: 3, usedCpu: 21, usedRam: 120 },
    });
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Ubuntu Desktop");
    await waitFor(() => expect(customField("Reserved CPU")).toBeVisible());

    expect(within(customField("Reserved CPU")).getByRole("button", { name: "4 CPU" })).toBeDisabled();
    expect(within(customField("Maximum CPU")).getByRole("button", { name: "4 CPU" })).toBeEnabled();
    expect(within(customField("Reserved memory")).getByRole("button", { name: "16 GB" })).toBeDisabled();
    expect(within(customField("Maximum memory")).getByRole("button", { name: "16 GB" })).toBeEnabled();
  });

  it("accepts an owner receipt while the launch POST is unresolved without submitting or navigating twice", async () => {
    const acceptedAgent = {
      id: "77777777-7777-4777-8777-777777777777",
      type: "codex",
      name: "MY_CODEX_AGENT",
      status: "provisioning",
      cpu: 2,
      ram: 4,
    };
    createAgentMock.mockReturnValue(new Promise(() => undefined));
    findHivraLaunchReceiptMock
      .mockResolvedValueOnce({ state: "reconciling", phase: "reconciling" })
      .mockImplementationOnce(() => new Promise(resolve => {
        window.setTimeout(() => resolve({ state: "accepted", phase: "accepted", agent: acceptedAgent }), 100);
      }));
    render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    fireEvent.click(launchButton());

    expect(await screen.findByRole("heading", { name: "Confirming your launch…" })).toBeInTheDocument();
    expect(screen.getByText("Hivra is checking the request for Codex 1. We’ll open it as soon as the launch is confirmed.")).toBeInTheDocument();
    expect(screen.queryByText(/exact receipt|infer success/i)).not.toBeInTheDocument();
    await waitFor(() => expect(findHivraLaunchReceiptMock).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    expect(createAgentMock).toHaveBeenCalledTimes(1);
    const launchRequestId = createAgentMock.mock.calls[0][0].launchRequestId;
    expect(findHivraLaunchReceiptMock.mock.calls).toEqual([[launchRequestId], [launchRequestId]]);
    expect(await screen.findByRole("heading", { name: "Codex is being created." })).toBeInTheDocument();
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledTimes(1));
    expect(routerPushMock).toHaveBeenCalledWith(
      "/dashboard/agent/77777777-7777-4777-8777-777777777777?welcome=1&tab=terminal",
    );
    expect(createAgentMock).toHaveBeenCalledTimes(1);
  });

  it("ends an unconfirmed check window without waiting forever or issuing a second POST", async () => {
    createAgentMock.mockReturnValue(new Promise(() => undefined));
    findHivraLaunchReceiptMock.mockResolvedValue(null);
    render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    const receiptClock = jest.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(30_001);
    fireEvent.click(launchButton());
    receiptClock.mockRestore();

    expect(await screen.findByRole("heading", { name: "Launch could not be confirmed." })).toHaveFocus();
    expectCurrentStep("Review");
    expect(screen.getByText(/still being confirmed/i)).toBeInTheDocument();
    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Resume same launch" })).toBeEnabled();
  });

  it("launches Ubuntu as a computer and exposes prepared Canary operating systems", async () => {
    createAgentMock.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      type: "linux-desktop",
      computer_profile: "ubuntu-desktop",
      name: "MY_UBUNTU_DESKTOP",
      status: "provisioning",
      cpu: 4,
      ram: 8,
    });
    render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    expect(screen.getByRole("button", { name: /Omarchy/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Windows/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Windows/i })).toHaveTextContent("your own ISO on a server you connected");
    expect(screen.getByRole("button", { name: /^Windows/i })).not.toHaveTextContent("Customer capacity");
    chooseTile("Ubuntu Desktop");

    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    const computerName = screen.getByRole("textbox", { name: "Computer name" });
    expect(computerName).toBeVisible();
    expect(computerName).toHaveValue("Ubuntu Desktop 1");
    expect(customField("Reserved CPU")).toBeVisible();
    fireEvent.change(computerName, { target: { value: "DESIGN_STATION" } });
    fireEvent.click(within(customField("Reserved CPU")).getByRole("button", { name: "4 CPU" }));
    fireEvent.click(within(customField("Reserved memory")).getByRole("button", { name: "8 GB" }));
    expect(screen.getByText(/Reserved CPU and memory count against your plan's pool/)).toBeInTheDocument();
    expect(screen.getByText("Custom · 4 CPU / 8 GB reserved · up to 4 CPU / 8 GB")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(screen.getByRole("heading", { name: "Review and launch DESIGN_STATION" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("Launch review")).getByText("You can use")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Launch review")).getByText("Creates one computer with Ubuntu Desktop. Nothing is bought.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch Ubuntu Desktop" }));

    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "linux-desktop",
      computerProfile: "ubuntu-desktop",
      name: "DESIGN_STATION",
      cpu: 4,
      ram: 8,
      browser: false,
      deployment: { mode: "hivra-managed" },
    })));
    expect(await screen.findByRole("link", { name: "Open Ubuntu Desktop" })).toHaveAttribute(
      "href",
      "/dashboard/agent/44444444-4444-4444-8444-444444444444?tab=desktop",
    );
  });

  it("keeps Windows visible while requiring exact customer-owned compatibility evidence", async () => {
    render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Windows");

    expect(screen.getByText("Choose the server and the ISO. Hivra Cloud isn't available for Windows.")).toBeVisible();
    expect(await screen.findByText("Hivra Cloud isn't available for Windows. Choose a server you connected.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review launch" })).toBeDisabled();
    expect(whereButton(/Hivra Cloud/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /^My server/ })).toBeDisabled();
    expect(screen.queryByRole("link", { name: /Review plans|Upgrade to/ })).not.toBeInTheDocument();
    // Capacity opens in a sheet over the launch (slice 10), not on another page.
    expect(screen.getByRole("button", { name: "Add capacity" })).toBeInTheDocument();
    expect(screen.queryByText(/private|test|evaluation|licen[cs]e|legal/i)).not.toBeInTheDocument();
  });

  it("keeps a compatible Proxmox target blocked until a host-side ISO is observed", async () => {
    infrastructureTargets = [PROXMOX_TARGET];
    render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Windows");

    const customerCapacity = await screen.findByRole("button", { name: /^My server/ });
    await waitFor(() => expect(customerCapacity).toBeEnabled());
    fireEvent.click(customerCapacity);
    await waitFor(() => expect(screen.getByText(/Choose an ISO already on this host, or download one directly from Microsoft/)).toBeVisible());
    expect(screen.getByText("Download directly from Microsoft")).toBeVisible();
    expect(screen.getByRole("link", { name: "Windows 11 download", hidden: true })).toHaveAttribute("href", "https://www.microsoft.com/software-download/windows11");
    expect(screen.getByRole("link", { name: "Windows Server Evaluation", hidden: true })).toHaveAttribute("href", "https://www.microsoft.com/evalcenter/download-windows-server-2025");
    expect(screen.getByText(/One host copy can be reused for multiple VMs/)).toBeVisible();
    expect(screen.getByText(/does not provide the media, licence, product key, activation, or a compliance determination/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Review launch" })).toBeDisabled();
  });

  it("does not offer an earlier Linux-desktop-only host for Windows setup", async () => {
    infrastructureTargets = [{
      ...PROXMOX_TARGET,
      capabilities: {
        ...PROXMOX_TARGET.capabilities,
        provisioner: { configured: true, ready: true, version: "2026.09.08.3" },
        runtimeCompatibility: { contractVersion: 1, provisionerVersion: "2026.09.08.3", supportedCatalogRuntimeIds: ["codex", "linux-desktop"] },
      },
    }];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Windows");
    expect(await screen.findByRole("button", { name: /^My server/ })).toBeDisabled();
    expect(screen.getByText(/do not have current Windows compatibility evidence/)).toBeVisible();
  });

  it("starts a direct-to-host Microsoft download only after attestation", async () => {
    infrastructureTargets = [PROXMOX_TARGET];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Windows");
    const customerCapacity = await screen.findByRole("button", { name: /^My server/ });
    await waitFor(() => expect(customerCapacity).toBeEnabled());
    fireEvent.click(customerCapacity);
    fireEvent.click(await screen.findByText("Download directly from Microsoft"));
    const download = screen.getByRole("button", { name: "Download to this host" });
    fireEvent.change(screen.getByRole("textbox", { name: "Final Microsoft ISO link" }), {
      target: { value: "https://software.download.prss.microsoft.com/dbazure/Win11.iso?t=expires" },
    });
    expect(download).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(download).toBeEnabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Microsoft Windows media type" }), { target: { value: "windows-server-evaluation" } });
    expect(download).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByRole("textbox", { name: "Final Microsoft ISO link" }), {
      target: { value: "https://download.microsoft.com/download/SERVER_EVAL_x64FRE_en-us.iso?t=expires" },
    });
    expect(download).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(download);
    await waitFor(() => expect(windowsDownloadBody).not.toBeNull());
    expect(windowsDownloadBody).toMatchObject({
      mode: "self-managed",
      connectionId: PROXMOX_TARGET.connectionId,
      targetId: PROXMOX_TARGET.id,
      expectedConnectionRevision: 7,
      source: "windows-server-evaluation",
      storage: "local",
      directUrl: "https://download.microsoft.com/download/SERVER_EVAL_x64FRE_en-us.iso?t=expires",
      rightsAttested: true,
      termsVersion: "windows-byo-iso-v1",
    });
    expect(screen.getByRole("status")).toHaveTextContent("Downloading on the host");
    await waitFor(() => {
      const saved = window.localStorage.getItem(DRAFT_KEY) ?? "";
      expect(saved).toContain("99999999-9999-4999-8999-999999999999");
      expect(saved).toContain("windows-server-evaluation");
      expect(saved).not.toContain("t=expires");
    });
  });

  it("reviews the exact customer ISO and attestation before launching Windows", async () => {
    infrastructureTargets = [PROXMOX_TARGET];
    windowsIsoImages = [{ volume: "local:iso/SERVER_EVAL_x64FRE_en-us.iso", name: "SERVER_EVAL_x64FRE_en-us.iso", sizeBytes: 6_123_456_789,
      modifiedAtSeconds: 1_757_934_000, fileIdentitySha256: "c".repeat(64), source: "windows-server-evaluation" },
    { volume: "local:iso/Win11.iso", name: "Win11.iso", sizeBytes: 6_000_000_000,
      modifiedAtSeconds: 1_757_934_001, fileIdentitySha256: "d".repeat(64), source: "unknown" }];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Windows");
    const customerCapacity = await screen.findByRole("button", { name: /^My server/ });
    await waitFor(() => expect(customerCapacity).toBeEnabled());
    fireEvent.click(customerCapacity);
    const iso = await screen.findByRole("combobox", { name: "Your Windows ISO" });
    fireEvent.change(iso, { target: { value: windowsIsoImages[0].volume } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(iso, { target: { value: windowsIsoImages[1].volume } });
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    fireEvent.change(iso, { target: { value: windowsIsoImages[0].volume } });
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Review launch" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Review launch" }));
    const review = screen.getByLabelText("Launch review");
    expect(within(review).getByText(windowsIsoImages[0].volume)).toBeVisible();
    expect(within(review).getByText(/Windows Server Evaluation — evaluation only/)).toBeVisible();
    expect(within(review).getByText(/Attestation will be stamped/)).toBeVisible();
    expect(within(review).getByText(
      `Creates one Windows setup computer on ${PROXMOX_TARGET.displayName}, attaches the ISO you chose and starts the installer. Nothing is bought or uploaded, and Hivra Cloud isn't used.`,
    )).toBeVisible();
    expect(screen.getByRole("button", { name: "Start Windows setup" })).toBeEnabled();
    fireEvent.click(launchButton());
    await waitFor(() => expect(windowsLaunchBody).not.toBeNull());
    expect(windowsLaunchBody).toMatchObject({
      mode: "self-managed", connectionId: PROXMOX_TARGET.connectionId, targetId: PROXMOX_TARGET.id,
      expectedConnectionRevision: 7, isoVolume: windowsIsoImages[0].volume, rightsAttested: true,
      mediaSource: "windows-server-evaluation",
      mediaEvidence: { sizeBytes: windowsIsoImages[0].sizeBytes, modifiedAtSeconds: windowsIsoImages[0].modifiedAtSeconds,
        fileIdentitySha256: windowsIsoImages[0].fileIdentitySha256 },
      termsVersion: "windows-byo-iso-v1", diskGb: 64,
    });
    expect(await screen.findByRole("heading", { name: "Windows setup has started." })).toBeVisible();
    expect(screen.getByText(/Finish installation from the Proxmox console/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Continue Windows setup" })).toHaveAttribute(
      "href",
      "/dashboard/agent/88888888-8888-4888-8888-888888888888?tab=desktop",
    );
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith(expect.stringMatching(/^\/dashboard\/agent\/[^?]+\?tab=desktop$/)));
    expect(routerPushMock).not.toHaveBeenCalledWith(expect.stringContaining("open=fast"));
  });

  it("keeps a prepared Proxmox target revision-bound through review", async () => {
    infrastructureTargets = [PROXMOX_TARGET];
    render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    const ownInfrastructure = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(ownInfrastructure).toBeEnabled());
    fireEvent.click(ownInfrastructure);
    fireEvent.click(screen.getByTestId("launch-primary-action"));

    expect(screen.getByRole("heading", { name: /^Review and launch/ })).toBeInTheDocument();
    expect(screen.getByText("Studio Proxmox / pve-01")).toBeInTheDocument();
    fireEvent.click(launchButton());

    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      deployment: {
        mode: "self-managed",
        connectionId: PROXMOX_TARGET.connectionId,
        targetId: PROXMOX_TARGET.id,
        expectedConnectionRevision: PROXMOX_TARGET.evidenceConnectionRevision,
      },
    })));
  });

  it("launches the whole prepared provider computer without a fictitious RAM slice", async () => {
    infrastructureTargets = [PROVIDER_TARGET];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    const own = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(own).toBeEnabled());
    fireEvent.click(own);
    expect(screen.getByText("The whole server")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Reserved CPU" })).not.toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toBeEnabled();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(within(screen.getByLabelText("Launch review")).getByText(
      "The whole server · its CPU and memory stay as they are",
    )).toBeInTheDocument();
    fireEvent.click(launchButton());
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      deployment: expect.objectContaining({ mode: "self-managed", targetId: PROVIDER_TARGET.id }),
    })));
  });

  it.each([5,7])("requires whole-provider Ubuntu host headroom with %s GiB available",async available=>{
    const target={...PROVIDER_TARGET,capacity:{...PROVIDER_TARGET.capacity,
      memoryBytes:{total:8*1024**3,available:available*1024**3}}};
    infrastructureTargets=[target];
    render(<LaunchPage />);
    await screen.findByRole("heading",{name:"What do you want to launch?"});
    chooseTile("Ubuntu Desktop");
    const own=await findWhereButton(/My infrastructure/i);
    await waitFor(()=>expect(own).toBeEnabled());fireEvent.click(own);
    if(available===5)expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
    else {
      expect(screen.getByTestId("launch-primary-action")).toBeEnabled();
      fireEvent.click(screen.getByTestId("launch-primary-action"));
      expect(screen.getByRole("heading",{name:/^Review and launch/})).toBeInTheDocument();
    }
    expect(createAgentMock).not.toHaveBeenCalled();
  });
  it("still blocks an exclusive provider computer without runtime memory headroom for the browser", async () => {
    infrastructureTargets = [{ ...PROVIDER_TARGET, capacity: { ...PROVIDER_TARGET.capacity,
      memoryBytes: { total: 4 * 1024 ** 3, available: 2 * 1024 ** 3 } } }];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    const own = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(own).toBeEnabled());
    fireEvent.click(own);
    // 2 GB of headroom holds Codex only without its browser, so that is the default.
    const browser = screen.getByRole("checkbox", { name: /Browser for Codex/ });
    expect(browser).not.toBeChecked();
    expect(screen.getByTestId("launch-primary-action")).toBeEnabled();

    fireEvent.click(browser);
    expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Turn off the browser" })).toBeInTheDocument();
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it("keeps a disappeared restored target self-managed and blocks instead of falling back", async () => {
    infrastructureTargets = [PROXMOX_TARGET];
    const first = render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    const ownInfrastructure = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(ownInfrastructure).toBeEnabled());
    fireEvent.click(ownInfrastructure);
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(screen.getByRole("heading", { name: /^Review and launch/ })).toBeInTheDocument();
    first.unmount();

    infrastructureTargets = [];
    render(<LaunchPage />);

    expect(await screen.findByRole("heading", { name: /^Review and launch/ })).toBeInTheDocument();
    expect(await screen.findByText("Unavailable server")).toBeInTheDocument();
    expect(screen.getByText("No compatible capacity is ready for this profile.")).toBeInTheDocument();
    expect(launchButton()).toBeDisabled();
  });

  it("ends plan preflight with a Check again action that re-runs the managed plan check", async () => {
    fetchPlanStrictMock.mockRejectedValueOnce(new Error("Plan service unavailable"));
    render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");

    expect(await screen.findByRole("alert")).toHaveTextContent("Managed capacity could not be verified.");
    expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
    expect(screen.queryByRole("link", { name: /Review plans|Upgrade to/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    expect(screen.queryByText("Managed capacity could not be verified.")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).toBeChecked();
    expect(screen.getByText(CODEX_BROWSER_SIZE)).toBeInTheDocument();
  });

  it("launches Codex without a browser at the base floor on a Free plan", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    chooseTile("Codex");

    const browser = screen.getByRole("checkbox", { name: /Browser for Codex/ });
    expect(browser).not.toBeChecked();
    expect(browser).toHaveAccessibleName(expect.stringContaining("1.5 CPU / 3 GB with the browser, or 0.5 CPU / 1 GB without it"));
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    expect(screen.getByText(CODEX_BASE_SIZE)).toBeInTheDocument();
    expect(within(customField("Reserved CPU")).getByRole("button", { name: "0.5 CPU" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));

    const review = screen.getByLabelText("Launch review");
    expect(within(review).getByText(CODEX_CAN_USE_WITHOUT_BROWSER)).toBeInTheDocument();
    expect(within(review).getByText(CODEX_BASE_SIZE)).toBeInTheDocument();
    fireEvent.click(launchButton());

    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(1));
    expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex", cpu: 0.5, ram: 1, maximumCpu: 0.5, maximumRam: 1, browser: false,
      deployment: { mode: "hivra-managed" },
    }));
  });

  // Live on Canary: a Command plan with 23 of 24 CPU in use said "has 1 CPU /
  // 16 GB left", mixing the free CPU with the per-computer memory limit.
  it("names only the plan's shared allowance that runs short, with what is in use", async () => {
    fetchPlanStrictMock.mockResolvedValue({
      ...PAID_PLAN, name: "Command", maxAgents: 999, maxCpuPerAgent: 8, maxRamPerAgent: 16, poolCpu: 24, poolRam: 128,
      usage: { agentCount: 10, usedCpu: 23, usedRam: 46 },
    });
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    chooseTile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());

    fireEvent.click(screen.getByRole("checkbox", { name: /Browser for Codex/ }));
    const blocker = screen.getByRole("alert");
    expect(blocker).toHaveTextContent("Codex with a browser needs 1.5 CPU / 3 GB. Your Command plan has 1 of its 24 CPU free.");
    expect(blocker).not.toHaveTextContent(/16 GB left/);
  });

  it("states the browser shortfall with real choices and lets the owner turn the browser off", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    chooseTile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());

    fireEvent.click(screen.getByRole("checkbox", { name: /Browser for Codex/ }));
    const blocker = screen.getByRole("alert");
    expect(blocker).toHaveTextContent("Codex with a browser needs 1.5 CPU / 3 GB. Your Free plan includes 0.5 CPU / 1 GB.");
    expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
    // The upgrade names the plan that holds this size and returns to this draft.
    expect(within(blocker).getByRole("link", { name: "Upgrade to Pro" })).toHaveAttribute(
      "href",
      `/dashboard/billing?from=launch&returnTo=${encodeURIComponent(`/dashboard/launch?draft=${storedDraftJson().launchRequestId}`)}`,
    );
    expect(within(blocker).getByRole("button", { name: "Set up your own capacity" })).toBeInTheDocument();
    expect(screen.queryByText(/does not have enough remaining capacity/)).not.toBeInTheDocument();

    fireEvent.click(within(blocker).getByRole("button", { name: "Turn off the browser" }));
    expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).not.toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(CODEX_BASE_SIZE)).toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toBeEnabled();
  });

  it("keeps a paid plan's size when the browser is turned off and only lowers the floor", async () => {
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    chooseTile("Codex");
    const browser = screen.getByRole("checkbox", { name: /Browser for Codex/ });
    await waitFor(() => expect(browser).toBeChecked());
    expect(within(customField("Reserved CPU")).queryByRole("button", { name: "0.5 CPU" })).not.toBeInTheDocument();

    fireEvent.click(browser);
    expect(browser).not.toBeChecked();
    // Off keeps the paid size; it is no longer a browser-off preset.
    const keptSize = "Recommended · 1.5 CPU / 3 GB reserved · up to 2 CPU / 4 GB";
    expect(screen.getByText(keptSize)).toBeInTheDocument();
    expect(within(customField("Reserved CPU")).getByRole("button", { name: "0.5 CPU" })).toBeEnabled();
    fireEvent.click(browser);
    expect(screen.getByText(CODEX_BROWSER_SIZE)).toBeInTheDocument();
    fireEvent.click(browser);
    expect(screen.getByText(keptSize)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(within(screen.getByLabelText("Launch review")).getByText(CODEX_CAN_USE_WITHOUT_BROWSER)).toBeInTheDocument();
    fireEvent.click(launchButton());
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex", cpu: 1.5, ram: 3, maximumCpu: 2, maximumRam: 4, browser: false,
    })));
  });

  it("keeps an explicit size across browser changes and raises only what the browser needs", async () => {
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    chooseTile("Codex");
    const browser = screen.getByRole("checkbox", { name: /Browser for Codex/ });
    await waitFor(() => expect(browser).toBeChecked());
    fireEvent.click(within(customField("Reserved memory")).getByRole("button", { name: "8 GB" }));
    fireEvent.click(browser);
    expect(screen.getByText("Custom · 1.5 CPU / 8 GB reserved · up to 2 CPU / 8 GB")).toBeInTheDocument();

    fireEvent.click(within(customField("Reserved CPU")).getByRole("button", { name: "0.5 CPU" }));
    expect(screen.getByText("Custom · 0.5 CPU / 8 GB reserved · up to 2 CPU / 8 GB")).toBeInTheDocument();
    fireEvent.click(browser);
    // The browser needs 1.5 CPU; the 8 GB already chosen stays.
    expect(screen.getByText("Custom · 1.5 CPU / 8 GB reserved · up to 2 CPU / 8 GB")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    fireEvent.click(launchButton());
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex", cpu: 1.5, ram: 8, maximumCpu: 2, maximumRam: 8, browser: true,
    })));
  });

  it("starts Codex with the browser on for a host that holds it, even on a Free plan, and follows the destination", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    infrastructureTargets = [PROXMOX_TARGET];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    chooseTile("Codex");
    const browser = screen.getByRole("checkbox", { name: /Browser for Codex/ });
    const own = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(own).toBeEnabled());
    expect(browser).not.toBeChecked();

    fireEvent.click(own);
    expect(browser).toBeChecked();
    expect(screen.getByText(CODEX_BROWSER_SIZE)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Hivra Cloud Free cannot hold the browser, so the default follows it back.
    fireEvent.click(whereButton(/Hivra Cloud/i));
    expect(browser).not.toBeChecked();
    expect(screen.getByText(CODEX_BASE_SIZE)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(own);
    expect(browser).toBeChecked();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    const review = screen.getByLabelText("Launch review");
    expect(within(review).getByText(CODEX_CAN_USE_WITH_BROWSER)).toBeInTheDocument();
    expect(within(review).getByText(PROXMOX_TARGET.displayName)).toBeInTheDocument();
    fireEvent.click(launchButton());
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex", cpu: 1.5, ram: 3, maximumCpu: 2, maximumRam: 4, browser: true,
      deployment: expect.objectContaining({ mode: "self-managed", targetId: PROXMOX_TARGET.id }),
    })));
  });

  it("starts self-hosted Codex with the browser on when the host holds it", async () => {
    const previousMode = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "local";
    fetchPlanStrictMock.mockResolvedValue(null);
    infrastructureTargets = [PROXMOX_TARGET];
    try {
      render(<LaunchPage />);
      await screen.findByRole("heading", { name: "What do you want to launch?" });
      chooseTile("Codex");
      await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
      expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).toBeChecked();
      fireEvent.click(screen.getByTestId("launch-primary-action"));
      fireEvent.click(launchButton());
      await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
        type: "codex", cpu: 1.5, ram: 3, browser: true,
        deployment: expect.objectContaining({ mode: "self-managed", targetId: PROXMOX_TARGET.id }),
      })));
    } finally {
      if (previousMode === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
      else process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = previousMode;
    }
  });

  it("never overrides an explicit browser choice when the destination changes", async () => {
    infrastructureTargets = [PROXMOX_TARGET];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    const browser = screen.getByRole("checkbox", { name: /Browser for Codex/ });
    await waitFor(() => expect(browser).toBeChecked());
    fireEvent.click(browser);
    const own = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(own).toBeEnabled());

    fireEvent.click(own);
    expect(browser).not.toBeChecked();
    fireEvent.click(whereButton(/Hivra Cloud/i));
    expect(browser).not.toBeChecked();
  });

  it("uses Turn off the browser on a self-managed host that holds Codex only without it", async () => {
    infrastructureTargets = [SMALL_PROXMOX_TARGET];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    const browser = screen.getByRole("checkbox", { name: /Browser for Codex/ });
    await waitFor(() => expect(browser).toBeChecked());
    const own = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(own).toBeEnabled());

    fireEvent.click(own);
    // 1 CPU / 2 GB cannot hold the browser floor, so the recommended default is off.
    expect(browser).not.toBeChecked();
    expect(screen.getByText(CODEX_BASE_SIZE)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(browser);
    expect(browser).toBeChecked();
    const blocker = screen.getByRole("alert");
    expect(blocker).toHaveTextContent("The selected host does not have enough measured capacity for this size.");
    expect(within(blocker).getByRole("button", { name: "Set up capacity" })).toBeInTheDocument();
    expect(within(blocker).queryByRole("link", { name: /Review plans|Upgrade to/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toBeDisabled();

    fireEvent.click(within(blocker).getByRole("button", { name: "Turn off the browser" }));
    expect(browser).not.toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(CODEX_BASE_SIZE)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    const review = screen.getByLabelText("Launch review");
    expect(within(review).getByText(CODEX_CAN_USE_WITHOUT_BROWSER)).toBeInTheDocument();
    expect(within(review).getByText(SMALL_PROXMOX_TARGET.displayName)).toBeInTheDocument();
    fireEvent.click(launchButton());
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex", cpu: 0.5, ram: 1, maximumCpu: 0.5, maximumRam: 1, browser: false,
      deployment: expect.objectContaining({ mode: "self-managed", targetId: SMALL_PROXMOX_TARGET.id }),
    })));
  });

  const storedDraft = () => storedDraftJson();
  const SMALL_HOST_CUSTOM_RESOURCES = { cpu: 1, ram: 2, maximumCpu: 1, maximumRam: 2, source: "custom" };
  const SMALL_HOST_CUSTOM_TEXT = "Custom · 1 CPU / 2 GB reserved · up to 1 CPU / 2 GB";

  // Codex on the 1 CPU / 2 GB host, browser at its default (off), and the
  // owner's own 1 CPU / 2 GB size: below the browser floor, above the base.
  async function chooseSmallHostCustomCodex() {
    infrastructureTargets = [SMALL_PROXMOX_TARGET];
    const view = render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    chooseTile("Codex");
    const own = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(own).toBeEnabled());
    fireEvent.click(own);
    expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).not.toBeChecked();
    fireEvent.click(within(customField("Reserved CPU")).getByRole("button", { name: "1 CPU" }));
    fireEvent.click(within(customField("Reserved memory")).getByRole("button", { name: "2 GB" }));
    expect(screen.getByText(SMALL_HOST_CUSTOM_TEXT)).toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toBeEnabled();
    expect(storedDraft()).toMatchObject({
      browser: false,
      browserSource: "recommended",
      resources: SMALL_HOST_CUSTOM_RESOURCES,
      capacity: { mode: "self-managed", targetId: SMALL_PROXMOX_TARGET.id },
    });
    return view;
  }

  // Holds the host lookup until the returned release is called.
  function holdTargetLookup(): () => void {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const respond = global.fetch as jest.Mock;
    const impl = respond.getMockImplementation()!;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/infrastructure/targets")) await gate;
      return impl(input, init);
    });
    return release;
  }

  function expectSmallHostCustomKept() {
    expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).not.toBeChecked();
    expect(screen.getByText(SMALL_HOST_CUSTOM_TEXT)).toBeInTheDocument();
    expect(storedDraft()).toMatchObject({ browser: false, resources: SMALL_HOST_CUSTOM_RESOURCES });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toBeEnabled();
  }

  it("keeps a resumed self-managed Codex draft's own size when the plan resolves before its host", async () => {
    (await chooseSmallHostCustomCodex()).unmount();

    const releaseTargets = holdTargetLookup();
    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    // The paid plan is known but the saved host is not restored yet.
    expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).not.toBeChecked();
    expect(storedDraft()).toMatchObject({ browser: false, resources: SMALL_HOST_CUSTOM_RESOURCES });

    await act(async () => { releaseTargets(); });
    await waitFor(() => expect(whereButton(/My infrastructure/i)).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    expectSmallHostCustomKept();
    expect(storedDraft().capacity).toEqual({ mode: "self-managed", targetId: SMALL_PROXMOX_TARGET.id });
  });

  it("keeps a resumed self-managed Codex draft's own size when its host loads before the plan", async () => {
    (await chooseSmallHostCustomCodex()).unmount();

    let resolvePlan: (plan: typeof PAID_PLAN) => void = () => undefined;
    fetchPlanStrictMock.mockReturnValue(new Promise(resolve => { resolvePlan = resolve; }));
    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    await waitFor(() => expect(whereButton(/My infrastructure/i)).toHaveAttribute("aria-pressed", "true"));

    await act(async () => { resolvePlan(PAID_PLAN); });
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    expectSmallHostCustomKept();
  });

  it("never shows a Hivra Cloud browser default on a resumed self-managed draft before its host is restored", async () => {
    infrastructureTargets = [SMALL_PROXMOX_TARGET];
    const first = render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    const own = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(own).toBeEnabled());
    fireEvent.click(own);
    expect(screen.getByText(CODEX_BASE_SIZE)).toBeInTheDocument();
    first.unmount();

    const releaseTargets = holdTargetLookup();
    const writes = jest.spyOn(Storage.prototype, "setItem");
    try {
      render(<LaunchPage />);
      expect(await screen.findByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
      await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalledTimes(2));
      await act(async () => { await Promise.resolve(); });
      await act(async () => { releaseTargets(); });
      await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
      const drafts = writes.mock.calls
        .filter(([key]) => key === DRAFT_KEY)
        .map(([, value]) => JSON.parse(value));
      // The paid plan's browser-on size was never applied, even for a moment.
      expect(drafts.filter(draft => draft.browser || draft.resources.cpu !== 0.5)).toEqual([]);
    } finally {
      writes.mockRestore();
    }
    expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).not.toBeChecked();
    expect(screen.getByText(CODEX_BASE_SIZE)).toBeInTheDocument();
  });

  it("never raises the owner's own size when a destination change flips the browser default", async () => {
    await chooseSmallHostCustomCodex();

    // A paid Hivra Cloud plan would default the browser on, but the owner's
    // 1 CPU / 2 GB is below its floor, so the default stays off instead.
    fireEvent.click(whereButton(/Hivra Cloud/i));
    expectSmallHostCustomKept();

    fireEvent.click(whereButton(/My infrastructure/i));
    expectSmallHostCustomKept();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    const review = screen.getByLabelText("Launch review");
    expect(within(review).getByText(CODEX_CAN_USE_WITHOUT_BROWSER)).toBeInTheDocument();
    expect(within(review).getByText(SMALL_PROXMOX_TARGET.displayName)).toBeInTheDocument();
    fireEvent.click(launchButton());
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex", cpu: 1, ram: 2, maximumCpu: 1, maximumRam: 2, browser: false,
      deployment: expect.objectContaining({ mode: "self-managed", targetId: SMALL_PROXMOX_TARGET.id }),
    })));
  });

  const BROWSER_RAISED_TEXT = "Custom · 1.5 CPU / 3 GB reserved · up to 1.5 CPU / 3 GB";

  it("gives back the owner's own size when the browser they turned on is turned off again, even after a reload", async () => {
    const first = await chooseSmallHostCustomCodex();
    const browser = screen.getByRole("checkbox", { name: /Browser for Codex/ });
    fireEvent.click(browser);
    expect(browser).toBeChecked();
    // The browser raised 1 CPU / 2 GB to its floor, which this host cannot hold.
    expect(screen.getByText(BROWSER_RAISED_TEXT)).toBeInTheDocument();
    const blocker = screen.getByRole("alert");
    expect(blocker).toHaveTextContent("The selected host does not have enough measured capacity for this size.");
    expect(within(blocker).getByRole("button", { name: "Turn off the browser" })).toBeInTheDocument();
    first.unmount();

    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Turn off the browser" }));
    expectSmallHostCustomKept();
    expect(storedDraft()).toMatchObject({ browserSource: "custom", browserRaisedFrom: null });

    // Unticking the checkbox itself gives the size back the same way.
    fireEvent.click(screen.getByRole("checkbox", { name: /Browser for Codex/ }));
    expect(screen.getByText(BROWSER_RAISED_TEXT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Browser for Codex/ }));
    expectSmallHostCustomKept();
  });

  it("keeps a size the owner changed after the browser raised it when the browser is turned off", async () => {
    await chooseSmallHostCustomCodex();
    const browser = screen.getByRole("checkbox", { name: /Browser for Codex/ });
    fireEvent.click(browser);
    expect(screen.getByText(BROWSER_RAISED_TEXT)).toBeInTheDocument();
    fireEvent.click(within(customField("Maximum memory")).getByRole("button", { name: "4 GB" }));
    const edited = "Custom · 1.5 CPU / 3 GB reserved · up to 1.5 CPU / 4 GB";
    expect(screen.getByText(edited)).toBeInTheDocument();

    fireEvent.click(browser);
    expect(browser).not.toBeChecked();
    // Turning the browser off never shrinks a size the owner chose.
    expect(screen.getByText(edited)).toBeInTheDocument();
    expect(storedDraft()).toMatchObject({ browser: false, browserRaisedFrom: null });
  });

  it("says how to get out when the owner's own size does not fit a smaller host", async () => {
    infrastructureTargets = [PROXMOX_TARGET, SMALL_PROXMOX_TARGET];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    const own = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(own).toBeEnabled());
    fireEvent.click(own);
    // Editing only the maximum makes the recommended size the owner's own.
    fireEvent.click(within(customField("Maximum CPU")).getByRole("button", { name: "4 CPU" }));
    fireEvent.change(readyHost(), { target: { value: SMALL_PROXMOX_TARGET.id } });
    expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).not.toBeChecked();
    expect(screen.getByText("Custom · 1.5 CPU / 3 GB reserved · up to 4 CPU / 4 GB")).toBeInTheDocument();
    const blocker = screen.getByRole("alert");
    expect(blocker).toHaveTextContent(
      "The selected host does not have enough measured capacity for this size. Choose a smaller size, or choose another host.",
    );
    expect(screen.getByTestId("launch-primary-action")).toBeDisabled();

    fireEvent.click(within(customField("Reserved CPU")).getByRole("button", { name: "1 CPU" }));
    fireEvent.click(within(customField("Reserved memory")).getByRole("button", { name: "2 GB" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toBeEnabled();
  });

  const RAISED_RESOURCES = { cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4, source: "custom" };
  const RAISED_TEXT = "Custom · 2 CPU / 4 GB reserved · up to 2 CPU / 4 GB";

  // With the browser held off by the owner's 1 CPU / 2 GB on a destination
  // whose default is on, raise the size past the 1.5 CPU / 3 GB browser floor.
  // The default turns on as soon as the size holds it, in view, and the size
  // stays exactly what the owner picked.
  function raiseHeldOffSize() {
    const browser = screen.getByRole("checkbox", { name: /Browser for Codex/ });
    expect(browser).not.toBeChecked();
    fireEvent.click(within(customField("Reserved CPU")).getByRole("button", { name: "2 CPU" }));
    // 2 CPU / 2 GB is still below the browser's memory floor.
    expect(browser).not.toBeChecked();
    expect(storedDraft()).toMatchObject({ browser: false, resources: { cpu: 2, ram: 2, source: "custom" } });
    fireEvent.click(within(customField("Reserved memory")).getByRole("button", { name: "4 GB" }));
    expectRaisedWithBrowser();
  }

  function expectRaisedWithBrowser() {
    expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).toBeChecked();
    expect(screen.getByText(RAISED_TEXT)).toBeInTheDocument();
    expect(storedDraft()).toMatchObject({ browser: true, browserSource: "recommended", resources: RAISED_RESOURCES });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toBeEnabled();
  }

  it("turns a held-off browser default on in view when the owner raises the size, and a reload keeps it", async () => {
    const first = await chooseSmallHostCustomCodex();
    fireEvent.click(whereButton(/Hivra Cloud/i));
    expectSmallHostCustomKept();
    raiseHeldOffSize();
    const shown = storedDraft();
    first.unmount();

    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    await act(async () => { await Promise.resolve(); });
    // The reload re-evaluates the default and finds nothing to change.
    expect(storedDraft()).toEqual(shown);
    expectRaisedWithBrowser();

    // The owner's own choice still wins over the default.
    fireEvent.click(screen.getByRole("checkbox", { name: /Browser for Codex/ }));
    expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).not.toBeChecked();
    expect(storedDraft()).toMatchObject({ browser: false, browserSource: "custom", resources: RAISED_RESOURCES });
  });

  it("turns a held-off browser default on in view when a raised size fits the host, and Refresh ready hosts keeps it", async () => {
    infrastructureTargets = [SMALL_PROXMOX_TARGET, PROXMOX_TARGET];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    chooseTile("Codex");
    const own = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(own).toBeEnabled());
    fireEvent.click(own);
    const host = readyHost();
    fireEvent.change(host, { target: { value: SMALL_PROXMOX_TARGET.id } });
    fireEvent.click(within(customField("Reserved CPU")).getByRole("button", { name: "1 CPU" }));
    fireEvent.click(within(customField("Reserved memory")).getByRole("button", { name: "2 GB" }));
    // The big host defaults the browser on, but 1 CPU / 2 GB holds it off.
    fireEvent.change(host, { target: { value: PROXMOX_TARGET.id } });
    expectSmallHostCustomKept();
    raiseHeldOffSize();
    const shown = storedDraft();
    expect(shown.capacity).toEqual({ mode: "self-managed", targetId: PROXMOX_TARGET.id });

    fireEvent.click(screen.getByRole("button", { name: "Refresh ready hosts" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh ready hosts" })).toBeEnabled());
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    await act(async () => { await Promise.resolve(); });
    // A new host identity re-runs the default; it had nothing left to change.
    expect(storedDraft()).toEqual(shown);
    expectRaisedWithBrowser();

    fireEvent.click(screen.getByTestId("launch-primary-action"));
    const review = screen.getByLabelText("Launch review");
    expect(within(review).getByText(CODEX_CAN_USE_WITH_BROWSER)).toBeInTheDocument();
    fireEvent.click(launchButton());
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex", cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4, browser: true,
      deployment: expect.objectContaining({ mode: "self-managed", targetId: PROXMOX_TARGET.id }),
    })));
  });

  it("launches and retries a rejected launch with the browser the owner saw after raising a held-off size", async () => {
    createAgentMock.mockRejectedValueOnce(new HivraLaunchRejectedError(
      "The selected infrastructure changed before launch.",
      409,
      "agent_insert_conflict",
    ));
    await chooseSmallHostCustomCodex();
    fireEvent.click(whereButton(/Hivra Cloud/i));
    expectSmallHostCustomKept();
    raiseHeldOffSize();

    fireEvent.click(screen.getByTestId("launch-primary-action"));
    const firstReview = screen.getByLabelText("Launch review");
    expect(within(firstReview).getByText(CODEX_CAN_USE_WITH_BROWSER)).toBeInTheDocument();
    fireEvent.click(launchButton());
    expect(await screen.findByRole("heading", {
      name: "Nothing new will be started from this receipt.",
    })).toBeInTheDocument();
    const sent = { type: "codex", cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4, browser: true };
    expect(createAgentMock).toHaveBeenCalledTimes(1);
    expect(createAgentMock.mock.calls[0][0]).toMatchObject({ ...sent, deployment: { mode: "hivra-managed" } });
    const failedRequestId = storedDraft().launchRequestId;

    // Review mints a new launch request, which re-runs the default. It must
    // show and send what the owner already saw, not a newly flipped choice.
    fireEvent.click(screen.getByRole("button", { name: "Review launch" }));
    expect(screen.getByRole("heading", { name: /^Review and launch/ })).toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
    const retryReview = screen.getByLabelText("Launch review");
    expect(within(retryReview).getByText(CODEX_CAN_USE_WITH_BROWSER)).toBeInTheDocument();
    expect(within(retryReview).getByText("Custom · 2 CPU / 4 GB reserved · up to 2 CPU / 4 GB")).toBeInTheDocument();
    expect(storedDraft()).toMatchObject({ browser: true, browserSource: "recommended", resources: RAISED_RESOURCES });
    expect(storedDraft().launchRequestId).not.toBe(failedRequestId);
    fireEvent.click(launchButton());
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(2));
    expect(createAgentMock.mock.calls[1][0]).toMatchObject({ ...sent, deployment: { mode: "hivra-managed" } });
    expect(createAgentMock.mock.calls[1][0].launchRequestId).not.toBe(failedRequestId);
  });

  it("shows Check again when the plan becomes unverified on Review, and recovers", async () => {
    const first = render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(screen.getByRole("heading", { name: /^Review and launch/ })).toBeInTheDocument();
    first.unmount();

    fetchPlanStrictMock.mockRejectedValueOnce(new Error("Plan service unavailable"));
    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: /^Review and launch/ })).toBeInTheDocument();
    const message = await screen.findByText("Managed capacity could not be verified.");
    const blocker = message.closest("[role='alert']") as HTMLElement;
    expect(blocker).not.toBeNull();
    expect(launchButton()).toBeDisabled();
    expect(within(blocker).queryByRole("link", { name: /Review plans|Upgrade to/ })).not.toBeInTheDocument();

    fireEvent.click(within(blocker).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(launchButton()).toBeEnabled());
    expect(screen.queryByText("Managed capacity could not be verified.")).not.toBeInTheDocument();
    const review = screen.getByLabelText("Launch review");
    expect(within(review).getByText(CODEX_CAN_USE_WITH_BROWSER)).toBeInTheDocument();
    fireEvent.click(launchButton());
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex", cpu: 1.5, ram: 3, maximumCpu: 2, maximumRam: 4, browser: true,
      deployment: { mode: "hivra-managed" },
    })));
  });

  it("applies the plan-derived browser default when the plan resolves after Codex is chosen", async () => {
    let resolvePlan: (plan: typeof PAID_PLAN) => void = () => undefined;
    fetchPlanStrictMock.mockReturnValue(new Promise(resolve => { resolvePlan = resolve; }));
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).not.toBeChecked();
    expect(await screen.findByText("Checking your managed plan…")).toBeInTheDocument();

    resolvePlan(PAID_PLAN);
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).toBeChecked());
    expect(screen.getByText(CODEX_BROWSER_SIZE)).toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toBeEnabled();
  });

  it("opens Linux Sandbox on the owner's infrastructure and offers host setup instead of plans", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Linux Sandbox");

    const cloud = whereButton(/Hivra Cloud/i);
    expect(cloud).toBeDisabled();
    expect(cloud).toHaveAttribute("aria-pressed", "false");
    expect(cloud).toHaveTextContent("Not available for Linux Sandbox.");
    expect(whereButton(/My infrastructure/i)).toHaveAttribute("aria-pressed", "true");
    const blocker = await screen.findByRole("alert");
    expect(blocker).toHaveTextContent("Linux Sandbox requires a compatible gVisor host you connected.");
    expect(within(blocker).getByRole("button", { name: "Set up capacity" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Review plans|Upgrade to/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
  });

  it("selects a ready gVisor host for Linux Sandbox without a destination click", async () => {
    infrastructureTargets = [GVISOR_TARGET];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Linux Sandbox");

    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    expect(whereButton(/My infrastructure/i)).toHaveAttribute("aria-pressed", "true");
    expect(whereButton(/Hivra Cloud/i)).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(within(screen.getByLabelText("Launch review")).getByText(GVISOR_TARGET.displayName)).toBeInTheDocument();
  });

  it("describes computers honestly without implying an agent can be attached later", async () => {
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    expect(within(screen.getByRole("region", { name: "An agent" })).getByText("An AI that works on its own computer.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "A computer" })).getByText("A machine you use yourself. It runs on its own, without an agent.")).toBeInTheDocument();
    expect(screen.queryByText(/attach/i)).not.toBeInTheDocument();
    chooseTile("Ubuntu Desktop");
    expect(screen.queryByText(/attach/i)).not.toBeInTheDocument();
  });

  it("blocks missing capacity and safely resumes an uncertain submission with the same receipt", async () => {
    const previousMode = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "local";
    createAgentMock
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValueOnce({
        id: "55555555-5555-4555-8555-555555555555",
        type: "codex",
        name: "MY_CODEX_AGENT",
        status: "provisioning",
        cpu: 2,
        ram: 4,
      });

    try {
      const view = render(<LaunchPage />);
      await screen.findByRole("heading", { name: "What do you want to launch?" });
      chooseTile("Codex");

      expect(await screen.findByText(/No compatible capacity is ready/i)).toBeInTheDocument();
      expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
      expect(screen.getByRole("button", { name: /Set up capacity/i })).toBeInTheDocument();

      view.unmount();
      process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "hosted";
      window.localStorage.clear();
      render(<LaunchPage />);
      await screen.findByRole("heading", { name: "What do you want to launch?" });
      chooseTile("Codex");
      await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
      fireEvent.click(screen.getByTestId("launch-primary-action"));
      const receiptClock = jest.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(195_001);
      fireEvent.click(launchButton());
      receiptClock.mockRestore();

      expect(await screen.findByRole("heading", { name: "Launch could not be confirmed." })).toBeInTheDocument();
      expect(createAgentMock).toHaveBeenCalledTimes(1);
      const firstRequestId = createAgentMock.mock.calls[0][0].launchRequestId;
      expect(screen.getByRole("link", { name: "Check Home" })).toHaveAttribute("href", "/dashboard");
      fireEvent.click(screen.getByRole("button", { name: "Resume same launch" }));
      await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(2));
      expect(createAgentMock.mock.calls[1][0].launchRequestId).toBe(firstRequestId);
      expect(await screen.findByRole("link", { name: "Open Codex" })).toBeInTheDocument();
    } finally {
      if (previousMode === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
      else process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = previousMode;
    }
  });

  it("shows a terminal rejection as failed and allows review or a fresh receipt", async () => {
    createAgentMock.mockRejectedValue(new HivraLaunchRejectedError(
      "The selected infrastructure changed before launch.",
      409,
      "agent_insert_conflict",
    ));
    render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    fireEvent.click(launchButton());

    expect(await screen.findByRole("heading", {
      name: "Nothing new will be started from this receipt.",
    })).toBeInTheDocument();
    expect(screen.getByText("The selected infrastructure changed before launch.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Launch could not be confirmed." })).not.toBeInTheDocument();
    const failedRequestId = storedDraftJson().launchRequestId;
    fireEvent.click(screen.getByRole("button", { name: "Review launch" }));
    expect(screen.getByRole("heading", { name: /^Review and launch/ })).toBeInTheDocument();
    expect(storedDraftJson().launchRequestId).not.toBe(failedRequestId);
  });

  it("returns an ordinary correctable 4xx to review without terminalizing the receipt", async () => {
    createAgentMock.mockRejectedValue(new HivraLaunchCorrectableError(
      "Refresh the selected capacity and review this launch.",
      409,
      "target_revision_changed",
    ));
    render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    const requestId = storedDraftJson().launchRequestId;
    fireEvent.click(launchButton());

    expect(await screen.findByRole("heading", { name: /^Review and launch/ })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Refresh the selected capacity and review this launch.",
    );
    expect(storedDraftJson()).toMatchObject({ launchRequestId: requestId, launchState: "idle", submittedDeployment: null });
  });

  it("replays an uncertain self-managed launch from its immutable deployment snapshot", async () => {
    infrastructureTargets = [PROXMOX_TARGET];
    createAgentMock
      .mockRejectedValueOnce(new Error("Lost response"))
      .mockResolvedValueOnce({
        id: "55555555-5555-4555-8555-555555555555",
        type: "codex",
        name: "MY_CODEX_AGENT",
        status: "provisioning",
        cpu: 2,
        ram: 4,
      });
    const first = render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    const ownInfrastructure = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(ownInfrastructure).toBeEnabled());
    fireEvent.click(ownInfrastructure);
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    const receiptClock = jest.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(30_001);
    fireEvent.click(launchButton());
    receiptClock.mockRestore();
    expect(await screen.findByRole("heading", { name: "Launch could not be confirmed." })).toBeInTheDocument();
    const firstInput = createAgentMock.mock.calls[0][0];
    first.unmount();

    infrastructureTargets = [];
    fetchPlanStrictMock.mockResolvedValue({
      ...PAID_PLAN,
      poolCpu: 2,
      poolRam: 3,
    });
    render(<LaunchPage />);

    expect(await screen.findByRole("heading", { name: "Launch could not be confirmed." })).toBeInTheDocument();
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalledTimes(2));
    const resume = screen.getByRole("button", { name: "Resume same launch" });
    expect(resume).toBeEnabled();
    fireEvent.click(resume);
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(2));
    expect(createAgentMock.mock.calls[1][0]).toMatchObject({
      launchRequestId: firstInput.launchRequestId,
      deployment: firstInput.deployment,
      cpu: firstInput.cpu,
      ram: firstInput.ram,
    });
  });

  async function leaveUnfinishedCodexDraft() {
    const first = render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    expect(screen.getByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    const saved = storedDraftJson();
    first.unmount();
    return saved;
  }

  function linkParams(params: Record<string, string>) {
    searchParamsGetMock.mockImplementation((key: string) => params[key] ?? null);
  }

  it("asks before a new launch link replaces an unfinished draft, and starts fresh on request", async () => {
    const saved = await leaveUnfinishedCodexDraft();
    linkParams({ start: "1", kind: "computer" });
    render(<LaunchPage />);

    expect(await screen.findByRole("heading", { name: "Continue your Codex launch, or start a new one?" })).toHaveFocus();
    // Nothing is thrown away until the owner chooses.
    expect(storedDraftJson().launchRequestId).toBe(saved.launchRequestId);
    fireEvent.click(screen.getByRole("button", { name: "Start a new launch" }));

    expect(screen.getByRole("heading", { name: "What do you want to launch?" })).toBeInTheDocument();
    const computers = screen.getByRole("region", { name: "A computer" });
    expect(computers.compareDocumentPosition(screen.getByRole("region", { name: "An agent" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(storedDraftJson()).toMatchObject({ profileId: null, stage: "choose" });
    expect(storedDraftJson().launchRequestId).not.toBe(saved.launchRequestId);
  });

  it("continues the unfinished draft exactly as it was", async () => {
    const saved = await leaveUnfinishedCodexDraft();
    linkParams({ start: "1", kind: "agent" });
    render(<LaunchPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue Codex launch" }));
    expect(screen.getByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue("Codex 1");
    expect(storedDraftJson().launchRequestId).toBe(saved.launchRequestId);
  });

  it("opens a new launch for the profile a link names after the owner picks start new", async () => {
    await leaveUnfinishedCodexDraft();
    linkParams({ start: "1", kind: "computer", profile: "ubuntu-desktop" });
    render(<LaunchPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Start a new Ubuntu Desktop launch" }));
    expect(screen.getByRole("heading", { name: "Ubuntu Desktop — here's the plan" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Computer name" })).toHaveValue("Ubuntu Desktop 1");
    expect(storedDraftJson()).toMatchObject({ profileId: "ubuntu-desktop", stage: "plan" });
  });

  it("opens the plan straight from a profile link when there is nothing to resume", async () => {
    linkParams({ start: "1", profile: "codex" });
    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    expect(screen.queryByText(/Continue your/)).not.toBeInTheDocument();
  });

  it("never sets an unconfirmed launch aside for a new launch link", async () => {
    const draft = { ...createLaunchDraft(), stage: "launch", resourceKind: "agent", profileId: "codex", name: "Codex 1",
      launchState: "uncertain", submittedDeployment: { mode: "hivra-managed" } };
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    linkParams({ start: "1" });
    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Launch could not be confirmed." })).toBeInTheDocument();
    expect(screen.queryByText(/Continue your/)).not.toBeInTheDocument();
  });

  it("resumes a draft another tab saved and moves a draft this tab saved before", async () => {
    const legacy = { ...createLaunchDraft(), stage: "capacity", resourceKind: "agent", profileId: "codex", name: "Codex 1" };
    window.sessionStorage.setItem("hivra.launch-draft.v1", JSON.stringify(legacy));
    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    expect(storedDraftJson().launchRequestId).toBe(legacy.launchRequestId);
    expect(window.sessionStorage.getItem("hivra.launch-draft.v1")).toBeNull();
  });

  it("restores the non-secret draft and stable request identity after a refresh", async () => {
    const first = render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    await waitFor(() => expect(screen.getByText(CODEX_BROWSER_SIZE)).toBeInTheDocument());
    const stored = storedDraftJson();
    first.unmount();

    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    fireEvent.click(launchButton());
    await waitFor(() => expect(createAgentMock).toHaveBeenCalled());
    expect(createAgentMock.mock.calls[0][0].launchRequestId).toBe(stored.launchRequestId);
    expect(stored).not.toHaveProperty("apiKey");
  });

  it("preserves name, custom resources, target, and request identity when reselecting the same choices after Back", async () => {
    infrastructureTargets = [PROXMOX_TARGET];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    const ownInfrastructure = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(ownInfrastructure).toBeEnabled());
    fireEvent.click(ownInfrastructure);
    fireEvent.change(screen.getByRole("textbox", { name: "Agent name" }), { target: { value: "STUDIO_CODEX" } });
    fireEvent.click(within(customField("Reserved CPU")).getByRole("button", { name: "4 CPU" }));
    fireEvent.click(within(customField("Reserved memory")).getByRole("button", { name: "8 GB" }));
    const saved = storedDraftJson();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expectCurrentStep("Choose");
    expect(screen.getByRole("button", { name: /^Codex/ })).toHaveAttribute("data-selected", "true");
    chooseTile("Codex");
    expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue("STUDIO_CODEX");
    expect(screen.getByText("Custom · 4 CPU / 8 GB reserved · up to 4 CPU / 8 GB")).toBeInTheDocument();
    expect(whereButton(/My infrastructure/i)).toHaveAttribute("aria-pressed", "true");
    expect(storedDraftJson()).toMatchObject({
      launchRequestId: saved.launchRequestId,
      name: "STUDIO_CODEX",
      capacity: { mode: "self-managed", targetId: PROXMOX_TARGET.id },
      resources: { cpu: 4, ram: 8, source: "custom" },
    });
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  // The owner picks the big host for Codex, goes back to look at Ubuntu
  // Desktop, and returns to Codex. The host stays selected on screen, so the fresh drafts
  // must record it too: otherwise a reload moves the launch to Hivra Cloud and
  // changes the browser the owner saw.
  async function roundTripProfileOnHost() {
    infrastructureTargets = [PROXMOX_TARGET];
    const view = render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    chooseTile("Codex");
    const own = await findWhereButton(/My infrastructure/i);
    await waitFor(() => expect(own).toBeEnabled());
    fireEvent.click(own);
    expect(storedDraft().capacity).toEqual({ mode: "self-managed", targetId: PROXMOX_TARGET.id });
    await stepBack();
    chooseTile("Ubuntu Desktop");
    expect(screen.getByRole("heading", { name: "Ubuntu Desktop — here's the plan" })).toBeInTheDocument();
    expect(storedDraft().capacity).toEqual({ mode: "self-managed", targetId: PROXMOX_TARGET.id });
    await stepBack();
    expect(screen.getByRole("heading", { name: "What do you want to launch?" })).toBeInTheDocument();
    return view;
  }

  /** Back pops the history entry the step pushed; let that traversal land. */
  async function stepBack() {
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(window.history.state).toEqual(expect.objectContaining({ hivraLaunchStage: "choose" })));
  }

  function expectHostSelected() {
    expect(whereButton(/My infrastructure/i)).toHaveAttribute("aria-pressed", "true");
    expect(readyHost()).toHaveValue(PROXMOX_TARGET.id);
    expect(storedDraft().capacity).toEqual({ mode: "self-managed", targetId: PROXMOX_TARGET.id });
  }

  it.each([
    ["Free", FREE_PLAN],
    ["paid", PAID_PLAN],
  ])("keeps the owner's host and browser across a profile round trip and a reload on a %s plan", async (_label, plan) => {
    fetchPlanStrictMock.mockResolvedValue(plan);
    const first = await roundTripProfileOnHost();
    chooseTile("Codex");
    const browser = screen.getByRole("checkbox", { name: /Browser for Codex/ });
    await waitFor(() => expect(browser).toBeChecked());
    expectHostSelected();
    fireEvent.click(within(customField("Reserved CPU")).getByRole("button", { name: "2 CPU" }));
    fireEvent.click(within(customField("Reserved memory")).getByRole("button", { name: "4 GB" }));
    expect(browser).toBeChecked();
    expect(screen.getByText(RAISED_TEXT)).toBeInTheDocument();
    expectHostSelected();
    const shown = storedDraft();
    expect(shown).toMatchObject({ browser: true, browserSource: "recommended", resources: RAISED_RESOURCES });
    first.unmount();

    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    await act(async () => { await Promise.resolve(); });
    // The reload restores exactly what the owner saw and changes nothing.
    expect(storedDraft()).toEqual(shown);
    expectHostSelected();
    expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).toBeChecked();
    expect(screen.getByText(RAISED_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("launch-primary-action"));
    const review = screen.getByLabelText("Launch review");
    expect(within(review).getByText(PROXMOX_TARGET.displayName)).toBeInTheDocument();
    expect(within(review).getByText(CODEX_CAN_USE_WITH_BROWSER)).toBeInTheDocument();
    fireEvent.click(launchButton());
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex", cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4, browser: true,
      deployment: expect.objectContaining({ mode: "self-managed", targetId: PROXMOX_TARGET.id }),
    })));
  });

  it("keeps the owner's host when the page reloads on Choose between two profiles", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    (await roundTripProfileOnHost()).unmount();

    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "What do you want to launch?" })).toBeInTheDocument();
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalledTimes(2));
    chooseTile("Codex");
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).toBeChecked());
    expectHostSelected();
    expect(screen.getByText(CODEX_BROWSER_SIZE)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not carry a placement Linux Sandbox forces into the next computer's draft", async () => {
    const gvisorHost = { ...GVISOR_TARGET, id: "77777777-7777-4777-8777-777777777777" };
    infrastructureTargets = [gvisorHost, PROXMOX_TARGET];
    const first = render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Linux Sandbox");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    expect(readyHost()).toHaveValue(gvisorHost.id);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    chooseTile("Ubuntu Desktop");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    // The owner never chose their own infrastructure; only the sandbox needed it.
    expect(whereButton(/Hivra Cloud/i)).toHaveAttribute("aria-pressed", "true");
    expect(storedDraft().capacity).toEqual({ mode: "hivra-managed", targetId: null });
    first.unmount();

    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Ubuntu Desktop — here's the plan" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    expect(whereButton(/Hivra Cloud/i)).toHaveAttribute("aria-pressed", "true");
    expect(storedDraft().capacity).toEqual({ mode: "hivra-managed", targetId: null });
  });

  it("keeps the name before placement and leaves the final action in the active step", async () => {
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Ubuntu Desktop");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    const name = screen.getByRole("textbox", { name: "Computer name" });
    openWhereItRuns();
    const destination = screen.getByRole("region", { name: "Where it runs" });
    expect(name.compareDocumentPosition(destination) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const plan = screen.getByRole("region", { name: "Ubuntu Desktop — here's the plan" });
    expect(within(plan).getByRole("button", { name: "Review launch" })).toBeInTheDocument();
  });

  it("returns from an upgrade to the same launch and says the new plan is active", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    const first = render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    chooseTile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByRole("checkbox", { name: /Browser for Codex/ }));
    const upgrade = within(screen.getByRole("alert")).getByRole("link", { name: "Upgrade to Pro" });
    const saved = storedDraftJson();
    const href = new URL(upgrade.getAttribute("href") ?? "", "https://hivra.test");
    expect(href.pathname).toBe("/dashboard/billing");
    expect(href.searchParams.get("returnTo")).toBe(`/dashboard/launch?draft=${saved.launchRequestId}`);
    first.unmount();

    // Billing sends the owner back to this draft once Pro is active.
    const pro = { ...PAID_PLAN, name: "Pro", maxCpuPerAgent: 2, maxRamPerAgent: 4, poolCpu: 2, poolRam: 4 };
    fetchPlanStrictMock.mockResolvedValue(pro);
    linkParams({ draft: saved.launchRequestId, upgraded: "1" });
    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Codex — here's the plan" })).toBeInTheDocument();
    expect(await screen.findByText("Pro is active. Continue your Codex launch.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    expect(screen.getByRole("checkbox", { name: /Browser for Codex/ })).toBeChecked();
    expect(screen.getByText(CODEX_BROWSER_SIZE)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(storedDraftJson().launchRequestId).toBe(saved.launchRequestId);
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    fireEvent.click(screen.getByRole("button", { name: "Launch Codex" }));
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex", browser: true, cpu: 1.5, ram: 3, launchRequestId: saved.launchRequestId,
    })));
  });

  it("says so when the new plan isn't showing yet after checkout, and checks again", async () => {
    const saved = await leaveUnfinishedCodexDraft();
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    linkParams({ draft: saved.launchRequestId, upgraded: "1" });
    render(<LaunchPage />);
    const waiting = await screen.findByText("Your new plan isn't showing yet. It can take a moment after checkout.");
    expect(screen.queryByText(/is active/)).not.toBeInTheDocument();

    fetchPlanStrictMock.mockResolvedValue(PAID_PLAN);
    fireEvent.click(within(waiting.closest("[role='status']") as HTMLElement).getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Operator is active. Continue your Codex launch.")).toBeInTheDocument();
  });

  it("never names a plan as active from the URL alone", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    linkParams({ upgraded: "1" });
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    expect(screen.queryByText(/is active/)).not.toBeInTheDocument();
  });

  const PRO_PLAN = { ...PAID_PLAN, name: "Pro", maxAgents: 3, maxCpuPerAgent: 2, maxRamPerAgent: 4, poolCpu: 2, poolRam: 4 };

  it("upgrades an Ubuntu Desktop launch from Free to the Pro the badge named and launches it on Pro", async () => {
    fetchPlanStrictMock.mockResolvedValue(FREE_PLAN);
    const first = render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Ubuntu Desktop/ })).toHaveTextContent("Needs Pro or your own server"));
    chooseTile("Ubuntu Desktop");
    const blocker = await screen.findByRole("alert");
    expect(blocker).toHaveTextContent("Ubuntu Desktop needs a paid plan on Hivra Cloud, or a server you connected.");
    // The blocker offers the plan the badge named, not a pricier one.
    const upgrade = within(blocker).getByRole("link", { name: "Upgrade to Pro" });
    const saved = storedDraftJson();
    expect(new URL(upgrade.getAttribute("href") ?? "", "https://hivra.test").searchParams.get("returnTo"))
      .toBe(`/dashboard/launch?draft=${saved.launchRequestId}`);
    first.unmount();

    // Back from checkout: the restored draft still carries Free's 4 CPU / 8 GB
    // maximum, which Pro's per-computer cap can't hold.
    expect(saved.resources).toMatchObject({ cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8, source: "recommended" });
    fetchPlanStrictMock.mockResolvedValue(PRO_PLAN);
    linkParams({ draft: saved.launchRequestId, upgraded: "operator" });
    render(<LaunchPage />);
    expect(await screen.findByText("Pro is active. Continue your Ubuntu Desktop launch.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Small · 2 CPU / 4 GB reserved · up to 2 CPU / 4 GB")).toBeInTheDocument());
    expect(screen.getByText("Your Pro plan lets each computer use up to 2 CPU / 4 GB, so Small's maximum stops there.")).toBeInTheDocument();
    const small = within(screen.getByRole("group", { name: "Size" })).getByRole("button", { name: /^Small/ });
    expect(small).toHaveAttribute("aria-pressed", "true");
    expect(small).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Upgrade to/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review launch" }));
    fireEvent.click(screen.getByRole("button", { name: "Launch Ubuntu Desktop" }));
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "linux-desktop", cpu: 2, ram: 4, maximumCpu: 2, maximumRam: 4, launchRequestId: saved.launchRequestId,
    })));
  });

  it("offers Ubuntu's Small on Pro and one click to it when the owner's own size is over the cap", async () => {
    fetchPlanStrictMock.mockResolvedValue(PRO_PLAN);
    const draft = { ...createLaunchDraft(), stage: "plan", resourceKind: "computer", profileId: "ubuntu-desktop", name: "Ubuntu Desktop 1",
      resources: { cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8, source: "custom" } };
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    render(<LaunchPage />);
    const blocker = await screen.findByRole("alert");
    expect(blocker).toHaveTextContent("Ubuntu Desktop is set to use up to 4 CPU / 8 GB. Your Pro plan allows up to 2 CPU / 4 GB for each computer.");
    // The owner's size is never lowered for them, so its upgrade holds it exactly.
    expect(within(blocker).getByRole("link", { name: "Upgrade to Power" })).toBeInTheDocument();
    const sizes = screen.getByRole("group", { name: "Size" });
    expect(within(sizes).getByRole("button", { name: /^Small/ })).toBeEnabled();
    expect(within(sizes).getByRole("button", { name: /^Medium/ })).toHaveTextContent("Over your plan");
    fireEvent.click(within(blocker).getByRole("button", { name: "Use Small (2 CPU / 4 GB)" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Small · 2 CPU / 4 GB reserved · up to 2 CPU / 4 GB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review launch" })).toBeEnabled();
  });

  it("names the plan a paid upgrade moved to while it hasn't shown up yet", async () => {
    const saved = await leaveUnfinishedCodexDraft();
    fetchPlanStrictMock.mockResolvedValue(PRO_PLAN);
    linkParams({ draft: saved.launchRequestId, upgraded: "fleet" });
    render(<LaunchPage />);
    const waiting = await screen.findByText("Your Power plan isn't showing yet. It can take a moment after checkout. You're still on Pro.");
    expect(screen.queryByText(/is active/)).not.toBeInTheDocument();

    fetchPlanStrictMock.mockResolvedValue({ ...PAID_PLAN, name: "Power", key: "fleet" });
    fireEvent.click(within(waiting.closest("[role='status']") as HTMLElement).getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Power is active. Continue your Codex launch.")).toBeInTheDocument();
  });

  it("drops the upgrade params from the URL so a reload doesn't announce it again", async () => {
    const saved = await leaveUnfinishedCodexDraft();
    fetchPlanStrictMock.mockResolvedValue(PRO_PLAN);
    window.history.replaceState(null, "", `/dashboard/launch?draft=${saved.launchRequestId}&upgraded=operator`);
    linkParams({ draft: saved.launchRequestId, upgraded: "operator" });
    const returned = render(<LaunchPage />);
    expect(await screen.findByText("Pro is active. Continue your Codex launch.")).toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("stage")).toBe("plan"));
    expect(new URLSearchParams(window.location.search).has("upgraded")).toBe(false);
    expect(new URLSearchParams(window.location.search).has("draft")).toBe(false);
    // The notice stays for this visit, on every step.
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(screen.getByText("Pro is active. Continue your Codex launch.")).toBeInTheDocument();
    returned.unmount();

    // A reload reads the URL as it now is.
    const reloaded = new URLSearchParams(window.location.search);
    searchParamsGetMock.mockImplementation((key: string) => reloaded.get(key));
    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Review and launch Codex 1" })).toBeInTheDocument();
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(/is active/)).not.toBeInTheDocument();
    window.history.replaceState(null, "", "/");
  });

  it("says the plan couldn't be checked on every Hivra Cloud tile instead of checking forever", async () => {
    fetchPlanStrictMock.mockRejectedValue(new Error("plan unavailable"));
    render(<LaunchPage />);
    await screen.findByText("We couldn't check your plan, so we can't show what fits it yet.");
    expect(screen.queryByText("Checking fit…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Codex/ })).toHaveTextContent("Couldn't check your plan");
    expect(screen.getByRole("button", { name: /^Ubuntu Desktop/ })).toHaveTextContent("Couldn't check your plan");
  });

  it("never reads a server list that failed to load as having no servers", async () => {
    const respond = (global.fetch as jest.Mock).getMockImplementation()!;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input).includes("/api/infrastructure/targets")
      ? { ok: false, status: 503, json: async () => ({ success: false, error: "Hosts unavailable" }) } as Response
      : respond(input, init));
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Linux Sandbox/ })).toHaveTextContent("Couldn't check your servers"));
    expect(screen.getByRole("button", { name: /^Linux Sandbox/ })).not.toHaveTextContent("Needs your own server");
    expect(screen.getByRole("button", { name: /^Windows/ })).toHaveTextContent("Couldn't check your servers");
    expect(screen.getByRole("button", { name: /^Codex/ })).toHaveTextContent("Fits your Operator plan");
  });

  it("points a resume prompt at what a partial launch created, and keeps it through Back", async () => {
    const partialId = "77777777-7777-4777-8777-777777777777";
    createAgentMock.mockRejectedValue(new HivraLaunchCorrectableError(
      "The browser sidecar failed to start. Delete the computer and try again.", 409, "sidecar_failed", partialId,
    ));
    const first = render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    fireEvent.click(launchButton());
    expect(await screen.findByText("Part of this launch was created and can be removed.")).toBeInTheDocument();
    // Back and forward again still shows the way to delete it.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(screen.getByText("Part of this launch was created and can be removed.")).toBeInTheDocument();
    first.unmount();

    linkParams({ start: "1" });
    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Continue your Codex launch, or start a new one?" })).toBeInTheDocument();
    expect(screen.getByText("Your last try created part of Codex 1 before it stopped.")).toBeInTheDocument();
    expect(screen.queryByText(/haven't launched/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing has started/)).not.toBeInTheDocument();
    expect(screen.getByText("Starting a new launch doesn't delete what was created.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open it to delete" })).toHaveAttribute("href", `/dashboard/agent/${partialId}?tab=manage`);
  });

  it("mentions a Windows ISO download still running when asking to resume", async () => {
    const draft = { ...createLaunchDraft(), stage: "plan", resourceKind: "computer", profileId: "windows", name: "Windows-1",
      resources: { cpu: 4, ram: 8, maximumCpu: 4, maximumRam: 8, source: "recommended" },
      capacity: { mode: "self-managed", targetId: PROXMOX_TARGET.id },
      windowsIsoDownload: { taskId: "99999999-9999-4999-8999-999999999999", connectionId: PROXMOX_TARGET.connectionId,
        targetId: PROXMOX_TARGET.id, expectedConnectionRevision: 7, source: "windows-11", storage: "local", filename: "Win11.iso", state: "running" } };
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    linkParams({ start: "1" });
    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Continue your Windows launch, or start a new one?" })).toBeInTheDocument();
    expect(screen.getByText("You set up Windows-1 but haven't launched it yet.")).toBeInTheDocument();
    expect(screen.getByText("When you left, your server was still downloading Win11.iso. Starting a new launch doesn't stop that download.")).toBeInTheDocument();
  });

  it("keeps Review closed until a Windows name is one the host accepts", async () => {
    infrastructureTargets = [PROXMOX_TARGET];
    windowsIsoImages = [{ volume: "local:iso/Win11.iso", name: "Win11.iso", sizeBytes: 6_000_000_000,
      modifiedAtSeconds: 1_757_934_001, fileIdentitySha256: "d".repeat(64), source: "unknown" }];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseTile("Windows");
    const myServer = await screen.findByRole("button", { name: /^My server/ });
    await waitFor(() => expect(myServer).toBeEnabled());
    fireEvent.click(myServer);
    fireEvent.change(await screen.findByRole("combobox", { name: "Your Windows ISO" }), { target: { value: windowsIsoImages[0].volume } });
    fireEvent.click(screen.getByRole("checkbox"));
    const name = screen.getByRole("textbox", { name: "Computer name" });
    expect(name).toHaveValue("Windows-1");
    await waitFor(() => expect(screen.getByRole("button", { name: "Review launch" })).toBeEnabled());

    fireEvent.change(name, { target: { value: "My Windows" } });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Windows names use letters, numbers, dots, dashes and underscores/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review launch" })).toBeDisabled();
    fireEvent.change(name, { target: { value: "My-Windows" } });
    expect(screen.getByRole("button", { name: "Review launch" })).toBeEnabled();
  });
});
