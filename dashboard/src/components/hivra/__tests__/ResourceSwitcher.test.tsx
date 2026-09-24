/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { useWorkspaceAgents } from "@/components/workspace/useWorkspaceAgents";
import type { UnifiedAgent } from "@/lib/hivra/unified-agent";
import { recordVisit } from "@/lib/workspace/recents";

import { ResourceSwitcher } from "../ResourceSwitcher";

const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

jest.mock("@/components/workspace/useWorkspaceAgents", () => ({
  useWorkspaceAgents: jest.fn(),
}));

const mockedUseWorkspaceAgents = jest.mocked(useWorkspaceAgents);

function agent(
  uid: string,
  name: string,
  kind: "hermes" | "hivra",
  resourceKind: "agent" | "computer" = "agent",
): UnifiedAgent {
  return {
    uid,
    kind,
    id: uid.slice(2),
    name,
    statusRaw: "running",
    state: "running",
    dot: "#22c55e",
    vendor: kind === "hermes" ? "Hermes" : "OpenAI",
    typeLabel: kind === "hermes" ? "Hermes" : "Codex",
    resourceKind,
  };
}

const hivra = agent("x-abc", "Codex One", "hivra");
const hermes = agent("h-xyz", "Hermes One", "hermes");
const desktop = agent("x-desktop", "My Desktop", "hivra", "computer");

/**
 * The switcher survives the route merge by moving here. These specs exist
 * because that move is easy to get subtly wrong: the route's path segment is a
 * raw id while the fleet list speaks source-qualified uids, so the "which one am
 * I on" highlight can silently stop matching.
 */
describe("ResourceSwitcher", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockedUseWorkspaceAgents.mockReturnValue({
      agents: [hivra, hermes],
      loading: false,
      hermesError: null,
      hivraError: null,
      lastRefreshedAt: null,
      retryHermes: jest.fn(async () => undefined),
      retryHivra: jest.fn(async () => undefined),
      retryAll: jest.fn(async () => undefined),
    });
  });

  it("does not fetch the fleet list until the menu is opened", () => {
    // Every resource page used to mount useWorkspaceAgents unconditionally,
    // firing a fleet-wide list nobody asked for on a page that shows one
    // resource. The hook must stay unmounted until intent is shown.
    render(<ResourceSwitcher currentUid="abc" />);

    expect(mockedUseWorkspaceAgents).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Switch agent or computer" }));
    expect(mockedUseWorkspaceAgents).toHaveBeenCalled();
  });

  it("navigates to the selected resource's own route by family", () => {
    render(<ResourceSwitcher currentUid="abc" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch agent or computer" }));

    fireEvent.click(screen.getAllByRole("option")[1]);

    // A Hermes instance is a different route, not the Hivra agent page.
    expect(push).toHaveBeenCalledWith("/dashboard/instances/xyz");
  });

  it("routes a Hivra selection to the agent page with the raw id", () => {
    render(<ResourceSwitcher currentUid="xyz" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch agent or computer" }));

    fireEvent.click(screen.getAllByRole("option")[0]);

    expect(push).toHaveBeenCalledWith("/dashboard/agent/abc");
  });

  it("marks the current resource even when the route carries a raw id", () => {
    // The route gives `abc`; the list speaks `x-abc`. Without the id fallback
    // the menu opens with nothing marked and no way to see where you are.
    render(<ResourceSwitcher currentUid="abc" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch agent or computer" }));

    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("names the whole fleet, not just agents, in its own copy", () => {
    // The menu lists computers as well as agents. Its trigger and dialog once
    // disagreed ("Switch resource" opening "Switch agent"), and the search field
    // promised agents while returning desktops — copy contradicting the rows
    // beneath it. Per-group headings still name each family; the menu's own
    // labels use the system term ("runtimes", the owner's word and the word the
    // Chat control pane uses) so one noun covers both families everywhere.
    // Scoped to this spec, with both families listed, so the shared agents-only
    // fixture keeps the positional specs' indices.
    mockedUseWorkspaceAgents.mockReturnValue({
      ...mockedUseWorkspaceAgents(),
      agents: [hivra, hermes, desktop],
    });

    render(<ResourceSwitcher currentUid="abc" />);
    const trigger = screen.getByRole("button", { name: "Switch agent or computer" });
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Switch agent or computer" });
    expect(screen.getByRole("combobox", { name: "Search your agents and computers" })).toBeInTheDocument();
    // The set-wide noun must be "runtimes" — the word the Chat control pane and
    // the owner use. "agents" contradicts the computers listed below it, and a
    // third synonym ("fleet", "resources") would split the vocabulary again.
    expect(dialog).not.toHaveTextContent("Search agents");
    expect(dialog).not.toHaveTextContent("Your fleet");
    expect(within(dialog).getByRole("group", { name: "Computers" })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "Agents" })).toBeInTheDocument();
  });

  it("keeps choosing an existing resource separate from launching a new one", () => {
    render(<ResourceSwitcher currentUid="abc" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch agent or computer" }));
    expect(screen.queryByRole("button", { name: "Test guide" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All agents and computers" })).toHaveAttribute("href", "/dashboard?runtimes=1");
    expect(screen.getByRole("link", { name: "Launch an agent or computer" })).toHaveAttribute("href", "/dashboard/launch");
  });

  it("uses the visible resource name as the switcher and keeps its status beside it", () => {
    render(<ResourceSwitcher currentUid="abc" name="My desktop" kind="computer" status="running" />);
    const trigger = screen.getByRole("button", { name: "Switch agent or computer: My desktop" });
    expect(trigger).toHaveTextContent("Computer · running");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on Escape and works when the current resource is not listed", async () => {
    // A resource mid-provision may not be in the list yet; the switcher must
    // not become unusable just because nothing matches.
    render(<ResourceSwitcher currentUid="not-listed" />);
    const trigger = screen.getByRole("button", { name: "Switch agent or computer" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Switch agent or computer" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Switch agent or computer" }),
      ).not.toBeInTheDocument(),
    );
  });
  it("returns focus to the trigger after Escape", async () => {
    jest.useFakeTimers();
    try {
      render(<ResourceSwitcher currentUid="abc" />);
      const trigger = screen.getByRole("button", { name: "Switch agent or computer" });
      fireEvent.click(trigger);
      screen.getByRole("combobox").focus();
      fireEvent.keyDown(window, { key: "Escape" });
      act(() => { jest.runOnlyPendingTimers(); });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    } finally {
      jest.useRealTimers();
    }
  });

  it("leaves focus in a Terminal or Desktop frame that takes it while the menu is open", () => {
    // Clicking into a frame closes the menu through window blur; pulling focus
    // back to the trigger would send the next keystrokes to the page instead.
    jest.useFakeTimers();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    try {
      render(<ResourceSwitcher currentUid="abc" />);
      const trigger = screen.getByRole("button", { name: "Switch agent or computer" });
      fireEvent.click(trigger);
      frame.focus();
      act(() => { window.dispatchEvent(new Event("blur")); });
      act(() => { jest.runOnlyPendingTimers(); });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(trigger).not.toHaveFocus();
      expect(frame).toHaveFocus();
    } finally {
      jest.useRealTimers();
      frame.remove();
    }
  });

  it("does not take focus back from another control clicked outside the menu", () => {
    jest.useFakeTimers();
    const other = document.createElement("button");
    document.body.append(other);
    try {
      render(<ResourceSwitcher currentUid="abc" />);
      const trigger = screen.getByRole("button", { name: "Switch agent or computer" });
      fireEvent.click(trigger);
      fireEvent.pointerDown(other);
      other.focus();
      act(() => { jest.runOnlyPendingTimers(); });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(other).toHaveFocus();
    } finally {
      jest.useRealTimers();
      other.remove();
    }
  });

  it.each(['All agents and computers', 'Launch an agent or computer'])(
    'lets Enter activate %s without selecting a resource', (name) => {
      render(<ResourceSwitcher currentUid="abc" />);
      fireEvent.click(screen.getByRole('button', { name: 'Switch agent or computer' }));
      const link = screen.getByRole('link', { name });
      link.focus();
      expect(fireEvent.keyDown(link, { key: 'Enter' })).toBe(true);
      expect(push).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeVisible();
    },
  );

  it('still selects the highlighted resource from the search field', () => {
    render(<ResourceSwitcher currentUid="abc" />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch agent or computer' }));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/dashboard/instances/xyz');
  });

  it('bounds the entire menu, including its footer, in a short viewport', () => {
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 390 });
    try {
      render(<ResourceSwitcher currentUid="abc" />);
      const trigger = screen.getByRole('button', { name: 'Switch agent or computer' });
      trigger.getBoundingClientRect = () => ({ left: 92, right: 280, top: 50, bottom: 101, width: 188, height: 51 }) as DOMRect;
      fireEvent.click(trigger);
      const menu = screen.getByRole('dialog');
      expect(menu.style.maxHeight).toBe('var(--agent-menu-max-height, 420px)');
      const top = parseFloat(menu.style.top);
      const height = parseFloat(menu.style.getPropertyValue('--agent-menu-max-height'));
      expect(top + height).toBeLessThanOrEqual(382);
      expect(screen.getByRole('listbox').style.maxHeight).toBe('');
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
    }
  });

});

describe("ResourceSwitcher recents", () => {
  const codexTwo = agent("x-two", "Codex Two", "hivra");

  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockedUseWorkspaceAgents.mockReturnValue({
      agents: [hivra, hermes, codexTwo, desktop],
      loading: false,
      hermesError: null,
      hivraError: null,
      lastRefreshedAt: null,
      retryHermes: jest.fn(async () => undefined),
      retryHivra: jest.fn(async () => undefined),
      retryAll: jest.fn(async () => undefined),
    });
  });

  /** Oldest first: the last uid named is the most recent. */
  function opened(...visits: Array<[string, "chat" | "box" | "terminal" | "desktop"]>) {
    visits.forEach(([uid, tab], index) => recordVisit(uid, tab, { now: 1_000_000 + index }));
  }

  it("lists Recent first without the current resource and starts on the previous one", () => {
    opened(["x-desktop", "desktop"], ["x-two", "box"], ["x-abc", "chat"]);
    render(<ResourceSwitcher currentUid="abc" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch agent or computer" }));

    const dialog = screen.getByRole("dialog", { name: "Switch agent or computer" });
    const groups = within(dialog).getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Recent", "Agents"]);
    expect(within(groups[0]).getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("Codex Two"),
      expect.stringContaining("My Desktop"),
    ]);
    // The current one keeps its place and its mark.
    expect(within(groups[1]).getByRole("option", { name: /Codex One/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-activedescendant", "agent-switcher-option-x-two");
    expect(dialog).toHaveTextContent("↵ back to Codex Two");
  });

  it("goes back to the previous resource on Enter, on the surface it was left on", () => {
    opened(["x-two", "box"], ["x-abc", "terminal"]);
    render(<ResourceSwitcher currentUid="abc" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch agent or computer" }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/dashboard/agent/two?tab=box");
  });

  it("opens the nth Recent entry with a digit while nothing is typed", () => {
    opened(["x-desktop", "desktop"], ["x-two", "box"], ["x-abc", "chat"]);
    render(<ResourceSwitcher currentUid="abc" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch agent or computer" }));
    const search = screen.getByRole("combobox");
    expect(fireEvent.keyDown(search, { key: "2" })).toBe(false);
    expect(push).toHaveBeenCalledWith("/dashboard/agent/desktop?tab=desktop");
  });

  // A touch screen shows no digit hints, and a search can start with a digit.
  it("lets a digit type into the search on a touch screen, where no shortcut is shown", () => {
    const original = window.matchMedia;
    window.matchMedia = jest.fn((query: string) => ({ matches: query.includes("pointer: coarse"), media: query })) as unknown as typeof window.matchMedia;
    try {
      opened(["x-desktop", "desktop"], ["x-two", "box"], ["x-abc", "chat"]);
      render(<ResourceSwitcher currentUid="abc" />);
      fireEvent.click(screen.getByRole("button", { name: "Switch agent or computer" }));
      expect(screen.getAllByRole("option").some((option) => option.hasAttribute("aria-keyshortcuts"))).toBe(false);
      expect(fireEvent.keyDown(screen.getByRole("combobox"), { key: "1" })).toBe(true);
      expect(push).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = original;
    }
  });

  it("does not jump on a digit once something is typed", () => {
    opened(["x-two", "box"]);
    render(<ResourceSwitcher currentUid="abc" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch agent or computer" }));
    const search = screen.getByRole("combobox");
    fireEvent.change(search, { target: { value: "c" } });
    expect(fireEvent.keyDown(search, { key: "1" })).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });

  it("filters every group with the search", () => {
    opened(["x-two", "box"], ["h-xyz", "chat"]);
    render(<ResourceSwitcher currentUid="abc" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch agent or computer" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "one" } });
    const dialog = screen.getByRole("dialog", { name: "Switch agent or computer" });
    expect(within(dialog).getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(["Recent", "Agents"]);
    expect(within(dialog).getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("Hermes One"),
      expect.stringContaining("Codex One"),
    ]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "desktop" } });
    expect(within(dialog).getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(["Computers"]);
  });

  it("includes the resource just left when opened again", () => {
    render(<ResourceSwitcher currentUid="abc" />);
    const trigger = screen.getByRole("button", { name: "Switch agent or computer" });
    fireEvent.click(trigger);
    expect(screen.queryByRole("group", { name: "Recent" })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    opened(["x-two", "chat"]);
    fireEvent.click(trigger);
    expect(screen.getByRole("group", { name: "Recent" })).toHaveTextContent("Codex Two");
  });
});

describe("ResourceSwitcher compact parts", () => {
  it("tags the status so a narrow host can show it as a dot and one word", () => {
    const { rerender } = render(<ResourceSwitcher currentUid="abc" name="Atlas" kind="agent" status="running" />);
    const trigger = screen.getByRole("button", { name: "Switch agent or computer: Atlas" });
    expect(trigger.querySelector('[data-switcher-part="kind"]')).toHaveTextContent("Agent");
    expect(trigger.querySelector('[data-switcher-part="separator"]')).toHaveAttribute("aria-hidden", "true");
    expect(trigger.querySelector('[data-switcher-part="status"]')).toHaveAttribute("data-tone", "ok");
    rerender(<ResourceSwitcher currentUid="abc" name="Atlas" kind="agent" status="setting up" />);
    expect(trigger.querySelector('[data-switcher-part="status"]')).toHaveAttribute("data-tone", "busy");
    rerender(<ResourceSwitcher currentUid="abc" name="Atlas" kind="agent" status="error" />);
    expect(trigger.querySelector('[data-switcher-part="status"]')).toHaveAttribute("data-tone", "error");
    rerender(<ResourceSwitcher currentUid="abc" name="Atlas" kind="agent" status="stopped" />);
    expect(trigger.querySelector('[data-switcher-part="status"]')).toHaveAttribute("data-tone", "off");
    expect(trigger).toHaveTextContent("Agent · stopped");
  });

  it("gives screen readers the status the label and a narrow host would hide", () => {
    const { rerender } = render(<ResourceSwitcher currentUid="abc" name="Atlas" kind="agent" status="running" />);
    const trigger = screen.getByRole("button", { name: "Switch agent or computer: Atlas" });
    expect(trigger).toHaveAccessibleDescription("running");
    rerender(<ResourceSwitcher currentUid="abc" name="Atlas" kind="agent" />);
    expect(trigger).not.toHaveAttribute("aria-describedby");
  });
});
