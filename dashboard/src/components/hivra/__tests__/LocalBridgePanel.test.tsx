/** @jest-environment jsdom */
// Manage -> let agents run commands on the owner's own computer: what waits for
// approval (agent, computer, exact command, folder), the three answers,
// allowances with End, computers with Revoke, and the settings shown once.
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LocalBridgePanel, commandLine } from "../LocalBridgePanel";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAC = "11111111-1111-4111-8111-111111111111";
const calls: Array<{ url: string; init?: RequestInit }> = [];
let view: unknown = null;
let status = 200;

function bridgeView(overrides: Record<string, unknown> = {}) {
  return {
    computers: [{ id: MAC, name: "Ash's Mac", revoked: false }],
    agents: [{ id: AGENT, name: "Claude" }],
    requests: [{ id: "r1", agentId: AGENT, computerId: MAC, argv: ["ls", "-la", "my folder"], cwd: "/Users/ash/work", status: "pending", createdAt: "2026-11-12T10:00:00Z" }],
    allowances: [{ agentId: AGENT, computerId: MAC, expiresAt: "2026-11-12T11:00:00Z" }],
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  status = 200;
  view = bridgeView();
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = (code: number, body: unknown) => ({ status: code, ok: code >= 200 && code < 300, json: async () => body }) as Response;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.action === "enroll") return reply(200, { success: true, data: { computer: { id: MAC, name: "Ash's Mac" }, config: { connectionId: MAC, bridgeKey: "k".repeat(64) } } });
      return reply(200, { success: true, data: {} });
    }
    return status === 404 ? reply(404, {}) : reply(200, { success: true, data: view });
  }) as typeof fetch;
});

const posted = () => calls.filter((call) => call.init?.method === "POST").map((call) => JSON.parse(String(call.init?.body)));

describe("LocalBridgePanel", () => {
  it("shows nothing where the bridge isn't offered, or when disabled", async () => {
    status = 404;
    const { container } = render(<LocalBridgePanel />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    const off = render(<LocalBridgePanel enabled={false} />);
    expect(off.container).toBeEmptyDOMElement();
    expect(calls).toHaveLength(1);
  });

  it("shows the agent, the computer, the exact command and the folder", async () => {
    render(<LocalBridgePanel />);
    expect(await screen.findByText(/wants to run this on/)).toBeInTheDocument();
    expect(screen.getAllByText("Claude").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ash's Mac").length).toBeGreaterThan(0);
    expect(screen.getByText('ls -la "my folder"')).toBeInTheDocument();
    expect(screen.getByText(/\/Users\/ash\/work/)).toBeInTheDocument();
    expect(commandLine(["echo", "a; rm -rf ~"])).toBe('echo "a; rm -rf ~"');
  });

  it("Approve, Deny and Allow this agent for 1 hour send those decisions, and there is no forever", async () => {
    render(<LocalBridgePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posted()).toContainEqual({ action: "decide", requestId: "r1", decision: "approve" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow this agent for 1 hour" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Allow this agent for 1 hour" }));
    await waitFor(() => expect(posted()).toHaveLength(3));
    expect(posted().map((body) => body.decision)).toEqual(["approve", "deny", "allow_hour"]);
    expect(screen.queryByText(/forever/i)).toBeNull();
  });

  it("ends an allowance and revokes a computer", async () => {
    render(<LocalBridgePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "End Claude's hour" }));
    await waitFor(() => expect(posted()).toContainEqual({ action: "end_allowance", agentId: AGENT, computerId: MAC }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Revoke Ash's Mac" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Revoke Ash's Mac" }));
    await waitFor(() => expect(posted()).toContainEqual({ action: "revoke", computerId: MAC }));
  });

  it("sets up a computer and shows its settings once, with the run command", async () => {
    view = bridgeView({ requests: [], allowances: [] });
    render(<LocalBridgePanel />);
    fireEvent.change(await screen.findByLabelText("Computer name"), { target: { value: "Studio Mac" } });
    fireEvent.click(screen.getByRole("button", { name: "Set up a computer" }));
    const region = await screen.findByRole("region", { name: "Bridge settings" });
    expect(posted()).toContainEqual({ action: "enroll", label: "Studio Mac" });
    expect(region).toHaveTextContent("python3 hivra_bridge.py run --config ~/.config/hivra-bridge/config.json");
    expect(region).toHaveTextContent("k".repeat(64));
    fireEvent.click(screen.getByRole("button", { name: "I saved them" }));
    expect(screen.queryByRole("region", { name: "Bridge settings" })).toBeNull();
  });
});
