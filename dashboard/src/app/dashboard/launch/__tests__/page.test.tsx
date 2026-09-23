/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import type { LaunchDestinationState } from "@/components/dashboard/welcome/DeploymentDestinationControl";
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
import { reviewMutation } from "@/components/launch/LaunchJourney";
import { createLaunchDraft, LAUNCH_DRAFT_STORAGE_KEY } from "@/lib/launch/draft-store";

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

function chooseResource(kind: "Agent" | "Computer") {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${kind}\\b`) }));
  fireEvent.click(screen.getByTestId("launch-primary-action"));
}

function chooseProfile(name: "Codex" | "Ubuntu Desktop" | "Linux Sandbox" | "Windows") {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
  fireEvent.click(screen.getByTestId("launch-primary-action"));
}

function expectCurrentStep(label: "Choose" | "Configure" | "Review") {
  const steps = screen.getByRole("list", { name: "Launch steps" });
  expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
  expect(within(steps).getByText(label).closest("li")).toHaveAttribute("aria-current", "step");
}

describe("LaunchPage", () => {
  let infrastructureTargets: DeploymentTargetDto[];
  let windowsIsoImages: Array<{ volume: string; name: string; sizeBytes: number; modifiedAtSeconds: number; fileIdentitySha256: string; source: "unknown" | "windows-11" | "windows-server-evaluation" }>;
  let windowsLaunchBody: Record<string, unknown> | null;
  let windowsDownloadBody: Record<string, unknown> | null;

  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
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

  it("describes a future self-managed Windows review without claiming an Ubuntu install", () => {
    const draft = {
      ...createLaunchDraft(),
      resourceKind: "computer" as const,
      profileId: "windows" as const,
    };
    const destination = {
      mode: "self-managed" as const,
      selectedTarget: PROXMOX_TARGET,
    } as LaunchDestinationState;

    expect(reviewMutation(draft, destination)).toBe(
      "Creates one UEFI/TPM Windows setup VM, attaches the selected host-side ISO, and starts the installer. It does not buy a server, upload the ISO, or use Hivra Cloud.",
    );
    expect(reviewMutation(draft, destination)).not.toContain("Ubuntu");
  });

  it("launches Linux Sandbox through the canonical agent API with reserved limits equal to maxima", async () => {
    infrastructureTargets = [GVISOR_TARGET];
    createAgentMock.mockResolvedValue({ id: "77777777-7777-4777-8777-777777777777", type: "linux-terminal",
      computer_profile: "linux-terminal", computer_substrate: "gvisor", name: "MY_LINUX_SANDBOX", status: "running", cpu: 1, ram: 1 });
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseResource("Computer");
    chooseProfile("Linux Sandbox");
    await waitFor(() => expect(screen.getByRole("button", { name: /My infrastructure/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /My infrastructure/i }));
    expect(screen.getByText(/1 CPU \/ 1 GB enforced limit/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Maximum CPU")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(within(screen.getByLabelText("Launch review")).getByText(/gVisor application-kernel sandbox/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    await waitFor(() => expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "linux-terminal", computerProfile: "linux-terminal", cpu: 1, ram: 1, maximumCpu: 1, maximumRam: 1,
      deployment: expect.objectContaining({ mode: "self-managed", targetId: GVISOR_TARGET.id }),
    })));
  });

  it("focuses each new step without stealing focus during name editing", async () => {
    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "What do you want to launch?" })).toHaveFocus();
    chooseResource("Computer");
    expect(screen.getByRole("heading", { name: "Choose an operating system" })).toHaveFocus();
    chooseProfile("Ubuntu Desktop");
    expect(screen.getByRole("heading", { name: "Where should Ubuntu Desktop run?" })).toHaveFocus();
    expect(screen.getByTestId("launch-journey")).toHaveAttribute("data-stage", "capacity");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    const name = screen.getByRole("textbox", { name: "Computer name" });
    name.focus();
    fireEvent.change(name, { target: { value: "FOCUS_CHECK" } });
    expect(name).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Choose an operating system" })).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Choose an operating system" })).toHaveAttribute("tabindex", "-1");
  });

  it("groups the launch into Choose, Configure, and Review while preserving the native handoff", async () => {
    render(<LaunchPage />);

    expect(await screen.findByRole("heading", { name: "What do you want to launch?" })).toBeInTheDocument();
    expectCurrentStep("Choose");
    expect(screen.getAllByTestId("launch-primary-action")).toHaveLength(1);
    chooseResource("Agent");

    expect(screen.getByRole("heading", { name: "Choose an agent" })).toBeInTheDocument();
    expectCurrentStep("Choose");
    expect(screen.getByRole("link", { name: /Browse every agent/i })).toHaveAttribute(
      "href",
      "/dashboard/welcome?step=agent-type&from=launch",
    );
    chooseProfile("Codex");

    expect(screen.getByRole("heading", { name: "Where should Codex run?" })).toBeInTheDocument();
    expectCurrentStep("Configure");
    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /Hivra Cloud/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Recommended · 1.5 CPU / 3 GB reserved · up to 2 CPU / 4 GB")).toBeInTheDocument();
    expect(screen.getByText("Use Hivra Cloud, or choose a compatible host you have connected.")).toBeInTheDocument();
    expect(screen.getByText(/Reserved CPU counts against your pool/)).toBeInTheDocument();
    expect(screen.getByText("Resources")).toBeInTheDocument();
    expect(screen.getByLabelText("Reserved CPU")).toBeVisible();
    expect(screen.getByLabelText("Maximum memory")).toBeVisible();
    fireEvent.click(screen.getByTestId("launch-primary-action"));

    expect(screen.getByRole("heading", { name: "Review this launch" })).toBeInTheDocument();
    expectCurrentStep("Review");
    expect(screen.getByText("Check the resource, location, and exact changes before you launch.")).toBeInTheDocument();
    const review = screen.getByLabelText("Launch review");
    expect(within(review).getByText("Codex")).toBeInTheDocument();
    expect(within(review).getByText("Hivra Cloud")).toBeInTheDocument();
    expect(within(review).getByText("1.5 CPU / 3 GB reserved · up to 2 CPU / 4 GB")).toBeInTheDocument();
    expect(within(review).getByText("Hardware-isolated Proxmox VM")).toBeInTheDocument();
    expect(within(review).getByText("Uses the included Operator plan allowance.")).toBeInTheDocument();
    expect(within(review).getByText("Creates one isolated VM and installs the Codex runtime.")).toBeInTheDocument();
    expect(within(review).getByText(/ChatGPT sign-in happens inside Codex/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    await waitFor(() => expect(createAgentMock).toHaveBeenCalledTimes(1));
    expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "codex",
      name: "MY_CODEX_AGENT",
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
    chooseResource("Computer");
    chooseProfile("Ubuntu Desktop");
    await waitFor(() => expect(screen.getByLabelText("Reserved CPU")).toBeVisible());

    expect(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" })).toBeDisabled();
    expect(within(screen.getByLabelText("Maximum CPU")).getByRole("button", { name: "4 CPU" })).toBeEnabled();
    expect(within(screen.getByLabelText("Reserved memory")).getByRole("button", { name: "16 GB" })).toBeDisabled();
    expect(within(screen.getByLabelText("Maximum memory")).getByRole("button", { name: "16 GB" })).toBeEnabled();
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
    chooseResource("Agent");
    chooseProfile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(await screen.findByRole("heading", { name: "Confirming your launch…" })).toBeInTheDocument();
    expect(screen.getByText("Hivra is checking the request for MY_CODEX_AGENT. We’ll open it as soon as the launch is confirmed.")).toBeInTheDocument();
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
    chooseResource("Agent");
    chooseProfile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    const receiptClock = jest.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(30_001);
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
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
    chooseResource("Computer");
    expect(screen.getByRole("heading", { name: "Choose an operating system" })).toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Omarchy/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Windows/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Windows/i })).toHaveTextContent("compatible capacity you own");
    expect(screen.getByRole("button", { name: /Windows/i })).not.toHaveTextContent("Customer capacity");
    chooseProfile("Ubuntu Desktop");

    await waitFor(() => expect(fetchPlanStrictMock).toHaveBeenCalled());
    const computerName = screen.getByRole("textbox", { name: "Computer name" });
    expect(computerName).toBeVisible();
    expect(computerName).toHaveValue("MY_UBUNTU_DESKTOP");
    expect(screen.getByLabelText("Reserved CPU")).toBeVisible();
    fireEvent.change(computerName, { target: { value: "DESIGN_STATION" } });
    fireEvent.click(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" }));
    fireEvent.click(within(screen.getByLabelText("Reserved memory")).getByRole("button", { name: "8 GB" }));
    expect(screen.getByText(/Reserved CPU and memory count against capacity/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(within(screen.getByLabelText("Launch review")).getByText("DESIGN_STATION")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

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
    chooseResource("Computer");
    chooseProfile("Windows");

    expect(screen.getByText("Choose compatible customer-owned or self-hosted capacity. Hivra Cloud is not available for Windows.")).toBeVisible();
    expect(await screen.findByText("Hivra Cloud is unavailable for Windows. Choose compatible customer-owned or self-hosted capacity.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review launch" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Hivra Cloud/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Customer-owned capacity/i })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Review plans" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Infrastructure" })).toHaveAttribute(
      "href",
      "/dashboard/infrastructure?launch=windows&returnTo=unified-launch",
    );
    expect(screen.queryByText(/private|test|evaluation|licen[cs]e|legal/i)).not.toBeInTheDocument();
  });

  it("keeps a compatible Proxmox target blocked until a host-side ISO is observed", async () => {
    infrastructureTargets = [PROXMOX_TARGET];
    render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseResource("Computer");
    chooseProfile("Windows");

    const customerCapacity = await screen.findByRole("button", { name: /Customer-owned capacity/i });
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
    chooseResource("Computer");
    chooseProfile("Windows");
    expect(await screen.findByRole("button", { name: /Customer-owned capacity/i })).toBeDisabled();
    expect(screen.getByText(/do not have current Windows compatibility evidence/)).toBeVisible();
  });

  it("starts a direct-to-host Microsoft download only after attestation", async () => {
    infrastructureTargets = [PROXMOX_TARGET];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseResource("Computer");
    chooseProfile("Windows");
    const customerCapacity = await screen.findByRole("button", { name: /Customer-owned capacity/i });
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
      const saved = window.sessionStorage.getItem(LAUNCH_DRAFT_STORAGE_KEY) ?? "";
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
    chooseResource("Computer");
    chooseProfile("Windows");
    const customerCapacity = await screen.findByRole("button", { name: /Customer-owned capacity/i });
    await waitFor(() => expect(customerCapacity).toBeEnabled());
    fireEvent.click(customerCapacity);
    const iso = await screen.findByRole("combobox", { name: "Customer-owned Windows ISO" });
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
    expect(within(review).getByText(/Creates one UEFI\/TPM Windows setup VM/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
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
    chooseResource("Agent");
    chooseProfile("Codex");
    const ownInfrastructure = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(ownInfrastructure).toBeEnabled());
    fireEvent.click(ownInfrastructure);
    fireEvent.click(screen.getByTestId("launch-primary-action"));

    expect(screen.getByRole("heading", { name: "Review this launch" })).toBeInTheDocument();
    expect(screen.getByText("Studio Proxmox / pve-01")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

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
    chooseResource("Agent"); chooseProfile("Codex");
    const own = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(own).toBeEnabled());
    fireEvent.click(own);
    expect(screen.getByText("Entire prepared provider computer")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Reserved CPU" })).not.toBeInTheDocument();
    expect(screen.getByTestId("launch-primary-action")).toBeEnabled();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(within(screen.getByLabelText("Launch review")).getByText(
      "Entire prepared provider computer · existing CPU and RAM unchanged",
    )).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
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
    chooseResource("Computer");chooseProfile("Ubuntu Desktop");
    const own=await screen.findByRole("button",{name:/My infrastructure/i});
    await waitFor(()=>expect(own).toBeEnabled());fireEvent.click(own);
    if(available===5)expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
    else {
      expect(screen.getByTestId("launch-primary-action")).toBeEnabled();
      fireEvent.click(screen.getByTestId("launch-primary-action"));
      expect(screen.getByRole("heading",{name:"Review this launch"})).toBeInTheDocument();
    }
    expect(createAgentMock).not.toHaveBeenCalled();
  });
  it("still blocks an exclusive provider computer without runtime memory headroom", async () => {
    infrastructureTargets = [{ ...PROVIDER_TARGET, capacity: { ...PROVIDER_TARGET.capacity,
      memoryBytes: { total: 4 * 1024 ** 3, available: 2 * 1024 ** 3 } } }];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseResource("Agent"); chooseProfile("Codex");
    const own = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(own).toBeEnabled());
    fireEvent.click(own);
    expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it("keeps a disappeared restored target self-managed and blocks instead of falling back", async () => {
    infrastructureTargets = [PROXMOX_TARGET];
    const first = render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseResource("Agent");
    chooseProfile("Codex");
    const ownInfrastructure = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(ownInfrastructure).toBeEnabled());
    fireEvent.click(ownInfrastructure);
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    expect(screen.getByRole("heading", { name: "Review this launch" })).toBeInTheDocument();
    first.unmount();

    infrastructureTargets = [];
    render(<LaunchPage />);

    expect(await screen.findByRole("heading", { name: "Review this launch" })).toBeInTheDocument();
    expect(await screen.findByText("Unavailable target")).toBeInTheDocument();
    expect(screen.getByText("No compatible capacity is ready for this profile.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
  });

  it("ends plan preflight with an actionable blocker when managed capacity cannot be verified", async () => {
    fetchPlanStrictMock.mockRejectedValue(new Error("Plan service unavailable"));
    render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseResource("Agent");
    chooseProfile("Codex");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Managed capacity could not be verified. Refresh before launching.",
    );
    expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
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
      chooseResource("Agent");
      chooseProfile("Codex");

      expect(await screen.findByText(/No compatible capacity is ready/i)).toBeInTheDocument();
      expect(screen.getByTestId("launch-primary-action")).toBeDisabled();
      expect(screen.getByRole("link", { name: /Set up capacity/i })).toHaveAttribute(
        "href",
        "/dashboard/infrastructure?launch=codex&returnTo=unified-launch",
      );

      view.unmount();
      process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "hosted";
      window.sessionStorage.clear();
      render(<LaunchPage />);
      await screen.findByRole("heading", { name: "What do you want to launch?" });
      chooseResource("Agent");
      chooseProfile("Codex");
      await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
      fireEvent.click(screen.getByTestId("launch-primary-action"));
      const receiptClock = jest.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(195_001);
      fireEvent.click(screen.getByRole("button", { name: "Launch" }));
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
    chooseResource("Agent");
    chooseProfile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(await screen.findByRole("heading", {
      name: "Nothing new will be started from this receipt.",
    })).toBeInTheDocument();
    expect(screen.getByText("The selected infrastructure changed before launch.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Launch could not be confirmed." })).not.toBeInTheDocument();
    const failedRequestId = JSON.parse(
      window.sessionStorage.getItem("hivra.launch-draft.v1") || "{}",
    ).launchRequestId;
    fireEvent.click(screen.getByRole("button", { name: "Review launch" }));
    expect(screen.getByRole("heading", { name: "Review this launch" })).toBeInTheDocument();
    expect(JSON.parse(
      window.sessionStorage.getItem("hivra.launch-draft.v1") || "{}",
    ).launchRequestId).not.toBe(failedRequestId);
  });

  it("returns an ordinary correctable 4xx to review without terminalizing the receipt", async () => {
    createAgentMock.mockRejectedValue(new HivraLaunchCorrectableError(
      "Refresh the selected capacity and review this launch.",
      409,
      "target_revision_changed",
    ));
    render(<LaunchPage />);

    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseResource("Agent");
    chooseProfile("Codex");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    const requestId = JSON.parse(
      window.sessionStorage.getItem("hivra.launch-draft.v1") || "{}",
    ).launchRequestId;
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(await screen.findByRole("heading", { name: "Review this launch" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Refresh the selected capacity and review this launch.",
    );
    expect(JSON.parse(
      window.sessionStorage.getItem("hivra.launch-draft.v1") || "{}",
    )).toMatchObject({ launchRequestId: requestId, launchState: "idle", submittedDeployment: null });
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
    chooseResource("Agent");
    chooseProfile("Codex");
    const ownInfrastructure = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(ownInfrastructure).toBeEnabled());
    fireEvent.click(ownInfrastructure);
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    const receiptClock = jest.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(30_001);
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
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

  it("honors an explicit fresh computer launch instead of reopening an idle agent draft", async () => {
    const first = render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseResource("Agent");
    expect(screen.getByRole("heading", { name: "Choose an agent" })).toBeInTheDocument();
    first.unmount();

    searchParamsGetMock.mockImplementation((key: string) => {
      if (key === "start") return "1";
      if (key === "kind") return "computer";
      return null;
    });
    render(<LaunchPage />);

    expect(await screen.findByRole("heading", { name: "Choose an operating system" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Choose an agent" })).not.toBeInTheDocument();
  });

  it("restores the non-secret draft and stable request identity after a refresh", async () => {
    const first = render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseResource("Agent");
    chooseProfile("Codex");
    await waitFor(() => expect(screen.getByText("Recommended · 1.5 CPU / 3 GB reserved · up to 2 CPU / 4 GB")).toBeInTheDocument());
    const stored = JSON.parse(window.sessionStorage.getItem("hivra.launch-draft.v1") || "{}");
    first.unmount();

    render(<LaunchPage />);
    expect(await screen.findByRole("heading", { name: "Where should Codex run?" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("launch-primary-action"));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(createAgentMock).toHaveBeenCalled());
    expect(createAgentMock.mock.calls[0][0].launchRequestId).toBe(stored.launchRequestId);
    expect(stored).not.toHaveProperty("apiKey");
  });

  it("preserves name, custom resources, target, and request identity when reselecting the same choices after Back", async () => {
    infrastructureTargets = [PROXMOX_TARGET];
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseResource("Agent");
    chooseProfile("Codex");
    const ownInfrastructure = await screen.findByRole("button", { name: /My infrastructure/i });
    await waitFor(() => expect(ownInfrastructure).toBeEnabled());
    fireEvent.click(ownInfrastructure);
    fireEvent.change(screen.getByRole("textbox", { name: "Agent name" }), { target: { value: "STUDIO_CODEX" } });
    fireEvent.click(within(screen.getByLabelText("Reserved CPU")).getByRole("button", { name: "4 CPU" }));
    fireEvent.click(within(screen.getByLabelText("Reserved memory")).getByRole("button", { name: "8 GB" }));
    const saved = JSON.parse(window.sessionStorage.getItem("hivra.launch-draft.v1") || "{}");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expectCurrentStep("Choose");
    chooseProfile("Codex");
    expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue("STUDIO_CODEX");
    expect(screen.getByText("Selected · 4 CPU / 8 GB reserved · up to 4 CPU / 8 GB")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    chooseResource("Agent");
    chooseProfile("Codex");
    expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue("STUDIO_CODEX");
    expect(screen.getByRole("button", { name: /My infrastructure/i })).toHaveAttribute("aria-pressed", "true");
    expect(JSON.parse(window.sessionStorage.getItem("hivra.launch-draft.v1") || "{}")).toMatchObject({
      launchRequestId: saved.launchRequestId,
      name: "STUDIO_CODEX",
      capacity: { mode: "self-managed", targetId: PROXMOX_TARGET.id },
      resources: { cpu: 4, ram: 8, source: "custom" },
    });
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it("keeps the name before placement and leaves the final action in the active step", async () => {
    render(<LaunchPage />);
    await screen.findByRole("heading", { name: "What do you want to launch?" });
    chooseResource("Computer");
    chooseProfile("Ubuntu Desktop");
    await waitFor(() => expect(screen.getByTestId("launch-primary-action")).toBeEnabled());
    const name = screen.getByRole("textbox", { name: "Computer name" });
    const destination = screen.getByRole("region", { name: "Where it runs" });
    expect(name.compareDocumentPosition(destination) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const configure = screen.getByRole("region", { name: "Where should Ubuntu Desktop run?" });
    expect(within(configure).getByRole("button", { name: "Review launch" })).toBeInTheDocument();
  });
});
