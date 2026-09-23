/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToolsBrowser } from "../ToolsBrowser";

jest.mock("@/lib/composio/use-composio-connect", () => ({
  useComposioKey: () => ({ hasKey: false }),
  useComposioConnect: () => ({ launch: jest.fn(), launching: null }),
  useComposioConnectedApps: () => ({ apps: new Set<string>() }),
}));
jest.mock("@/components/instances/ComposioKeyPanel", () => ({ ComposioKeyPanel: () => null }));
jest.mock("@/components/instances/ComposioAppPicker", () => ({ ComposioAppPicker: () => null }));

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
