/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { BuzzConnectionsPage } from "../BuzzConnectionsPage";

const CONNECTION = "00000000-0000-4000-8000-000000001003";
const AGENT = "00000000-0000-4000-8000-000000001008";
const BINDING = "00000000-0000-4000-8000-000000001014";
const PUBLIC_KEY = "b".repeat(64);

const connection = {
  id: CONNECTION,
  relayUrl: "wss://buzz.example",
  openUrl: "https://buzz.example",
  relayPublicKey: "a".repeat(64),
  displayName: "Studio Relay",
  software: "https://github.com/block/buzz",
  version: "0.5.20",
  requiresMembership: true,
  revision: 1,
  status: "ready",
  observedAt: "2026-09-01T00:00:00.000Z",
};

const agent = { id: AGENT, name: "Research", type: "codex", status: "running", desiredState: "running" };

function response(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: async () => ({ success: status < 400, data }),
  } as Response);
}

describe("BuzzConnectionsPage", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(global.crypto, "randomUUID", {
      configurable: true,
      value: jest.fn(() => "00000000-0000-4000-8000-000000001017"),
    });
  });

  afterEach(() => { global.fetch = originalFetch; });

  it("explains the private runtime preview without claiming unsupported substrates", async () => {
    global.fetch = jest.fn(() => response({
      connections: [connection],
      bindings: [{
        id: BINDING, connectionId: CONNECTION, agentId: AGENT, agentName: "Research", agentType: "codex",
        publicKey: PUBLIC_KEY, status: "joined", lastHealthAt: null, joinedAt: "2026-09-01T00:00:00.000Z",
        revokedAt: null, lastErrorCode: null, runtimeAdapter: "not_installed", runtimeProvider: null,
        runtimeModel: null, runtimeLastObservedAt: null, runtimeLastErrorCode: null,
      }],
      agents: [agent],
    })) as typeof fetch;

    render(<BuzzConnectionsPage />);

    expect(await screen.findByText("Studio Relay")).toBeInTheDocument();
    expect(screen.getByText("Membership verified")).toBeInTheDocument();
    expect(screen.getByText("Runtime not installed")).toBeInTheDocument();
    expect(screen.getByText(/Other substrates remain unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/does not reuse the agent's existing vendor login or conversation/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open relay/i })).toHaveAttribute("href", "https://buzz.example");
    expect(screen.getByRole("button", { name: "Check Buzz membership for Research" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave Buzz relay for Research" }));
    expect(screen.getByRole("button", { name: "Confirm Buzz leave for Research" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel Buzz leave for Research" })).toBeInTheDocument();
  });

  it("connects a relay and refreshes the inspected identity", async () => {
    let summary = { connections: [] as typeof connection[], bindings: [], agents: [agent] };
    global.fetch = jest.fn((input, init) => {
      const url = String(input);
      if (url === "/api/hivra/buzz" && init?.method === "POST") {
        summary = { ...summary, connections: [connection] };
        return response({ connection }, 201);
      }
      return response(summary);
    }) as typeof fetch;

    render(<BuzzConnectionsPage />);
    expect(await screen.findByText("No relay connected")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /Relay URL/ }), { target: { value: "https://buzz.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect relay" }));

    expect(await screen.findByText("Studio Relay")).toBeInTheDocument();
    expect(screen.getByText("Relay identity inspected and pinned to this account.")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith("/api/hivra/buzz", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ relayUrl: "https://buzz.example" }),
    }));
  });

  it("treats an invite as write-only and shows the verified agent identity", async () => {
    let bindings: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn((input, init) => {
      if (String(input) === "/api/hivra/buzz/bindings" && init?.method === "POST") {
        expect(String(init.body)).toContain("one-time-secret");
        bindings = [{
          id: BINDING, connectionId: CONNECTION, agentId: AGENT, agentName: "Research", agentType: "codex",
          publicKey: PUBLIC_KEY, status: "joined", lastHealthAt: null, joinedAt: "2026-09-01T00:00:00.000Z",
          revokedAt: null, lastErrorCode: null, runtimeAdapter: "not_installed", runtimeProvider: null,
          runtimeModel: null, runtimeLastObservedAt: null, runtimeLastErrorCode: null,
        }];
        return response({ bindingId: BINDING, status: "joined" });
      }
      return response({ connections: [connection], bindings, agents: [agent] });
    }) as typeof fetch;

    render(<BuzzConnectionsPage />);
    await screen.findByText("Studio Relay");
    fireEvent.change(screen.getByLabelText(/One-time invite/), { target: { value: "one-time-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Admit agent" }));

    expect(await screen.findByText("Membership verified")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByDisplayValue("one-time-secret")).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain("one-time-secret");
  });

  it("shows a useful inline error rather than leaving the setup form stuck", async () => {
    global.fetch = jest.fn((input, init) => {
      if (String(input) === "/api/hivra/buzz" && init?.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 422,
          json: async () => ({ success: false, error: "That server is not a compatible Buzz relay." }),
        } as Response);
      }
      return response({ connections: [], bindings: [], agents: [agent] });
    }) as typeof fetch;
    render(<BuzzConnectionsPage />);
    await screen.findByText("No relay connected");
    fireEvent.change(screen.getByRole("textbox", { name: /Relay URL/ }), { target: { value: "https://wrong.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect relay" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("not a compatible Buzz relay");
    await act(async () => undefined);
  });

  it("treats the runtime provider key as write-only and renders the settled runtime", async () => {
    let runtimeAdapter = "not_installed";
    const currentSummary = () => ({
      connections: [connection],
      bindings: [{
        id: BINDING, connectionId: CONNECTION, agentId: AGENT, agentName: "Research", agentType: "codex",
        publicKey: PUBLIC_KEY, status: "joined", lastHealthAt: null, joinedAt: "2026-09-01T00:00:00.000Z",
        revokedAt: null, lastErrorCode: null, runtimeAdapter,
        runtimeProvider: runtimeAdapter === "active" ? "openai" : null,
        runtimeModel: runtimeAdapter === "active" ? "gpt-5" : null,
        runtimeLastObservedAt: runtimeAdapter === "active" ? "2026-09-01T12:00:00.000Z" : null,
        runtimeLastErrorCode: null,
      }],
      agents: [agent],
    });
    global.fetch = jest.fn((input, init) => {
      if (String(input) === `/api/hivra/buzz/bindings/${BINDING}` && init?.method === "POST") {
        expect(String(init.body)).toContain("sk-write-only-test");
        expect(JSON.parse(String(init.body))).toMatchObject({
          action: "runtime_install", provider: "openai", model: "gpt-5", ownerPublicKey: "c".repeat(64),
        });
        runtimeAdapter = "active";
        return response({ bindingId: BINDING, status: "active" });
      }
      return response(currentSummary());
    }) as typeof fetch;

    render(<BuzzConnectionsPage />);
    await screen.findByText("Runtime not installed");
    fireEvent.change(screen.getByLabelText("Buzz runtime API key for Research"), { target: { value: "sk-write-only-test" } });
    fireEvent.change(screen.getByLabelText("Buzz owner public key for Research"), { target: { value: "c".repeat(64) } });
    fireEvent.click(screen.getByRole("button", { name: "Activate runtime" }));

    expect(await screen.findByText(/Owner-only Buzz sidecar active/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("sk-write-only-test")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("sk-write-only-test");
    expect(screen.getByRole("button", { name: "Check runtime" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove runtime" })).toBeInTheDocument();
  });

  it("uses the saved Venice Vault key without rendering or posting plaintext", async () => {
    const joinedSummary = {
      connections: [connection],
      bindings: [{
        id: BINDING, connectionId: CONNECTION, agentId: AGENT, agentName: "Research", agentType: "codex",
        publicKey: PUBLIC_KEY, status: "joined", lastHealthAt: null, joinedAt: "2026-09-01T00:00:00.000Z",
        revokedAt: null, lastErrorCode: null, runtimeAdapter: "not_installed", runtimeProvider: null,
        runtimeModel: null, runtimeLastObservedAt: null, runtimeLastErrorCode: null,
      }],
      agents: [agent],
    };
    global.fetch = jest.fn((input, init) => {
      if (String(input) === `/api/hivra/buzz/bindings/${BINDING}` && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
          action: "runtime_install", provider: "venice", model: "deepseek-v4-flash-0731-fast",
        });
        expect(body).not.toHaveProperty("apiKey");
        return response({ bindingId: BINDING, status: "active" });
      }
      return response(joinedSummary);
    }) as typeof fetch;

    render(<BuzzConnectionsPage />);
    await screen.findByText("Runtime not installed");
    fireEvent.change(screen.getByLabelText("Buzz runtime provider for Research"), { target: { value: "venice" } });
    expect(screen.queryByLabelText("Buzz runtime API key for Research")).not.toBeInTheDocument();
    expect(screen.getByText("Venice key from Vault")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Buzz owner public key for Research"), { target: { value: "c".repeat(64) } });
    fireEvent.click(screen.getByRole("button", { name: "Activate runtime" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      `/api/hivra/buzz/bindings/${BINDING}`, expect.objectContaining({ method: "POST" }),
    ));
  });
});
