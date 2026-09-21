/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { useWorkspaceAgents } from "@/components/workspace/useWorkspaceAgents";
import type { UnifiedAgent } from "@/lib/hivra/unified-agent";

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
    fireEvent.click(screen.getByRole("button", { name: "Switch runtime" }));
    expect(mockedUseWorkspaceAgents).toHaveBeenCalled();
  });

  it("navigates to the selected resource's own route by family", () => {
    render(<ResourceSwitcher currentUid="abc" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch runtime" }));

    fireEvent.click(screen.getAllByRole("option")[1]);

    // A Hermes instance is a different route, not the Hivra agent page.
    expect(push).toHaveBeenCalledWith("/dashboard/instances/xyz");
  });

  it("routes a Hivra selection to the agent page with the raw id", () => {
    render(<ResourceSwitcher currentUid="xyz" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch runtime" }));

    fireEvent.click(screen.getAllByRole("option")[0]);

    expect(push).toHaveBeenCalledWith("/dashboard/agent/abc");
  });

  it("marks the current resource even when the route carries a raw id", () => {
    // The route gives `abc`; the list speaks `x-abc`. Without the id fallback
    // the menu opens with nothing marked and no way to see where you are.
    render(<ResourceSwitcher currentUid="abc" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch runtime" }));

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
    const trigger = screen.getByRole("button", { name: "Switch runtime" });
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Switch runtime" });
    expect(screen.getByRole("combobox", { name: "Search your runtimes" })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Switch runtime" }));
    expect(screen.queryByRole("button", { name: "Test guide" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All agents and computers" })).toHaveAttribute("href", "/dashboard?runtimes=1");
    expect(screen.getByRole("link", { name: "Launch a runtime" })).toHaveAttribute("href", "/dashboard/launch");
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
    const trigger = screen.getByRole("button", { name: "Switch runtime" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Switch runtime" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Switch runtime" }),
      ).not.toBeInTheDocument(),
    );
  });
  it.each(['All agents and computers', 'Launch a runtime'])(
    'lets Enter activate %s without selecting a resource', (name) => {
      render(<ResourceSwitcher currentUid="abc" />);
      fireEvent.click(screen.getByRole('button', { name: 'Switch runtime' }));
      const link = screen.getByRole('link', { name });
      link.focus();
      expect(fireEvent.keyDown(link, { key: 'Enter' })).toBe(true);
      expect(push).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeVisible();
    },
  );

  it('still selects the highlighted resource from the search field', () => {
    render(<ResourceSwitcher currentUid="abc" />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch runtime' }));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/dashboard/instances/xyz');
  });

  it('bounds the entire menu, including its footer, in a short viewport', () => {
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 390 });
    try {
      render(<ResourceSwitcher currentUid="abc" />);
      const trigger = screen.getByRole('button', { name: 'Switch runtime' });
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
