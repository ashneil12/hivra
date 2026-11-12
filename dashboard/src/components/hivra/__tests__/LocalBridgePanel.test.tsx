/** @jest-environment jsdom */
// Manage -> let agents run commands on the owner's own computer: what waits for
// approval (agent, computer, exact command, folder), the three answers,
// allowances with End, computers with Revoke, and the settings shown once.
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LocalBridgePanel, commandLine, escapeUnusual, hasUnusual } from "../LocalBridgePanel";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAC = "11111111-1111-4111-8111-111111111111";
const calls: Array<{ url: string; init?: RequestInit }> = [];
let view: unknown = null;
let status = 200;

function bridgeView(overrides: Record<string, unknown> = {}) {
  return {
    computers: [{ id: MAC, name: "Ash's Mac", revoked: false }],
    agents: [{ id: AGENT, name: "Claude" }],
    requests: [{ id: "r1", agentId: AGENT, computerId: MAC, argv: ["ls", "-la", "my folder"], cwd: "/Users/example/work", status: "pending", createdAt: "2026-11-12T10:00:00Z", expiresAt: "2999-01-01T00:00:00Z" }],
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
      if (body.action === "enroll") return reply(200, { success: true, data: { computer: { id: MAC, name: "Ash's Mac" }, command: "curl -fsSL https://canary.example.test/api/hivra/bridge/install | bash -s -- hvb_" + "x".repeat(32), expiresAt: "2999-01-01T00:15:00Z" } });
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
    expect(screen.getByText(/\/Users\/example\/work/)).toBeInTheDocument();
    expect(commandLine(["echo", "a; rm -rf ~"])).toBe('echo "a; rm -rf ~"');
  });

  it("says the command can read and change anything, and that folders are not a sandbox", async () => {
    render(<LocalBridgePanel />);
    expect(await screen.findByText(/read and change anything you can/)).toHaveTextContent(/not a sandbox/);
    expect(screen.getByText(/can run any command on/)).toHaveTextContent(/anything you can read or change/);
  });

  it("makes invisible and look-alike characters visible and warns", async () => {
    expect(escapeUnusual("a‮b​c d\u0007 e")).toBe("a\\u202eb\\u200bc\\u00a0d\\u0007 e");
    expect(escapeUnusual("\u{E0001}")).toBe("\\u{e0001}");
    expect(hasUnusual("plain text", "x y")).toBe(false);
    view = bridgeView({ requests: [{ id: "r2", agentId: AGENT, computerId: MAC, argv: ["echo", "hi‮there"], cwd: "/tmp/​", status: "pending", createdAt: "x", expiresAt: "2999-01-01T00:00:00Z" }] });
    render(<LocalBridgePanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("unusual characters");
    expect(screen.getByText(/hi\\u202ethere/)).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/\\u200b/)).toBeInTheDocument();
  });

  it("does not offer approval for a request past its time", async () => {
    view = bridgeView({ requests: [{ id: "r3", agentId: AGENT, computerId: MAC, argv: ["ls"], cwd: null, status: "pending", createdAt: "x", expiresAt: "2000-01-01T00:00:00Z" }] });
    render(<LocalBridgePanel />);
    expect(await screen.findByText("No commands are waiting for your OK.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("fetches output only when asked", async () => {
    view = bridgeView({ requests: [{ id: "r4", agentId: AGENT, computerId: MAC, argv: ["uname"], cwd: null, status: "done", hasResult: true, createdAt: "x", expiresAt: "2999-01-01T00:00:00Z" }] });
    const base = global.fetch;
    global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("?request=")) {
        calls.push({ url: String(url), init });
        return { status: 200, ok: true, json: async () => ({ success: true, data: { result: { stdout: "Darwin\n", exitCode: 0 } } }) } as Response;
      }
      return base(url, init);
    }) as typeof fetch;
    render(<LocalBridgePanel />);
    fireEvent.click(await screen.findByText("Recent commands"));
    expect(calls.some((call) => call.url.includes("?request="))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Show output" }));
    await waitFor(() => expect(screen.getByText(/Darwin/)).toBeInTheDocument());
    expect(calls.filter((call) => call.url.includes("?request=r4"))).toHaveLength(1);
  });

  it("Approve, Deny and Allow any command from this agent for 1 hour send those decisions, and there is no forever", async () => {
    render(<LocalBridgePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posted()).toContainEqual({ action: "decide", requestId: "r1", decision: "approve" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow any command from this agent for 1 hour" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Allow any command from this agent for 1 hour" }));
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

  it("sets up a computer and shows one command to paste, with Copy, and no settings or secrets", async () => {
    view = bridgeView({ requests: [], allowances: [] });
    const write = jest.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    render(<LocalBridgePanel />);
    fireEvent.change(await screen.findByLabelText("Computer name"), { target: { value: "Studio Mac" } });
    fireEvent.click(screen.getByRole("button", { name: "Set up a computer" }));
    const region = await screen.findByRole("region", { name: "Set up this computer" });
    expect(posted()).toContainEqual({ action: "enroll", label: "Studio Mac" });
    const command = `curl -fsSL https://canary.example.test/api/hivra/bridge/install | bash -s -- hvb_${"x".repeat(32)}`;
    expect(region).toHaveTextContent(command);
    expect(region).toHaveTextContent(/not with sudo|do not run it with sudo/i);
    expect(region).not.toHaveTextContent(/bridgeKey|config\.json/);
    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
    await waitFor(() => expect(write).toHaveBeenCalledWith(command));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("region", { name: "Set up this computer" })).toBeNull();
  });

  it("New settings for a computer gives a fresh command the same way", async () => {
    render(<LocalBridgePanel />);
    fireEvent.click(await screen.findByRole("button", { name: "New settings for Ash's Mac" }));
    expect(await screen.findByRole("region", { name: "Set up this computer" })).toBeInTheDocument();
    expect(posted()).toContainEqual({ action: "enroll", computerId: MAC });
  });
});
