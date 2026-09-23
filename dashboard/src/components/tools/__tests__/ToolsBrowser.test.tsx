/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { ToolsBrowser } from "../ToolsBrowser";

jest.mock("@/components/instances/ComposioKeyPanel", () => ({
  ComposioKeyPanel: () => null,
}));

jest.mock("@/components/instances/ComposioAppPicker", () => ({
  ComposioAppPicker: () => null,
}));

jest.mock("@/lib/composio/use-composio-connect", () => ({
  useComposioKey: () => ({ hasKey: false }),
  useComposioConnect: () => ({ launch: jest.fn(), launching: null }),
  useComposioConnectedApps: () => ({ apps: new Set<string>() }),
}));

const tool = {
  id: "tavily",
  name: "Tavily Search",
  description: "Web search for agents.",
  category: "search",
  trust: "verified",
  mcpName: "tavily",
  env: [],
  skillCount: 1,
};

const targets = [
  { uid: "cli:a1", lane: "cli", id: "a1", name: "Codex Agent", type: "codex", status: "running", installable: true, installedTools: ["tavily"] },
  { uid: "cli:a2", lane: "cli", id: "a2", name: "Claude Agent", type: "claude", status: "running", installable: true, installedTools: ["tavily"] },
];

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
}

describe("ToolsBrowser manage dialog", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ success: true, data: { results: [{ uid: "cli:a1", ok: true }, { uid: "cli:a2", ok: true }] } });
      }
      return jsonResponse({ success: true, data: { tools: [tool], targets } });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  async function openManageDialog() {
    render(<ToolsBrowser />);
    fireEvent.click(await screen.findByRole("button", { name: /manage \/ edit agents/i }));
    return screen.getByRole("dialog", { name: "Manage Tavily Search" });
  }

  function uninstallCalls() {
    return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"
      && JSON.parse(String(init.body)).op === "uninstall");
  }

  it("asks for a second press before removing the tool from the preselected agents", async () => {
    const dialog = await openManageDialog();
    jest.useFakeTimers();
    try {
      fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));
      expect(uninstallCalls()).toHaveLength(0);

      act(() => {
        jest.advanceTimersByTime(600);
      });
      const confirm = within(dialog).getByRole("button", { name: "Confirm remove from 2 agents" });
      await act(async () => {
        fireEvent.click(confirm);
        await Promise.resolve();
      });

      expect(uninstallCalls()).toHaveLength(1);
      expect(JSON.parse(String(uninstallCalls()[0][1].body))).toEqual({
        toolId: "tavily",
        targets: ["cli:a1", "cli:a2"],
        op: "uninstall",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("ignores a confirm tap that lands as part of the same double tap", async () => {
    const dialog = await openManageDialog();
    jest.useFakeTimers();
    try {
      fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));
      act(() => {
        jest.advanceTimersByTime(120);
      });
      const confirm = within(dialog).getByRole("button", { name: "Confirm remove from 2 agents" });
      expect(confirm).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(confirm);
      expect(uninstallCalls()).toHaveLength(0);

      act(() => {
        jest.advanceTimersByTime(480);
      });
      expect(confirm).not.toHaveAttribute("aria-disabled");
      await act(async () => {
        fireEvent.click(confirm);
        await Promise.resolve();
      });
      expect(uninstallCalls()).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("asks again after the agent selection changes", async () => {
    const dialog = await openManageDialog();

    fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: /claude agent/i }));

    expect(within(dialog).queryByRole("button", { name: /confirm remove/i })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));
    expect(within(dialog).getByRole("button", { name: "Confirm remove from 1 agent" })).toBeInTheDocument();
    expect(uninstallCalls()).toHaveLength(0);
  });

  it("renders the dialog outside the page tree so it layers above the shell chrome", async () => {
    const { container } = render(<ToolsBrowser />);
    fireEvent.click(await screen.findByRole("button", { name: /manage \/ edit agents/i }));

    const dialog = screen.getByRole("dialog", { name: "Manage Tavily Search" });
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.closest("[data-hermes-portal-root]")).not.toBeNull();
  });

  it("drops the remove confirmation after four seconds", async () => {
    const dialog = await openManageDialog();
    jest.useFakeTimers();
    try {
      fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));
      expect(within(dialog).getByRole("button", { name: /confirm remove/i })).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(4000);
      });

      fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));
      expect(uninstallCalls()).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("moves focus into the dialog, closes on Escape and returns focus to the trigger", async () => {
    render(<ToolsBrowser />);
    const trigger = await screen.findByRole("button", { name: /manage \/ edit agents/i });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Manage Tavily Search" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Manage Tavily Search" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("ignores Escape while a request is running", async () => {
    const dialog = await openManageDialog();
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "POST" ? new Promise(() => {}) : jsonResponse({ success: true, data: { tools: [tool], targets } })
    ));

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /save \/ install/i }));
      await Promise.resolve();
    });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByRole("dialog", { name: "Manage Tavily Search" })).toBeInTheDocument();
  });
});
