/** @jest-environment node */
jest.mock("server-only", () => ({}));

const mockAuth = jest.fn();
const mockGet = jest.fn();
const mockQuote = jest.fn();
const mockApply = jest.fn();
const mockLimit = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockLimit(...args) }));
jest.mock("@/lib/hivra/provider-agent-resize", () => {
  class ProviderAgentResizeError extends Error {
    constructor(readonly code: string) { super(code); this.name = "ProviderAgentResizeError"; }
  }
  return {
    ProviderAgentResizeError,
    getProviderResizeView: (...args: unknown[]) => mockGet(...args),
    quoteProviderResize: (...args: unknown[]) => mockQuote(...args),
    applyProviderResize: (...args: unknown[]) => mockApply(...args),
  };
});

import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import {
  ProviderAgentResizeError,
  type ProviderResizeErrorCode,
} from "@/lib/hivra/provider-agent-resize";
import { PROVIDER_RESIZE_BILLING_CONFIRMATION } from "@/lib/hivra/provider-agent-resize-contract";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const quoteFingerprint = "d".repeat(64);
const context = { params: Promise.resolve({ id }) };

function request(method: "GET" | "POST", body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`https://hivra.test/api/hivra/agents/${id}/provider-resize`, {
    method,
    headers: method === "POST" ? {
      host: "hivra.test", origin: "https://hivra.test", "sec-fetch-site": "same-origin",
      "content-type": "application/json", ...headers,
    } : { host: "hivra.test", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: "owner" });
  mockLimit.mockReturnValue(null);
  mockGet.mockResolvedValue({ operation: null, catalog: { capability: "hetzner-change-type-v1" } });
});

it("reads only the authenticated owner's capability-gated state and disables caches", async () => {
  const response = await GET(request("GET"), context);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mockGet).toHaveBeenCalledWith("owner", id);
});

it("describes an active installation as busy without claiming a resize was saved", async () => {
  mockGet.mockRejectedValue(new ProviderAgentResizeError("computer_busy"));
  const response = await GET(request("GET"), context);
  expect(response.status).toBe(409);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body.code).toBe("computer_busy");
  expect(JSON.stringify(body)).toContain("operation in progress");
  expect(JSON.stringify(body)).not.toContain("original resize is saved");
  expect(mockQuote).not.toHaveBeenCalled();
  expect(mockApply).not.toHaveBeenCalled();
});

it("requires authentication and same-origin strict JSON before any resize work", async () => {
  mockAuth.mockResolvedValueOnce({ userId: null });
  expect((await POST(request("POST", { mode: "quote" }), context)).status).toBe(401);

  expect((await POST(request("POST", { mode: "quote" }, { origin: "https://attacker.test", "sec-fetch-site": "cross-site" }), context)).status).toBe(403);
  expect((await POST(request("POST", { mode: "quote" }, { "content-type": "text/plain" }), context)).status).toBe(415);
  expect(mockQuote).not.toHaveBeenCalled();
  expect(mockApply).not.toHaveBeenCalled();
});

it("saves a fresh owner-bound quote without accepting arbitrary resources", async () => {
  const quote = { operationId, quoteFingerprint };
  mockQuote.mockResolvedValue(quote);
  const response = await POST(request("POST", { mode: "quote", operationId, targetServerType: "cpx32" }), context);
  expect(response.status).toBe(200);
  expect(mockQuote).toHaveBeenCalledWith({ userId: "owner", agentId: id, operationId, targetServerType: "cpx32" });
  expect(await response.json()).toEqual({ success: true, data: { quote } });

  const invalid = await POST(request("POST", { mode: "quote", operationId, targetServerType: "cpx32", cpu: 64 }), context);
  expect(invalid.status).toBe(400);
  expect(mockQuote).toHaveBeenCalledTimes(1);
});

it("requires the exact billing confirmation and returns 202 until actual provider reconciliation completes", async () => {
  mockApply.mockResolvedValue({ operationId, stage: "action_pending" });
  const body = { mode: "apply", operationId, quoteFingerprint, billingConfirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION };
  const response = await POST(request("POST", body), context);
  expect(response.status).toBe(202);
  expect(mockApply).toHaveBeenCalledWith({
    userId: "owner",
    agentId: id,
    operationId,
    quoteFingerprint,
    billingConfirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION,
  });

  const weak = await POST(request("POST", { ...body, billingConfirmation: "yes" }), context);
  expect(weak.status).toBe(400);
  expect(mockApply).toHaveBeenCalledTimes(1);
});

it.each([
  ["not_found", 404], ["computer_must_be_stopped", 409], ["quote_changed", 409],
  ["provider_unavailable", 503], ["operation_unverified", 503],
])("maps %s to a stable secret-free response", async (code, status) => {
  mockGet.mockRejectedValue(new ProviderAgentResizeError(code as ProviderResizeErrorCode));
  const response = await GET(request("GET"), context);
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(body.code).toBe(code);
  expect(JSON.stringify(body)).not.toContain("private");
});
