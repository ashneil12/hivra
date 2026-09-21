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
  expect(await screen.findByText(/running, owner-bound Ubuntu computer on Proxmox/)).toBeInTheDocument();
  expect(screen.queryByLabelText("One-time enrollment key")).not.toBeInTheDocument();
});
