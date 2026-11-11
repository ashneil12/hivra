/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HivraPrivateAccessPanel } from "../HivraPrivateAccessPanel";

const mockFetch = jest.fn();
function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch;
});

it("offers a one-time key, honest network copy, and clears the key before the request completes", async () => {
  let finish!: (value: Response) => void;
  mockFetch
    .mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true, connection: null } }))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<HivraPrivateAccessPanel agentId="agent-1" />);
  const key = await screen.findByLabelText("One-time enrollment key");
  expect(screen.getByText(/does not publish services, open ports, enable Tailscale SSH/)).toBeInTheDocument();
  fireEvent.change(key, { target: { value: "opaque-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect private network" }));
  expect(key).toHaveValue("");
  const request = mockFetch.mock.calls[1][1];
  expect(JSON.parse(request.body)).toEqual({ action: "connect", authKey: "opaque-secret", loginServer: "https://controlplane.tailscale.com" });
  finish(jsonResponse({ success: true, data: { supported: true,
    connection: { state: "connected", loginServer: "https://controlplane.tailscale.com", ipv4: "100.64.0.7", observedAt: "2026-09-15T12:00:00Z" } } }));
  expect(await screen.findByText("100.64.0.7")).toBeInTheDocument();
});

it("supports a deliberate Headscale origin and fresh refresh", async () => {
  mockFetch
    .mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true, connection: null } }))
    .mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true,
      connection: { state: "connected", loginServer: "https://headscale.example.test", ipv4: "100.64.0.8", observedAt: "2026-09-15T12:00:00Z" } } }))
    .mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true,
      connection: { state: "connected", loginServer: "https://headscale.example.test", ipv4: "100.64.0.9", observedAt: "2026-09-15T12:01:00Z" } } }));
  render(<HivraPrivateAccessPanel agentId="agent-1" />);
  fireEvent.click(await screen.findByLabelText("Use a Headscale coordination server"));
  fireEvent.change(screen.getByLabelText("HTTPS coordination URL"), { target: { value: "https://headscale.example.test" } });
  fireEvent.change(screen.getByLabelText("One-time enrollment key"), { target: { value: "preauth" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect private network" }));
  expect(await screen.findByText("100.64.0.8")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  await waitFor(() => expect(screen.getByText("100.64.0.9")).toBeInTheDocument());
  expect(JSON.parse(mockFetch.mock.calls[2][1].body)).toEqual({ action: "refresh" });
});

it("shows unsupported lifecycle state without an enrollment control", async () => {
  mockFetch.mockResolvedValue(jsonResponse({ success: true, data: { supported: false, connection: null } }));
  render(<HivraPrivateAccessPanel agentId="agent-1" />);
  expect(await screen.findByText(/needs a running Ubuntu computer on Hivra Cloud or My server/)).toBeInTheDocument();
  expect(screen.queryByLabelText("One-time enrollment key")).not.toBeInTheDocument();
});

// Regression: a stopped, eligible Ubuntu computer was told it "does not meet
// that support contract", as if it could never connect.
it.each([
  ["not_running", "Start this computer to connect it to a private network."],
  ["operation_in_progress", "Wait for the current operation to finish, then connect."],
  ["not_ready", "Wait for this computer to finish starting, then connect."],
  ["not_bound", "It was created before Hivra recorded ownership checks."],
])("says what to do when the server reports %s", async (reason, copy) => {
  mockFetch.mockResolvedValue(jsonResponse({ success: true, data: { supported: false, reason, connection: null } }));
  render(<HivraPrivateAccessPanel agentId="agent-1" />);
  expect(await screen.findByText(new RegExp(copy.replace(/[.?]/g, "\\$&")))).toBeInTheDocument();
  expect(screen.queryByText(/support contract/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("One-time enrollment key")).not.toBeInTheDocument();
});

it("checks again when the computer's status changes, keeping a typed key", async () => {
  mockFetch.mockResolvedValue(jsonResponse({ success: true, data: { supported: false, reason: "not_running", connection: null } }));
  const view = render(<HivraPrivateAccessPanel agentId="agent-1" observedStatus="stopped" />);
  await screen.findByText(/Start this computer/);
  mockFetch.mockResolvedValue(jsonResponse({ success: true, data: { supported: true, reason: null, connection: null } }));
  view.rerender(<HivraPrivateAccessPanel agentId="agent-1" observedStatus="running" />);
  expect(await screen.findByLabelText("One-time enrollment key")).toBeInTheDocument();
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

it("asks before disconnecting, because reconnecting needs a new enrollment key", async () => {
  const connection = { state: "connected", loginServer: "https://controlplane.tailscale.com", magicDnsName: "ubuntu.tail1234.ts.net", ipv4: "100.64.0.7", observedAt: "2026-09-15T12:00:00Z" };
  mockFetch
    .mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true, connection } }))
    .mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true, connection: { ...connection, state: "disconnected" } } }));
  render(<HivraPrivateAccessPanel agentId="agent-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Disconnect this computer\? Reconnecting needs a new one-time enrollment key/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("button", { name: "Disconnect computer" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect computer" }));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ action: "disconnect" });
  await waitFor(() => expect(screen.getByText("Status:").parentElement).toHaveTextContent("Status: disconnected"));
});

it("keeps enrollment inputs free of touch-keyboard capitalization", async () => {
  mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true, connection: null } }));
  render(<HivraPrivateAccessPanel agentId="agent-1" />);
  const key = await screen.findByLabelText("One-time enrollment key");
  fireEvent.click(screen.getByLabelText("Use a Headscale coordination server"));
  for (const input of [key, screen.getByLabelText("HTTPS coordination URL")]) {
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
  }
  expect(screen.getByLabelText("HTTPS coordination URL")).toHaveAttribute("inputmode", "url");
});

describe("private network v2 (flag on)", () => {
  const FLAG = "NEXT_PUBLIC_HIVRA_PRIVATE_NETWORK_V2";
  const saved = process.env[FLAG];
  beforeEach(() => { process.env[FLAG] = "1"; });
  afterEach(() => { if (saved === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved; });

  const live = (extra: Record<string, unknown> = {}) => ({ state: "connected", loginServer: "https://controlplane.tailscale.com",
    ipv4: "100.64.0.7", observedAt: "2026-11-11T12:00:00Z", provider: "tailscale", ...extra });

  it("offers three networks and tells people to make a one-off key with tag:hivra", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true, connection: null } }));
    render(<HivraPrivateAccessPanel agentId="agent-1" />);
    expect(await screen.findByRole("radio", { name: "Tailscale" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Headscale" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "NetBird" })).toBeInTheDocument();
    expect(screen.getByText(/one-off, pre-approved key with the tag tag:hivra/)).toBeInTheDocument();
  });

  it("sends the chosen provider, and an optional NetBird server only when given", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true, connection: null } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true,
        connection: live({ provider: "netbird", loginServer: "https://api.netbird.io", ipv4: "100.92.1.2" }) } }));
    render(<HivraPrivateAccessPanel agentId="agent-1" />);
    fireEvent.click(await screen.findByRole("radio", { name: "NetBird" }));
    fireEvent.change(screen.getByLabelText("One-time enrollment key"), { target: { value: "nb-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect private network" }));
    expect(await screen.findByText("100.92.1.2")).toBeInTheDocument();
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ action: "connect", provider: "netbird", authKey: "nb-secret" });
    expect(screen.getByText(/Make a setup key that can be used once/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Policy to copy")).not.toBeInTheDocument();
  });

  it("shows a collapsed policy after connecting and copies it", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true, connection: live({ canSeeOtherDevices: false, visiblePeerCount: 0 }) } }));
    const { container } = render(<HivraPrivateAccessPanel agentId="agent-1" />);
    expect(await screen.findByText("Keep your other devices safe")).toBeInTheDocument();
    expect(container.querySelector("details")).not.toHaveAttribute("open");
    expect(screen.getByText(/no other devices\. This is what it can see, not a proof/)).toBeInTheDocument();
    expect(screen.getByLabelText("Policy to copy").textContent).toContain('"tag:hivra:22"');
    fireEvent.click(screen.getByRole("button", { name: "Copy policy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"tagOwners"')));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("warns gently, and opens the policy, when the computer can see other devices", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true,
      connection: live({ canSeeOtherDevices: true, visiblePeerCount: 3 }) } }));
    const { container } = render(<HivraPrivateAccessPanel agentId="agent-1" />);
    expect(await screen.findByText(/shows this computer 3 other devices/)).toBeInTheDocument();
    expect(screen.getByText(/not a proof of what it can reach/)).toBeInTheDocument();
    expect(container.querySelector("details")).toHaveAttribute("open");
  });

  it("warns when the computer joined without tag:hivra", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true, connection: live({ taggedHivra: false }) } }));
    render(<HivraPrivateAccessPanel agentId="agent-1" />);
    expect(await screen.findByText(/joined without the tag:hivra tag/)).toBeInTheDocument();
  });

  it("switches network in one action from the connected screen", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true, connection: live() } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true,
        connection: live({ provider: "netbird", loginServer: "https://api.netbird.io", ipv4: "100.92.1.2" }) } }));
    render(<HivraPrivateAccessPanel agentId="agent-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Use a different network" }));
    fireEvent.click(screen.getByRole("radio", { name: "NetBird" }));
    fireEvent.change(screen.getByLabelText("One-time enrollment key"), { target: { value: "nb-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Switch private network" }));
    expect(await screen.findByText("100.92.1.2")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).provider).toBe("netbird");
  });

  it("shows the plain-words reason when a connect is refused", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true, connection: null } }))
      .mockResolvedValueOnce(jsonResponse({ success: false, failureCode: "client_too_old",
        error: "This computer's Tailscale is older than 1.104.4, which Hivra needs to connect safely. Update Tailscale on the computer, then connect again." }, 202));
    render(<HivraPrivateAccessPanel agentId="agent-1" />);
    fireEvent.change(await screen.findByLabelText("One-time enrollment key"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect private network" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/older than 1\.104\.4/);
  });
});

it("keeps the original screen when the flag is off", async () => {
  mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { supported: true, connection: null } }));
  render(<HivraPrivateAccessPanel agentId="agent-1" />);
  await screen.findByLabelText("One-time enrollment key");
  expect(screen.queryByRole("radio", { name: "NetBird" })).not.toBeInTheDocument();
  expect(screen.queryByText(/tag:hivra/)).not.toBeInTheDocument();
});
