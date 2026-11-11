/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { useEffect } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AgentTitleBar, type AgentTitleBarProps } from "../agent-shell/AgentTitleBar";
import { SurfaceActionProvider, createSurfaceActionStore } from "../SurfaceActionContext";

type Id = "desktop" | "browser" | "files" | "manage";
const all = (["desktop", "browser", "files", "manage"] as const).map((id) => ({
  id, label: { desktop: "Desktop", browser: "Browser", files: "Files", manage: "Manage" }[id], icon: <i data-icon={id} />,
}));

function bar(overrides: Partial<AgentTitleBarProps<Id>> = {}) {
  return <AgentTitleBar<Id> name="Site Builder" status="running" surfaces={all.slice(0, 3)} active="browser"
    onSelect={jest.fn()} panelId="agent-work-pane" actionSurface="browser" groupLabel="Computer" {...overrides} />;
}

describe("AgentTitleBar", () => {
  it("is one row with the name and a plain status word", () => {
    render(bar());
    const header = screen.getByRole("banner");
    expect(header).toHaveTextContent(/^Site Builderrunning/);
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("draws the segmented control only when the group has more than one surface", () => {
    const view = render(bar());
    const tabs = within(screen.getByRole("tablist", { name: "Computer views" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Desktop", "Browser", "Files"]);
    view.rerender(bar({ surfaces: all.slice(1, 2) }));
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    view.rerender(bar({ surfaces: [] }));
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("keeps tablist semantics: the open view controls the pane, arrows move between views", () => {
    const onSelect = jest.fn();
    render(bar({ onSelect }));
    const browser = screen.getByRole("tab", { name: "Browser" });
    expect(browser).toHaveAttribute("aria-selected", "true");
    expect(browser).toHaveAttribute("aria-controls", "agent-work-pane");
    expect(browser).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Desktop" })).not.toHaveAttribute("aria-controls");
    expect(screen.getByRole("tab", { name: "Desktop" })).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(browser, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("files");
    fireEvent.keyDown(browser, { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith("desktop");
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(onSelect).toHaveBeenLastCalledWith("files");
  });

  it("names the settings pane Settings inside its group", () => {
    render(bar({ surfaces: [all[3], { id: "files" as Id, label: "Files", icon: null }], active: "manage", groupLabel: "Settings" }));
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows the lifted actions of the active surface under the same slot id", () => {
    const store = createSurfaceActionStore();
    const onSelect = jest.fn();
    store.publish("browser", [{ id: "open-in-new-tab", label: "Open in new tab", icon: "external-link", onSelect }]);
    store.publish("desktop", [{ id: "open-in-new-tab", label: "Other surface action", icon: "external-link", onSelect: jest.fn() }]);
    render(<SurfaceActionProvider store={store}>{bar()}</SurfaceActionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open in new tab" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Other surface action" })).not.toBeInTheDocument();
  });

  it("follows a surface that publishes after the bar has rendered", () => {
    const store = createSurfaceActionStore();
    function Publisher() {
      useEffect(() => store.publish("browser", [{ id: "open-in-new-tab", label: "Open in new tab", icon: "external-link", onSelect: jest.fn() }]), []);
      return null;
    }
    render(<SurfaceActionProvider store={store}>{bar()}<Publisher /></SurfaceActionProvider>);
    expect(screen.getByRole("button", { name: "Open in new tab" })).toBeInTheDocument();
  });

  it("offers the export link, a note beside the status and the sidebar toggle only when given", () => {
    const onClick = jest.fn();
    const view = render(bar());
    expect(screen.queryByRole("link", { name: "Export data" })).not.toBeInTheDocument();
    expect(screen.queryByText("View only")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show sidebar" })).not.toBeInTheDocument();

    view.rerender(bar({ exportHref: "/api/hivra/agents/a/export", note: "View only", sidebarToggle: { onClick, controlsId: "side", expanded: false } }));
    expect(screen.getByRole("link", { name: "Export data" })).toHaveAttribute("href", "/api/hivra/agents/a/export");
    expect(screen.getByText("View only")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show sidebar" });
    expect(toggle).toHaveAttribute("aria-controls", "side");
    fireEvent.click(toggle);
    expect(onClick).toHaveBeenCalled();
  });

  it("puts where the agent runs in a tooltip on its name", () => {
    render(bar({ nameTitle: "Site Builder’s own computer · Hivra Cloud · 2 CPU / 4 GB" }));
    expect(screen.getByTitle("Site Builder’s own computer · Hivra Cloud · 2 CPU / 4 GB")).toHaveTextContent("Site Builder");
  });
});
