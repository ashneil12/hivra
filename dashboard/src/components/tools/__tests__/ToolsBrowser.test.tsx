/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

const OWN_CLOUD = "Catalog tools aren't available on computers in your own cloud yet. Use Advanced MCP.";
const HOST_FAILURE = "Couldn't install the tool on this agent. Check that it's running, then try again.";

describe("ToolsBrowser agent picker", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => init?.method === "POST"
        ? { success: true, data: { results: [{ uid: "cli-kvm", ok: false, error: HOST_FAILURE }] } }
        : {
          success: true,
          data: {
            tools: [{ id: "github", name: "GitHub", description: "Repos", category: "dev", trust: "official", mcpName: "github", env: [], skillCount: 0 }],
            targets: [
              { uid: "cli-kvm", lane: "cli", id: "kvm", name: "KVM_AGENT", type: "codex", status: "running", installable: true, installedTools: [] },
              { uid: "cli-provider", lane: "cli", id: "provider", name: "CLOUD_AGENT", type: "codex", status: "running", installable: false,
                blockedReason: "unsupported_substrate", blockedMessage: OWN_CLOUD, installedTools: [] },
            ],
          },
        },
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("explains a blocked agent in plain words and shows install failures as readable text", async () => {
    render(<ToolsBrowser />);
    fireEvent.click(await screen.findByRole("button", { name: /Install on agents/ }));
    const dialog = screen.getByRole("dialog", { name: "Manage GitHub" });

    const blocked = within(dialog).getByRole("button", { name: /CLOUD_AGENT/ });
    expect(blocked).toBeDisabled();
    expect(within(blocked).getByText(OWN_CLOUD)).toBeInTheDocument();
    expect(within(blocked).queryByText("unsupported_substrate")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /KVM_AGENT/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Save \/ Install/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/tools", expect.objectContaining({ method: "POST" })));
    const failed = within(dialog).getByRole("button", { name: /KVM_AGENT/ });
    expect(await within(failed).findByText(HOST_FAILURE)).toBeInTheDocument();
    expect(within(failed).getByText("failed")).toBeInTheDocument();
  });
});
