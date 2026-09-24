/** @jest-environment jsdom */
import "@testing-library/jest-dom";

// The desktop, DigitalOcean, Tasks and paywall code is only for computers,
// DigitalOcean sessions, the Tasks tab and the browser paywall. A chat agent's
// page must open without loading it. Each mock records when its module loads,
// and every test gets a fresh copy of the page's modules (and so of its lazy
// loaders), so nothing an earlier test loaded can hide what this one does.
const mockLoaded: string[] = [];
let mockAgent: Record<string, unknown>;
let mockTab: string | null = null;

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "agent_123" }),
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => ({ get: (key: string) => (key === "tab" ? mockTab : null) }),
}));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraEnabled: () => true }));
jest.mock("@/lib/hivra/chat-readiness", () => ({ inspectChatReadiness: async () => "native_connected" }));
jest.mock("@/lib/hivra/agent-api", () => ({
  getAgent: async () => mockAgent,
  listAgents: async () => [],
  boxLoginStatus: async () => ({ loggedIn: true }),
  browserStatus: async () => ({ enabled: false, error: null }),
  fetchPlanStrict: async () => null,
  telegramStatus: async () => ({ connected: true, active: true, ownerId: "1" }),
}));
jest.mock("@/components/hivra/HivraChat", () => ({ HivraChat: () => <div>Chat panel</div> }));
jest.mock("@/components/hivra/HivraManage", () => ({ HivraManage: () => <div>Manage panel</div> }));
jest.mock("@/components/hivra/HivraRemoteDesktop", () => {
  mockLoaded.push("HivraRemoteDesktop");
  return { HivraRemoteDesktop: ({ active }: { active?: boolean }) => <div hidden={!active}>Remote desktop</div> };
});
jest.mock("@/components/hivra/HivraConsoleDesktop", () => {
  mockLoaded.push("HivraConsoleDesktop");
  return { HivraConsoleDesktop: () => <div>Console desktop</div> };
});
jest.mock("@/components/hivra/HivraOmarchyDesktop", () => {
  mockLoaded.push("HivraOmarchyDesktop");
  return { HivraOmarchyDesktop: () => <div>Omarchy desktop</div> };
});
jest.mock("@/components/hivra/DigitalOceanAgentWorkspace", () => {
  mockLoaded.push("DigitalOceanAgentWorkspace");
  return { DigitalOceanAgentWorkspace: () => <div>DigitalOcean session</div> };
});
jest.mock("@/components/scheduled-tasks/TasksPanel", () => {
  mockLoaded.push("TasksPanel");
  return { TasksPanel: () => <div>Tasks panel</div> };
});

type Loaded = { AgentPage: typeof import("../page").default; rtl: typeof import("@testing-library/react") };
let loaded: Loaded | null = null;
/** A fresh copy of the page and everything it imports (React included). */
function loadPage(): Loaded {
  // Cleanup is registered below; the library must not add its own hook mid-test.
  process.env.RTL_SKIP_AUTO_CLEANUP = "true";
  jest.isolateModules(() => {
    loaded = {
      rtl: jest.requireActual<typeof import("@testing-library/react")>("@testing-library/react"),
      AgentPage: jest.requireActual<typeof import("../page")>("../page").default,
    };
  });
  return loaded as unknown as Loaded;
}

beforeEach(() => {
  mockTab = null;
  mockLoaded.length = 0;
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
    mockTab = tab;
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
