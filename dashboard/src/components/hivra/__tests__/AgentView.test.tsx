/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AppShellProvider } from "@/components/layout/AppShell";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { AppTitleBar } from "@/components/layout/AppTitleBar";
import { useAppShell } from "@/components/layout/AppShellContext";
import { AgentView } from "../agent-shell/AgentView";
import { useAgentChatListSlot } from "../agent-shell/AgentChatListSlot";
import { agentViewRows, type AgentSurfaceId } from "@/lib/agent-computers/agent-surfaces";

jest.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/agent/a",
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/components/layout/useDashboardResources", () => ({
  useDashboardResources: () => ({
    resources: [{ uid: "x-a", id: "a", source: "hivra", kind: "agent", name: "Site Builder", description: "Claude Code", status: "running", href: "/dashboard/agent/a" }],
    loading: false, errors: { hermes: null, hivra: null }, refresh: jest.fn(),
  }),
}));
jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark", setTheme: jest.fn() }) }));

const IDS: AgentSurfaceId[] = ["chat", "terminal", "browser", "desktop", "files", "box", "manage", "skills"];
const LABELS: Record<string, string> = { chat: "Chat", terminal: "Codex session", browser: "Browser", desktop: "Desktop", files: "Files", box: "Terminal", manage: "Manage", skills: "Skills" };

function mockViewport(narrow: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: narrow && query === "(max-width: 767px)", media: query, onchange: null,
      addListener: jest.fn(), removeListener: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn(), dispatchEvent: jest.fn(),
    }),
  });
}

/** A chat that puts its list in the sidebar's slot, as HivraChat does. */
function ChatList() {
  const slot = useAgentChatListSlot();
  if (!slot?.element) return <p>Inline chat list</p>;
  return createPortal(<button type="button" onClick={slot.onChatOpened}>Plan my week</button>, slot.element);
}

function Page({ onActive }: { onActive?: (id: string) => void }) {
  const [active, setActive] = useState<AgentSurfaceId>("browser");
  const surfaces = IDS.map((id) => ({ id, label: LABELS[id], icon: <i data-icon={id} /> }));
  const rows = agentViewRows(IDS).map((row) => ({ ...row, icon: <i data-icon={row.id} /> }));
  return (
    <AgentView name="Site Builder" status="running" surfaces={surfaces} rows={rows} active={active}
      onSelect={(id) => { setActive(id); onActive?.(id); }} chatSurface="chat" panelId="pane"
      exportHref="/export" surfaceNote={{ browser: "View only" }}>
      <div id="pane">Active: {active}</div>
      <ChatList />
    </AgentView>
  );
}

function Shell({ children, chrome = true }: { children: ReactNode; chrome?: boolean }) {
  return (
    <AppShellProvider openSwitcher={jest.fn()} userName="Ash" chrome={chrome}>
      <AppSidebar owner="owner" />
      <AppTitleBar owner="owner" />
      {children}
    </AppShellProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  mockViewport(false);
});

describe("AgentView in the web shell", () => {
  it("puts the agent's views as rows under its own entry in the sidebar", () => {
    render(<Shell><Page /></Shell>);
    const open = screen.getByRole("link", { name: /Site Builder/ });
    const views = within(open.parentElement as HTMLElement).getByRole("navigation", { name: "Views" });
    // Browser is its own row; Computer is the desktop alone; the session is a view of Chat, not a row.
    expect(Array.from(views.querySelectorAll("[data-view-row]")).map((row) => row.textContent))
      .toEqual(["Chat", "Browser", "Computer", "Files", "Terminal", "Settings"]);
    expect(within(views).getByRole("button", { name: "Browser" })).toHaveAttribute("aria-current", "page");
  });

  it("opens a row's first view, and the title bar holds the views of Chat and Settings", () => {
    render(<Shell><Page /></Shell>);
    const views = screen.getByRole("navigation", { name: "Views" });
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    fireEvent.click(within(views).getByRole("button", { name: "Chat" }));
    expect(screen.getByText("Active: chat")).toBeInTheDocument();
    expect(within(screen.getByRole("tablist", { name: "Chat views" })).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Chat", "Codex session"]);
    fireEvent.click(screen.getByRole("tab", { name: "Codex session" }));
    expect(screen.getByText("Active: terminal")).toBeInTheDocument();
    // The row still marks Chat while its session is open.
    expect(within(views).getByRole("button", { name: "Chat" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(views).getByRole("button", { name: "Settings" }));
    expect(within(screen.getByRole("tablist", { name: "Settings views" })).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Settings", "Skills"]);
    expect(screen.getByRole("link", { name: "Export data" })).toBeInTheDocument();
    fireEvent.click(within(views).getByRole("button", { name: "Files" }));
    expect(screen.queryByRole("link", { name: "Export data" })).not.toBeInTheDocument();
  });

  it("shows the name once with a status word and the active view's note in the title bar", () => {
    render(<Shell><Page /></Shell>);
    const bar = screen.getByTestId("app-title-bar");
    expect(bar).toHaveTextContent(/^Site Builderrunning/);
    expect(within(bar).getByText("View only")).toBeInTheDocument();
    // The layout's own title steps aside while the page fills the bar.
    expect(within(bar).getAllByText("Site Builder")).toHaveLength(1);
  });

  it("brings the layout's title back when the page leaves", () => {
    const view = render(<Shell><Page /></Shell>);
    view.rerender(<Shell><p>Another page</p></Shell>);
    expect(within(screen.getByTestId("app-title-bar")).getByText("Site Builder")).toBeInTheDocument();
    expect(screen.getByTestId("app-title-bar")).not.toHaveTextContent("View only");
  });

  it("puts the chat's list indented under the Chat row, through the slot", () => {
    render(<Shell><Page /></Shell>);
    const chat = screen.getByRole("button", { name: "Chat" });
    const list = chat.parentElement?.querySelector("[data-agent-chat-list]");
    expect(list).toContainElement(screen.getByRole("button", { name: "Plan my week" }));
    expect(screen.queryByText("Inline chat list")).not.toBeInTheDocument();
    // Opening a chat from the list shows the Chat view.
    fireEvent.click(screen.getByRole("button", { name: "Plan my week" }));
    expect(screen.getByText("Active: chat")).toBeInTheDocument();
  });

  it("closes a phone drawer behind a row and behind a chat", () => {
    mockViewport(true);
    function Menu() {
      const shell = useAppShell();
      return <button type="button" onClick={shell?.openSidebar}>Menu</button>;
    }
    render(<Shell><Menu /><Page /></Shell>);
    const open = () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Menu" })[0]);
      return screen.getByRole("dialog", { name: "Workspace navigation" });
    };
    fireEvent.click(within(open()).getByRole("button", { name: "Files" }));
    expect(screen.getByText("Active: files")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Workspace navigation" })).not.toBeInTheDocument();
    fireEvent.click(within(open()).getByRole("button", { name: "Plan my week" }));
    expect(screen.getByText("Active: chat")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Workspace navigation" })).not.toBeInTheDocument();
  });
});

describe("AgentView without the web shell", () => {
  it("falls back to the flat surface bar, with the chat list kept inline", () => {
    render(
      <AppShellProvider openSwitcher={jest.fn()} userName="Ash" chrome={false}>
        <Page />
      </AppShellProvider>,
    );
    expect(screen.queryByRole("navigation", { name: "Views" })).not.toBeInTheDocument();
    expect(screen.getByText("Inline chat list")).toBeInTheDocument();
    expect(screen.getByText("Active: browser")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
  });

  it("renders on its own, outside any layout", () => {
    render(<Page />);
    expect(screen.getByText("Active: browser")).toBeInTheDocument();
  });
});
