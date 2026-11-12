/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { AgentPill, type AgentPillProps } from "../agent-shell/AgentPill";
import { SurfaceActionProvider, createSurfaceActionStore } from "../SurfaceActionContext";

// jsdom has no PointerEvent: a mouse event with the same name carries the coordinates.
if (typeof window.PointerEvent === "undefined") {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, writable: true, value: TestPointerEvent });
}

jest.mock("@/components/ui/ThinkingOrb", () => ({ ThinkingOrb: () => <i data-testid="orb" /> }));

const INTRO_KEY = "hivra:agent-pill-intro-seen";
const OFFSET_KEY = "hivra:agent-pill-offset";

function setup(overrides: Partial<AgentPillProps> = {}) {
  const onSelect = { chat: jest.fn(), files: jest.fn(), box: jest.fn() };
  const props: AgentPillProps = {
    name: "Hermes 1", status: "running", actionSurface: "chat",
    views: [
      { key: "chat", label: "Chat", icon: <i />, active: true, onSelect: onSelect.chat },
      { key: "files", label: "Files", icon: <i />, active: false, onSelect: onSelect.files },
      { key: "box", label: "Terminal", icon: <i />, active: false, onSelect: onSelect.box },
    ],
    ...overrides,
  };
  const view = render(<AgentPill {...props} />);
  return { ...view, props, onSelect, rerenderWith: (next: Partial<AgentPillProps>) => view.rerender(<AgentPill {...props} {...next} />) };
}

const handle = () => screen.getByRole("button", { name: /Show controls$/ });
const dialog = () => screen.queryByRole("dialog", { name: "Hermes 1 controls" });

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(INTRO_KEY, "1"); // the gentle intro has its own tests
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe("AgentPill", () => {
  it("is a small handle named for the agent and its status, and opens on a tap", () => {
    setup();
    expect(handle()).toHaveAccessibleName("Hermes 1, running. Show controls");
    expect(handle()).toHaveAttribute("aria-expanded", "false");
    expect(dialog()).not.toBeInTheDocument();
    fireEvent.click(handle());
    expect(dialog()).toBeInTheDocument();
    expect(handle()).toHaveAttribute("aria-expanded", "true");
    expect(handle()).toHaveAttribute("aria-controls", dialog()!.id);
  });

  it("opens on a tap's click, never on the release, and not on a drag", () => {
    setup();
    // A tap that barely moves: the release leaves it shut, so a touch's own
    // click (which arrives next, where the finger was) cannot land on the
    // freshly opened dropdown and pick a view. The click opens it.
    fireEvent.pointerDown(handle(), { clientX: 100, button: 0 });
    fireEvent.pointerMove(handle(), { clientX: 102 });
    fireEvent.pointerUp(handle(), { clientX: 102 });
    expect(dialog()).not.toBeInTheDocument();
    fireEvent.click(handle());
    expect(dialog()).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog()).not.toBeInTheDocument();
    // A drag, and the click its release produces, leave it shut.
    fireEvent.pointerDown(handle(), { clientX: 100, button: 0 });
    fireEvent.pointerMove(handle(), { clientX: 120 });
    fireEvent.pointerUp(handle(), { clientX: 120 });
    fireEvent.click(handle());
    expect(dialog()).not.toBeInTheDocument();
  });

  it("closes on Escape, on a press outside, and with its close button, and gives focus back to the handle", () => {
    setup();
    fireEvent.click(handle());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog()).not.toBeInTheDocument();
    expect(handle()).toHaveFocus();

    fireEvent.click(handle());
    fireEvent.pointerDown(document.body);
    expect(dialog()).not.toBeInTheDocument();

    fireEvent.click(handle());
    fireEvent.pointerDown(within(dialog()!).getByRole("navigation", { name: "Views" }));
    expect(dialog()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close controls" }));
    expect(dialog()).not.toBeInTheDocument();
  });

  it("stays open for a press inside something marked to keep it open", () => {
    setup();
    fireEvent.click(handle());
    const menu = document.createElement("div");
    menu.setAttribute("data-agent-pill-keep", "");
    document.body.appendChild(menu);
    fireEvent.pointerDown(menu);
    expect(dialog()).toBeInTheDocument();
    menu.remove();
  });

  it("closes when focus moves into an iframe", () => {
    setup();
    fireEvent.click(handle());
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    frame.focus();
    fireEvent.blur(window);
    expect(dialog()).not.toBeInTheDocument();
    frame.remove();
  });

  it("lists every view, marks the open one, focuses it, and closes after a choice", () => {
    const { onSelect } = setup({ panelId: "pane" });
    fireEvent.click(handle());
    const nav = within(dialog()!).getByRole("navigation", { name: "Views" });
    const buttons = within(nav).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Chat", "Files", "Terminal"]);
    expect(buttons[0]).toHaveAttribute("aria-current", "page");
    expect(buttons[0]).toHaveAttribute("aria-controls", "pane");
    expect(buttons[1]).not.toHaveAttribute("aria-current");
    expect(buttons[0]).toHaveFocus();
    fireEvent.click(within(nav).getByRole("button", { name: "Terminal" }));
    expect(onSelect.box).toHaveBeenCalledTimes(1);
    expect(dialog()).not.toBeInTheDocument();
  });

  it("shows the name, status, note and extras in the header", () => {
    setup({ nameTitle: "Hermes 1's own computer", note: "View only", extras: <span>Update available</span> });
    fireEvent.click(handle());
    const box = within(dialog()!);
    expect(box.getByText("Hermes 1")).toHaveAttribute("title", "Hermes 1's own computer");
    expect(box.getByText("running")).toBeInTheDocument();
    expect(box.getByText("View only")).toBeInTheDocument();
    expect(box.getByText("Update available")).toBeInTheDocument();
  });

  it("shows a back pill beside the handle only when given one", () => {
    const onClick = jest.fn();
    const view = setup();
    expect(screen.queryByRole("button", { name: /^Back to/ })).not.toBeInTheDocument();
    view.rerenderWith({ back: { label: "Hermes", onClick } });
    fireEvent.click(screen.getByRole("button", { name: "Back to Hermes" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("opens a setting's pop-up in the same dropdown, and Escape goes back to the menu first", () => {
    const render = jest.fn(() => <p>Pop-up body</p>);
    setup({ quickSettings: [{ id: "model", icon: <i />, label: "Model", value: "Hermes 4", render }] });
    fireEvent.click(handle());
    const row = screen.getByRole("button", { name: /^Model/ });
    expect(row).toHaveTextContent("Hermes 4");
    fireEvent.click(row);
    expect(screen.getByText("Pop-up body")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Views" })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog()).toBeInTheDocument();
    expect(screen.queryByText("Pop-up body")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Views" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("navigation", { name: "Views" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Model/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close controls" }));
    expect(dialog()).not.toBeInTheDocument();
  });

  it("leaves the settings list out when there are none", () => {
    setup();
    fireEvent.click(handle());
    expect(screen.queryByText("Quick settings")).not.toBeInTheDocument();
  });

  it("calls the pop-up's own close and tells it when it is left", () => {
    const onLeave = jest.fn();
    setup({ quickSettings: [{ id: "x", icon: <i />, label: "Thing", onLeave, render: (ctx) => <button type="button" onClick={ctx.close}>Done here</button> }] });
    fireEvent.click(handle());
    fireEvent.click(screen.getByRole("button", { name: /^Thing/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done here" }));
    expect(dialog()).not.toBeInTheDocument();
    expect(onLeave).toHaveBeenCalled();
  });

  it("shows one suggestion with Set up and Not now, and a dot on the handle", () => {
    const onAction = jest.fn();
    const onDismiss = jest.fn();
    setup({ suggestion: { id: "channels", title: "Chat from your phone", body: "Reach it anywhere.", actionLabel: "Set up", onAction, onDismiss } });
    expect(screen.getByTestId("agent-pill-badge")).toBeInTheDocument();
    fireEvent.click(handle());
    const card = screen.getByRole("region", { name: "Suggestion: Chat from your phone" });
    fireEvent.click(within(card).getByRole("button", { name: "Not now" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Set up" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(dialog()).not.toBeInTheDocument();
  });

  it("calls through for the sidebar, the switcher and the download, each only when given", () => {
    const onToggle = jest.fn();
    const onSwitchAgent = jest.fn();
    const view = setup();
    fireEvent.click(handle());
    expect(screen.queryByRole("button", { name: /sidebar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });

    view.rerenderWith({ sidebar: { shown: false, onToggle, controlsId: "side" }, onSwitchAgent, exportHref: "/api/hivra/agents/a/export" });
    fireEvent.click(handle());
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute("href", "/api/hivra/agents/a/export");
    const toggle = screen.getByRole("button", { name: "Show sidebar" });
    expect(toggle).toHaveAttribute("aria-controls", "side");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(dialog()).not.toBeInTheDocument();

    fireEvent.click(handle());
    fireEvent.click(screen.getByRole("button", { name: "Switch agent" }));
    expect(onSwitchAgent).toHaveBeenCalledTimes(1);

    view.rerenderWith({ sidebar: { shown: true, onToggle, controlsId: "side" } });
    fireEvent.click(handle());
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the active surface's lifted actions in the footer", () => {
    const store = createSurfaceActionStore();
    const onSelect = jest.fn();
    store.publish("chat", [{ id: "open-in-new-tab", label: "Open in new tab", icon: "external-link", onSelect }]);
    render(<SurfaceActionProvider store={store}><AgentPill name="Hermes 1" status="running" actionSurface="chat" views={[]} /></SurfaceActionProvider>);
    fireEvent.click(handle());
    fireEvent.click(screen.getByRole("button", { name: "Open in new tab" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("AgentPill status", () => {
  it("shows the busy word with the orb, and the status word while setting up", () => {
    const view = setup({ busy: "Updating" });
    expect(handle()).toHaveTextContent("Updating");
    expect(screen.getByTestId("orb")).toBeInTheDocument();
    expect(handle()).toHaveAccessibleName("Hermes 1, Updating. Show controls");
    view.rerenderWith({ busy: null, status: "provisioning" });
    expect(handle()).toHaveTextContent("provisioning");
    expect(screen.getByTestId("orb")).toBeInTheDocument();
  });

  it("shows the word for a stopped agent and none for a running one", () => {
    const view = setup();
    expect(handle()).not.toHaveTextContent(/running/i);
    view.rerenderWith({ status: "stopped" });
    expect(handle()).toHaveTextContent("stopped");
    expect(screen.queryByTestId("orb")).not.toBeInTheDocument();
  });

  it("says Ready for four seconds after it finishes working, then fades back to the dot", () => {
    jest.useFakeTimers();
    const view = setup({ busy: "Updating" });
    view.rerenderWith({ busy: null });
    expect(handle()).toHaveTextContent("Ready");
    act(() => { jest.advanceTimersByTime(3900); });
    expect(handle()).toHaveTextContent("Ready");
    act(() => { jest.advanceTimersByTime(200); });
    expect(handle()).not.toHaveTextContent("Ready");
  });

  it("does not say Ready for an agent that was running all along", () => {
    setup();
    expect(handle()).not.toHaveTextContent("Ready");
  });
});

describe("AgentPill first open", () => {
  it("opens by itself once after a moment, and never again", () => {
    jest.useFakeTimers();
    window.localStorage.removeItem(INTRO_KEY);
    const first = setup();
    expect(dialog()).not.toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(800); });
    expect(dialog()).toBeInTheDocument();
    expect(window.localStorage.getItem(INTRO_KEY)).toBe("1");
    first.unmount();

    setup();
    act(() => { jest.advanceTimersByTime(2000); });
    expect(dialog()).not.toBeInTheDocument();
  });

  it("does not open by itself while the agent is not running", () => {
    jest.useFakeTimers();
    window.localStorage.removeItem(INTRO_KEY);
    setup({ status: "provisioning" });
    act(() => { jest.advanceTimersByTime(2000); });
    expect(dialog()).not.toBeInTheDocument();
  });
});

describe("AgentPill storage", () => {
  it("still works, and does not open by itself, when storage throws", () => {
    jest.useFakeTimers();
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    setup();
    act(() => { jest.advanceTimersByTime(2000); });
    expect(dialog()).not.toBeInTheDocument();
    fireEvent.click(handle());
    expect(dialog()).toBeInTheDocument();
    fireEvent.pointerDown(handle(), { clientX: 1, button: 0 });
    fireEvent.pointerMove(handle(), { clientX: 30 });
    fireEvent.pointerUp(handle(), { clientX: 30 });
  });

  it("ignores a saved position that is not a number", () => {
    window.localStorage.setItem(OFFSET_KEY, "left");
    setup();
    expect(handle()).toBeInTheDocument();
  });
});
