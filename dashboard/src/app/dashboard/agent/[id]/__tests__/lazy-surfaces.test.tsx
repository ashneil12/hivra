/** @jest-environment jsdom */
import "@testing-library/jest-dom";

// The desktop, DigitalOcean and Tasks code is only for computers, DigitalOcean
// sessions and the Tasks tab. A chat agent's page must open without loading
// it. Each mock records when its module loads, and every test gets a fresh
// copy of the page's modules (and so of its lazy loaders) and a fresh module
// registry for what those loaders fetch later, so nothing an earlier test
// loaded can hide what this one does.
const mockLoaded: string[] = [];
// Modules whose download fails, as when the connection drops or a new release
// replaced the file while the page was open.
const mockUnavailable = new Set<string>();
// A fault while drawing Tasks, as opposed to a failed download.
let mockTasksFault: Error | null = null;
let mockAgent: Record<string, unknown>;
let mockAgentLoad: () => Promise<unknown>;
let mockParams: Record<string, string> = {};

// Production's app router builds next/dynamic on React.lazy, which remembers
// a failed download; Jest would otherwise get the pages-router loader.
jest.mock("next/dynamic", () => jest.requireActual("next/dist/shared/lib/app-dynamic"));
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "agent_123" }),
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => ({ get: (key: string) => mockParams[key] ?? null }),
}));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraEnabled: () => true }));
jest.mock("@/lib/hivra/chat-readiness", () => ({ inspectChatReadiness: async () => "native_connected" }));
jest.mock("@/lib/hivra/agent-api", () => ({
  getAgent: () => mockAgentLoad(),
  listAgents: async () => [],
  boxLoginStatus: async () => ({ loggedIn: true }),
  browserStatus: async () => ({ enabled: false, error: null }),
  fetchPlanStrict: async () => null,
  telegramStatus: async () => ({ connected: true, active: true, ownerId: "1" }),
}));
jest.mock("@/components/hivra/HivraChat", () => ({ HivraChat: () => <div>Chat panel</div> }));
jest.mock("@/components/hivra/HivraManage", () => ({ HivraManage: () => <div>Manage panel</div> }));
jest.mock("@/components/hivra/HivraRemoteDesktop", () => {
  if (mockUnavailable.has("HivraRemoteDesktop")) throw new Error("Failed to load chunk HivraRemoteDesktop");
  mockLoaded.push("HivraRemoteDesktop");
  return { HivraRemoteDesktop: ({ active }: { active?: boolean }) => <div hidden={!active}>Remote desktop</div> };
});
jest.mock("@/components/hivra/HivraConsoleDesktop", () => {
  if (mockUnavailable.has("HivraConsoleDesktop")) throw new Error("Failed to load chunk HivraConsoleDesktop");
  mockLoaded.push("HivraConsoleDesktop");
  return { HivraConsoleDesktop: () => <div>Console desktop</div> };
});
jest.mock("@/components/hivra/HivraOmarchyDesktop", () => {
  if (mockUnavailable.has("HivraOmarchyDesktop")) throw new Error("Failed to load chunk HivraOmarchyDesktop");
  mockLoaded.push("HivraOmarchyDesktop");
  return { HivraOmarchyDesktop: () => <div>Omarchy desktop</div> };
});
jest.mock("@/components/hivra/DigitalOceanAgentWorkspace", () => {
  if (mockUnavailable.has("DigitalOceanAgentWorkspace")) throw new Error("Failed to load chunk DigitalOceanAgentWorkspace");
  mockLoaded.push("DigitalOceanAgentWorkspace");
  return { DigitalOceanAgentWorkspace: () => <div>DigitalOcean session</div> };
});
jest.mock("@/components/scheduled-tasks/TasksPanel", () => {
  if (mockUnavailable.has("TasksPanel")) throw new Error("Failed to load chunk TasksPanel");
  mockLoaded.push("TasksPanel");
  return {
    TasksPanel: () => {
      if (mockTasksFault) throw mockTasksFault;
      return <div>Tasks panel</div>;
    },
  };
});

type Loaded = {
  AgentPage: typeof import("../page").default;
  rtl: typeof import("@testing-library/react");
  React: typeof import("react");
};
let loaded: Loaded | null = null;
/** A fresh copy of the page and everything it imports (React included). */
function loadPage(): Loaded {
  // Cleanup is registered below; the library must not add its own hook mid-test.
  process.env.RTL_SKIP_AUTO_CLEANUP = "true";
  jest.isolateModules(() => {
    loaded = {
      rtl: jest.requireActual<typeof import("@testing-library/react")>("@testing-library/react"),
      AgentPage: jest.requireActual<typeof import("../page")>("../page").default,
      React: jest.requireActual<typeof import("react")>("react"),
    };
  });
  return loaded as unknown as Loaded;
}

beforeEach(() => {
  // A lazy loader fetches its module after isolateModules has returned, from
  // the shared registry; start that registry empty too.
  jest.resetModules();
  mockParams = {};
  mockTasksFault = null;
  mockLoaded.length = 0;
  mockUnavailable.clear();
  mockAgentLoad = async () => mockAgent;
  window.localStorage.clear();
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ agentKind: "codex", surfaceAuth: "post-cookie-v1" }),
  }) as unknown as typeof fetch;
});
afterEach(() => {
  loaded?.rtl.cleanup();
  loaded = null;
});

it("opens a chat agent without loading desktop, DigitalOcean or Tasks code", async () => {
  mockAgent = {
    id: "agent_123", type: "codex", name: "CODEX_AGENT", status: "running", cpu: 2, ram: 4,
    chat_url: "https://box.example.com", api_token: "box-token",
  };
  const { AgentPage, rtl } = loadPage();
  rtl.render(<AgentPage />);
  expect(await rtl.screen.findByText("Chat panel")).toBeInTheDocument();
  expect(mockLoaded).toEqual([]);
});

describe("a computer's desktop", () => {
  const UBUNTU = {
    id: "agent_123", type: "linux-desktop", computer_profile: "ubuntu-desktop", name: "UBUNTU", status: "running",
    cpu: 2, ram: 4, chat_url: "https://box.example.com", api_token: "box-token", computer_substrate: "proxmox-kvm",
  };
  /** Opens the computer on a tab; returns every piece of text shown meanwhile, however briefly. */
  async function openComputer(tab: string) {
    mockParams = { tab };
    mockAgent = UBUNTU;
    const { AgentPage, rtl } = loadPage();
    const shown: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) shown.push(node.textContent ?? "");
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      rtl.render(<AgentPage />);
      // The desktop stays mounted behind other tabs, so it loads either way.
      expect(await rtl.screen.findByText("Remote desktop")).toBeInTheDocument();
    } finally {
      observer.disconnect();
    }
    return { shown: shown.join("\n"), screen: rtl.screen };
  }

  it("shows its placeholder while the desktop code loads", async () => {
    const { shown, screen } = await openComputer("desktop");
    expect(shown).toContain("Opening your computer…");
    expect(screen.getByText("Remote desktop")).toBeVisible();
  });

  it("never shows that placeholder over another tab", async () => {
    const { shown, screen } = await openComputer("manage");
    expect(screen.getByText("Manage panel")).toBeVisible();
    expect(shown).not.toContain("Opening your computer…");
    expect(screen.getByText("Remote desktop")).not.toBeVisible();
  });
});

describe("a part of the page whose code can't download", () => {
  const CODEX = {
    id: "agent_123", type: "codex", name: "CODEX_AGENT", status: "running", cpu: 2, ram: 4,
    chat_url: "https://box.example.com", api_token: "box-token",
  };
  const UBUNTU = {
    id: "agent_123", type: "linux-desktop", computer_profile: "ubuntu-desktop", name: "UBUNTU", status: "running",
    cpu: 2, ram: 4, chat_url: "https://box.example.com", api_token: "box-token", computer_substrate: "proxmox-kvm",
  };
  const NOTICE = "Couldn’t load this part of the page";

  /** Renders the page under a stand-in for the dashboard's own error page. */
  function openPage() {
    const { AgentPage, rtl, React } = loadPage();
    class DashboardErrorPage extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
      state = { error: null as Error | null };
      static getDerivedStateFromError(error: Error) { return { error }; }
      render() {
        return this.state.error ? <p>Dashboard error page: {this.state.error.message}</p> : this.props.children;
      }
    }
    rtl.render(<DashboardErrorPage><AgentPage /></DashboardErrorPage>);
    return rtl;
  }

  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    // React reports the caught failure; the page logs it too.
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => consoleError.mockRestore());

  it("says so where Tasks would be, and the tabs and chat keep working", async () => {
    mockAgent = CODEX;
    mockParams = { tab: "tasks" };
    mockUnavailable.add("TasksPanel");
    const { screen, fireEvent } = openPage();

    expect(await screen.findByText(NOTICE)).toBeVisible();
    expect(screen.queryByText(/Dashboard error page/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Chat/ }));
    expect(await screen.findByText("Chat panel")).toBeVisible();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it("offers a reload, which is what fetches the code again", async () => {
    mockAgent = CODEX;
    mockParams = { tab: "tasks" };
    mockUnavailable.add("TasksPanel");
    const { screen, fireEvent } = openPage();

    fireEvent.click(await screen.findByRole("button", { name: "Reload page" }));
    // jsdom can't navigate; it reports the reload the page asked for.
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Not implemented: navigation (except hash changes)",
    }));
  });

  it("says so on the desktop only while Desktop is open", async () => {
    mockAgent = UBUNTU;
    mockParams = { tab: "manage" };
    mockUnavailable.add("HivraRemoteDesktop");
    const { screen, fireEvent } = openPage();

    expect(await screen.findByText("Manage panel")).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByText(/Dashboard error page/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Desktop/ }));
    expect(await screen.findByText(NOTICE)).toBeVisible();
    expect(screen.queryByText("Opening your computer…")).not.toBeInTheDocument();
  });

  it("says so in place of a DigitalOcean session", async () => {
    mockAgent = { ...CODEX, computer_substrate: "do-managed-session" };
    mockUnavailable.add("DigitalOceanAgentWorkspace");
    const { screen } = openPage();

    expect(await screen.findByText(NOTICE)).toBeVisible();
    expect(screen.queryByText(/Dashboard error page/)).not.toBeInTheDocument();
  });

  it("still sends a fault inside a part that did download to the dashboard's error page", async () => {
    mockAgent = CODEX;
    mockParams = { tab: "tasks" };
    mockTasksFault = new Error("Tasks broke while drawing");
    const { screen } = openPage();
    expect(await screen.findByText("Dashboard error page: Tasks broke while drawing")).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});

describe("a computer opened on its desktop", () => {
  /** Opens the page with its record still on its way; returns what loaded meanwhile. */
  async function loadedBeforeRecord(params: Record<string, string>) {
    mockParams = params;
    mockAgentLoad = () => new Promise(() => undefined);
    const { AgentPage, rtl } = loadPage();
    rtl.render(<AgentPage />);
    expect(await rtl.screen.findByText("Opening your workspace…")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [...mockLoaded];
  }

  it("starts downloading the desktop alongside the computer's record", async () => {
    expect(await loadedBeforeRecord({ tab: "desktop" })).toEqual(["HivraRemoteDesktop"]);
  });

  it("starts downloading the Windows desktop for a fast Windows link", async () => {
    expect(await loadedBeforeRecord({ tab: "desktop", open: "fast" })).toEqual(["HivraConsoleDesktop"]);
  });

  it.each<Record<string, string>>([{ tab: "manage" }, { tab: "chat" }, {}])("downloads nothing early for %j", async (params) => {
    expect(await loadedBeforeRecord(params)).toEqual([]);
  });
});
