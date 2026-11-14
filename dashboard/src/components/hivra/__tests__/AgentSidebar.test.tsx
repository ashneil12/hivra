/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { createPortal } from "react-dom";
import { useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { AgentSidebar, type AgentSidebarProps } from "../agent-shell/AgentSidebar";
import { AgentShell } from "../agent-shell/AgentShell";
import { useAgentChatListSlot } from "../agent-shell/AgentChatListSlot";
import { AppShellContext } from "@/components/layout/AppShellContext";

jest.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark", setTheme: jest.fn() }) }));

type Id = "chat" | "terminal" | "desktop" | "files" | "manage";
const surfaces = (["chat", "terminal", "desktop", "files", "manage"] as const).map((id) => ({
  id, label: { chat: "Chat", terminal: "Codex session", desktop: "Desktop", files: "Files", manage: "Manage" }[id], icon: <i data-icon={id} />,
}));
const groups = [
  { id: "work", label: "Chat", icon: <i />, surfaces: ["chat", "terminal"] as Id[], home: "chat" as Id },
  { id: "computer", label: "Computer", icon: <i />, surfaces: ["desktop", "files"] as Id[], start: "files" as Id },
  { id: "manage", label: "Settings", icon: <i />, surfaces: ["manage"] as Id[], home: "manage" as Id },
];

function sidebarProps(overrides: Partial<AgentSidebarProps<Id>> = {}): AgentSidebarProps<Id> {
  return {
    id: "agent-sidebar", switcher: <button type="button">Switch agent or computer: Site Builder</button>,
    surfaces, groups, activeGroupId: "work", active: "chat", onOpenGroup: jest.fn(), onSelectSurface: jest.fn(),
    hasChat: true, chatSlotRef: jest.fn(), mode: "inline", collapsed: false, open: false, onClose: jest.fn(), ...overrides,
  };
}

function withShell(children: ReactNode, openSwitcher = jest.fn()) {
  return <AppShellContext.Provider value={{ openSwitcher, userName: "Ash" }}>{children}</AppShellContext.Provider>;
}

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

beforeEach(() => {
  window.localStorage.clear();
  mockViewport(false);
});

describe("AgentSidebar", () => {
  it("shows one row per group, marks the open one, and reports the choice", () => {
    const props = sidebarProps();
    render(withShell(<AgentSidebar {...props} />));
    const nav = screen.getByRole("navigation", { name: "Resource surfaces" });
    const rows = Array.from(nav.querySelectorAll("[data-surface-group]"));
    expect(rows.map((row) => row.textContent)).toEqual(["Chat", "Computer", "Settings"]);
    expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual(["page", null, null]);
    fireEvent.click(within(nav).getByRole("button", { name: "Computer" }));
    expect(props.onOpenGroup).toHaveBeenCalledWith(expect.objectContaining({ id: "computer" }));
  });

  it("lists a computer's own surfaces as rows when it has no groups", () => {
    const props = sidebarProps({ groups: [], activeGroupId: null, active: "files", hasChat: false });
    render(withShell(<AgentSidebar {...props} />));
    const nav = screen.getByRole("navigation", { name: "Resource surfaces" });
    expect(within(nav).getAllByRole("button").map((row) => row.textContent))
      .toEqual(["Chat", "Codex session", "Desktop", "Files", "Settings"]);
    expect(within(nav).getByRole("button", { name: "Files" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(nav).getByRole("button", { name: "Desktop" }));
    expect(props.onSelectSurface).toHaveBeenCalledWith("desktop");
  });

  it("draws the Chats section, with the slot element, only for an agent that has a chat", () => {
    const chatSlotRef = jest.fn();
    const view = render(withShell(<AgentSidebar {...sidebarProps({ chatSlotRef })} />));
    const section = screen.getByRole("region", { name: "Chats" });
    expect(chatSlotRef).toHaveBeenCalledWith(section.querySelector("[data-agent-chat-list]"));
    view.rerender(withShell(<AgentSidebar {...sidebarProps({ chatSlotRef, hasChat: false })} />));
    expect(screen.queryByRole("region", { name: "Chats" })).not.toBeInTheDocument();
  });

  it("does not draw a New chat control of its own: the chat's list brings it", () => {
    render(withShell(<AgentSidebar {...sidebarProps()} />));
    expect(screen.queryByRole("button", { name: /new chat/i })).not.toBeInTheDocument();
  });

  it("opens the layout's switcher from Search and leaves home and the account to the rail beside it", () => {
    const openSwitcher = jest.fn();
    render(withShell(<AgentSidebar {...sidebarProps()} />, openSwitcher));
    fireEvent.click(screen.getByRole("button", { name: "Search agents and computers" }));
    expect(openSwitcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link", { name: "Hivra home" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Home" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("mock-user-button")).not.toBeInTheDocument();
  });

  it("as a phone drawer, where there is no rail, links home and shows the account", () => {
    const onClose = jest.fn();
    render(withShell(<AgentSidebar {...sidebarProps()} mode="drawer" open onClose={onClose} />, jest.fn()));
    expect(screen.getByRole("link", { name: "Hivra home" })).toHaveAttribute("href", "/dashboard");
    const home = screen.getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("href", "/dashboard");
    expect(screen.getByText("Ash")).toBeInTheDocument();
    expect(screen.getByTestId("mock-user-button")).toBeInTheDocument();
    fireEvent.click(home);
    expect(onClose).toHaveBeenCalled();
  });

  it("leaves Search out where there is no layout to open", () => {
    render(<AgentSidebar {...sidebarProps()} />);
    expect(screen.queryByRole("button", { name: "Search agents and computers" })).not.toBeInTheDocument();
  });
});

/** A chat that portals its list into the sidebar's slot, as HivraChat does. */
function SlotChat() {
  const slot = useAgentChatListSlot();
  return slot?.element
    ? createPortal(<button type="button" onClick={slot.onChatOpened}>Plan my week</button>, slot.element)
    : <span>inline list</span>;
}

function Shell({ initialActive = "files" as Id }) {
  const [active, setActive] = useState<Id>(initialActive);
  return withShell(
    <AgentShell<Id> name="Site Builder" status="running" switcher={<button type="button">Switch agent or computer: Site Builder</button>}
      surfaces={surfaces} groups={groups} active={active} onSelect={setActive} chatSurface="chat" panelId="pane">
      <div id="pane" data-active={active}><SlotChat /></div>
    </AgentShell>,
  );
}

/** The floating pill's dropdown, opened if it is not already. */
function pillMenu() {
  if (!screen.queryByRole("dialog", { name: "Site Builder controls" })) fireEvent.click(screen.getByRole("button", { name: /Show controls$/ }));
  return within(screen.getByRole("dialog", { name: "Site Builder controls" }));
}

describe("AgentShell around the sidebar", () => {
  beforeEach(() => { window.localStorage.setItem("hivra:agent-pill-intro-seen", "1"); });

  it("provides the chat list element, and a chat opened from it shows the Chat surface", () => {
    render(<Shell />);
    const slot = document.querySelector("[data-agent-chat-list]") as HTMLElement;
    const item = within(slot).getByRole("button", { name: "Plan my week" });
    expect(screen.queryByText("inline list")).not.toBeInTheDocument();
    expect(document.getElementById("pane")).toHaveAttribute("data-active", "files");
    fireEvent.click(item);
    expect(document.getElementById("pane")).toHaveAttribute("data-active", "chat");
  });

  it("opens a group on its home surface, else the one last used in it", () => {
    render(<Shell initialActive="chat" />);
    const nav = screen.getByRole("navigation", { name: "Resource surfaces" });
    fireEvent.click(within(nav).getByRole("button", { name: "Computer" }));
    expect(document.getElementById("pane")).toHaveAttribute("data-active", "files");
    fireEvent.click(within(pillMenu().getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Desktop" }));
    fireEvent.click(within(nav).getByRole("button", { name: "Chat" }));
    expect(document.getElementById("pane")).toHaveAttribute("data-active", "chat");
    fireEvent.click(within(nav).getByRole("button", { name: "Computer" }));
    expect(document.getElementById("pane")).toHaveAttribute("data-active", "desktop");
  });

  it("collapses the sidebar, brings it back from the pill, and remembers the choice", () => {
    const view = render(<Shell />);
    const sidebar = () => screen.queryByRole("complementary", { name: "Agent navigation" });
    expect(sidebar()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(sidebar()).not.toBeInTheDocument();
    expect(window.localStorage.getItem("hivra:agent-sidebar-collapsed")).toBe("true");
    // Hidden, not unmounted: the chat's list stays where it was.
    expect(document.querySelector("[data-agent-chat-list]")).toBeInTheDocument();

    view.unmount();
    render(<Shell />);
    expect(sidebar()).not.toBeInTheDocument();
    fireEvent.click(pillMenu().getByRole("button", { name: "Show sidebar" }));
    expect(sidebar()).toBeInTheDocument();
    expect(window.localStorage.getItem("hivra:agent-sidebar-collapsed")).toBe("false");
  });

  it("keeps working when the browser refuses to store the preference", () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    render(<Shell />);
    expect(screen.getByRole("complementary", { name: "Agent navigation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(screen.queryByRole("complementary", { name: "Agent navigation" })).not.toBeInTheDocument();
    jest.restoreAllMocks();
  });

  describe("below 768px, as a drawer", () => {
    beforeEach(() => mockViewport(true));

    it("starts closed, opens from the pill as a modal dialog and closes on Escape", () => {
      render(<Shell />);
      expect(screen.queryByRole("dialog", { name: "Agent navigation" })).not.toBeInTheDocument();
      fireEvent.click(pillMenu().getByRole("button", { name: "Show sidebar" }));
      const drawer = screen.getByRole("dialog", { name: "Agent navigation" });
      expect(drawer).toHaveAttribute("aria-modal", "true");
      expect(drawer.contains(document.activeElement)).toBe(true);

      fireEvent.keyDown(drawer, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Agent navigation" })).not.toBeInTheDocument();
    });

    it("closes from the backdrop, and behind a choice", () => {
      render(<Shell initialActive="chat" />);
      fireEvent.click(pillMenu().getByRole("button", { name: "Show sidebar" }));
      fireEvent.click(screen.getByTestId("agent-sidebar-backdrop"));
      expect(screen.queryByRole("dialog", { name: "Agent navigation" })).not.toBeInTheDocument();

      fireEvent.click(pillMenu().getByRole("button", { name: "Show sidebar" }));
      fireEvent.click(within(screen.getByRole("navigation", { name: "Resource surfaces" })).getByRole("button", { name: "Computer" }));
      expect(screen.queryByRole("dialog", { name: "Agent navigation" })).not.toBeInTheDocument();
      expect(document.getElementById("pane")).toHaveAttribute("data-active", "files");
    });

    it("keeps Tab inside the open drawer", () => {
      render(<Shell />);
      fireEvent.click(pillMenu().getByRole("button", { name: "Show sidebar" }));
      const drawer = screen.getByRole("dialog", { name: "Agent navigation" });
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
      const last = focusable[focusable.length - 1];
      last.focus();
      fireEvent.keyDown(last, { key: "Tab" });
      expect(document.activeElement).toBe(focusable[0]);
      fireEvent.keyDown(focusable[0], { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(last);
    });

    it("does not touch the remembered desktop preference", () => {
      render(<Shell />);
      fireEvent.click(pillMenu().getByRole("button", { name: "Show sidebar" }));
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      act(() => undefined);
      expect(window.localStorage.getItem("hivra:agent-sidebar-collapsed")).toBeNull();
    });
  });
});
