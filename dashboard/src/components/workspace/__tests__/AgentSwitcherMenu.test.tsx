/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";

import { AgentSwitcherMenu } from "../AgentSwitcherMenu";
import type { UnifiedAgent } from "@/lib/hivra/unified-agent";

function agent(uid: string, name: string): UnifiedAgent {
  return {
    uid, kind: "hivra", id: uid.slice(2), name, statusRaw: "running", state: "running",
    dot: "#22c55e", vendor: "OpenAI", typeLabel: "Codex", resourceKind: "agent",
  };
}

const agents = [agent("x-one", "One"), agent("x-two", "Two"), agent("x-three", "Three")];

function setPointer(coarse: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: coarse && query.includes("coarse"), media: query }) as MediaQueryList,
  });
}

function renderMenu(onClose = jest.fn(), onSelect = jest.fn()) {
  const anchorRef = createRef<HTMLButtonElement>();
  const anchor = document.createElement("button");
  document.body.append(anchor);
  (anchorRef as { current: HTMLButtonElement | null }).current = anchor;
  jest.spyOn(anchor, "getBoundingClientRect").mockReturnValue({ top: 40, bottom: 84, left: 8, right: 320, width: 312, height: 44 } as DOMRect);
  render(
    <AgentSwitcherMenu open agents={agents} selectedUid="x-two" loading={false} hermesError={null} hivraError={null}
      anchorRef={anchorRef} onSelect={onSelect} onClose={onClose} onRetryHermes={jest.fn()} onRetryHivra={jest.fn()} />,
  );
  return { anchor, onClose, onSelect };
}

describe("AgentSwitcherMenu on touch", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = "";
    delete (window as { visualViewport?: unknown }).visualViewport;
  });

  it("focuses the search for a mouse and keyboard", async () => {
    setPointer(false);
    renderMenu();
    expect(await screen.findByRole("combobox", { name: "Search your agents and computers" })).toHaveFocus();
  });

  it("keeps the keyboard down on touch and lands on the current runtime", async () => {
    setPointer(true);
    renderMenu();
    await screen.findByRole("dialog", { name: "Switch agent or computer" });
    expect(screen.getByRole("combobox", { name: "Search your agents and computers" })).not.toHaveFocus();
    expect(screen.getByRole("option", { name: /Two/ })).toHaveFocus();
  });

  it("sizes the menu to the visible area above an on-screen keyboard", async () => {
    setPointer(true);
    const listeners: Record<string, () => void> = {};
    const viewport = {
      offsetTop: 0, height: 667,
      addEventListener: (type: string, listener: () => void) => { listeners[type] = listener; },
      removeEventListener: jest.fn(),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 667 });
    renderMenu();
    const dialog = await screen.findByRole("dialog", { name: "Switch agent or computer" });
    expect(dialog.style.getPropertyValue("--agent-menu-max-height")).toBe("420px");
    viewport.height = 380;
    act(() => listeners.resize());
    // 380 visible - 84 anchor bottom - 4 offset - 8 margin.
    expect(dialog.style.getPropertyValue("--agent-menu-max-height")).toBe("284px");
  });

  it("closes when an iframe takes focus away from the page, without asking for focus back", async () => {
    setPointer(false);
    const { onClose } = renderMenu();
    await screen.findByRole("dialog", { name: "Switch agent or computer" });
    act(() => window.dispatchEvent(new Event("blur")));
    expect(onClose).toHaveBeenCalledWith({ restoreFocus: false });
  });

  it("walks the list with a hardware keyboard when touch focus starts on an option", async () => {
    setPointer(true);
    const { onSelect } = renderMenu();
    const current = await screen.findByRole("option", { name: /Two/ });
    expect(current).toHaveFocus();
    fireEvent.keyDown(current, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Three/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(screen.getByRole("option", { name: /One/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: /Three/ })).toHaveFocus();
    // A focused option is a button; Enter activates it natively, not twice.
    expect(fireEvent.keyDown(document.activeElement!, { key: "Enter" })).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps the anchor's last position when the anchor is hidden", async () => {
    setPointer(true);
    const { anchor } = renderMenu();
    const dialog = await screen.findByRole("dialog", { name: "Switch agent or computer" });
    const placed = { top: dialog.style.top, left: dialog.style.left, width: dialog.style.width };
    jest.spyOn(anchor, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect);
    act(() => window.dispatchEvent(new Event("resize")));
    expect({ top: dialog.style.top, left: dialog.style.left, width: dialog.style.width }).toEqual(placed);
  });

  it("gives the search a full-row tap target and no iOS autocorrect", async () => {
    setPointer(true);
    renderMenu();
    const search = await screen.findByRole("combobox", { name: "Search your agents and computers" });
    expect(search.closest("label")).not.toBeNull();
    expect(search).toHaveAttribute("autocapitalize", "none");
    expect(search).toHaveAttribute("autocorrect", "off");
    expect(search).toHaveAttribute("spellcheck", "false");
    expect(search).toHaveAttribute("enterkeyhint", "search");
  });
});
