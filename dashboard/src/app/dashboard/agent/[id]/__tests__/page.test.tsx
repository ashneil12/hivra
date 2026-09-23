/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NativeWorkspaceProvider } from "@/components/layout/NativeWorkspaceBridge";

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

jest.mock("@/components/hivra/HivraChat", () => ({
  HivraChat: () => <div>Chat panel</div>,
}));

jest.mock("@/components/hivra/DigitalOceanAgentWorkspace", () => ({
  DigitalOceanAgentWorkspace: ({ agentId }: { agentId: string }) => <div>DigitalOcean session {agentId}</div>,
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
  HivraManage: ({ plan, onChanged }: { plan?: { usage?: { usedCpu: number } } | null; onChanged: () => void }) => <>
    <div>Manage panel</div>
    <output data-testid="manage-usage">{plan?.usage?.usedCpu ?? "unknown"}</output>
    <button onClick={onChanged}>Refresh capacity</button>
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

// Keep the component's build-time flag false so these tests exercise the same
// hostname-resolved hydration path as Canary, independent of the caller's env.
const previousHivraEnv = process.env.NEXT_PUBLIC_HIVRA_AGENTS;
delete process.env.NEXT_PUBLIC_HIVRA_AGENTS;
const AgentPage = jest.requireActual("../page").default as typeof import("../page").default;
if (previousHivraEnv === undefined) delete process.env.NEXT_PUBLIC_HIVRA_AGENTS;
else process.env.NEXT_PUBLIC_HIVRA_AGENTS = previousHivraEnv;

// Exercise the same disclosure path owners use for advanced surfaces.
function getSurfaceButton(name: string | RegExp) {
  const visible = screen.queryByRole("button", { name });
  if (visible) return visible;
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

  it("opens a DigitalOcean agent in its session workspace, never the box chat or login", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent_123", type: "claude-code", name: "DO_AGENT", cpu: 2, ram: 4,
      status: "running", computer_substrate: "do-managed-session", deployment_mode: "self-managed", chat_url: null });
    render(<AgentPage />);
    expect(await screen.findByText("DigitalOcean session agent_123")).toBeInTheDocument();
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
    expect(screen.getByText(/Open Manage and choose Update & restart/)).toBeInTheDocument();
    expect(screen.queryByText("Chat panel")).not.toBeInTheDocument();
    expect(screen.queryByText("Login panel")).not.toBeInTheDocument();
  });

  it("lets native chrome select existing surfaces while preserving connection guards and desktop sessions", async () => {
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
      select("desktop");
      const desktop = await screen.findByTestId("remote-desktop");
      expect(desktop).toBeVisible();
      select("manage");
      expect(await screen.findByText("Manage panel")).toBeInTheDocument();
      expect(screen.getByTestId("remote-desktop")).toBe(desktop);
      expect(desktop).not.toBeVisible();
      expect(JSON.stringify(postMessage.mock.calls)).not.toMatch(/box-token|box\.example\.com/);
    } finally {
      view.unmount();
      delete host.__HIVRA_NATIVE_WORKSPACE__;
      delete host.webkit;
    }
  });

  it("lazily retains one desktop session while switching local surfaces", async () => {
    render(<AgentPage />);
    expect(await screen.findByText("Chat panel")).toBeInTheDocument();
    expect(screen.queryByTestId("remote-desktop")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Desktop" }));
    const desktop = await screen.findByTestId("remote-desktop");
    expect(desktop).toBeVisible();
    expect(desktop).toHaveTextContent("CLAUDE_CODE_AGENT desktop session");

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByText("Chat panel")).toBeInTheDocument();
    expect(desktop).not.toBeVisible();
    expect(screen.getByTestId("remote-desktop")).toBe(desktop);

    fireEvent.click(screen.getByRole("button", { name: "Desktop" }));
    expect(screen.getByTestId("remote-desktop")).toBe(desktop);
    expect(desktop).toBeVisible();
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
    expect(document.querySelector('iframe[title="Box · shell"], form[action*="windows-box"]')).toBeNull();
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
    expect(document.querySelector('iframe[title="Box · shell"], form[action*="auth/bootstrap"]')).toBeNull();
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
    expect(document.querySelector('iframe[title="Box · shell"], form[action*="stale-box"]')).toBeNull();
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
    expect(document.querySelector('iframe[title="Box · shell"], form[action*="auth/bootstrap"]')).toBeNull();
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
    expect(await screen.findByTitle("Box · shell")).toBeVisible();
  });

  it("keeps the selected surface in the URL without reloading or adding history entries", async () => {
    window.history.replaceState(null, "", "/dashboard/agent/agent_123?hivra=1&tab=desktop&prepare=1#workspace");
    mockSearchGet.mockImplementation((key: string) => new URLSearchParams(window.location.search).get(key));
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
    expect(screen.queryByTestId("remote-desktop")).not.toBeInTheDocument();
  });

  it("follows changed tab deep links while preserving an already opened desktop", async () => {
    let requested = "manage";
    mockSearchGet.mockImplementation((key: string) => key === "tab" ? requested : null);
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

  it("keeps the Browser tab exposed for browser-capable agents even when browser automation is off", async () => {
    render(<AgentPage />);

    expect(await screen.findByRole("button", { name: /claude code terminal/i })).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: /claude code terminal/i }));

    const frame = await screen.findByTitle("Claude Code · terminal");
    expect(frame.tagName).toBe("IFRAME");
    const form = frame.parentElement?.querySelector("form");
    expect(frame).not.toHaveAttribute("src");
    expect(form).toHaveAttribute("action", "https://box.example.com/auth/bootstrap");
    expect(form).toHaveAttribute("method", "POST");
    expect(form?.querySelector('input[name="destination"]')).toHaveValue("/terminal/");
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
    fireEvent.click(await screen.findByRole("button", { name: /claude code terminal/i }));

    expect(await screen.findByText("Connection update needed")).toBeInTheDocument();
    expect(screen.getByText(/Open Manage and choose/)).toHaveTextContent("Update & restart");
    expect(screen.queryByRole("link", { name: /update the connection service/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open in new tab/i })).toBeDisabled();
    expect(document.querySelector("iframe, form")).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain("box-token");
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { name: "legacy terminal", tab: /claude code terminal/i, metadata: { agentKind: "claude" }, heading: "Connection update needed" },
    { name: "unreachable box terminal", tab: /^box terminal$/i, metadata: null, heading: "Couldn’t verify secure access" },
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
    expect(await screen.findByText(heading)).toBeInTheDocument();

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
    (global.fetch as jest.Mock).mockResolvedValueOnce(response);
    render(<AgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: /claude code terminal/i }));

    expect(await screen.findByText("Couldn’t verify secure access")).toBeInTheDocument();
    expect(document.querySelector("iframe, form")).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain("box-token");
    expect(requestSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTitle("Claude Code · terminal")).toBeInTheDocument();
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
  });

  it("does not fall back to a bearer URL on network failure", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError("Network failed"));
    render(<AgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: /claude code terminal/i }));

    expect(await screen.findByText("Couldn’t verify secure access")).toBeInTheDocument();
    expect(document.querySelector("iframe, form")).toBeNull();
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it.each(["http://box.example.com", "https://user:password@box.example.com", "https://box.example.com?token=secret"])("does not send credentials to an invalid surface base %s", async (chatUrl) => {
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "claude-code", name: "CLAUDE_CODE_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: chatUrl, api_token: "box-token",
    });
    render(<AgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: /claude code terminal/i }));

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
    fireEvent.click(await screen.findByRole("button", { name: /claude code terminal/i }));
    expect(await screen.findByText("Connecting securely…")).toBeInTheDocument();
    expect(requestSubmit).not.toHaveBeenCalled();

    mockAgentId = "agent_next";
    mockGetAgent.mockResolvedValue({
      id: "agent_next", type: "claude-code", name: "NEXT_AGENT", status: "running",
      cpu: 2, ram: 4, chat_url: "https://next.example.com", api_token: "next-token",
    });
    view.rerender(<AgentPage />);
    const frame = await screen.findByTitle("Claude Code · terminal");
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
    fireEvent.click(await screen.findByRole("button", { name: /claude code terminal/i }));
    const agentFrame = await screen.findByTitle("Claude Code · terminal");
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
    const agentName = agentFrame.getAttribute("name");

    fireEvent.click(getSurfaceButton("Box Terminal"));
    const boxFrame = await screen.findByTitle("Box · shell");
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(2));
    expect(boxFrame).not.toBe(agentFrame);
    expect(boxFrame.getAttribute("name")).not.toBe(agentName);
    expect(agentFrame).toBeInTheDocument();
    expect(agentFrame).not.toBeVisible();
    expect(agentFrame.closest("[inert]")).not.toBeNull();
    expect(boxFrame).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /claude code terminal/i }));
    expect(screen.getByTitle("Claude Code · terminal")).toBe(agentFrame);
    expect(agentFrame).toBeVisible();
    expect(boxFrame).not.toBeVisible();
    expect(requestSubmit).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(agentFrame).toBeInTheDocument();
    expect(boxFrame).toBeInTheDocument();
    expect(agentFrame).not.toBeVisible();
    expect(boxFrame).not.toBeVisible();
    fireEvent.click(getSurfaceButton("Box Terminal"));
    expect(screen.getByTitle("Box · shell")).toBe(boxFrame);
    expect(boxFrame).toBeVisible();
    expect(requestSubmit).toHaveBeenCalledTimes(2);
  });

  it("disposes retained terminals immediately when changing computers", async () => {
    const view = render(<AgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: /claude code terminal/i }));
    const oldFrame = await screen.findByTitle("Claude Code · terminal");
    mockAgentId = "agent_next";
    mockGetAgent.mockReturnValue(new Promise(() => undefined));
    await act(async () => { view.rerender(<AgentPage />); });
    expect(oldFrame).not.toBeInTheDocument();
    expect(document.querySelector("iframe, form")).toBeNull();
  });

  it("does not retain terminal sessions while the computer is stopped", async () => {
    render(<AgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: /claude code terminal/i }));
    const agentFrame = await screen.findByTitle("Claude Code · terminal");
    fireEvent.click(getSurfaceButton("Box Terminal"));
    const boxFrame = await screen.findByTitle("Box · shell");
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    mockGetAgent.mockResolvedValue({
      id: "agent_123", type: "claude-code", name: "CLAUDE_CODE_AGENT", status: "stopped",
      cpu: 2, ram: 4, chat_url: "https://box.example.com", api_token: "box-token",
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh capacity" }));
    await waitFor(() => expect(agentFrame).not.toBeInTheDocument());
    expect(boxFrame).not.toBeInTheDocument();
    fireEvent.click(getSurfaceButton("Box Terminal"));
    expect(screen.getByText("The box isn't reachable yet.")).toBeInTheDocument();
    expect(document.querySelector("iframe, form")).toBeNull();
  });

  it("still retries an initial load failure after leaving another computer", async () => {
    jest.useFakeTimers();
    try {
      const view = render(<AgentPage />);
      fireEvent.click(await screen.findByRole("button", { name: /claude code terminal/i }));
      const oldFrame = await screen.findByTitle("Claude Code · terminal");
      mockAgentId = "agent_next";
      mockGetAgent.mockResolvedValueOnce(null).mockResolvedValue({
        id: "agent_next", type: "claude-code", name: "NEXT_AGENT", status: "running",
        cpu: 2, ram: 4, chat_url: "https://next.example.com", api_token: "next-token",
      });
      await act(async () => { view.rerender(<AgentPage />); });
      expect(oldFrame).not.toBeInTheDocument();
      await act(async () => { jest.advanceTimersByTime(2000); });
      expect(await screen.findByText("NEXT_AGENT")).toBeInTheDocument();
      const nextFrame = await screen.findByTitle("Claude Code · terminal");
      expect(nextFrame.parentElement?.querySelector("form")).toHaveAttribute("action", "https://next.example.com/auth/bootstrap");
    } finally {
      jest.useRealTimers();
    }
  });

  it("revalidates rotated credentials before restoring a retained terminal", async () => {
    render(<AgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: /claude code terminal/i }));
    const oldFrame = await screen.findByTitle("Claude Code · terminal");
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
    fireEvent.click(screen.getByRole("button", { name: /claude code terminal/i }));
    expect(screen.getByText("Connecting securely…")).toBeVisible();
    await act(async () => { resolveMetadata({ ok: true, json: async () => ({ agentKind: "claude", surfaceAuth: "post-cookie-v1" }) }); });
    const nextFrame = await screen.findByTitle("Claude Code · terminal");
    expect(nextFrame).not.toBe(oldFrame);
    expect(nextFrame.parentElement?.querySelector('input[name="token"]')).toHaveValue("rotated-token");
    expect(requestSubmit).toHaveBeenCalledTimes(2);
  });

  it.each([
    { tab: "terminal", title: "Claude Code · terminal", destination: "/terminal/" },
    { tab: "box", title: "Box · shell", destination: "/box-terminal/" },
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

  it("opens a fresh welcome launch on chat even when terminal was the last remembered view", async () => {
    window.localStorage.setItem("hivra:agent-last-view", "terminal");
    mockSearchGet.mockImplementation((key: string) => (key === "welcome" ? "1" : null));

    render(<AgentPage />);

    expect(await screen.findByText("Chat panel")).toBeInTheDocument();
    expect(window.localStorage.getItem("hivra:agent-last-view")).toBe("chat");
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

    expect(await screen.findByRole("button", { name: /codex terminal/i })).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole("button", { name: /^connect$/i }));

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
    // The sticky chat/terminal memory is untouched by non-sticky deep links.
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
      proxmox_host: "fixturenode10",
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
        proxmoxHost: "fixturenode10",
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

  it("tells a computer with missing box credentials to update and restart instead of a false connection error", async () => {
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
    expect(await screen.findByText(/Secure access credentials for this computer/)).toBeInTheDocument();
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

});
