/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AgentShell } from "../agent-shell/AgentShell";
import type { AgentShellGroup } from "../agent-shell/useAgentSurfaceNav";

type Id = "aeon" | "desktop" | "files" | "box" | "manage";
const surfaces = (["aeon", "desktop", "files", "box", "manage"] as const).map((id) => ({
  id, label: { aeon: "Dashboard", desktop: "Desktop", files: "Files", box: "Terminal", manage: "Manage" }[id], icon: <i data-icon={id} />,
}));
const groups: AgentShellGroup<Id>[] = [
  { id: "work", label: "Dashboard", icon: null, surfaces: ["aeon"], home: "aeon" },
  { id: "computer", label: "Computer", icon: null, surfaces: ["desktop", "files", "box"], start: "files" },
  { id: "manage", label: "Settings", icon: null, surfaces: ["manage"], home: "manage" },
];

const openPill = () => fireEvent.click(screen.getByRole("button", { name: /Show controls$/ }));

function Page({ start, homeLabel, onSelect, chat = true }: { start: Id; homeLabel?: string; onSelect?: (id: Id) => void; chat?: boolean }) {
  const [active, setActive] = useState<Id>(start);
  return (
    <AgentShell<Id> name="Hermes 1" status="running" switcher={<span>Hermes 1</span>} surfaces={surfaces} groups={groups}
      active={active} onSelect={(id) => { onSelect?.(id); setActive(id); }} chatSurface={chat ? "aeon" : ("chat" as Id)} panelId="agent-work-pane" homeLabel={homeLabel}>
      <div data-testid="pane">{active}</div>
    </AgentShell>
  );
}

describe("AgentShell way back", () => {
  beforeEach(() => { try { window.localStorage.clear(); } catch { /* not needed */ } });

  it("shows no back button on the agent's own view", () => {
    render(<Page start="aeon" homeLabel="Hermes" />);
    expect(screen.queryByRole("button", { name: /^Back to/ })).not.toBeInTheDocument();
  });

  it("takes the owner from Terminal back to the agent's own view in one click, named after the agent", () => {
    const onSelect = jest.fn();
    render(<Page start="box" homeLabel="Hermes" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Back to Hermes" }));
    expect(onSelect).toHaveBeenLastCalledWith("aeon");
    expect(screen.getByTestId("pane")).toHaveTextContent("aeon");
    expect(screen.queryByRole("button", { name: /^Back to/ })).not.toBeInTheDocument();
  });

  it("offers the way back from Files, Desktop and Settings too, even with the sidebar hidden", () => {
    window.localStorage.setItem("hivra:agent-sidebar-collapsed", "true");
    for (const start of ["files", "desktop", "manage"] as const) {
      const view = render(<Page start={start} homeLabel="Hermes" />);
      expect(screen.getByRole("button", { name: "Back to Hermes" })).toBeInTheDocument();
      openPill();
      expect(screen.getByRole("button", { name: "Show sidebar" })).toBeInTheDocument();
      view.unmount();
    }
  });

  it("falls back to the first group's name when the page gives no label", () => {
    render(<Page start="files" />);
    expect(screen.getByRole("button", { name: "Back to Dashboard" })).toBeInTheDocument();
  });
});

describe("AgentShell pill", () => {
  beforeEach(() => { try { window.localStorage.clear(); window.localStorage.setItem("hivra:agent-pill-intro-seen", "1"); } catch { /* not needed */ } });
  const sidebar = () => document.querySelector("aside");

  it("has no title bar, and offers every view as a quick button: one for a single-view group, one per view otherwise", () => {
    render(<Page start="aeon" />);
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    openPill();
    const nav = within(screen.getByRole("navigation", { name: "Views" }));
    expect(nav.getAllByRole("button").map((button) => button.textContent)).toEqual(["Dashboard", "Desktop", "Files", "Terminal", "Settings"]);
    expect(nav.getByRole("button", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  });

  it("opens the chosen view and marks the one that is open", () => {
    const onSelect = jest.fn();
    render(<Page start="aeon" onSelect={onSelect} />);
    openPill();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Terminal" }));
    expect(onSelect).toHaveBeenLastCalledWith("box");
    expect(screen.getByTestId("pane")).toHaveTextContent("box");
    openPill();
    expect(within(screen.getByRole("navigation", { name: "Views" })).getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-current", "page");
  });

  it("shows the sidebar by default with a chat, and hides it without one", () => {
    const view = render(<Page start="aeon" />);
    expect(sidebar()).not.toHaveAttribute("hidden");
    view.unmount();
    render(<Page start="aeon" chat={false} />);
    expect(sidebar()).toHaveAttribute("hidden");
  });

  it("remembers the sidebar separately for a page with a chat and one without", () => {
    const view = render(<Page start="aeon" chat={false} />);
    openPill();
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(sidebar()).not.toHaveAttribute("hidden");
    expect(window.localStorage.getItem("hivra:agent-sidebar-collapsed:no-chat")).toBe("false");
    expect(window.localStorage.getItem("hivra:agent-sidebar-collapsed")).toBeNull();
    view.unmount();
    render(<Page start="aeon" chat={false} />);
    expect(sidebar()).not.toHaveAttribute("hidden");

  });

  it("hides the sidebar from the pill when the page has a chat, and remembers that under the chat key", () => {
    render(<Page start="aeon" />);
    openPill();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Hide sidebar" }));
    expect(sidebar()).toHaveAttribute("hidden");
    expect(window.localStorage.getItem("hivra:agent-sidebar-collapsed")).toBe("true");
    expect(window.localStorage.getItem("hivra:agent-sidebar-collapsed:no-chat")).toBeNull();
  });
});
