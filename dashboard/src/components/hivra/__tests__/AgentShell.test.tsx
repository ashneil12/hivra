/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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

function Page({ start, homeLabel, onSelect }: { start: Id; homeLabel?: string; onSelect?: (id: Id) => void }) {
  const [active, setActive] = useState<Id>(start);
  return (
    <AgentShell<Id> name="Hermes 1" status="running" switcher={<span>Hermes 1</span>} surfaces={surfaces} groups={groups}
      active={active} onSelect={(id) => { onSelect?.(id); setActive(id); }} chatSurface="aeon" panelId="agent-work-pane" homeLabel={homeLabel}>
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
      expect(screen.getByRole("button", { name: "Show sidebar" })).toBeInTheDocument();
      view.unmount();
    }
  });

  it("falls back to the first group's name when the page gives no label", () => {
    render(<Page start="files" />);
    expect(screen.getByRole("button", { name: "Back to Dashboard" })).toBeInTheDocument();
  });
});
