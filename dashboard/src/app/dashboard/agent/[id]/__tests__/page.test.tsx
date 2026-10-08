/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SURFACE_NATIVE_START_LIMIT_MS } from "@/components/hivra/useSurfaceBootstrap";
import { NativeWorkspaceProvider } from "@/components/layout/NativeWorkspaceBridge";
import { refreshDesktopCapability, resetDesktopSessionLaneForTests } from "@/lib/remote-computers/desktop-session-lane";
import { lastTabFor, listRecents, recordVisit } from "@/lib/workspace/recents";
import { resetResourceInventory, resourceInventory } from "@/lib/workspace/resource-inventory";
import { manageCapabilitiesFor } from "@/lib/hivra/manage-capabilities";
import { SETTLED_AGENT_POLL_MS } from "@/lib/hivra/agent-status-poll";

const { renderToString } = jest.requireActual("react-dom/server.node") as typeof import("react-dom/server");

const pushMock = jest.fn();
const mockSearchGet = jest.fn();
const mockGetAgent = jest.fn();
const mockListAgents = jest.fn();
const mockBoxLoginStatus = jest.fn();
const mockChatReadiness = jest.fn();
const mockBrowserStatus = jest.fn();
const mockFetchPlan = jest.fn();
const mockTelegramStatus = jest.fn();
const mockClientWarn = jest.fn();
let mockAgentId = "agent_123";

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: mockAgentId }),
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => ({ get: mockSearchGet }),
}));

jest.mock("@/lib/hivra/hivra-flag", () => ({
  isHivraEnabled: () => true,
}));

jest.mock("@/lib/hivra/chat-readiness", () => ({
  inspectChatReadiness: (...args: unknown[]) => mockChatReadiness(...args),
}));

jest.mock("@/lib/hivra/agent-api", () => ({
  getAgent: (...args: unknown[]) => mockGetAgent(...args),
  listAgents: (...args: unknown[]) => mockListAgents(...args),
  boxLoginStatus: (...args: unknown[]) => mockBoxLoginStatus(...args),
  browserStatus: (...args: unknown[]) => mockBrowserStatus(...args),
  fetchPlanStrict: (...args: unknown[]) => mockFetchPlan(...args),
  telegramStatus: (...args: unknown[]) => mockTelegramStatus(...args),
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: {
    warn: (...args: unknown[]) => mockClientWarn(...args),
  },
}));

jest.mock("@/components/instances/AgentSwitcher", () => ({
  AgentSwitcher: () => <div data-testid="agent-switcher" />,
}));

// Home's list, for the round trip from an agent back through Home.
const mockHomeAgents = jest.fn((): unknown[] => []);
jest.mock("@/components/workspace/useWorkspaceAgents", () => ({
  useWorkspaceAgents: () => ({
    agents: mockHomeAgents(), loading: false, hermesError: null, hivraError: null, lastRefreshedAt: null,
    retryHermes: async () => undefined, retryHivra: async () => undefined, retryAll: async () => undefined,
  }),
}));

const mockChatMounts = jest.fn();
jest.mock("@/components/hivra/HivraChat", () => ({
  HivraChat: function MockHivraChat() {
    const { useEffect } = jest.requireActual<typeof import("react")>("react");
    useEffect(() => { mockChatMounts(); }, []);
    return <div>Chat panel</div>;
  },
}));

jest.mock("@/components/hivra/DigitalOceanAgentWorkspace", () => ({
  DigitalOceanAgentWorkspace: ({ agentId, firstTask, onDeleted, onChanged }: { agentId: string; firstTask?: string | null; onDeleted: () => void; onChanged?: () => void }) => (
    <div>
      <span>DigitalOcean session {agentId}{firstTask ? ` · first task: ${firstTask}` : ""}</span>
      <button type="button" onClick={onDeleted}>Session deleted</button>
      <button type="button" onClick={onChanged}>Session renamed</button>
    </div>
  ),
}));

jest.mock("@/components/hivra/HivraLogin", () => ({
  HivraLogin: () => <div>Login panel</div>,
}));

jest.mock("@/components/hivra/HivraFiles", () => ({
  HivraFiles: ({ workspaceRoot }: { workspaceRoot?: boolean }) => (
    <div data-workspace-root={String(Boolean(workspaceRoot))}>Files panel</div>
  ),
}));
jest.mock("@/components/hivra/HivraProviderWorkspace", () => ({
  HivraProviderWorkspace: ({ computerId, surface, active }: { computerId: string; surface: string; active: boolean }) =>
    <div data-testid={`provider-workspace-${surface}`} hidden={!active}>{computerId}</div>,
}));

jest.mock("@/components/hivra/HivraSkills", () => ({
  HivraSkills: () => <div>Skills panel</div>,
}));

jest.mock("@/components/hivra/HivraTelegram", () => ({
  HivraTelegram: () => <div>Telegram panel</div>,
}));

jest.mock("@/components/hivra/HivraManage", () => ({
  HivraManage: ({ agent, plan, onChanged, onDestroyed, onConnectionServiceRestarted, chatReadiness }: {
    agent?: { manage?: { power?: { stop?: { state?: string } } } };
    plan?: { usage?: { usedCpu: number } } | null;
    onChanged: () => void;
    onDestroyed: () => void;
    onConnectionServiceRestarted?: () => void;
    chatReadiness?: string | null;
  }) => <>
    <div>Manage panel</div>
    <output data-testid="manage-usage">{plan?.usage?.usedCpu ?? "unknown"}</output>
    <output data-testid="manage-stop">{agent?.manage?.power?.stop?.state ?? "unknown"}</output>
    <output data-testid="manage-sign-in">{chatReadiness ?? "unknown"}</output>
    {/* Uncontrolled: it keeps what was typed only while Manage stays mounted. */}
    <input aria-label="Manage draft" />
    <button onClick={onChanged}>Refresh capacity</button>
    <button onClick={onDestroyed}>Agent deleted</button>
    {/* Stands in for a finished in-place connection-service update. */}
    <button onClick={() => { onConnectionServiceRestarted?.(); onChanged(); }}>Finish connection update</button>
  </>,
}));

jest.mock("@/components/hivra/HivraRemoteDesktop", () => ({
  HivraRemoteDesktop: ({ name, active, autoPrepare }: { name: string; active?: boolean; autoPrepare?: boolean }) => (
    <div data-testid="remote-desktop" data-autoprepare={String(Boolean(autoPrepare))} hidden={!active}>{name} desktop session</div>
  ),
}));

jest.mock("@/components/hivra/HivraConsoleDesktop", () => ({
  HivraConsoleDesktop: ({ active }: { active: boolean }) =>
    <iframe data-testid="windows-desktop" title="Windows desktop" hidden={!active} />,
}));

// An agent added to a computer (design 5.8): the page reads it from the
// computer's attach gate. Elsewhere the gate is not offered.
const mockFetchAttachGate = jest.fn();
jest.mock("@/lib/agent-computers/attach-client", () => ({
  ...jest.requireActual("@/lib/agent-computers/attach-client"),
  fetchAttachGate: (...args: unknown[]) => mockFetchAttachGate(...args) ?? Promise.resolve({ state: "not_offered" }),
}));
jest.mock("@/components/hivra/AttachedAgentChat", () => ({
  ...jest.requireActual("@/components/hivra/AttachedAgentChat"),
  AttachedAgentChat: ({ agentName, installationId, chatUrl }: { agentName: string; installationId: string; chatUrl: string }) =>
    <div data-testid="attached-chat">{agentName} {installationId} via {chatUrl}</div>,
}));

// Keep the component's build-time flag false so these tests exercise the same
// hostname-resolved hydration path as Canary, independent of the caller's env.
const previousHivraEnv = process.env.NEXT_PUBLIC_HIVRA_AGENTS;
delete process.env.NEXT_PUBLIC_HIVRA_AGENTS;
const AgentPage = jest.requireActual("../page").default as typeof import("../page").default;
const { FleetControlPane } = jest.requireActual("@/components/hivra/FleetControlPane") as typeof import("@/components/hivra/FleetControlPane");
if (previousHivraEnv === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AGENTS;
else process.env.NEXT_PUBLIC_HIVRA_AGENTS = previousHivraEnv;

// A running Proxmox Ubuntu computer with its workspace connection up.
const CONNECTED_UBUNTU = {
  id: "agent_123", type: "linux-desktop", computer_profile: "ubuntu-desktop",
  name: "UBUNTU", status: "running", cpu: 2, ram: 4,
  chat_url: "https://box.example.com", api_token: "box-token", computer_substrate: "proxmox-kvm",
};

// Agent pages group their surfaces as Agent · Computer · Manage, each view a
// tab in its group's row; computers keep one flat bar with a Tools menu.
// Reach a surface the way an owner does: its tab, then its group, then Tools.
const GROUP_OF_LABEL: Record<string, string> = {
  Terminal: "Computer", Files: "Computer", Browser: "Computer", Git: "Computer",
  "Claude Code session": "Agent", "Codex session": "Agent",
  Skills: "Manage", Telegram: "Manage",
};
function groupFor(name: string | RegExp): string | null {
  const label = Object.keys(GROUP_OF_LABEL).find((candidate) => typeof name === "string" ? candidate === name : name.test(candidate));
  return label ? GROUP_OF_LABEL[label] : null;
}
/** Not hidden by any ancestor: what the owner can actually see. */
function shownToOwner(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if ((node as HTMLElement).hidden || style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}
function getSurfaceButton(name: string | RegExp) {
  const tab = screen.queryByRole("tab", { name });
  if (tab) return tab;
  const visible = screen.queryByRole("button", { name });
  if (visible) return visible;
  const group = groupFor(name);
  const groupButton = group ? screen.queryByRole("button", { name: group }) : null;
  if (groupButton) {
    fireEvent.click(groupButton);
    return screen.getByRole("tab", { name });
  }
  fireEvent.click(screen.getByRole("button", { name: /^Tools(?:$|:)/ }));
  return screen.getByRole("button", { name });
}

async function findSurfaceButton(name: string | RegExp) {
  await screen.findByRole("navigation", { name: "Resource surfaces" });
  return getSurfaceButton(name);
}

describe("AgentPage", () => {
  let requestSubmit: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Desktop proofs are shared per tab; each test is a new tab.
    resetDesktopSessionLaneForTests();
    window.history.replaceState(null, "", "/dashboard/agent/agent_123");
    mockAgentId = "agent_123";
    requestSubmit = jest.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => undefined);
    window.localStorage.clear();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, agentKind: "claude", surfaceAuth: "post-cookie-v1" }),
    }) as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_HIVRA_AGENTS = "1";
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      status: "running",
      cpu: 2,
      ram: 4,
      chat_url: "https://box.example.com",
      api_token: "box-token",
    });
    mockListAgents.mockResolvedValue([]);
    mockBoxLoginStatus.mockResolvedValue({ loggedIn: true });
    mockChatReadiness.mockImplementation(async () => (await mockBoxLoginStatus()).loggedIn ? "native_connected" : "sign_in_required");
    mockBrowserStatus.mockResolvedValue({ enabled: false, error: null });
    mockFetchPlan.mockResolvedValue({
      subscribed: false,
      name: "Free",
      key: "free",
      maxAgents: 1,
      maxCpuPerAgent: 0.5,
      maxRamPerAgent: 1,
      poolCpu: 0.5,
      poolRam: 1,
    });
    // Default: connected → the channel nudge stays out of unrelated tests.
    mockTelegramStatus.mockResolvedValue({ connected: true, active: true, ownerId: "1" });
    mockSearchGet.mockReturnValue(null);
  });

  it("shows honest status freshness across a failed provisioning poll and recovery", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-05T05:00:00Z"));
    const pending = {
      id: "agent_123", type: "linux-desktop", computer_profile: "ubuntu-desktop",
      name: "COLD_UBUNTU", status: "provisioning", activity: "provision",
      provisioned_at: null, cpu: 2, ram: 4, computer_substrate: "proxmox-kvm",
    };
    mockGetAgent.mockResolvedValueOnce(pending).mockResolvedValueOnce(null).mockResolvedValue(pending);
    try {
      render(<AgentPage />);
      await screen.findByText(/Last status response:/);
      const firstResponse = document.querySelector("time")?.getAttribute("datetime") ?? "";
      expect(Date.parse(firstResponse)).toBe(Date.now());
      expect(screen.getByText(/This is a status check, not installation progress/)).toBeVisible();
      await act(async () => { jest.advanceTimersByTime(5000); });
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t get the latest status");
      expect(screen.getByRole("alert")).toHaveTextContent("This does not mean setup failed");
      expect(document.querySelector("time")).toHaveAttribute("datetime", firstResponse);
      expect(screen.queryByText("Agent not found.")).not.toBeInTheDocument();
      await act(async () => { jest.advanceTimersByTime(5000); });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(document.querySelector("time")).toHaveAttribute("datetime", new Date(Date.parse(firstResponse) + 10000).toISOString());
    } finally {
      mockGetAgent.mockReset();
      jest.useRealTimers();
    }
  });

  it("shows the truthful customer-host Windows installation handoff without opening RDP", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "linux-desktop", computer_profile: "windows",
      deployment_mode: "self-managed", computer_substrate: "proxmox-kvm",
      name: "MY_WINDOWS_DESKTOP", status: "provisioning", vmid: 208, cpu: 4, ram: 8,
    });
    const view = render(<AgentPage />);
    expect(await screen.findByText("Finish Windows setup on your Proxmox host")).toBeVisible();
    expect(screen.getByText(/created and started VM 208/)).toBeVisible();
    expect(screen.getByText(/customer-host RDP enrolment are not implemented yet/)).toBeVisible();
    expect(screen.queryByTestId("windows-desktop")).not.toBeInTheDocument();
    view.unmount();
  });

  it("renders neutral feedback until the hostname feature flag resolves after hydration", () => {
    const serverMarkup = renderToString(<AgentPage />);

    expect(serverMarkup).toContain("Checking availability…");
    expect(serverMarkup).not.toContain("This preview isn");
  });

  it.each(["Manage", "Open Manage"])("shows observed provider readiness and opens %s during installation", async button => {
    mockGetAgent.mockResolvedValue({ id: "agent_123", type: "codex", name: "CLOUD_AGENT", cpu: 2, ram: 4,
      status: "provisioning", activity: "provision", computer_substrate: "provider-vm", deployment_mode: "self-managed",
      readiness_stage: "public_access_pending" });
    render(<AgentPage />);
    await screen.findByText(/public connection has not passed verification yet/);
    fireEvent.click(screen.getByRole("button", { name: button }));
    expect(screen.getByText("Manage panel")).toBeInTheDocument();
    expect(screen.queryByText("Chat panel")).not.toBeInTheDocument();
  });

  it("keeps Manage mounted, with its drafts, while the owner uses Chat", async () => {
    render(<AgentPage />);
    expect(await screen.findByText("Chat panel")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^manage$/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Manage draft" }), { target: { value: "unsaved size" } });
    await waitFor(() => expect(screen.getByTestId("manage-sign-in")).toHaveTextContent("native_connected"));

    fireEvent.click(screen.getByRole("button", { name: /^agent$/i }));
    expect(screen.getByText("Manage panel")).not.toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Manage draft" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^manage$/i }));
    expect(screen.getByRole("textbox", { name: "Manage draft" })).toHaveValue("unsaved size");
    expect(screen.getByText("Manage panel")).toBeVisible();
  });

  // Regression: while a Proxmox computer was being set up, every tab showed the
  // setup progress, so Manage (and Delete) could not be reached.
  it("opens Manage while a Proxmox computer is still being set up, after landing on its progress", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "linux-desktop", computer_profile: "ubuntu-desktop", name: "NEW_UBUNTU",
      status: "provisioning", activity: "provision", provisioned_at: null, cpu: 2, ram: 4,
      computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed",
    });
    render(<AgentPage />);
    expect(await screen.findByText(/Setting up NEW_UBUNTU/)).toBeVisible();
    expect(screen.queryByText("Manage panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Manage" }));
    expect(screen.getByText("Manage panel")).toBeVisible();
    expect(screen.queryByText(/Setting up NEW_UBUNTU/)).not.toBeInTheDocument();
  });

  it("opens Manage straight away from the launch's Open it to delete link to a computer being set up", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "linux-desktop", computer_profile: "ubuntu-desktop", name: "NEW_UBUNTU",
      status: "provisioning", activity: "provision", provisioned_at: null, cpu: 2, ram: 4,
      computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed",
    });
    // LaunchJourney's link: ?tab=manage&section=advanced#danger.
    mockSearchGet.mockImplementation((key: string) => ({ tab: "manage", section: "advanced" } as Record<string, string>)[key] ?? null);
    render(<AgentPage />);
    expect(await screen.findByText("Manage panel")).toBeVisible();
    expect(screen.queryByText(/Setting up NEW_UBUNTU/)).not.toBeInTheDocument();
  });

  // Regression: a launch's own landing (?tab=manage) replaced the setup
  // progress with settings that can't be used until setup finishes.
  it("keeps the Codex model-key launch on its setup progress and While you wait, then opens Model & tools once it is ready", async () => {
    jest.useFakeTimers();
    try {
      const provisioning = {
        id: "agent_123", type: "codex", name: "NEW_CODEX", status: "provisioning", activity: "provision",
        provisioned_at: null, cpu: 2, ram: 4, chat_url: null, api_token: null,
      };
      mockGetAgent.mockResolvedValueOnce(provisioning).mockResolvedValue({ ...provisioning, status: "running", activity: null,
        provisioned_at: "2026-09-25T10:00:00Z", chat_url: "https://box.example.com", api_token: "box-token" });
      // launchResultHref for Codex with a model key: ?welcome=1&tab=manage&section=model#model-settings.
      mockSearchGet.mockImplementation((key: string) => ({ welcome: "1", tab: "manage", section: "model" } as Record<string, string>)[key] ?? null);
      render(<AgentPage />);
      expect(await screen.findByText("While you wait")).toBeInTheDocument();
      expect(screen.getByText(/Setting up NEW_CODEX/)).toBeVisible();
      expect(screen.queryByText("Manage panel")).not.toBeInTheDocument();
      await act(async () => { jest.advanceTimersByTime(5000); });
      expect(screen.getByText("Manage panel")).toBeVisible();
      expect(screen.queryByText("While you wait")).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it("opens Manage from the Codex launch's setup progress when the owner asks for it", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "codex", name: "NEW_CODEX", status: "provisioning", activity: "provision",
      provisioned_at: null, cpu: 2, ram: 4, chat_url: null, api_token: null,
    });
    mockSearchGet.mockImplementation((key: string) => ({ welcome: "1", tab: "manage", section: "model" } as Record<string, string>)[key] ?? null);
    render(<AgentPage />);
    expect(await screen.findByText("While you wait")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Manage" }));
    expect(screen.getByText("Manage panel")).toBeVisible();
    expect(screen.queryByText("While you wait")).not.toBeInTheDocument();
  });

  it.each([
    ["the Linux Sandbox launch", { tab: "manage" }],
    ["the computers list", { tab: "manage" }],
    ["a remembered visit", {}],
  ])("keeps a Linux Sandbox being set up on its progress when opened from %s", async (_from, params: Record<string, string>) => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "linux-terminal", computer_profile: "linux-terminal", name: "SANDBOX",
      status: "provisioning", activity: "provision", provisioned_at: null, cpu: 1, ram: 1,
      computer_substrate: "gvisor", deployment_mode: "hivra-managed", chat_url: null, api_token: null,
    });
    // A Linux Sandbox always lands on Manage, so its visits are recorded there.
    recordVisit("x-agent_123", "manage");
    mockSearchGet.mockImplementation((key: string) => params[key] ?? null);
    render(<AgentPage />);
    expect(await screen.findByText(/Setting up SANDBOX/)).toBeVisible();
    expect(screen.queryByText("Manage panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Manage" }));
    expect(screen.getByText("Manage panel")).toBeVisible();
  });

  // Regression: the page read a computer again only while it was being set
  // up, so controls blocked by an operation it didn't start (a desktop
  // preparation) stayed blocked after it finished, until a reload.
  it("reads the computer again while another operation runs, so Manage's controls come back without a reload", async () => {
    jest.useFakeTimers();
    try {
      const row = {
        id: "agent_123", type: "claude-code", name: "CLAUDE_CODE_AGENT", status: "running", cpu: 2, ram: 4,
        chat_url: "https://box.example.com", api_token: "box-token", computer_substrate: "proxmox-kvm",
        deployment_mode: "hivra-managed", infrastructure_binding_token_enforced: true,
      };
      const leased = { ...row, operation_id: "op-1", operation_kind: "desktop_prepare" };
      mockGetAgent
        .mockResolvedValueOnce({ ...row, manage: manageCapabilitiesFor(leased, { preparedMatch: false }) })
        .mockResolvedValue({ ...row, manage: manageCapabilitiesFor(row, { preparedMatch: false }) });
      mockSearchGet.mockImplementation((key: string) => key === "tab" ? "manage" : null);
      render(<AgentPage />);
      expect(await screen.findByTestId("manage-stop")).toHaveTextContent("blocked");
      await act(async () => { jest.advanceTimersByTime(5000); });
      expect(screen.getByTestId("manage-stop")).toHaveTextContent("available");
      const reads = mockGetAgent.mock.calls.length;
      // Nothing is running any more: it drops to the slow settled cadence.
      await act(async () => { jest.advanceTimersByTime(SETTLED_AGENT_POLL_MS - 1); });
      expect(mockGetAgent.mock.calls.length).toBe(reads);
      await act(async () => { jest.advanceTimersByTime(1); });
      expect(mockGetAgent.mock.calls.length).toBe(reads + 1);
    } finally {
      jest.useRealTimers();
    }
  });

  // Reproduced on Canary 2026-09-25 (1c8d40ce): the page read Error, stopped
  // reading, and a Start sent from outside it sat at provisioning/start with no
  // read to complete it until the page was reloaded.
  it("keeps reading a settled Error computer, so a Start sent elsewhere is completed without a reload", async () => {
    jest.useFakeTimers();
    try {
      const row = {
        id: "agent_123", type: "claude-code", name: "CLAUDE_CODE_AGENT",
        cpu: 2, ram: 4, vmid: 1112, computer_substrate: "proxmox-kvm", provisioned_at: "2026-09-12T08:30:00Z",
        chat_url: "https://box.example.com", api_token: "box-token",
      };
      mockGetAgent
        .mockResolvedValueOnce({ ...row, status: "error", error: "Choose Restart in Manage to try again." })
        .mockResolvedValueOnce({ ...row, status: "provisioning", activity: "start", error: null })
        .mockResolvedValue({ ...row, status: "running", error: null });
      render(<AgentPage />);
      expect(await screen.findByText("Computer isn’t ready")).toBeVisible();
      expect(screen.queryByText("Provisioning failed")).not.toBeInTheDocument();
      expect(mockGetAgent).toHaveBeenCalledTimes(1);
      await act(async () => { jest.advanceTimersByTime(SETTLED_AGENT_POLL_MS); });
      expect(mockGetAgent).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Computer isn’t ready")).not.toBeInTheDocument();
      // Converging again: the fast read that completes the Start.
      await act(async () => { jest.advanceTimersByTime(5000); });
      expect(mockGetAgent).toHaveBeenCalledTimes(3);
    } finally {
      mockGetAgent.mockReset();
      jest.useRealTimers();
    }
  });

  it("pauses settled reads while the tab is hidden and reads at once when it is shown again", async () => {
    jest.useFakeTimers();
    const visibility = jest.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      mockGetAgent.mockResolvedValue({
        id: "agent_123", type: "claude-code", name: "CLAUDE_CODE_AGENT", status: "stopped", cpu: 2, ram: 4,
        chat_url: "https://box.example.com", api_token: "box-token",
      });
      render(<AgentPage />);
      await screen.findAllByText(/stopped/i);
      await act(async () => { jest.advanceTimersByTime(SETTLED_AGENT_POLL_MS * 3); });
      expect(mockGetAgent).toHaveBeenCalledTimes(1);
      visibility.mockReturnValue("visible");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(mockGetAgent).toHaveBeenCalledTimes(2);
    } finally {
      visibility.mockRestore();
      mockGetAgent.mockReset();
      jest.useRealTimers();
    }
  });

  it("opens Manage from the Windows setup handoff on the owner's own server", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "linux-desktop", computer_profile: "windows", deployment_mode: "self-managed",
      computer_substrate: "proxmox-kvm", name: "MY_WINDOWS_DESKTOP", status: "provisioning", vmid: 208, cpu: 4, ram: 8,
    });
    render(<AgentPage />);
    expect(await screen.findByText("Finish Windows setup on your Proxmox host")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open Manage" }));
    expect(screen.getByText("Manage panel")).toBeVisible();
    expect(screen.queryByText("Finish Windows setup on your Proxmox host")).not.toBeInTheDocument();
  });

  it("opens a DigitalOcean agent in its session workspace, never the box chat or login", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent_123", type: "claude-code", name: "DO_AGENT", cpu: 2, ram: 4,
      status: "running", computer_substrate: "do-managed-session", deployment_mode: "self-managed", chat_url: null,
      first_task: "Summarize the repo" });
    render(<AgentPage />);
    // The workspace gets the launch's first task, so an unsent one is offered back.
    expect(await screen.findByText("DigitalOcean session agent_123 · first task: Summarize the repo")).toBeInTheDocument();
    expect(screen.queryByText("Chat panel")).not.toBeInTheDocument();
    expect(screen.queryByText("Login panel")).not.toBeInTheDocument();
    expect(mockBrowserStatus).not.toHaveBeenCalled();
  });

  it("opens Chat for a guest-confirmed provider without demanding native sign-in", async () => {
    mockChatReadiness.mockResolvedValue("provider_configured");
    render(<AgentPage />);
    expect(await screen.findByText("Chat panel")).toBeInTheDocument();
    expect(screen.queryByText("Login panel")).not.toBeInTheDocument();
  });
  it("shows a recoverable live connection check error rather than a false login prompt", async () => {
    mockChatReadiness.mockResolvedValueOnce("unavailable").mockResolvedValue("provider_configured");
    render(<AgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Check connection" }));
    expect(await screen.findByText("Chat panel")).toBeInTheDocument();
    expect(screen.queryByText("Login panel")).not.toBeInTheDocument();
  });
  it("does not open Chat for an older guest that can save a key but cannot speak Responses", async () => {
    mockChatReadiness.mockResolvedValue("upgrade_required");
    render(<AgentPage />);
    expect(await screen.findByText("This computer needs a Chat update")).toBeInTheDocument();
    expect(screen.getByText(/Open Manage and choose Update connection service \(the computer keeps running\)/)).toBeInTheDocument();
    expect(screen.queryByText("Chat panel")).not.toBeInTheDocument();
    expect(screen.queryByText("Login panel")).not.toBeInTheDocument();
  });

  it("lets native chrome select existing surfaces while preserving connection guards, never a Desktop on an agent", async () => {
    const host = window as Window & { __HIVRA_NATIVE_WORKSPACE__?: unknown; webkit?: unknown };
    const postMessage = jest.fn();
    host.__HIVRA_NATIVE_WORKSPACE__ = { version: 1 };
    host.webkit = { messageHandlers: { hivraWorkspace: { postMessage } } };
    mockChatReadiness.mockResolvedValue("upgrade_required");
    const view = render(<NativeWorkspaceProvider enabled pathname="/dashboard/agent/agent_123" ownerKey="user_123"><AgentPage /></NativeWorkspaceProvider>);
    try {
      expect(await screen.findByText("This computer needs a Chat update")).toBeInTheDocument();
      expect(screen.queryByText("Chat panel")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Back to agents" })).not.toBeInTheDocument();
      expect(screen.queryByRole("navigation", { name: "Resource surfaces" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Export data" })).toHaveAttribute("href", "/api/hivra/agents/agent_123/export");
      const select = (id: string) => act(() => { window.dispatchEvent(new CustomEvent("hivra:select-surface", { detail: { pathname: "/dashboard/agent/agent_123", id } })); });
      // A CLI agent has no desktop: the desktop service refuses agent resources.
      select("desktop");
      expect(screen.getByText("This computer needs a Chat update")).toBeInTheDocument();
      expect(screen.queryByTestId("remote-desktop")).not.toBeInTheDocument();
      select("manage");
      expect(await screen.findByText("Manage panel")).toBeInTheDocument();
      expect(screen.queryByTestId("remote-desktop")).not.toBeInTheDocument();
      expect(JSON.stringify(postMessage.mock.calls)).not.toMatch(/box-token|box\.example\.com/);
    } finally {
      view.unmount();
      delete host.__HIVRA_NATIVE_WORKSPACE__;
      delete host.webkit;
    }
  });

  it("lets native chrome switch a computer away from Desktop and back without a new session", async () => {
    const host = window as Window & { __HIVRA_NATIVE_WORKSPACE__?: unknown; webkit?: unknown };
    host.__HIVRA_NATIVE_WORKSPACE__ = { version: 1 };
    host.webkit = { messageHandlers: { hivraWorkspace: { postMessage: jest.fn() } } };
    mockGetAgent.mockResolvedValue(CONNECTED_UBUNTU);
    const view = render(<NativeWorkspaceProvider enabled pathname="/dashboard/agent/agent_123" ownerKey="user_123"><AgentPage /></NativeWorkspaceProvider>);
    try {
      const desktop = await screen.findByTestId("remote-desktop");
      expect(desktop).toBeVisible();
      const select = (id: string) => act(() => { window.dispatchEvent(new CustomEvent("hivra:select-surface", { detail: { pathname: "/dashboard/agent/agent_123", id } })); });
      select("manage");
      expect(await screen.findByText("Manage panel")).toBeInTheDocument();
      expect(screen.getByTestId("remote-desktop")).toBe(desktop);
      expect(desktop).not.toBeVisible();
      select("desktop");
      expect(screen.getByTestId("remote-desktop")).toBe(desktop);
      expect(desktop).toBeVisible();
    } finally {
      view.unmount();
      delete host.__HIVRA_NATIVE_WORKSPACE__;
      delete host.webkit;
    }
  });

  it.each([
    { type: "claude-code", name: "CLAUDE_CODE_AGENT", landing: "Chat panel" },
    { type: "codex", name: "CODEX_AGENT", landing: "Chat panel" },
  ])("never offers Desktop on a $type agent", async ({ type, name, landing }) => {
    mockGetAgent.mockResolvedValue({ id: "agent_123", type, name, status: "running", cpu: 2, ram: 4,
      chat_url: "https://box.example.com", api_token: "box-token", computer_substrate: "proxmox-kvm" });
    render(<AgentPage />);
    expect(await screen.findByText(landing)).toBeInTheDocument();
    await screen.findByRole("navigation", { name: "Resource surfaces" });
    const tools = screen.queryByRole("button", { name: /^Tools(?:$|:)/ });
    if (tools) fireEvent.click(tools);
    expect(screen.queryByRole("button", { name: "Desktop" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("remote-desktop")).not.toBeInTheDocument();
  });

  it("never offers Desktop on a dashboard agent", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent_123", type: "openclaw", name: "OPENCLAW_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: "https://box.example.com", api_token: "box-token", computer_substrate: "proxmox-kvm" });
    render(<AgentPage />);
    expect(await screen.findByRole("button", { name: /^dashboard$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desktop" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("remote-desktop")).not.toBeInTheDocument();
  });

  it("keeps Desktop on a computer and retains its session while switching surfaces", async () => {
    mockGetAgent.mockResolvedValue(CONNECTED_UBUNTU);
    render(<AgentPage />);
    const desktop = await screen.findByTestId("remote-desktop");
    expect(desktop).toBeVisible();
    expect(desktop).toHaveTextContent("UBUNTU desktop session");

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByText("Manage panel")).toBeInTheDocument();
    expect(desktop).not.toBeVisible();
    expect(screen.getByTestId("remote-desktop")).toBe(desktop);

    fireEvent.click(screen.getByRole("button", { name: "Desktop" }));
    expect(screen.getByTestId("remote-desktop")).toBe(desktop);
    expect(desktop).toBeVisible();
  });

  it("lands a stale Desktop link on a CLI agent on Chat and corrects the URL", async () => {
    window.history.replaceState(null, "", "/dashboard/agent/agent_123?hivra=1&tab=desktop#workspace");
    mockSearchGet.mockImplementation((key: string) => new URLSearchParams(window.location.search).get(key));
    render(<AgentPage />);
    expect(await screen.findByText("Chat panel")).toBeVisible();
    expect(screen.queryByTestId("remote-desktop")).not.toBeInTheDocument();
    expect(screen.queryByText("Not ready")).not.toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("tab")).toBe("chat"));
    expect(new URLSearchParams(window.location.search).get("hivra")).toBe("1");
    expect(window.location.hash).toBe("#workspace");
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/remote-desktop"), expect.anything());
  });

  it("lands a stale Desktop link on a dashboard agent on its dashboard", async () => {
    window.history.replaceState(null, "", "/dashboard/agent/agent_123?tab=desktop");
    mockSearchGet.mockImplementation((key: string) => new URLSearchParams(window.location.search).get(key));
    mockGetAgent.mockResolvedValue({ id: "agent_123", type: "openclaw", name: "OPENCLAW_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: "https://box.example.com", api_token: "box-token", computer_substrate: "proxmox-kvm" });
    render(<AgentPage />);
    expect(await screen.findByTitle("OpenClaw · dashboard")).toBeInTheDocument();
    expect(screen.queryByTestId("remote-desktop")).not.toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("tab")).toBe("aeon"));
  });

  it.each(["running", "stopped"])("hides Terminal and Files for a %s Windows computer", async status => {
    mockGetAgent.mockResolvedValue({ id: "agent_123", type: "linux-desktop", computer_profile: "windows",
      name: "WINDOWS", status, cpu: 2, ram: 4,
      chat_url: "https://windows-box.example.com", api_token: "must-not-be-used",
      computer_substrate: "proxmox-kvm" });
    render(<AgentPage />);
    await screen.findByRole("navigation", { name: "Resource surfaces" });
    const tools = screen.queryByRole("button", { name: /^Tools(?:$|:)/ });
    if (tools) fireEvent.click(tools);
    expect(screen.queryByRole("button", { name: "Files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(?:Box )?Terminal$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desktop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage" })).toBeInTheDocument();
    expect(document.querySelector('iframe[title="Terminal"], form[action*="windows-box"]')).toBeNull();
  });

  it("hides Terminal and Files for disconnected Omarchy", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "linux-desktop", computer_profile: "omarchy",
      name: "OMARCHY", status: "running", cpu: 2, ram: 4,
      chat_url: null, api_token: null, computer_substrate: "proxmox-kvm",
    });
    render(<AgentPage />);
    expect(await screen.findByTestId("remote-desktop")).toBeVisible();
    const tools = screen.queryByRole("button", { name: /^Tools(?:$|:)/ });
    if (tools) fireEvent.click(tools);
    expect(screen.queryByRole("button", { name: "Files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
    expect(document.querySelector('iframe[title="Terminal"], form[action*="auth/bootstrap"]')).toBeNull();
  });

  it.each(["omarchy", "ubuntu-desktop"])("hides Terminal and Files for stopped %s even with a retained chat URL", async profile => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "linux-desktop", computer_profile: profile,
      name: "STOPPED_COMPUTER", status: "stopped", cpu: 2, ram: 4,
      chat_url: "https://stale-box.example.com", api_token: "stale-token", computer_substrate: "proxmox-kvm",
    });
    render(<AgentPage />);
    await screen.findByRole("navigation", { name: "Resource surfaces" });
    const tools = screen.queryByRole("button", { name: /^Tools(?:$|:)/ });
    if (tools) fireEvent.click(tools);
    expect(screen.queryByRole("button", { name: "Files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
    expect(document.querySelector('iframe[title="Terminal"], form[action*="stale-box"]')).toBeNull();
  });

  it.each([
    { profile: "windows", tab: "files", chatUrl: "https://windows-box.example.com" },
    { profile: "omarchy", tab: "box", chatUrl: null },
  ])("falls back from an unavailable $tab deep link on running $profile to Desktop", async ({ profile, tab, chatUrl }) => {
    window.history.replaceState(null, "", `/dashboard/agent/agent_123?hivra=1&tab=${tab}&prepare=1#workspace`);
    mockSearchGet.mockImplementation((key: string) => new URLSearchParams(window.location.search).get(key));
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "linux-desktop", computer_profile: profile,
      name: profile.toUpperCase(), status: "running", cpu: 2, ram: 4,
      chat_url: chatUrl, api_token: "must-not-be-used", computer_substrate: "proxmox-kvm",
    });
    render(<AgentPage />);
    const desktop = profile === "windows"
      ? await screen.findByTestId("windows-desktop")
      : await screen.findByTestId("remote-desktop");
    expect(desktop).toBeVisible();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("tab")).toBe("desktop"));
    expect(new URLSearchParams(window.location.search).get("hivra")).toBe("1");
    expect(new URLSearchParams(window.location.search).get("prepare")).toBe("1");
    expect(window.location.hash).toBe("#workspace");
    expect(screen.queryByText(/Use (?:Windows|Files|Terminal)/)).not.toBeInTheDocument();
    expect(document.querySelector('iframe[title="Terminal"], form[action*="auth/bootstrap"]')).toBeNull();
  });

  it("keeps Terminal and Files for a connected Ubuntu computer", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "linux-desktop", computer_profile: "ubuntu-desktop",
      name: "UBUNTU", status: "running", cpu: 2, ram: 4,
      chat_url: "https://box.example.com", api_token: "box-token", computer_substrate: "proxmox-kvm",
    });
    render(<AgentPage />);
    fireEvent.click(await findSurfaceButton("Files"));
    expect(await screen.findByText("Files panel")).toHaveAttribute("data-workspace-root", "true");
    fireEvent.click(getSurfaceButton(/^Terminal$/));
    expect(await screen.findByTitle("Terminal")).toBeVisible();
  });

  it("keeps the selected surface in the URL without reloading or adding history entries", async () => {
    window.history.replaceState(null, "", "/dashboard/agent/agent_123?hivra=1&tab=desktop&prepare=1#workspace");
    mockSearchGet.mockImplementation((key: string) => new URLSearchParams(window.location.search).get(key));
    mockGetAgent.mockResolvedValue(CONNECTED_UBUNTU);
    const initialHistoryLength = window.history.length;
    const first = render(<AgentPage />);
    const desktop = await screen.findByTestId("remote-desktop");
    fireEvent.click(await screen.findByRole("button", { name: "Files" }));
    expect(window.location.pathname).toBe("/dashboard/agent/agent_123");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("files");
    expect(new URLSearchParams(window.location.search).get("hivra")).toBe("1");
    expect(new URLSearchParams(window.location.search).get("prepare")).toBe("1");
    expect(window.location.hash).toBe("#workspace");
    expect(window.history.length).toBe(initialHistoryLength);
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("remote-desktop")).toBe(desktop);
    expect(desktop).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("manage");
    first.unmount();
    render(<AgentPage />);
    expect(await screen.findByText("Manage panel")).toBeInTheDocument();
    expect(screen.getByTestId("remote-desktop")).not.toBeVisible();
  });

  it("follows changed tab deep links while preserving an already opened desktop", async () => {
    let requested = "manage";
    mockSearchGet.mockImplementation((key: string) => key === "tab" ? requested : null);
    mockGetAgent.mockResolvedValue(CONNECTED_UBUNTU);
    const view = render(<AgentPage />);
    expect(await screen.findByText("Manage panel")).toBeInTheDocument();
    requested = "desktop";
    view.rerender(<AgentPage />);
    const desktop = await screen.findByTestId("remote-desktop");
    expect(desktop).toBeVisible();
    requested = "files";
    view.rerender(<AgentPage />);
    expect(await screen.findByText("Files panel")).toBeInTheDocument();
    expect(screen.getByTestId("remote-desktop")).toBe(desktop);
    expect(desktop).not.toBeVisible();
    requested = "not-a-tab";
    view.rerender(<AgentPage />);
    expect(screen.getByText("Files panel")).toBeInTheDocument();
  });

  it.each([null, "unexpected-token-must-not-select-legacy"])("routes provider Ubuntu through grants even with token=%s", async apiToken => {
    mockGetAgent.mockResolvedValue({ id: "agent_123", type: "linux-desktop", computer_profile: "ubuntu-desktop", name: "PROVIDER_UBUNTU",
      cpu: 2, ram: 4, status: "running", computer_substrate: "provider-vm", deployment_mode: "self-managed",
      chat_url: "https://box.hermesos.cloud", api_token: apiToken });
    render(<AgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Files" }));
    const files = screen.getByTestId("provider-workspace-files"), terminal = screen.getByTestId("provider-workspace-box-terminal");
    expect(files).toBeVisible(); expect(terminal).not.toBeVisible();
    expect(screen.queryByText("Files panel")).not.toBeInTheDocument();
    expect(document.querySelector('iframe[src*="/box-terminal"]')).toBeNull();
    fireEvent.click(getSurfaceButton(/^Terminal$/));
    expect(terminal).toBeVisible(); expect(files).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByTestId("provider-workspace-files")).toBe(files); expect(files).toBeVisible();
  });

  it("makes an unavailable provider observation visible without inventing progress", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent_123", type: "codex", name: "CLOUD_AGENT", cpu: 2, ram: 4,
      status: "provisioning", activity: "provision", computer_substrate: "provider-vm", readiness_stage: "verification_unavailable" });
    render(<AgentPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t verify readiness");
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
  });
  it.each([
    ["reboot_pending", "still on its previous boot"],
    ["request_uncertain", "No retry or forced power-off"],
    ["public_access_pending", "public connection has not passed verification"],
  ])("shows factual %s power state and preserves access to Manage", async (stage, message) => {
    mockGetAgent.mockResolvedValue({ id: "agent_123", type: "codex", name: "CLOUD_AGENT", cpu: 2, ram: 4,
      status: "provisioning", activity: "restart", computer_substrate: "provider-vm", power_stage: stage });
    render(<AgentPage />);
    expect(await screen.findByText(new RegExp(message))).toBeInTheDocument();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Manage" }));
    expect(screen.getByText("Manage panel")).toBeInTheDocument();
  });

  afterEach(() => {
    requestSubmit.mockRestore();
  });

  it("groups an agent's surfaces as Agent · Computer · Manage and names its computer (ATT-11, ATT-12)", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent_123", type: "codex", name: "Codex 1", status: "running", cpu: 1.5, ram: 3,
      chat_url: "https://box.example.com", api_token: "box-token", computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed" });
    render(<AgentPage />);
    const nav = await screen.findByRole("navigation", { name: "Resource surfaces" });
    expect(Array.from(nav.querySelectorAll("[data-surface-group]")).map((button) => button.textContent)).toEqual(["Agent", "Computer", "Manage"]);
    expect(within(screen.getByRole("tablist", { name: "Agent views" })).getAllByRole("tab").map((tab) => tab.textContent))
      .toEqual(["Chat", "Codex session"]);
    fireEvent.click(screen.getByRole("button", { name: "Computer" }));
    expect(within(screen.getByRole("tablist", { name: "Computer views" })).getAllByRole("tab").map((tab) => tab.textContent))
      .toEqual(["Terminal", "Files", "Browser", "Git"]);
    expect(screen.getByText("On its own computer (Hivra Cloud · 1.5 CPU / 3 GB)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    // The group is Manage, so its own pane's tab is Settings: no "Manage › Manage".
    expect(within(screen.getByRole("tablist", { name: "Manage views" })).getAllByRole("tab").map((tab) => tab.textContent))
      .toEqual(["Settings", "Skills", "Telegram"]);
    expect(screen.getByText("Manage panel")).toBeInTheDocument();
    // Retired: "Box Terminal", "<Agent> Terminal", the Desktop tab on an agent, and the Tools overflow.
    expect(document.body).not.toHaveTextContent(/Box Terminal|Codex Terminal/);
    expect(screen.queryByRole("button", { name: /^Tools/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Desktop" })).not.toBeInTheDocument();
  });

  it("says Agent once in a chat agent's bar: the group button, not the switcher's caption as well", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent_123", type: "codex", name: "Codex 1", status: "running", cpu: 1.5, ram: 3,
      chat_url: "https://box.example.com", api_token: "box-token", computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed" });
    render(<AgentPage />);
    const nav = await screen.findByRole("navigation", { name: "Resource surfaces" });
    expect(nav.textContent?.match(/Agent/g)).toEqual(["Agent"]);
    const switcher = within(nav).getByRole("button", { name: "Switch agent or computer: Codex 1" });
    expect(switcher).toHaveTextContent(/^Codex 1running$/);
    expect(switcher).toHaveAccessibleDescription("running");
  });

  it("keeps the kind in the switcher's caption where no group button already names it", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent_123", type: "openclaw", name: "OPENCLAW_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: "https://box.example.com", api_token: "box-token", computer_substrate: "proxmox-kvm" });
    const { unmount } = render(<AgentPage />);
    expect(await screen.findByRole("button", { name: "Switch agent or computer: OPENCLAW_AGENT" })).toHaveTextContent("Agent · running");
    unmount();
    mockGetAgent.mockResolvedValue(CONNECTED_UBUNTU);
    render(<AgentPage />);
    expect(await screen.findByRole("button", { name: "Switch agent or computer: UBUNTU" })).toHaveTextContent("Computer · running");
  });

  it("gives a dashboard agent's single-surface groups no second row, with Export data still in reach", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent_123", type: "openclaw", name: "OPENCLAW_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: "https://box.example.com", api_token: "box-token", computer_substrate: "proxmox-kvm" });
    render(<AgentPage />);
    const nav = await screen.findByRole("navigation", { name: "Resource surfaces" });
    expect(Array.from(nav.querySelectorAll("[data-surface-group]")).map((button) => button.textContent)).toEqual(["Dashboard", "Computer", "Manage"]);
    expect(await screen.findByTitle("OpenClaw · dashboard")).toBeInTheDocument();
    // Dashboard and Manage each hold one surface: their buttons open it, and
    // no "Dashboard › Dashboard" or "Manage › Manage" row repeats the name.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByText("Manage panel")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Export data" })).toHaveAttribute("href", "/api/hivra/agents/agent_123/export");
    fireEvent.click(screen.getByRole("button", { name: "Computer" }));
    expect(within(screen.getByRole("tablist", { name: "Computer views" })).getAllByRole("tab").map((tab) => tab.textContent))
      .toEqual(["Terminal", "Files", "Browser"]);
    expect(screen.queryByRole("link", { name: "Export data" })).not.toBeInTheDocument();
  });

  it("keeps the Browser tab exposed for browser-capable agents even when browser automation is off", async () => {
    render(<AgentPage />);

    expect(await findSurfaceButton(/claude code session/i)).toBeInTheDocument();
    await waitFor(() => expect(mockBrowserStatus).toHaveBeenCalledWith("https://box.example.com", "box-token"));

    expect(getSurfaceButton(/^browser$/i)).toBeInTheDocument();
  });

  it.each(["hivra-managed", "self-managed", undefined])("uses runtime-advertised POST bootstrap without a bearer URL for %s ownership", async (deploymentMode) => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      status: "running",
      deployment_mode: deploymentMode,
      cpu: 2,
      ram: 4,
      chat_url: "https://box.example.com",
      api_token: "box-token",
    });

    render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(/claude code session/i));

    const frame = await screen.findByTitle("Claude Code session");
    expect(frame.tagName).toBe("IFRAME");
    const form = frame.parentElement?.querySelector("form");
    expect(frame).not.toHaveAttribute("src");
    expect(form).toHaveAttribute("action", "https://box.example.com/auth/bootstrap");
    expect(form).toHaveAttribute("method", "POST");
    expect(form?.querySelector('input[name="destination"]')).toHaveValue("/terminal/?arg=1");
    expect(form?.querySelector('input[name="token"]')).toHaveValue("box-token");
    expect(screen.getByRole("button", { name: /open in new tab/i })).toBeInTheDocument();
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
    expect(global.fetch).toHaveBeenCalledWith("https://box.example.com/api/meta", {
      cache: "no-store",
      credentials: "omit",
      signal: expect.any(AbortSignal),
    });
    for (const element of document.querySelectorAll("a, iframe, form")) {
      for (const attribute of ["href", "src", "action"]) {
        expect(element.getAttribute(attribute) || "").not.toContain("box-token");
      }
    }

    fireEvent.click(screen.getByRole("button", { name: /open in new tab/i }));
    expect(requestSubmit).toHaveBeenCalledTimes(2);
    const newTabForm = requestSubmit.mock.instances[1] as HTMLFormElement;
    expect(newTabForm).toHaveAttribute("target", "_blank");
    expect(newTabForm).toHaveAttribute("rel", "noopener noreferrer");
    expect(form).toHaveAttribute("target", frame.getAttribute("name"));
    expect(form).not.toHaveAttribute("rel");
  });

  it("requires an explicit runtime update for legacy metadata instead of leaking a URL token", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ agentKind: "claude", model: null }),
    });
    render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(/claude code session/i));

    expect(await screen.findByText("Connection update needed")).toBeInTheDocument();
    expect(screen.getByText(/Open Manage and choose/)).toHaveTextContent("Update connection service");
    expect(screen.getByText(/Open Manage and choose/)).toHaveTextContent("without restarting the computer");
    expect(screen.queryByRole("link", { name: /update the connection service/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open in new tab/i })).toBeDisabled();
    expect(document.querySelector("iframe, form")).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain("box-token");
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { name: "legacy terminal", tab: /claude code session/i, metadata: { agentKind: "claude" }, heading: "Connection update needed" },
    { name: "unreachable box terminal", tab: /^terminal$/i, metadata: null, heading: "Couldn’t verify secure access" },
    { name: "legacy browser", tab: /^browser$/i, metadata: { agentKind: "claude" }, heading: "Connection update needed" },
    { name: "legacy dashboard", tab: /^dashboard$/i, type: "agent-zero", metadata: { agentKind: "agent-zero" }, heading: "Connection update needed" },
  ])("opens Manage directly from the $name without starting an update", async ({ tab, metadata, heading, type }) => {
    if (type) mockGetAgent.mockResolvedValue({
      id: "agent_123", type, name: "AGENT_ZERO", status: "running", cpu: 2, ram: 4,
      chat_url: "https://box.example.com", api_token: "box-token",
    });
    mockBrowserStatus.mockResolvedValue({ enabled: true, error: null });
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => metadata });
    render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(tab));
    // Reaching Browser through Computer opens Terminal first; that surface
    // stays mounted (hidden), so check the heading the owner can see.
    await waitFor(() => expect(screen.getAllByText(heading).filter(shownToOwner)).toHaveLength(1));

    const requestsBeforeNavigation = (global.fetch as jest.Mock).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Open Manage" }));
    expect(await screen.findByText("Manage panel")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(requestsBeforeNavigation);
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(document.querySelector("iframe, form")).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain("box-token");
  });

  it.each([
    { label: "HTTP failure", response: { ok: false, json: async () => ({ surfaceAuth: "post-cookie-v1" }) } },
    { label: "malformed metadata", response: { ok: true, json: async () => null } },
    { label: "invalid JSON", response: { ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } } },
    { label: "unknown metadata", response: { ok: true, json: async () => ({ surfaceAuth: "future-protocol" }) } },
  ])("fails closed on $label and can retry without a bearer URL", async ({ response }) => {
    // The computer answers this way until it is fixed. The page asks when it
    // opens and again when the session opens.
    let metadata: unknown = response;
    (global.fetch as jest.Mock).mockImplementation(async () => metadata);
    render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(/claude code session/i));

    expect(await screen.findByText("Couldn’t verify secure access")).toBeInTheDocument();
    expect(document.querySelector("iframe, form")).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain("box-token");
    expect(requestSubmit).not.toHaveBeenCalled();

    metadata = { ok: true, json: async () => ({ agentKind: "claude", surfaceAuth: "post-cookie-v1" }) };
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTitle("Claude Code session")).toBeInTheDocument();
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
  });

  it("does not fall back to a bearer URL on network failure", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError("Network failed"));
    render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(/claude code session/i));

    expect(await screen.findByText("Couldn’t verify secure access")).toBeInTheDocument();
    expect(document.querySelector("iframe, form")).toBeNull();
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  describe("connection service check", () => {
    const READY = { ok: true, json: async () => ({ agentKind: "claude", surfaceAuth: "post-cookie-v1" }) };
    const metaChecks = () => (global.fetch as jest.Mock).mock.calls.filter(([url]) => url === "https://box.example.com/api/meta").length;

    it("checks the computer as soon as the page opens, before any terminal and without the bearer", async () => {
      render(<AgentPage />);
      await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("https://box.example.com/api/meta", {
        cache: "no-store",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      }));
      expect(document.querySelector("iframe, form")).toBeNull();
      expect(requestSubmit).not.toHaveBeenCalled();
    });

    it("reuses that check for every session tab and terminal instead of asking again", async () => {
      render(<AgentPage />);
      fireEvent.click(await findSurfaceButton(/claude code session/i));
      await screen.findByTitle("Claude Code session");
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByRole("button", { name: "New terminal session" }));
      await screen.findByTitle("Claude Code session · 2");
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(2));
      fireEvent.click(getSurfaceButton("Terminal"));
      await screen.findByTitle("Terminal");
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(3));

      expect(metaChecks()).toBe(1);
    });

    it("does not remember a failed check: opening the session asks again", async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError("Network failed"));
      render(<AgentPage />);
      await waitFor(() => expect(metaChecks()).toBe(1));
      fireEvent.click(await findSurfaceButton(/claude code session/i));

      expect(await screen.findByTitle("Claude Code session")).toBeInTheDocument();
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
      expect(metaChecks()).toBe(2);
    });

    it("asks afresh on Try again, even while another surface's check is still waiting", async () => {
      const answers: Array<() => Promise<unknown>> = [
        async () => { throw new TypeError("Network failed"); }, // when the page opens
        async () => { throw new TypeError("Network failed"); }, // the session
        () => new Promise(() => undefined), // the Terminal, still waiting
      ];
      (global.fetch as jest.Mock).mockImplementation((url: string) =>
        url.endsWith("/api/meta") && answers.length ? answers.shift()!() : Promise.resolve(READY));
      render(<AgentPage />);
      fireEvent.click(await findSurfaceButton(/claude code session/i));
      expect(await screen.findByText("Couldn’t verify secure access")).toBeInTheDocument();
      fireEvent.click(getSurfaceButton("Terminal"));
      expect(await screen.findByText("Connecting securely…")).toBeVisible();

      fireEvent.click(getSurfaceButton(/claude code session/i));
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByTitle("Claude Code session")).toBeInTheDocument();
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
      expect(metaChecks()).toBe(4);
    });
  });

  it.each(["http://box.example.com", "https://user:password@box.example.com", "https://box.example.com?token=secret"])("does not send credentials to an invalid surface base %s", async (chatUrl) => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "claude-code", name: "CLAUDE_CODE_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: chatUrl, api_token: "box-token",
    });
    render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(/claude code session/i));

    expect(await screen.findByText("Couldn’t verify secure access")).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(document.querySelector("iframe, form")).toBeNull();
  });

  it("ignores a stale capability response after the selected computer changes", async () => {
    let resolveOld: (value: unknown) => void = () => undefined;
    (global.fetch as jest.Mock).mockImplementation((url: string) => url === "https://box.example.com/api/meta"
      ? new Promise((resolve) => { resolveOld = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ agentKind: "claude", surfaceAuth: "post-cookie-v1" }) }));
    const view = render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(/claude code session/i));
    expect(await screen.findByText("Connecting securely…")).toBeInTheDocument();
    expect(requestSubmit).not.toHaveBeenCalled();

    mockAgentId = "agent_next";
    mockGetAgent.mockResolvedValue({
      id: "agent_next", type: "claude-code", name: "NEXT_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: "https://next.example.com", api_token: "next-token",
    });
    view.rerender(<AgentPage />);
    // The next agent opens on its own surface, so its session is opened by hand.
    expect(await screen.findByText("NEXT_AGENT")).toBeInTheDocument();
    fireEvent.click(await findSurfaceButton(/claude code session/i));
    const frame = await screen.findByTitle("Claude Code session");
    expect(frame.parentElement?.querySelector("form")).toHaveAttribute("action", "https://next.example.com/auth/bootstrap");
    await act(async () => {
      resolveOld({ ok: true, json: async () => ({ agentKind: "claude" }) });
    });
    expect(screen.queryByText("Connection update needed")).not.toBeInTheDocument();
    expect(frame.parentElement?.querySelector('input[name="token"]')).toHaveValue("next-token");
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });

  it("retains distinct native terminal sessions when switching tabs", async () => {
    render(<AgentPage />);
    expect(document.querySelector("iframe")).toBeNull();
    fireEvent.click(await findSurfaceButton(/claude code session/i));
    const agentFrame = await screen.findByTitle("Claude Code session");
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
    const agentName = agentFrame.getAttribute("name");

    fireEvent.click(getSurfaceButton("Terminal"));
    const boxFrame = await screen.findByTitle("Terminal");
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(2));
    expect(boxFrame).not.toBe(agentFrame);
    expect(boxFrame.getAttribute("name")).not.toBe(agentName);
    expect(agentFrame).toBeInTheDocument();
    expect(agentFrame).not.toBeVisible();
    expect(agentFrame.closest("[inert]")).not.toBeNull();
    expect(boxFrame).toBeVisible();

    fireEvent.click(getSurfaceButton(/claude code session/i));
    expect(screen.getByTitle("Claude Code session")).toBe(agentFrame);
    expect(agentFrame).toBeVisible();
    expect(boxFrame).not.toBeVisible();
    expect(requestSubmit).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(agentFrame).toBeInTheDocument();
    expect(boxFrame).toBeInTheDocument();
    expect(agentFrame).not.toBeVisible();
    expect(boxFrame).not.toBeVisible();
    fireEvent.click(getSurfaceButton("Terminal"));
    expect(screen.getByTitle("Terminal")).toBe(boxFrame);
    expect(boxFrame).toBeVisible();
    expect(requestSubmit).toHaveBeenCalledTimes(2);
  });

  it("opens parallel terminal sessions that each keep their own shell", async () => {
    render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(/claude code session/i));
    const first = await screen.findByTitle("Claude Code session");
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "New terminal session" }));
    const second = await screen.findByTitle("Claude Code session · 2");
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(2));
    expect(second.getAttribute("name")).not.toBe(first.getAttribute("name"));
    expect(second).toBeVisible();
    expect(first).toBeInTheDocument();
    expect(first).not.toBeVisible();
    expect(screen.getByRole("tab", { name: "Session 2" })).toHaveAttribute("aria-selected", "true");

    // Switching back is a view change, not a new shell.
    fireEvent.click(screen.getByRole("tab", { name: "Session 1" }));
    expect(screen.getByTitle("Claude Code session")).toBe(first);
    expect(first).toBeVisible();
    expect(second).not.toBeVisible();
    expect(requestSubmit).toHaveBeenCalledTimes(2);

    // Closing a session drops its frame (ending that process) and keeps the rest.
    fireEvent.click(screen.getByRole("button", { name: "Close session 2" }));
    expect(second).not.toBeInTheDocument();
    expect(first).toBeVisible();
    expect(screen.queryByRole("button", { name: "Close session 1" })).not.toBeInTheDocument();
  });

  it("reopens a tab for every terminal session still running on the computer", async () => {
    const defaultFetch = (global.fetch as jest.Mock).getMockImplementation();
    (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => String(url).includes("/api/terminal/sessions")
      ? Promise.resolve({ ok: true, json: async () => ({ surface: "box", sessions: [{ slot: 1 }, { slot: 3 }] }) })
      : defaultFetch!(url, init));
    render(<AgentPage />);
    await findSurfaceButton(/claude code session/i);
    fireEvent.click(getSurfaceButton("Terminal"));
    await screen.findByTitle("Terminal");
    expect(await screen.findByRole("tab", { name: "Session 3" })).toBeInTheDocument();
    const sessionsCall = (global.fetch as jest.Mock).mock.calls.find(([url]) => String(url).includes("/api/terminal/sessions"));
    expect(sessionsCall![0]).toBe("https://box.example.com/api/terminal/sessions?surface=box");
    expect(sessionsCall![1]).toMatchObject({ credentials: "omit", headers: { Authorization: "Bearer box-token" } });
    fireEvent.click(screen.getByRole("tab", { name: "Session 3" }));
    const third = await screen.findByTitle("Terminal · 3");
    expect(third.parentElement?.querySelector('input[name="destination"]')).toHaveValue("/box-terminal/?arg=3");
  });

  it("ends the session on the computer when its tab is closed", async () => {
    render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(/claude code session/i));
    await screen.findByTitle("Claude Code session");
    fireEvent.click(screen.getByRole("button", { name: "New terminal session" }));
    await screen.findByTitle("Claude Code session · 2");
    fireEvent.click(screen.getByRole("button", { name: "Close session 2" }));
    const closeCall = (global.fetch as jest.Mock).mock.calls.find(([url]) => String(url).endsWith("/api/terminal/sessions/close"));
    expect(closeCall![1]).toMatchObject({ method: "POST", credentials: "omit", headers: { Authorization: "Bearer box-token" } });
    expect(JSON.parse(String(closeCall![1].body))).toEqual({ surface: "agent", slot: 2 });
  });

  it("caps parallel terminal sessions per surface", async () => {
    render(<AgentPage />);
    await findSurfaceButton(/claude code session/i);
    fireEvent.click(getSurfaceButton("Terminal"));
    await screen.findByTitle("Terminal");
    const add = screen.getByRole("button", { name: "New terminal session" });
    for (let i = 0; i < 10; i += 1) fireEvent.click(add);
    // Session tabs only; the Computer views row is its own tablist.
    expect(within(screen.getByRole("tablist", { name: "Terminal sessions" })).getAllByRole("tab")).toHaveLength(8);
    expect(add).toBeDisabled();
  });

  it("keeps the chat mounted while working in other surfaces", async () => {
    mockChatMounts.mockClear();
    render(<AgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Agent" }));
    const chat = await screen.findByText("Chat panel");
    expect(mockChatMounts).toHaveBeenCalledTimes(1);

    fireEvent.click(getSurfaceButton(/claude code session/i));
    await screen.findByTitle("Claude Code session");
    expect(chat).toBeInTheDocument();
    expect(chat).not.toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByText("Chat panel")).toBe(chat);
    expect(chat).toBeVisible();
    expect(mockChatMounts).toHaveBeenCalledTimes(1);
  });

  it("disposes retained terminals immediately when changing computers", async () => {
    const view = render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(/claude code session/i));
    const oldFrame = await screen.findByTitle("Claude Code session");
    mockAgentId = "agent_next";
    mockGetAgent.mockReturnValue(new Promise(() => undefined));
    await act(async () => { view.rerender(<AgentPage />); });
    expect(oldFrame).not.toBeInTheDocument();
    expect(document.querySelector("iframe, form")).toBeNull();
  });

  it("does not retain terminal sessions while the computer is stopped", async () => {
    render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(/claude code session/i));
    const agentFrame = await screen.findByTitle("Claude Code session");
    fireEvent.click(getSurfaceButton("Terminal"));
    const boxFrame = await screen.findByTitle("Terminal");
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "claude-code", name: "CLAUDE_CODE_AGENT", status: "stopped",
      cpu: 2, ram: 4, chat_url: "https://box.example.com", api_token: "box-token",
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh capacity" }));
    await waitFor(() => expect(agentFrame).not.toBeInTheDocument());
    expect(boxFrame).not.toBeInTheDocument();
    fireEvent.click(getSurfaceButton("Terminal"));
    expect(screen.getByText("The computer isn't reachable yet.")).toBeInTheDocument();
    expect(document.querySelector("iframe, form")).toBeNull();
  });

  it("still retries an initial load failure after leaving another computer", async () => {
    jest.useFakeTimers();
    try {
      const view = render(<AgentPage />);
      fireEvent.click(await findSurfaceButton(/claude code session/i));
      const oldFrame = await screen.findByTitle("Claude Code session");
      mockAgentId = "agent_next";
      mockGetAgent.mockResolvedValueOnce(null).mockResolvedValue({
        id: "agent_next", type: "claude-code", name: "NEXT_AGENT", status: "running",
        cpu: 2, ram: 4, chat_url: "https://next.example.com", api_token: "next-token",
      });
      await act(async () => { view.rerender(<AgentPage />); });
      expect(oldFrame).not.toBeInTheDocument();
      await act(async () => { jest.advanceTimersByTime(2000); });
      expect(await screen.findByText("NEXT_AGENT")).toBeInTheDocument();
      fireEvent.click(await findSurfaceButton(/claude code session/i));
      const nextFrame = await screen.findByTitle("Claude Code session");
      expect(nextFrame.parentElement?.querySelector("form")).toHaveAttribute("action", "https://next.example.com/auth/bootstrap");
    } finally {
      jest.useRealTimers();
    }
  });

  it("revalidates rotated credentials before restoring a retained terminal", async () => {
    render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(/claude code session/i));
    const oldFrame = await screen.findByTitle("Claude Code session");
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    let resolveMetadata: (value: unknown) => void = () => undefined;
    (global.fetch as jest.Mock).mockImplementation(() => new Promise(resolve => { resolveMetadata = resolve; }));
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "claude-code", name: "CLAUDE_CODE_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: "https://box.example.com", api_token: "rotated-token",
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh capacity" }));
    await waitFor(() => expect(oldFrame).not.toBeInTheDocument());
    expect(document.querySelector("iframe, form")).toBeNull();
    fireEvent.click(getSurfaceButton(/claude code session/i));
    expect(screen.getByText("Connecting securely…")).toBeVisible();
    await act(async () => { resolveMetadata({ ok: true, json: async () => ({ agentKind: "claude", surfaceAuth: "post-cookie-v1" }) }); });
    const nextFrame = await screen.findByTitle("Claude Code session");
    expect(nextFrame).not.toBe(oldFrame);
    expect(nextFrame.parentElement?.querySelector('input[name="token"]')).toHaveValue("rotated-token");
    expect(requestSubmit).toHaveBeenCalledTimes(2);
  });

  // bootId is the gateway's sign-in epoch: it stays the same across an
  // ordinary restart (sign-ins are saved) and changes when they were lost.
  describe("after the computer's gateway restarts", () => {
    const BOOT_A = "00000000400080000000000000000001";
    const BOOT_B = "00000000400080000000000000000002";
    let bootId: string | undefined;
    let clock: jest.SpyInstance | undefined;

    beforeEach(() => {
      bootId = BOOT_A;
      (global.fetch as jest.Mock).mockImplementation(async () => ({
        ok: true,
        json: async () => ({ agentKind: "claude", surfaceAuth: "post-cookie-v1", ...(bootId ? { bootId } : {}) }),
      }));
    });
    afterEach(() => clock?.mockRestore());

    // Focus re-checks are throttled to one per couple of seconds.
    function later() {
      const now = Date.now();
      clock = jest.spyOn(Date, "now").mockReturnValue(now + 10_000);
    }

    it("signs a loaded terminal in again, in a new frame, when the gateway lost its sign-ins (new bootId)", async () => {
      render(<AgentPage />);
      fireEvent.click(await findSurfaceButton(/claude code session/i));
      const frame = await screen.findByTitle("Claude Code session");
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));

      bootId = BOOT_B;
      later();
      await act(async () => { fireEvent.focus(window); });

      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(2));
      const form = requestSubmit.mock.instances[1] as HTMLFormElement;
      expect(form.querySelector('input[name="destination"]')).toHaveValue("/terminal/?arg=1");
      // A POST into the loaded ttyd frame would add a history entry, so Back
      // would reload the terminal (a new shell) instead of leaving the page.
      const next = screen.getByTitle("Claude Code session");
      expect(next).not.toBe(frame);
      expect(frame.isConnected).toBe(false);
      expect(next).toHaveAttribute("name", frame.getAttribute("name"));
      expect(form).toHaveAttribute("target", next.getAttribute("name"));
      expect(next).not.toHaveAttribute("src");
    });

    // Manage's in-place update restarts the gateway. Each retained surface
    // checks again as soon as the owner returns to it, and signs in again only
    // when the gateway lost its sign-ins; both terminal sessions keep their place.
    it.each([
      ["lost its sign-ins (an older gateway that kept them in memory)", BOOT_B, 4],
      ["kept its sign-ins", BOOT_A, 2],
    ])("re-checks retained surfaces after a connection-service update whose gateway %s", async (_case, after, submits) => {
      render(<AgentPage />);
      fireEvent.click(await findSurfaceButton(/claude code session/i));
      await screen.findByTitle("Claude Code session");
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
      fireEvent.click(getSurfaceButton("Terminal"));
      await screen.findByTitle("Terminal");
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(2));
      const metaProbes = () => (global.fetch as jest.Mock).mock.calls.filter(([url]) => url === "https://box.example.com/api/meta").length;

      fireEvent.click(screen.getByRole("button", { name: "Manage" }));
      bootId = after;
      later();
      fireEvent.click(screen.getByRole("button", { name: "Finish connection update" }));
      const before = metaProbes();
      fireEvent.click(getSurfaceButton("Terminal"));
      await waitFor(() => expect(metaProbes()).toBeGreaterThan(before));
      clock?.mockReturnValue(Date.now() + 10_000);
      fireEvent.click(getSurfaceButton(/claude code session/i));
      await waitFor(() => expect(metaProbes()).toBeGreaterThan(before + 1));
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(submits));
      expect(await screen.findByTitle("Claude Code session")).toBeVisible();
      expect(screen.getByTitle("Terminal")).toBeInTheDocument();
    });

    it("leaves a loaded terminal alone after a restart that kept its sign-ins (same bootId)", async () => {
      render(<AgentPage />);
      fireEvent.click(await findSurfaceButton(/claude code session/i));
      const frame = await screen.findByTitle("Claude Code session");
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
      const probes = (global.fetch as jest.Mock).mock.calls.length;

      later();
      await act(async () => { fireEvent.focus(window); });
      await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.length).toBe(probes + 1));
      expect(requestSubmit).toHaveBeenCalledTimes(1);
      expect(screen.getByTitle("Claude Code session")).toBe(frame);
    });

    it("keeps a legacy gateway without bootId exactly as before", async () => {
      bootId = undefined;
      render(<AgentPage />);
      fireEvent.click(await findSurfaceButton(/claude code session/i));
      await screen.findByTitle("Claude Code session");
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
      const probes = (global.fetch as jest.Mock).mock.calls.length;

      later();
      await act(async () => { fireEvent.focus(window); });
      await act(async () => { window.dispatchEvent(new Event("online")); });
      await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(probes));
      expect(requestSubmit).toHaveBeenCalledTimes(1);
    });

    it("re-checks a retained terminal when its tab is shown again", async () => {
      render(<AgentPage />);
      fireEvent.click(await findSurfaceButton(/claude code session/i));
      const agentFrame = await screen.findByTitle("Claude Code session");
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
      fireEvent.click(getSurfaceButton("Terminal"));
      await screen.findByTitle("Terminal");
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(2));

      // Sign-ins were lost while the agent session was out of view; hidden
      // frames do not poll, so nothing happens until it is shown again.
      bootId = BOOT_B;
      later();
      fireEvent.click(getSurfaceButton(/claude code session/i));
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(3));
      expect(requestSubmit.mock.instances[2]).toHaveAttribute("target", agentFrame.getAttribute("name"));
      expect(screen.getByTitle("Claude Code session")).not.toBe(agentFrame);
    });

    it("shows a DeepSeek start state instead of its 503 until the native interface is ready", async () => {
      mockGetAgent.mockResolvedValue({
        id: "agent_123", type: "deepseek-harness", name: "NATIVE_AGENT", status: "running",
        cpu: 2, ram: 4, chat_url: "https://box.example.com", api_token: "box-token",
      });
      let nativeReady = false;
      (global.fetch as jest.Mock).mockImplementation(async () => ({
        ok: true,
        json: async () => ({ agentKind: "deepseek-harness", surfaceAuth: "post-cookie-v1", bootId, nativeSurface: "/", nativeReady }),
      }));
      render(<AgentPage />);

      expect(await screen.findByText("Starting DeepSeek…")).toBeInTheDocument();
      expect(document.querySelector('iframe[title="DeepSeek Harness · dashboard"], form')).toBeNull();
      expect(requestSubmit).not.toHaveBeenCalled();
      expect(document.documentElement.outerHTML).not.toContain("box-token");

      nativeReady = true;
      const frame = await screen.findByTitle("DeepSeek Harness · dashboard", undefined, { timeout: 4_000 });
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
      expect(frame.parentElement?.querySelector('input[name="destination"]')).toHaveValue("/");
    });

    it("says DeepSeek hasn't started, with Try again, once its start runs past the limit", async () => {
      mockGetAgent.mockResolvedValue({
        id: "agent_123", type: "deepseek-harness", name: "NATIVE_AGENT", status: "running",
        cpu: 2, ram: 4, chat_url: "https://box.example.com", api_token: "box-token",
      });
      (global.fetch as jest.Mock).mockImplementation(async () => ({
        ok: true,
        json: async () => ({ agentKind: "deepseek-harness", surfaceAuth: "post-cookie-v1", bootId, nativeSurface: "/", nativeReady: false }),
      }));
      render(<AgentPage />);
      expect(await screen.findByText("Starting DeepSeek…")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

      const now = Date.now();
      clock = jest.spyOn(Date, "now").mockReturnValue(now + SURFACE_NATIVE_START_LIMIT_MS + 1_000);
      await act(async () => { window.dispatchEvent(new Event("online")); });

      expect(await screen.findByText("DeepSeek hasn’t started")).toBeInTheDocument();
      expect(screen.queryByText("Starting DeepSeek…")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open Manage" })).toBeInTheDocument();
      expect(requestSubmit).not.toHaveBeenCalled();
    });
  });

  it.each([
    { tab: "terminal", title: "Claude Code session", destination: "/terminal/?arg=1" },
    { tab: "box", title: "Terminal", destination: "/box-terminal/?arg=1" },
    { tab: "browser", title: "Live browser", destination: "/vnc/vnc.html?path=vnc/websockify&autoconnect=true&resize=scale&reconnect=true&view_only=true" },
  ])("keeps the $tab bootstrap destination local and clean", async ({ tab, title, destination }) => {
    mockSearchGet.mockImplementation((key: string) => key === "tab" ? tab : null);
    mockBrowserStatus.mockResolvedValue({ enabled: true, error: null });
    render(<AgentPage />);

    const frame = await screen.findByTitle(title);
    expect(frame.parentElement?.querySelector('input[name="destination"]')).toHaveValue(destination);
    expect(frame).not.toHaveAttribute("src");
    expect(frame).not.toHaveAttribute("allowfullscreen");
    if (tab === "browser") {
      expect(frame).toHaveAttribute("allow", "fullscreen https://box.example.com");
      expect(screen.getByText("Live browser · read-only view of the agent's Chrome. Conflict-free human takeover isn't available on this legacy surface.")).toBeVisible();
    } else {
      expect(frame).not.toHaveAttribute("allow");
    }
  });

  it.each([
    { chatUrl: "https://BOX.EXAMPLE.COM:443", origin: "https://box.example.com" },
    { chatUrl: "https://box.example.com:9443", origin: "https://box.example.com:9443" },
    { chatUrl: "https://box.example.com:9443/custom/base", origin: "https://box.example.com:9443" },
  ])("scopes browser permissions to the validated origin $origin before POST navigation", async ({ chatUrl, origin }) => {
    mockSearchGet.mockImplementation((key: string) => key === "tab" ? "browser" : null);
    mockBrowserStatus.mockResolvedValue({ enabled: true, error: null });
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "claude-code", name: "BROWSER_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: chatUrl, api_token: "box-token",
    });
    render(<AgentPage />);

    const frame = await screen.findByTitle("Live browser");
    const permissionPolicy = frame.getAttribute("allow") ?? "";
    expect(permissionPolicy).toBe(`fullscreen ${origin}`);
    expect(permissionPolicy).not.toMatch(/\*|'src'|'self'|box-token|\/vnc/);
    expect(frame).not.toHaveAttribute("allowfullscreen");
    expect(frame).not.toHaveAttribute("src");
    const form = frame.parentElement?.querySelector("form");
    expect(form).toHaveAttribute("action", `${origin}/auth/bootstrap`);
    expect(form).toHaveAttribute("target", frame.getAttribute("name"));
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
  });

  it.each(["https://*.example.com", "https://box.example.com;camera"])(
    "rejects a surface origin that could broaden the permissions policy: %s",
    async (chatUrl) => {
      mockSearchGet.mockImplementation((key: string) => key === "tab" ? "browser" : null);
      mockBrowserStatus.mockResolvedValue({ enabled: true, error: null });
      mockGetAgent.mockResolvedValue({
        id: "agent_123", type: "claude-code", name: "BROWSER_AGENT", status: "running",
        cpu: 2, ram: 4, chat_url: chatUrl, api_token: "box-token",
      });
      render(<AgentPage />);

      expect(await screen.findByText("Couldn’t verify secure access")).toBeInTheDocument();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(document.querySelector("iframe, form")).toBeNull();
      expect(requestSubmit).not.toHaveBeenCalled();
    },
  );

  it("replaces browser permissions when the selected guest origin changes", async () => {
    mockSearchGet.mockImplementation((key: string) => key === "tab" ? "browser" : null);
    mockBrowserStatus.mockResolvedValue({ enabled: true, error: null });
    const view = render(<AgentPage />);
    const firstFrame = await screen.findByTitle("Live browser");
    expect(firstFrame).toHaveAttribute("allow", "fullscreen https://box.example.com");

    mockAgentId = "agent_next";
    mockGetAgent.mockResolvedValue({
      id: "agent_next", type: "claude-code", name: "NEXT_BROWSER_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: "https://next.example.com:9443", api_token: "next-token",
    });
    view.rerender(<AgentPage />);

    await waitFor(() => {
      const nextFrame = screen.getByTitle("Live browser");
      expect(nextFrame).toHaveAttribute("allow", "fullscreen https://next.example.com:9443");
      expect(nextFrame.parentElement?.querySelector("form")).toHaveAttribute("action", "https://next.example.com:9443/auth/bootstrap");
    });
    const permissionPolicy = screen.getByTitle("Live browser").getAttribute("allow") ?? "";
    expect(permissionPolicy).not.toContain("box.example.com");
    expect(permissionPolicy).not.toContain("next-token");
  });

  it.each([
    { type: "aeon", name: "Aeon", destination: "/aeon/" },
    { type: "openclaw", name: "OpenClaw", destination: "/openclaw/" },
    { type: "agent-zero", name: "Agent Zero", destination: "/agent-zero/" },
    { type: "deepseek-harness", name: "DeepSeek Harness", destination: "/" },
  ])("uses the same secure native-dashboard bootstrap for $name", async ({ type, name, destination }) => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type, name: "NATIVE_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: "https://box.example.com", api_token: "box-token",
    });
    render(<AgentPage />);

    const frame = await screen.findByTitle(`${name} · dashboard`);
    expect(frame.parentElement?.querySelector('input[name="destination"]')).toHaveValue(destination);
    expect(frame).not.toHaveAttribute("src");
    expect(frame).not.toHaveAttribute("allowfullscreen");
    expect(frame).toHaveAttribute("allow", "clipboard-read https://box.example.com; clipboard-write https://box.example.com");
  });

  it("opens a fresh welcome launch on chat even when this agent was last left on its session", async () => {
    recordVisit("x-agent_123", "terminal");
    mockSearchGet.mockImplementation((key: string) => (key === "welcome" ? "1" : null));

    render(<AgentPage />);

    expect(await screen.findByText("Chat panel")).toBeInTheDocument();
    expect(screen.queryByTitle("Claude Code session")).not.toBeInTheDocument();
    expect(lastTabFor("x-agent_123")).toBe("chat");
  });

  // Each agent reopens where it was left; nothing carries over to another one.
  // A single remembered view used to be shared by every agent, so after using
  // one agent's command line the next agent opened on its command line too,
  // which on an older computer could start a session nobody asked for.
  it("reopens an agent on the surface it was last left on, Computer › Terminal included", async () => {
    recordVisit("x-agent_123", "box");

    render(<AgentPage />);

    expect(await screen.findByTitle("Terminal")).toBeVisible();
    expect(screen.queryByTitle("Claude Code session")).not.toBeInTheDocument();
  });

  it("does not open another agent on the surface the previous agent was left on", async () => {
    const first = render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(/claude code session/i));
    expect(await screen.findByTitle("Claude Code session")).toBeVisible();
    first.unmount();

    mockAgentId = "agent_next";
    mockGetAgent.mockResolvedValue({
      id: "agent_next", type: "claude-code", name: "NEXT_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: "https://next.example.com", api_token: "next-token",
    });
    render(<AgentPage />);

    expect(await screen.findByText("Chat panel")).toBeVisible();
    expect(screen.queryByTitle("Claude Code session")).not.toBeInTheDocument();
    expect(document.querySelector('iframe[name], form[action*="/terminal"]')).toBeNull();
    // The first agent still reopens on its own session.
    expect(lastTabFor("x-agent_123")).toBe("terminal");
  });

  // Computer › Terminal and the agent's session were remembered as one word,
  // so Home's continue link reopened the agent's session instead of the shell.
  it("sends Home's continue link back to Computer › Terminal, not the agent's session", async () => {
    const page = render(<AgentPage />);
    fireEvent.click(await findSurfaceButton("Terminal"));
    expect(await screen.findByTitle("Terminal")).toBeVisible();
    page.unmount();

    mockHomeAgents.mockReturnValue([{
      uid: "x-agent_123", kind: "hivra", id: "agent_123", name: "CLAUDE_CODE_AGENT", statusRaw: "running",
      state: "running", dot: "#22c55e", vendor: "Anthropic", typeLabel: "Claude Code", resourceKind: "agent", agentType: "claude-code",
    }]);
    render(<FleetControlPane requested />);
    const resume = screen.getAllByRole("link").find((link) => /Continue/.test(link.textContent ?? "") && link.textContent?.includes("CLAUDE_CODE_AGENT"));
    expect(resume).toHaveAttribute("href", "/dashboard/agent/agent_123?tab=box");
  });

  it("starts the next agent on its own surface when the page is reused for it", async () => {
    const view = render(<AgentPage />);
    fireEvent.click(await findSurfaceButton(/claude code session/i));
    expect(await screen.findByTitle("Claude Code session")).toBeVisible();

    mockAgentId = "agent_next";
    mockGetAgent.mockResolvedValue({
      id: "agent_next", type: "claude-code", name: "NEXT_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: "https://next.example.com", api_token: "next-token",
    });
    await act(async () => { view.rerender(<AgentPage />); });

    expect(await screen.findByText("Chat panel")).toBeVisible();
    expect(screen.queryByTitle("Claude Code session")).not.toBeInTheDocument();
  });

  it("records the surface on screen: at once on open, then after a pause, and on leaving", async () => {
    jest.useFakeTimers();
    try {
      const view = render(<AgentPage />);
      expect(await screen.findByText("Chat panel")).toBeInTheDocument();
      expect(listRecents()).toEqual([{ uid: "x-agent_123", tab: "chat", usedAt: expect.any(Number) }]);

      fireEvent.click(getSurfaceButton("Files"));
      expect(lastTabFor("x-agent_123")).toBe("chat");
      await act(async () => { jest.advanceTimersByTime(400); });
      expect(lastTabFor("x-agent_123")).toBe("files");

      fireEvent.click(getSurfaceButton("Terminal"));
      view.unmount();
      expect(lastTabFor("x-agent_123")).toBe("box");
    } finally {
      jest.useRealTimers();
    }
  });

  it("records a computer on the desktop it lands on, not on chat", async () => {
    mockGetAgent.mockResolvedValue(CONNECTED_UBUNTU);

    render(<AgentPage />);

    expect(await screen.findByTestId("remote-desktop")).toBeVisible();
    expect(lastTabFor("x-agent_123")).toBe("desktop");
  });

  it("records nothing for an agent that cannot be found", async () => {
    jest.useFakeTimers();
    try {
      mockGetAgent.mockResolvedValue(null);
      render(<AgentPage />);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await act(async () => { jest.advanceTimersByTime(2000); });
      }
      expect(await screen.findByText("Agent not found.")).toBeInTheDocument();
      expect(listRecents()).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows launch personalization questions while a fresh Claude Code box is provisioning", async () => {
    mockSearchGet.mockImplementation((key: string) => (key === "welcome" ? "1" : null));
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      status: "provisioning",
      activity: "provision",
      cpu: 2,
      ram: 4,
      chat_url: null,
      api_token: null,
    });

    render(<AgentPage />);

    expect(await screen.findByText("While you wait")).toBeInTheDocument();
    expect(screen.getByLabelText("Focus")).toBeInTheDocument();
    expect(screen.getByLabelText("Context")).toBeInTheDocument();
    expect(screen.getByLabelText("First task")).toBeInTheDocument();
    // The phone keyboard offers Done on the last field instead of a newline-style Return.
    expect(screen.getByLabelText("First task")).toHaveAttribute("enterkeyhint", "done");
  });

  it.each([
    { activity: "cancelling", verb: "Cancelling", body: "Deletion was requested" },
    { activity: "restart", verb: "Restarting", body: "Rebooting your existing computer" },
    { activity: "start", verb: "Starting", body: "Starting your existing computer" },
    { activity: "resize", verb: "Resizing", body: "Applying your resource change" },
    { activity: "stop", verb: "Stopping", body: "Stopping your computer" },
    { activity: "delete", verb: "Deleting", body: "Removing this computer" },
    { activity: undefined, verb: "Updating", body: "Waiting for the computer’s latest state" },
    { activity: "provision", verb: "Updating", body: "Waiting for the computer’s latest state" },
  ])("shows $activity truthfully without repeating welcome setup on an existing box", async ({ activity, verb, body }) => {
    mockSearchGet.mockImplementation((key: string) => (key === "welcome" ? "1" : null));
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "codex", name: "EXISTING_AGENT", status: "provisioning",
      activity, provisioned_at: "2026-08-27T10:00:00Z", cpu: 2, ram: 4,
    });
    render(<AgentPage />);
    await screen.findByText(`${verb} EXISTING_AGENT…`);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(`${verb} EXISTING_AGENT…`);
    expect(status).toHaveTextContent(body);
    expect(status.querySelector("svg")).toHaveStyle({ display: "block", margin: "0 auto" });
    expect(screen.queryByText("While you wait")).not.toBeInTheDocument();
    expect(screen.queryByText(/Spinning up a fresh/)).not.toBeInTheDocument();
  });

  it("does not show first-task setup after cancellation of a first provision", async () => {
    mockSearchGet.mockImplementation((key: string) => (key === "welcome" ? "1" : null));
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "codex", name: "CANCELLED_AGENT", status: "provisioning",
      activity: "cancelling", provisioned_at: null, cpu: 2, ram: 4,
    });
    render(<AgentPage />);
    await screen.findByText("Cancelling CANCELLED_AGENT…");
    expect(screen.getByRole("status")).toHaveTextContent("Cancelling CANCELLED_AGENT…");
    expect(screen.queryByText("While you wait")).not.toBeInTheDocument();
    expect(screen.queryByText(/Once it is ready/)).not.toBeInTheDocument();
  });

  it("does not infer a first install from a welcome URL when activity is missing", async () => {
    mockSearchGet.mockImplementation((key: string) => (key === "welcome" ? "1" : null));
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "codex", name: "UNKNOWN_AGENT", status: "provisioning",
      provisioned_at: null, cpu: 2, ram: 4,
    });
    render(<AgentPage />);
    await screen.findByText("Updating UNKNOWN_AGENT…");
    expect(screen.getByRole("status")).toHaveTextContent("Updating UNKNOWN_AGENT…");
    expect(screen.queryByText("While you wait")).not.toBeInTheDocument();
  });

  it("does not re-save or nest stored launch context until the user edits it", async () => {
    mockSearchGet.mockImplementation((key: string) => (key === "welcome" ? "1" : null));
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "codex",
      name: "CODEX_AGENT",
      status: "provisioning",
      activity: "provision",
      cpu: 2,
      ram: 4,
      chat_url: null,
      api_token: null,
      goal: "build",
      context: [
        "## About the user",
        "- Who they are: Founder",
        "- Their business / product: A secure agent platform",
        "- What they want help with: Ship faster, Improve reliability",
        "",
        "## Context from launch setup",
        "Existing project context.",
        "",
        "## First task to demonstrate value",
        "Ship the first release.",
      ].join("\n"),
      first_task: "Ship the first release.",
    });

    render(<AgentPage />);

    expect(await screen.findByLabelText("Context")).toHaveValue("Existing project context.");
    expect(screen.getByLabelText("First task")).toHaveValue("Ship the first release.");
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    const actionCallsBeforeEdit = (global.fetch as jest.Mock).mock.calls.filter(([url]) =>
      String(url).includes("/api/hivra/agents/agent_123/action"),
    );
    expect(actionCallsBeforeEdit).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Context"), {
      target: { value: "Updated project context." },
    });
    await waitFor(() => {
      const actionCalls = (global.fetch as jest.Mock).mock.calls.filter(([url]) =>
        String(url).includes("/api/hivra/agents/agent_123/action"),
      );
      expect(actionCalls).toHaveLength(1);
    });
    const actionCall = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
      String(url).includes("/api/hivra/agents/agent_123/action"),
    );
    const payload = JSON.parse(String(actionCall?.[1]?.body));
    expect(payload.firstTask).toBe("Ship the first release.");
    expect(payload.context).toContain("Updated project context.");
    expect(payload.context).toContain("- Who they are: Founder");
    expect(payload.context).toContain("- Their business / product: A secure agent platform");
    expect(payload.context).toContain("- What they want help with: Ship faster, Improve reliability");
    expect(payload.context.match(/## Context from launch setup/g)).toHaveLength(1);
  });

  it("refreshes managed capacity after changes without carrying a stale snapshot", async () => {
    mockFetchPlan.mockResolvedValueOnce({ key: "command", subscribed: true, usage: { usedCpu: 2 } });
    let resolveRefresh: (value: unknown) => void = () => undefined;
    mockFetchPlan.mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
    render(<AgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    await waitFor(() => expect(screen.getByTestId("manage-usage")).toHaveTextContent("2"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh capacity" }));
    await waitFor(() => expect(mockFetchPlan).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("manage-usage")).toHaveTextContent("unknown");
    await act(async () => { resolveRefresh({ key: "command", subscribed: true, usage: { usedCpu: 4 } }); });
    expect(screen.getByTestId("manage-usage")).toHaveTextContent("4");
  });

  it.each(["self-managed", "unknown-plan"])("does not demand a managed upgrade for a %s browser", async mode => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "codex", name: "TEST", status: "running", cpu: 2, ram: 4,
      deployment_mode: mode === "self-managed" ? "self-managed" : "hivra-managed",
      chat_url: "https://box.example.com", api_token: "box-token",
    });
    if (mode === "unknown-plan") mockFetchPlan.mockResolvedValue(null);
    render(<AgentPage />);
    const browserTab = await findSurfaceButton(/^browser$/i);
    await waitFor(() => expect(mockBrowserStatus).toHaveBeenCalled());
    fireEvent.click(browserTab);
    expect(screen.getByText("Turn it on in Manage to open the live browser.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /upgrade to pro/i })).not.toBeInTheDocument();
  });

  it("tells free-plan users to upgrade to Pro or above when the exposed Browser tab is off", async () => {
    render(<AgentPage />);

    const browserTab = await findSurfaceButton(/^browser$/i);
    await waitFor(() => expect(mockBrowserStatus).toHaveBeenCalled());
    fireEvent.click(browserTab);

    expect(screen.getByText(/upgrade to pro or above/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /upgrade to pro/i })).toBeInTheDocument();
  });

  it("opens the upgrade paywall modal from the free-plan browser lock", async () => {
    render(<AgentPage />);

    const browserTab = await findSurfaceButton(/^browser$/i);
    await waitFor(() => expect(mockBrowserStatus).toHaveBeenCalled());
    fireEvent.click(browserTab);

    fireEvent.click(screen.getByRole("button", { name: /upgrade to pro/i }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /upgrade to pro/i })).toHaveAttribute(
      "href",
      "/dashboard/billing?from=paywall&feature=browser",
    );

    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not expose the Browser tab for agents that do not ship browser automation", async () => {
    // Aeon is the browser-less agent now (codex gained the browser stack); it's
    // also dashboard-surface, so the tab set is Dashboard/Files/Box/Manage.
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "aeon",
      name: "AEON_AGENT",
      status: "running",
      cpu: 0.5,
      ram: 1,
      chat_url: "https://box.example.com",
      api_token: "box-token",
    });

    render(<AgentPage />);

    expect(await screen.findByRole("button", { name: /^dashboard$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^browser$/i })).not.toBeInTheDocument();
    expect(mockBrowserStatus).not.toHaveBeenCalled();
  });

  it("exposes the Browser tab on codex boxes (same stack as Claude Code)", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "codex",
      name: "CODEX_AGENT",
      status: "running",
      cpu: 2,
      ram: 4,
      chat_url: "https://box.example.com",
      api_token: "box-token",
    });

    render(<AgentPage />);

    expect(await findSurfaceButton(/codex session/i)).toBeInTheDocument();
    expect(getSurfaceButton(/^browser$/i)).toBeInTheDocument();
    await waitFor(() => expect(mockBrowserStatus).toHaveBeenCalled());
  });

  it("shows the channel-connect nudge on a welcome landing when Telegram is not connected", async () => {
    mockSearchGet.mockImplementation((key: string) => (key === "welcome" ? "1" : null));
    mockTelegramStatus.mockResolvedValue({ connected: false, active: false, ownerId: null });

    render(<AgentPage />);

    expect(await screen.findByTestId("channel-connect-nudge")).toBeInTheDocument();
    expect(screen.getByText(/your agent can reach you when work is done/i)).toBeInTheDocument();
  });

  it("routes the nudge's connect action to the Telegram tab (where the nudge hides)", async () => {
    mockSearchGet.mockImplementation((key: string) => (key === "welcome" ? "1" : null));
    mockTelegramStatus.mockResolvedValue({ connected: false, active: false, ownerId: null });

    render(<AgentPage />);

    // The nudge's action reads "Connect Telegram" since the phone pass.
    fireEvent.click(await screen.findByRole("button", { name: /^connect( telegram)?$/i }));

    expect(await screen.findByText("Telegram panel")).toBeInTheDocument();
    expect(screen.queryByTestId("channel-connect-nudge")).not.toBeInTheDocument();
  });

  it("does not show the nudge without the welcome param", async () => {
    mockTelegramStatus.mockResolvedValue({ connected: false, active: false, ownerId: null });

    render(<AgentPage />);

    expect(await screen.findByText("Chat panel")).toBeInTheDocument();
    expect(screen.queryByTestId("channel-connect-nudge")).not.toBeInTheDocument();
  });

  it("opens directly on a tab requested via the ?tab= deep link", async () => {
    mockSearchGet.mockImplementation((key: string) => (key === "tab" ? "telegram" : null));

    render(<AgentPage />);

    expect(await screen.findByText("Telegram panel")).toBeInTheDocument();
    // What is remembered is this agent's own surface, not a shared view.
    expect(lastTabFor("x-agent_123")).toBe("telegram");
    expect(window.localStorage.getItem("hivra:agent-last-view")).toBeNull();
  });

  it("keeps Manage reachable when provisioning failed so the agent can be deleted", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "claude-code",
      name: "CLAUDE_CODE_AGENT",
      status: "error",
      error: "Proxmox target fixturenode10 is missing target-specific values",
      cpu: 2,
      ram: 4,
      vmid: 1090,
      chat_url: null,
      api_token: null,
    });

    render(<AgentPage />);

    expect(await screen.findByText("Provisioning failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^manage$/i }));

    expect(screen.getByText("Manage panel")).toBeInTheDocument();
    expect(screen.queryByText("Provisioning failed")).not.toBeInTheDocument();
    expect(mockClientWarn).toHaveBeenCalledWith(
      "Hivra agent provisioning failed",
      expect.objectContaining({
        source: "hivra-agent-page",
        route: "/dashboard/agent/[id]",
        instanceId: "agent_123",
        agentType: "claude-code",
        status: "error",
        vmid: 1090,
        hasChatUrl: false,
        error: "Proxmox target fixturenode10 is missing target-specific values",
      }),
    );
  });

  it("never shows the GitHub-connect screen for a no-connect dashboard agent (OpenClaw runs on the box, not GitHub)", async () => {
    mockAgentId = "agent_oc";
    mockGetAgent.mockResolvedValue({
      id: "agent_oc",
      type: "openclaw",
      name: "OPENCLAW_AGENT",
      status: "running",
      cpu: 1,
      ram: 2,
      chat_url: "https://box.example.com",
      api_token: "box-token",
    });
    // Even if the box reports not-logged-in (e.g. an older image), OpenClaw has no
    // GitHub connect step — it must go straight to its embedded dashboard, never the
    // Aeon-fork connect screen.
    mockBoxLoginStatus.mockResolvedValue({ loggedIn: false });

    render(<AgentPage />);

    // The embedded dashboard (iframe) renders...
    expect(await screen.findByTitle(/OpenClaw · dashboard/i)).toBeInTheDocument();
    // ...and NOT the Aeon GitHub-connect copy.
    expect(screen.queryByText(/Fork Aeon/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/runs on/i)).not.toBeInTheDocument();
  });

  it("still shows the GitHub connect step for Aeon (connect:github) when the box is not connected", async () => {
    mockAgentId = "agent_aeon";
    mockGetAgent.mockResolvedValue({
      id: "agent_aeon",
      type: "aeon",
      name: "AEON_AGENT",
      status: "running",
      cpu: 1,
      ram: 1,
      chat_url: "https://box.example.com",
      api_token: "box-token",
    });
    mockBoxLoginStatus.mockResolvedValue({ loggedIn: false });

    render(<AgentPage />);

    // Aeon DOES run on the user's GitHub, so the connect screen is correct here.
    expect(await screen.findByText(/Fork Aeon/i)).toBeInTheDocument();
  });

  it("prefetches read-only remote-desktop capability refresh for computers without prepare", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "linux-desktop",
      computer_profile: "ubuntu-desktop",
      name: "UBUNTU_BOX",
      status: "running",
      cpu: 2,
      ram: 4,
      chat_url: "https://box.example.com",
      api_token: null,
      computer_substrate: "proxmox-kvm",
    });
    const fetchMock = global.fetch as unknown as jest.Mock;
    render(<AgentPage />);
    await screen.findByRole("navigation", { name: "Resource surfaces" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/hivra/agents/agent_123/remote-desktop",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "refresh" }),
      }),
    ));
    expect(fetchMock.mock.calls.some(([, init]) => String(init?.body || "").includes('"prepare"'))).toBe(false);
  });

  it("starts the one runtime proof the Linux desktop joins, so a first open never inspects the computer twice", async () => {
    mockGetAgent.mockResolvedValue(CONNECTED_UBUNTU);
    let landProof!: () => void;
    const proofGate = new Promise<void>(resolve => { landProof = resolve; });
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock.mockImplementation((input: unknown) => String(input) === "/api/hivra/agents/agent_123/remote-desktop"
      ? proofGate.then(() => ({ ok: true, status: 200, json: async () => ({ success: true, data: { prepared: true } }) }))
      : Promise.resolve({ ok: true, json: async () => ({ success: true, agentKind: "claude", surfaceAuth: "post-cookie-v1" }) }));
    const proofRequests = () => fetchMock.mock.calls.filter(([url]) => String(url) === "/api/hivra/agents/agent_123/remote-desktop");

    render(<AgentPage />);
    await screen.findByRole("navigation", { name: "Resource surfaces" });
    await waitFor(() => expect(proofRequests()).toHaveLength(1));
    // The desktop's first session request found the proof expired and asks
    // for one while the page's is still running: it gets the page's.
    const joined = refreshDesktopCapability("agent_123");
    expect(proofRequests()).toHaveLength(1);
    landProof();
    await expect(joined).resolves.toEqual({ ok: true, status: 200, payload: { success: true, data: { prepared: true } } });
    expect(proofRequests()).toHaveLength(1);
  });

  it("shows a gVisor Linux terminal computer only on Manage", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "linux-terminal",
      computer_profile: "linux-terminal",
      name: "TERMINAL_BOX",
      status: "running",
      cpu: 2,
      ram: 4,
      chat_url: null,
      api_token: null,
      computer_substrate: "gvisor",
    });
    const fetchMock = global.fetch as unknown as jest.Mock;
    render(<AgentPage />);

    expect(await screen.findByText("Manage panel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desktop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(?:Box )?Terminal$/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/remote-desktop"))).toBe(false);
  });

  it("keeps Omarchy autoPrepare gated to prepare=1 while still prefetching refresh", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "linux-desktop",
      computer_profile: "omarchy",
      name: "OMARCHY_BOX",
      status: "running",
      cpu: 2,
      ram: 4,
      chat_url: "https://box.example.com",
      api_token: null,
      computer_substrate: "proxmox-kvm",
    });
    // Ensure Omarchy desktop mock captures autoPrepare
    const fetchMock = global.fetch as unknown as jest.Mock;
    window.history.replaceState(null, "", "/dashboard/agent/agent_123?tab=desktop");
    mockSearchGet.mockImplementation((key: string) => new URLSearchParams(window.location.search).get(key));
    render(<AgentPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/hivra/agents/agent_123/remote-desktop",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "refresh" }),
      }),
    ));
    expect(fetchMock.mock.calls.some(([, init]) => String(init?.body || "").includes('"prepare"'))).toBe(false);
    expect(new URLSearchParams(window.location.search).get("prepare")).toBeNull();
  });

  it("does not auto-prepare a running computer whose box connection is already up", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "linux-desktop",
      computer_profile: "ubuntu-desktop",
      name: "UBUNTU_BOX",
      status: "running",
      cpu: 2,
      ram: 4,
      chat_url: "https://box.example.com",
      api_token: null,
      computer_substrate: "proxmox-kvm",
    });
    window.history.replaceState(null, "", "/dashboard/agent/agent_123?tab=desktop");
    mockSearchGet.mockImplementation((key: string) => new URLSearchParams(window.location.search).get(key));
    render(<AgentPage />);
    expect(await screen.findByTestId("remote-desktop")).toHaveAttribute("data-autoprepare", "false");
  });

  it("still auto-prepares a running computer that cannot attach yet", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "linux-desktop",
      computer_profile: "ubuntu-desktop",
      name: "UBUNTU_BOX",
      status: "running",
      cpu: 2,
      ram: 4,
      chat_url: null,
      api_token: null,
      computer_substrate: "proxmox-kvm",
    });
    render(<AgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Desktop" }));
    expect(await screen.findByTestId("remote-desktop")).toHaveAttribute("data-autoprepare", "true");
  });

  it("labels the Files root as the shared Hivra workspace on computers", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "linux-desktop",
      computer_profile: "ubuntu-desktop",
      name: "UBUNTU_BOX",
      status: "running",
      cpu: 2,
      ram: 4,
      chat_url: "https://box.example.com",
      api_token: "box-token",
      computer_substrate: "proxmox-kvm",
    });
    render(<AgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Files" }));
    expect(await screen.findByText("Files panel")).toHaveAttribute("data-workspace-root", "true");
  });

  it("tells a computer with missing box credentials to contact support instead of a false connection error", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "linux-desktop",
      computer_profile: "ubuntu-desktop",
      name: "UBUNTU_BOX",
      status: "running",
      cpu: 2,
      ram: 4,
      chat_url: "https://box.example.com",
      api_token: null,
      computer_substrate: "proxmox-kvm",
    });
    render(<AgentPage />);
    await screen.findByRole("navigation", { name: "Resource surfaces" });
    fireEvent.click(getSurfaceButton(/^Terminal$/));
    const guidance = await screen.findByText(/Secure access credentials for this computer/);
    expect(guidance).toHaveTextContent("Contact support to restore access.");
    // No Manage action restores the dashboard credential, so none is named.
    expect(guidance).not.toHaveTextContent(/Update connection service|Update & restart|Restart/);
    expect(screen.queryByText(/connection service isn’t reachable yet/)).not.toBeInTheDocument();
    expect(document.documentElement.outerHTML).not.toContain("box-token");
  });

  it("throttles capability refresh prefetch to once per computer session (no page+desktop double-fire)", async () => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123",
      type: "linux-desktop",
      computer_profile: "ubuntu-desktop",
      name: "UBUNTU_BOX",
      status: "running",
      cpu: 2,
      ram: 4,
      chat_url: "https://box.example.com",
      api_token: null,
      computer_substrate: "proxmox-kvm",
    });
    const fetchMock = global.fetch as unknown as jest.Mock;
    render(<AgentPage />);
    await screen.findByRole("navigation", { name: "Resource surfaces" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/hivra/agents/agent_123/remote-desktop",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "refresh" }),
      }),
    ));
    const refreshCallsBefore = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes("/remote-desktop") && String(init?.body || "").includes('"refresh"'),
    ).length;
    expect(refreshCallsBefore).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Desktop" }));
    await screen.findByTestId("remote-desktop");
    await act(async () => { await Promise.resolve(); });
    const refreshCallsAfter = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes("/remote-desktop") && String(init?.body || "").includes('"refresh"'),
    ).length;
    expect(refreshCallsAfter).toBe(1);
  });

  describe("an agent added to this computer (design 5.8)", () => {
    const INSTALLATION = "55555555-5555-4555-8555-555555555555";
    const gateWith = (attachment: Record<string, unknown>) => ({ state: "ready", gate: { attachments: [attachment] } });
    async function chatTab() {
      const direct = screen.queryByRole("button", { name: "Chat" });
      if (direct) return direct;
      const tools = screen.queryByRole("button", { name: /^Tools(?:$|:)/ });
      if (tools) fireEvent.click(tools);
      return screen.queryByRole("button", { name: "Chat" }) ?? screen.queryByRole("menuitem", { name: "Chat" });
    }

    it("gains a Chat tab for it once it is ready, reaching it through the computer's gateway", async () => {
      mockGetAgent.mockResolvedValue(CONNECTED_UBUNTU);
      mockFetchAttachGate.mockResolvedValue(gateWith({ phase: "attached", installationId: INSTALLATION, agentName: "Codex" }));
      render(<AgentPage />);
      await screen.findByTestId("remote-desktop");
      await waitFor(() => expect(mockFetchAttachGate).toHaveBeenCalledWith("agent_123"));
      const tab = await waitFor(async () => { const found = await chatTab(); expect(found).not.toBeNull(); return found!; });
      fireEvent.click(tab);
      expect(await screen.findByTestId("attached-chat")).toHaveTextContent(`Codex ${INSTALLATION} via https://box.example.com`);
    });

    it("opens its Chat deep link without first showing the computer's Desktop", async () => {
      mockSearchGet.mockImplementation((key: string) => key === "tab" ? "chat" : null);
      mockGetAgent.mockResolvedValue(CONNECTED_UBUNTU);
      let answer!: (value: unknown) => void;
      mockFetchAttachGate.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
      render(<AgentPage />);
      await waitFor(() => expect(mockFetchAttachGate).toHaveBeenCalledWith("agent_123"));
      // While the computer's attach read is out, the Desktop stays closed: it is
      // never opened (and a session started) only to be replaced by Chat.
      expect(await screen.findByText("Checking this computer…")).toBeInTheDocument();
      const desktop = screen.queryByTestId("remote-desktop");
      if (desktop) expect(desktop).not.toBeVisible();
      await act(async () => { answer(gateWith({ phase: "attached", installationId: INSTALLATION, agentName: "Codex" })); });
      expect(await screen.findByTestId("attached-chat")).toHaveTextContent(`Codex ${INSTALLATION} via https://box.example.com`);
      const after = screen.queryByTestId("remote-desktop");
      if (after) expect(after).not.toBeVisible();
    });

    // Recents and Home keep the added agent as its own resource: its Chat was
    // recorded as the computer (x-<computer>) on its Desktop.
    it("records its own visit, a-<attachment id> on Chat, while its Chat is on screen", async () => {
      const ATTACHMENT = "77777777-7777-4777-8777-777777777777";
      mockSearchGet.mockImplementation((key: string) => key === "tab" ? "chat" : null);
      mockGetAgent.mockResolvedValue(CONNECTED_UBUNTU);
      mockFetchAttachGate.mockResolvedValue(gateWith({ id: ATTACHMENT, phase: "attached", installationId: INSTALLATION, agentName: "Codex" }));
      render(<AgentPage />);
      expect(await screen.findByTestId("attached-chat")).toBeInTheDocument();
      await waitFor(() => expect(listRecents()).toContainEqual({ uid: `a-${ATTACHMENT}`, tab: "chat", usedAt: expect.any(Number) }));
      expect(lastTabFor("x-agent_123")).not.toBe("chat");
    });

    it("has no Chat tab while the agent is still being added", async () => {
      mockGetAgent.mockResolvedValue(CONNECTED_UBUNTU);
      mockFetchAttachGate.mockResolvedValue(gateWith({ phase: "dispatched", installationId: null, agentName: "Codex" }));
      render(<AgentPage />);
      await screen.findByTestId("remote-desktop");
      await waitFor(() => expect(mockFetchAttachGate).toHaveBeenCalled());
      expect(await chatTab()).toBeNull();
      expect(screen.queryByTestId("attached-chat")).not.toBeInTheDocument();
    });
  });

  // The sidebar, ⌘K and Home reuse a list of agents read in the last few
  // seconds. A change made here has to reach them, or Home offers to continue
  // in an agent just deleted and the switchers keep its old name and status.
  describe("after a change on Manage", () => {
    const agentRow = { id: "agent_123", name: "CLAUDE_CODE_AGENT", type: "claude-code", status: "running", cpu: 2, ram: 4 };
    let listed: unknown[];
    let listReads: number;
    let stopShowing: () => void;
    const heldNames = () => {
      const body = resourceInventory.getSnapshot().hivra.body as { data: { agents: Array<{ name: string }> } };
      return body.data.agents.map((row) => row.name);
    };

    beforeEach(async () => {
      resetResourceInventory();
      listed = [agentRow];
      listReads = 0;
      const pageFetch = global.fetch as jest.Mock;
      global.fetch = jest.fn((url: string, init?: RequestInit) => {
        if (url === "/api/hivra/agents") {
          listReads += 1;
          return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { agents: listed } }) });
        }
        return pageFetch(url, init);
      }) as unknown as typeof fetch;
      await act(async () => { await resourceInventory.load("hivra"); });
      // The sidebar is showing the list.
      stopShowing = resourceInventory.subscribe(() => undefined);
    });

    afterEach(() => {
      stopShowing();
      resetResourceInventory();
    });

    it("reads the agents list again after deleting, so it is not offered again", async () => {
      mockSearchGet.mockImplementation((key: string) => key === "tab" ? "manage" : null);
      render(<AgentPage />);
      listed = [];
      fireEvent.click(await screen.findByRole("button", { name: "Agent deleted" }));
      expect(pushMock).toHaveBeenCalledWith("/dashboard?hivra=1");
      await waitFor(() => expect(heldNames()).toEqual([]));
      expect(listReads).toBe(2);
    });

    it("reads the agents list again after a rename, stop or resize", async () => {
      mockSearchGet.mockImplementation((key: string) => key === "tab" ? "manage" : null);
      render(<AgentPage />);
      listed = [{ ...agentRow, name: "RENAMED_AGENT", status: "stopped" }];
      fireEvent.click(await screen.findByRole("button", { name: "Refresh capacity" }));
      await waitFor(() => expect(heldNames()).toEqual(["RENAMED_AGENT"]));
      expect(listReads).toBe(2);
    });

    it("reads the agents list again when a DigitalOcean session is deleted", async () => {
      mockGetAgent.mockResolvedValue({ ...agentRow, computer_substrate: "do-managed-session", deployment_mode: "self-managed", chat_url: null });
      render(<AgentPage />);
      listed = [];
      fireEvent.click(await screen.findByRole("button", { name: "Session deleted" }));
      expect(pushMock).toHaveBeenCalledWith("/dashboard?hivra=1");
      await waitFor(() => expect(heldNames()).toEqual([]));
      expect(listReads).toBe(2);
    });

    // Regression: a DigitalOcean agent renamed in Manage kept its old name in
    // the sidebar, ⌘K and Home until their list refreshed on its own.
    it("reads the agents list again after a DigitalOcean agent is renamed, paused or resumed in Manage", async () => {
      mockGetAgent.mockResolvedValue({ ...agentRow, computer_substrate: "do-managed-session", deployment_mode: "self-managed", chat_url: null });
      render(<AgentPage />);
      listed = [{ ...agentRow, name: "RENAMED_AGENT" }];
      fireEvent.click(await screen.findByRole("button", { name: "Session renamed" }));
      await waitFor(() => expect(heldNames()).toEqual(["RENAMED_AGENT"]));
      expect(listReads).toBe(2);
    });
  });

});
