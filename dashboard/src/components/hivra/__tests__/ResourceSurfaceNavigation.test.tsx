/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ResourceSurfaceNavigation } from "../ResourceSurfaceNavigation";

const surfaces = ["chat", "terminal", "desktop", "files", "git", "skills", "box", "manage"]
  .map(id => ({ id, label: id, icon: null }));

it("keeps everyday surfaces visible and reveals every advanced surface on demand", () => {
  const onSelect = jest.fn();
  render(<ResourceSurfaceNavigation surfaces={surfaces} active="chat" onSelect={onSelect} exportHref="/api/hivra/agents/owned/export" />);
  expect(screen.getByRole("button", { name: "chat" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: "skills" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Tools" }));
  expect(screen.getByRole("link", { name: "Export data" })).toHaveAttribute("href", "/api/hivra/agents/owned/export");
  fireEvent.click(screen.getByRole("button", { name: "skills" }));
  expect(onSelect).toHaveBeenCalledWith("skills");
  expect(screen.queryByRole("button", { name: "skills" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Tools" })).toHaveFocus();
});

it("identifies a deep-linked tool and closes on Escape without changing its surface", () => {
  const onSelect = jest.fn();
  render(<ResourceSurfaceNavigation surfaces={surfaces} active="git" onSelect={onSelect} />);
  const trigger = screen.getByRole("button", { name: "Tools: git" });
  expect(trigger).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(trigger);
  const selected = screen.getByRole("button", { name: "git" });
  selected.focus();
  fireEvent.keyDown(selected, { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(onSelect).not.toHaveBeenCalled();
});

it("closes on outside interaction while preserving the selected surface", () => {
  const onSelect = jest.fn();
  render(<ResourceSurfaceNavigation surfaces={surfaces} active="desktop" onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "Tools" }));
  fireEvent.pointerDown(document.body);
  expect(screen.getByRole("button", { name: "Tools" })).toHaveAttribute("aria-expanded", "false");
  expect(onSelect).not.toHaveBeenCalled();
});

it.each(["chat", "manage"])("closes Tools when a keyboard user activates %s and keeps focus there", name => {
  const onSelect = jest.fn();
  render(<ResourceSurfaceNavigation surfaces={surfaces} active="desktop" onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "Tools" }));
  const destination = screen.getByRole("button", { name });
  destination.focus();
  // Keyboard activation emits a click without pointerdown outside the popover.
  fireEvent.click(destination);
  expect(onSelect).toHaveBeenCalledWith(name);
  expect(screen.getByRole("button", { name: "Tools" })).toHaveAttribute("aria-expanded", "false");
  expect(destination).toHaveFocus();
});

it("keeps the computer's short set of surfaces directly available", () => {
  render(<ResourceSurfaceNavigation surfaces={surfaces.filter(surface => ["desktop", "files", "box", "manage"].includes(surface.id))} active="desktop" onSelect={jest.fn()} />);
  expect(screen.getByRole("button", { name: "box" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Tools" })).not.toBeInTheDocument();
});

it("repositions an open menu when the usable screen space changes", () => {
  const bottomNav = document.createElement("nav");
  bottomNav.dataset.testid = "pwa-bottom-navigation";
  document.body.append(bottomNav);
  const { unmount } = render(<ResourceSurfaceNavigation surfaces={surfaces} active="chat" onSelect={jest.fn()} />);
  const trigger = screen.getByRole("button", { name: "Tools" });
  let anchorTop = 141;
  const anchorRect = jest.spyOn(trigger.parentElement!, "getBoundingClientRect").mockImplementation(() =>
    ({ top: anchorTop, bottom: anchorTop + 44, height: 44 } as DOMRect));
  const bottomRect = jest.spyOn(bottomNav, "getBoundingClientRect").mockReturnValue({ top: 504, bottom: 568, height: 64 } as DOMRect);
  try {
    fireEvent.click(trigger);
    const menu = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(menu.style.maxHeight).toBe("303px");
    anchorTop = 410;
    fireEvent(window, new Event("resize"));
    expect(menu.style.maxHeight).toBe("394px");
    expect(menu.style.bottom).toBe("calc(100% + 8px)");
  } finally {
    unmount();
    anchorRect.mockRestore();
    bottomRect.mockRestore();
    bottomNav.remove();
  }
});

it("closes Tools when a surface iframe takes focus, which never reaches the document", () => {
  render(<ResourceSurfaceNavigation surfaces={surfaces} active="terminal" onSelect={jest.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Tools" }));
  expect(screen.getByRole("button", { name: "Tools" })).toHaveAttribute("aria-expanded", "true");
  fireEvent(window, new Event("blur"));
  expect(screen.getByRole("button", { name: "Tools" })).toHaveAttribute("aria-expanded", "false");
});

it("closes Tools from the tap-catcher layer without selecting anything", () => {
  const onSelect = jest.fn();
  render(<ResourceSurfaceNavigation surfaces={surfaces} active="desktop" onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "Tools" }));
  const catcher = screen.getByTestId("surface-tools-catcher");
  // The layer must outlive pointerdown, or the tap's click lands on whatever
  // sits underneath (a pill, a frame) once it unmounts.
  fireEvent.pointerDown(catcher);
  fireEvent.pointerUp(catcher);
  expect(screen.getByTestId("surface-tools-catcher")).toBe(catcher);
  fireEvent.click(catcher);
  expect(screen.getByRole("button", { name: "Tools" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByTestId("surface-tools-catcher")).not.toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
});

describe("grouped agent surfaces: Chat · Computer · Manage", () => {
  const agentSurfaces = [
    { id: "chat", label: "Chat" }, { id: "terminal", label: "Codex session" },
    { id: "box", label: "Terminal" }, { id: "files", label: "Files" }, { id: "browser", label: "Browser" }, { id: "git", label: "Git" },
    { id: "manage", label: "Manage" }, { id: "skills", label: "Skills" },
  ].map(surface => ({ ...surface, icon: null }));
  const groups = [
    { id: "work", label: "Chat", icon: null, surfaces: ["chat", "terminal"] },
    { id: "computer", label: "Computer", icon: null, surfaces: ["box", "files", "browser", "git"] },
    { id: "manage", label: "Manage", icon: null, surfaces: ["manage", "skills"] },
  ];

  function Harness({ initial = "chat", exportHref }: { initial?: string; exportHref?: string }) {
    const [active, setActive] = useState(initial);
    return <ResourceSurfaceNavigation surfaces={agentSurfaces} groups={groups} active={active} onSelect={setActive}
      panelId="work-pane" exportHref={exportHref} groupNotes={{ computer: "On its own computer (Hivra Cloud · 1.5 CPU / 3 GB)" }} />;
  }

  it("shows three destinations and the active one's own views as tabs", () => {
    render(<Harness />);
    const nav = screen.getByRole("navigation", { name: "Resource surfaces" });
    expect(Array.from(nav.querySelectorAll("[data-surface-group]")).map(button => button.textContent)).toEqual(["Chat", "Computer", "Manage"]);
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tablist", { name: "Chat views" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Chat", "Codex session"]);
    expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-controls", "work-pane");
    // Nothing is hidden behind an overflow menu any more.
    expect(screen.queryByRole("button", { name: /^Tools/ })).not.toBeInTheDocument();
  });

  it("opens Terminal first under Computer, then reopens the view last used there", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Computer" }));
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Terminal", "Files", "Browser", "Git"]);
    expect(screen.getByText("On its own computer (Hivra Cloud · 1.5 CPU / 3 GB)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(screen.getByRole("tab", { name: "Manage" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Computer" }));
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  });

  it("always opens Chat from the Chat button, even after the agent's session was last used", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "Codex session" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  });

  it("moves between a group's views with the arrow keys and keeps focus on the chosen tab", () => {
    render(<Harness initial="box" />);
    const terminal = screen.getByRole("tab", { name: "Terminal" });
    terminal.focus();
    fireEvent.keyDown(terminal, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Git" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Git" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Git" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveFocus();
  });

  it("puts Export data with Manage, and drops groups the agent has no surface for", () => {
    render(<ResourceSurfaceNavigation surfaces={agentSurfaces.filter(surface => ["chat", "manage"].includes(surface.id))} groups={groups}
      active="manage" onSelect={jest.fn()} exportHref="/api/hivra/agents/owned/export" />);
    expect(screen.queryByRole("button", { name: "Computer" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Export data" })).toHaveAttribute("href", "/api/hivra/agents/owned/export");
  });
});
