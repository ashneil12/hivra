import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockLaunch = jest.fn();
const mockAssertStreamable = jest.fn();
const mockStream = jest.fn();
const mockApproval = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: () => null }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock("@/lib/infrastructure/digitalocean-store", () => ({ listDigitalOceanTargets: jest.fn(async () => []) }));
jest.mock("@/lib/hivra/do-managed-sessions", () => {
  class ManagedSessionError extends Error {
    constructor(public readonly code: string, message: string, public readonly agentId?: string) { super(message); }
  }
  return {
    ManagedSessionError,
    launchDigitalOceanSession: (...args: unknown[]) => mockLaunch(...args),
    listManagedSessions: jest.fn(async () => []),
    assertManagedSessionStreamable: (...args: unknown[]) => mockAssertStreamable(...args),
    streamManagedSessionEvents: (...args: unknown[]) => mockStream(...args),
    resolveManagedSessionApproval: (...args: unknown[]) => mockApproval(...args),
  };
});

import { POST as launch } from "../route";
import { GET as events } from "../[id]/events/route";
import { POST as approve } from "../[id]/approvals/[requestId]/route";
import { ManagedSessionError } from "@/lib/hivra/do-managed-sessions";

const AGENT = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "http://localhost";

function mutation(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", host: "localhost", ...headers },
    body: JSON.stringify(body),
  });
}

const launchBody = {
  launchRequestId: "22222222-2222-4222-8222-222222222222",
  connectionId: "33333333-3333-4333-8333-333333333333",
  targetId: "44444444-4444-4444-8444-444444444444",
  harness: "codex", size: "mars-2vcpu-4gb", name: "Agent",
  model: { mode: "vendor", apiKey: "sk-" + "a".repeat(40) },
};

beforeEach(() => {
  mockLaunch.mockReset();
  mockAuth.mockResolvedValue({ userId: "user_1" });
  process.env.NEXT_PUBLIC_HIVRA_AGENTS = "1";
});
afterEach(() => { delete process.env.NEXT_PUBLIC_HIVRA_AGENTS; });

it("stays unavailable off the Hivra hosts, before auth or DigitalOcean work", async () => {
  delete process.env.NEXT_PUBLIC_HIVRA_AGENTS;
  const response = await launch(mutation("/api/hivra/managed-sessions", launchBody));
  expect(response.status).toBe(404);
  expect(mockAuth).not.toHaveBeenCalled();
  expect(mockLaunch).not.toHaveBeenCalled();
});

describe("POST /api/hivra/managed-sessions", () => {
  it("requires a signed-in, same-origin JSON request", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    expect((await launch(mutation("/api/hivra/managed-sessions", launchBody))).status).toBe(401);
    expect((await launch(mutation("/api/hivra/managed-sessions", launchBody, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("rejects an unsupported harness before calling DigitalOcean", async () => {
    const response = await launch(mutation("/api/hivra/managed-sessions", { ...launchBody, harness: "cursor" }));
    expect(response.status).toBe(400);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  // INF-16: a launch may name a key saved in the owner's Vault instead of pasting it.
  it("accepts a saved Vault key id in place of a pasted key, for the signed-in owner", async () => {
    mockLaunch.mockResolvedValueOnce({ agentId: AGENT });
    const model = { mode: "vendor", vaultKeyId: "55555555-5555-4555-8555-555555555555" };
    const response = await launch(mutation("/api/hivra/managed-sessions", { ...launchBody, model }));
    expect(response.status).toBe(201);
    expect(mockLaunch).toHaveBeenCalledWith("user_1", expect.objectContaining({ model }));
  });

  it.each([
    ["both a saved key and a pasted key", { mode: "vendor", apiKey: "sk-" + "a".repeat(40), vaultKeyId: "55555555-5555-4555-8555-555555555555" }],
    ["neither", { mode: "vendor" }],
  ])("refuses a vendor model with %s before calling DigitalOcean", async (_label, model) => {
    const response = await launch(mutation("/api/hivra/managed-sessions", { ...launchBody, model }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Choose either a saved Vault key or a pasted key for this launch." });
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("refuses a saved key for DigitalOcean Inference, which the Vault doesn't hold", async () => {
    const model = { mode: "digitalocean-inference", vaultKeyId: "55555555-5555-4555-8555-555555555555", model: "llama3.3-70b-instruct" };
    const response = await launch(mutation("/api/hivra/managed-sessions", { ...launchBody, harness: "hermes", model }));
    expect(response.status).toBe(400);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("maps a prepaid-balance refusal to 402 with its code", async () => {
    mockLaunch.mockRejectedValueOnce(new ManagedSessionError("payment_required", "Top up DigitalOcean."));
    const response = await launch(mutation("/api/hivra/managed-sessions", launchBody));
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({ error: "Top up DigitalOcean.", code: "payment_required" });
  });
});

describe("GET /api/hivra/managed-sessions/[id]/events", () => {
  it("fails as JSON, before any stream bytes, when the session cannot stream", async () => {
    mockAssertStreamable.mockRejectedValueOnce(new ManagedSessionError("not_ready", "This session is still starting."));
    const response = await events(new NextRequest(`${ORIGIN}/api/hivra/managed-sessions/${AGENT}/events`), { params: Promise.resolve({ id: AGENT }) });
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("relays sanitized events as SSE frames with resumable ids, resuming from Last-Event-ID", async () => {
    mockAssertStreamable.mockResolvedValueOnce(undefined);
    mockStream.mockImplementationOnce(async function* () {
      yield { id: "e7", runId: "r1", type: "run.token_delta", at: null, data: { text: "hi", isReasoning: false } };
    });
    const response = await events(new NextRequest(`${ORIGIN}/api/hivra/managed-sessions/${AGENT}/events?after=e1`, { headers: { "last-event-id": "e6" } }), { params: Promise.resolve({ id: AGENT }) });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("retry: 2000");
    expect(text).toContain('id: e7\ndata: {"id":"e7","runId":"r1","type":"run.token_delta"');
    expect(mockStream).toHaveBeenCalledWith("user_1", AGENT, expect.objectContaining({ after: "e6" }));
  });
});

describe("POST /api/hivra/managed-sessions/[id]/approvals/[requestId]", () => {
  it("forwards a decision and reports acceptance, not completion", async () => {
    mockApproval.mockResolvedValueOnce(undefined);
    const response = await approve(mutation(`/api/hivra/managed-sessions/${AGENT}/approvals/hitl_1`, { outcome: "approve" }), { params: Promise.resolve({ id: AGENT, requestId: "hitl_1" }) });
    expect(response.status).toBe(202);
    expect(mockApproval).toHaveBeenCalledWith("user_1", AGENT, "hitl_1", "approve");
  });

  it("rejects a malformed approval id", async () => {
    const response = await approve(mutation(`/api/hivra/managed-sessions/${AGENT}/approvals/x`, { outcome: "approve" }), { params: Promise.resolve({ id: AGENT, requestId: "../../x" }) });
    expect(response.status).toBe(404);
    expect(mockApproval).not.toHaveBeenCalled();
  });
});
