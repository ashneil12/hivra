/** @jest-environment jsdom */
// "Waiting for your OK": shows while a request is pending, answers it, polls only
// while the tab is visible, and renders nothing otherwise or where the bridge is off.
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PendingBridgeCard } from "../PendingBridgeCard";
import { BRIDGE_POLL_MS } from "../LocalBridgePanel";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAC = "11111111-1111-4111-8111-111111111111";
const calls: Array<{ url: string; init?: RequestInit }> = [];
let view: unknown;
let status = 200;

const bridgeView = (requests: unknown[]) => ({
  computers: [{ id: MAC, name: "Ash's Mac", revoked: false }],
  agents: [{ id: AGENT, name: "Claude" }],
  requests,
  allowances: [],
});
const pendingRequest = { id: "r1", agentId: AGENT, computerId: MAC, argv: ["ls", "-la"], cwd: null, status: "pending", createdAt: "2026-11-12T10:00:00Z", expiresAt: "2999-01-01T00:00:00Z" };

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

beforeEach(() => {
  jest.useFakeTimers();
  calls.length = 0;
  status = 200;
  setHidden(false);
  view = bridgeView([pendingRequest]);
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = (code: number, body: unknown) => ({ status: code, ok: code >= 200 && code < 300, json: async () => body }) as Response;
    if (init?.method === "POST") return reply(200, { success: true, data: {} });
    return status === 404 ? reply(404, {}) : reply(200, { success: true, data: view });
  }) as typeof fetch;
});
afterEach(() => { jest.useRealTimers(); });

const gets = () => calls.filter((call) => !call.init?.method).length;

describe("PendingBridgeCard", () => {
  it("shows who is waiting, on which computer, the exact command and the three answers", async () => {
    render(<PendingBridgeCard />);
    expect(await screen.findByRole("heading", { name: "Waiting for your OK" })).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Ash's Mac")).toBeInTheDocument();
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow any command from this agent for 1 hour" })).toBeInTheDocument();
  });

  it("sends the owner's answer", async () => {
    render(<PendingBridgeCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.find((call) => call.init?.method === "POST")).toBeTruthy());
    expect(JSON.parse(String(calls.find((call) => call.init?.method === "POST")?.init?.body))).toEqual({ action: "decide", requestId: "r1", decision: "approve" });
  });

  it("renders nothing when nothing is pending", async () => {
    view = bridgeView([{ ...pendingRequest, status: "done" }, { ...pendingRequest, id: "r2", expiresAt: "2000-01-01T00:00:00Z" }]);
    const { container } = render(<PendingBridgeCard />);
    await waitFor(() => expect(gets()).toBe(1));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing, and stops asking, where the bridge is off", async () => {
    status = 404;
    const { container } = render(<PendingBridgeCard />);
    await waitFor(() => expect(gets()).toBe(1));
    await act(async () => { jest.advanceTimersByTime(BRIDGE_POLL_MS * 3); });
    expect(container).toBeEmptyDOMElement();
    expect(gets()).toBe(1);
  });

  it("reads again every few seconds while the tab is visible, and not while it is hidden", async () => {
    view = bridgeView([]);
    render(<PendingBridgeCard />);
    await waitFor(() => expect(gets()).toBe(1));
    await act(async () => { jest.advanceTimersByTime(BRIDGE_POLL_MS); });
    await waitFor(() => expect(gets()).toBe(2));
    setHidden(true);
    await act(async () => { jest.advanceTimersByTime(BRIDGE_POLL_MS * 3); });
    expect(gets()).toBe(2);
    // A new request shows up on the next visible read.
    view = bridgeView([pendingRequest]);
    setHidden(false);
    await act(async () => { jest.advanceTimersByTime(BRIDGE_POLL_MS); });
    expect(await screen.findByRole("heading", { name: "Waiting for your OK" })).toBeInTheDocument();
  });
});
