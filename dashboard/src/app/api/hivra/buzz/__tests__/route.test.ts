/** @jest-environment node */

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { GET, POST as CONNECT } from "../route";
import { POST as BIND } from "../bindings/route";
import { DELETE as DISCONNECT, POST as BINDING_ACTION } from "../bindings/[id]/route";
import { createBuzzCoordinator, BuzzCoordinatorError } from "@/lib/hivra/buzz-coordinator";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: jest.fn(() => true) }));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: jest.fn(() => null),
  RATE_LIMIT_PRESETS: { secretWrite: { limit: 20, windowMs: 60_000 } },
}));
jest.mock("@/lib/hivra/buzz-coordinator", () => {
  const actual = jest.requireActual("@/lib/hivra/buzz-coordinator");
  return { ...actual, createBuzzCoordinator: jest.fn() };
});

const USER = "user_a";
const CONNECTION = "00000000-0000-4000-8000-000000001003";
const AGENT = "00000000-0000-4000-8000-000000001008";
const BINDING = "00000000-0000-4000-8000-000000001014";
const OPERATION = "00000000-0000-4000-8000-000000001017";
const coordinator = {
  summary: jest.fn(),
  connect: jest.fn(),
  bind: jest.fn(),
  resume: jest.fn(),
  health: jest.fn(),
  activateRuntime: jest.fn(),
  resumeRuntime: jest.fn(),
  runtimeHealth: jest.fn(),
  removeRuntime: jest.fn(),
  disconnect: jest.fn(),
};

function request(path: string, method = "GET", body?: unknown, sameOrigin = true) {
  const headers = new Headers({ host: "canary.hermesos.cloud" });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (sameOrigin) {
    headers.set("origin", "https://canary.hermesos.cloud");
    headers.set("sec-fetch-site", "same-origin");
  }
  return new NextRequest(`https://canary.hermesos.cloud${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("Hivra Buzz API", () => {
  let consoleWarn: jest.SpyInstance;
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: USER });
    (createBuzzCoordinator as jest.Mock).mockReturnValue(coordinator);
    (enforceAuthenticatedRouteRateLimit as jest.Mock).mockReturnValue(null);
    coordinator.summary.mockResolvedValue({ connections: [], bindings: [], agents: [] });
    coordinator.connect.mockResolvedValue({ id: CONNECTION, relayUrl: "wss://buzz.example" });
    coordinator.bind.mockResolvedValue({ bindingId: BINDING, status: "joined" });
    coordinator.resume.mockResolvedValue({ bindingId: BINDING, status: "joined" });
    coordinator.health.mockResolvedValue({ bindingId: BINDING, healthy: true, status: "joined" });
    coordinator.activateRuntime.mockResolvedValue({ bindingId: BINDING, status: "active" });
    coordinator.resumeRuntime.mockResolvedValue({ bindingId: BINDING, status: "active" });
    coordinator.runtimeHealth.mockResolvedValue({ bindingId: BINDING, healthy: true, status: "active" });
    coordinator.removeRuntime.mockResolvedValue({ bindingId: BINDING, status: "removed" });
    coordinator.disconnect.mockResolvedValue({ bindingId: BINDING, status: "revoked" });
  });

  afterEach(() => {
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });

  it("returns only the coordinator's public Buzz summary and forbids caching", async () => {
    coordinator.summary.mockResolvedValue({
      connections: [{ id: CONNECTION, relayPublicKey: "a".repeat(64) }],
      bindings: [{ id: BINDING, publicKey: "b".repeat(64), runtimeAdapter: "not_installed" }],
      agents: [],
    });
    const response = await GET(request("/api/hivra/buzz"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.data.bindings[0].runtimeAdapter).toBe("not_installed");
    expect(JSON.stringify(body)).not.toMatch(/invite|privateKey|ciphertext/i);
  });

  it("requires authentication before listing or mutating Buzz", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    expect((await GET(request("/api/hivra/buzz"))).status).toBe(401);
    expect((await CONNECT(request("/api/hivra/buzz", "POST", { relayUrl: "https://buzz.example" }))).status).toBe(401);
    expect(coordinator.summary).not.toHaveBeenCalled();
    expect(coordinator.connect).not.toHaveBeenCalled();
  });

  it("rejects cross-site relay connection requests before touching a secret", async () => {
    const response = await CONNECT(request("/api/hivra/buzz", "POST", {
      relayUrl: "https://buzz.example",
    }, false));
    expect(response.status).toBe(403);
    expect(coordinator.connect).not.toHaveBeenCalled();
  });

  it("inspects and connects a relay through the bounded secret-write path", async () => {
    const response = await CONNECT(request("/api/hivra/buzz", "POST", {
      relayUrl: "https://buzz.example",
    }));
    expect(response.status).toBe(201);
    expect(enforceAuthenticatedRouteRateLimit).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({
      routeKey: "hivra_buzz_connect", userId: USER, limit: 20,
    }));
    expect(coordinator.connect).toHaveBeenCalledWith(USER, "https://buzz.example");
  });

  it("binds an agent without reflecting the invite in the response", async () => {
    const response = await BIND(request("/api/hivra/buzz/bindings", "POST", {
      connectionId: CONNECTION,
      agentId: AGENT,
      operationId: OPERATION,
      inviteCode: "buzz-secret-invite",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(coordinator.bind).toHaveBeenCalledWith(USER, expect.objectContaining({ inviteCode: "buzz-secret-invite" }));
    expect(JSON.stringify(body)).not.toContain("buzz-secret-invite");
  });

  it("does not leak rejected invite values through errors or logs", async () => {
    coordinator.bind.mockRejectedValue(new BuzzCoordinatorError("invalid_invite"));
    const response = await BIND(request("/api/hivra/buzz/bindings", "POST", {
      connectionId: CONNECTION,
      agentId: AGENT,
      operationId: OPERATION,
      inviteCode: "do-not-log-this-invite",
    }));
    const serialized = JSON.stringify(await response.json()) + JSON.stringify(consoleWarn.mock.calls) + JSON.stringify(consoleError.mock.calls);

    expect(response.status).toBe(422);
    expect(serialized).not.toContain("do-not-log-this-invite");
  });

  it("supports retry, health, and signed disconnect actions", async () => {
    const context = { params: Promise.resolve({ id: BINDING }) };
    expect((await BINDING_ACTION(request(`/api/hivra/buzz/bindings/${BINDING}`, "POST", { action: "resume" }), context)).status).toBe(200);
    expect((await BINDING_ACTION(request(`/api/hivra/buzz/bindings/${BINDING}`, "POST", { action: "health" }), context)).status).toBe(200);
    expect((await DISCONNECT(request(`/api/hivra/buzz/bindings/${BINDING}`, "DELETE", {}), context)).status).toBe(200);

    expect(coordinator.resume).toHaveBeenCalledWith(USER, BINDING);
    expect(coordinator.health).toHaveBeenCalledWith(USER, BINDING);
    expect(coordinator.disconnect).toHaveBeenCalledWith(USER, BINDING);
  });

  it("accepts a write-only provider key for runtime activation without reflecting it", async () => {
    const context = { params: Promise.resolve({ id: BINDING }) };
    const response = await BINDING_ACTION(request(`/api/hivra/buzz/bindings/${BINDING}`, "POST", {
      action: "runtime_install",
      operationId: OPERATION,
      provider: "openai",
      model: "gpt-5",
      apiKey: "sk-do-not-reflect",
      ownerPublicKey: "c".repeat(64),
    }), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(coordinator.activateRuntime).toHaveBeenCalledWith(USER, BINDING, expect.objectContaining({
      apiKey: "sk-do-not-reflect", ownerPublicKey: "c".repeat(64),
    }));
    expect(JSON.stringify(body)).not.toContain("sk-do-not-reflect");
  });

  it("activates Venice from Vault without accepting a browser-side provider key", async () => {
    const context = { params: Promise.resolve({ id: BINDING }) };
    const response = await BINDING_ACTION(request(`/api/hivra/buzz/bindings/${BINDING}`, "POST", {
      action: "runtime_install",
      operationId: OPERATION,
      provider: "venice",
      model: "qwen3-4b",
      ownerPublicKey: "c".repeat(64),
    }), context);

    expect(response.status).toBe(200);
    expect(coordinator.activateRuntime).toHaveBeenCalledWith(USER, BINDING, {
      action: "runtime_install", operationId: OPERATION, provider: "venice", model: "qwen3-4b",
      ownerPublicKey: "c".repeat(64),
    });
  });

  it("rejects a Venice install that tries to smuggle a browser-side key", async () => {
    const context = { params: Promise.resolve({ id: BINDING }) };
    const response = await BINDING_ACTION(request(`/api/hivra/buzz/bindings/${BINDING}`, "POST", {
      action: "runtime_install", operationId: OPERATION, provider: "venice", model: "qwen3-4b",
      apiKey: "must-not-be-accepted", ownerPublicKey: "c".repeat(64),
    }), context);
    expect(response.status).toBe(400);
    expect(coordinator.activateRuntime).not.toHaveBeenCalled();
  });

  it("supports runtime resume, health, and secret-erasing removal", async () => {
    const context = { params: Promise.resolve({ id: BINDING }) };
    for (const action of ["runtime_resume", "runtime_health", "runtime_remove"] as const) {
      const response = await BINDING_ACTION(request(`/api/hivra/buzz/bindings/${BINDING}`, "POST", { action }), context);
      expect(response.status).toBe(200);
    }
    expect(coordinator.resumeRuntime).toHaveBeenCalledWith(USER, BINDING);
    expect(coordinator.runtimeHealth).toHaveBeenCalledWith(USER, BINDING);
    expect(coordinator.removeRuntime).toHaveBeenCalledWith(USER, BINDING);
  });
});
