import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { ModelKeyError, type ModelKeyProblem } from "@/lib/hivra/model-key-coordinator";
import { ModelKeyStoreError } from "@/lib/hivra/model-key-store";

const mockAuth = jest.fn(), mockAllowed = jest.fn(), mockLimit = jest.fn();
const mockSummary = jest.fn(), mockStart = jest.fn(), mockResume = jest.fn(), mockCreate = jest.fn();
const mockLaunchCreate = jest.fn(), mockLaunchSummary = jest.fn(), mockContinueLaunch = jest.fn(), mockCancelLaunch = jest.fn(), mockNoLaunch = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => mockAllowed() }));
jest.mock("@/lib/hivra/model-key-coordinator", () => ({
  ...jest.requireActual("@/lib/hivra/model-key-coordinator"),
  createModelKeyCoordinator: () => { mockCreate(); return { summary: mockSummary, start: mockStart, resume: mockResume }; },
}));
jest.mock("@/lib/hivra/launch-model-coordinator", () => ({
  createLaunchModelCoordinator: () => { mockLaunchCreate(); return { summary: mockLaunchSummary, continue: mockContinueLaunch,
    cancel: mockCancelLaunch, assertNoPendingLaunch: mockNoLaunch }; },
}));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockLimit(...args),
  RATE_LIMIT_PRESETS: { secretWrite: { limit: 20, windowMs: 60_000 } },
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const agentId = randomUUID(), operationId = randomUUID(), requestId = randomUUID();
const url = "https://canary.hivra.test/api/hivra/agents/" + agentId + "/llm";
const params = { params: Promise.resolve({ id: agentId }) };
const byok = { provider: "venice", mode: "byok", apiKey: "synthetic-fixture-secret" };
function req(body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(url, { method: body === undefined ? "GET" : "POST",
    headers: { Origin: "https://canary.hivra.test", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
}
beforeEach(() => {
  jest.resetAllMocks(); mockAuth.mockResolvedValue({ userId: "owner" }); mockAllowed.mockReturnValue(true);
  mockLimit.mockReturnValue(null); mockSummary.mockResolvedValue({ llm: null, pending: null });
  mockStart.mockResolvedValue({ operationId, status: "applied" }); mockResume.mockResolvedValue({ operationId, status: "pending", reason: "computer_busy" });
  mockLaunchSummary.mockResolvedValue(null); mockNoLaunch.mockResolvedValue(undefined);
  mockContinueLaunch.mockResolvedValue({ requestId, operationId, status: "pending" });
  mockCancelLaunch.mockResolvedValue({ requestId, status: "cancelled" });
});

it.each([GET, POST])("requires authenticated ownership before reading a body or constructing the coordinator", async handler => {
  mockAuth.mockResolvedValue({ userId: null });
  const response = await handler(req({ action: "apply", operationId, llm: byok }), params);
  expect(response.status).toBe(401); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mockCreate).not.toHaveBeenCalled(); expect(mockLaunchCreate).not.toHaveBeenCalled();
});
it.each([GET, POST])("keeps the existing Hivra feature/host gate", async handler => {
  mockAllowed.mockReturnValue(false);
  expect((await handler(req(), params)).status).toBe(404);
  expect(mockAuth).not.toHaveBeenCalled(); expect(mockCreate).not.toHaveBeenCalled();
});
it.each<Record<string, string>>([
  { Origin: "https://foreign.test" }, { "Sec-Fetch-Site": "cross-site" }, { Origin: "" }, { "Sec-Fetch-Site": "" },
])("refuses cross-origin or unproven browser mutations: %j", async headers => {
  expect((await POST(req({ action: "apply", operationId, llm: byok }, headers), params)).status).toBe(403);
  expect(mockCreate).not.toHaveBeenCalled();
});
it("requires JSON and a bounded request body", async () => {
  expect((await POST(req("private", { "Content-Type": "text/plain" }), params)).status).toBe(415);
  expect((await POST(req({ action: "apply", operationId, llm: byok }, { "Content-Length": "4097" }), params)).status).toBe(413);
  expect((await POST(req(JSON.stringify({ pad: "x".repeat(4097) })), params)).status).toBe(413);
  expect(mockCreate).not.toHaveBeenCalled();
});
it.each(["", "{", "null", "[]", "false", "0", '"private"', {}, { llm: null },
  { action: "apply", operationId }, { action: "apply", operationId: "bad", llm: null },
  { action: "apply", operationId, llm: null, userId: "foreign" }, { action: "resume", operationId, llm: byok },
  { action: "resume", operationId, hostname: "other.test" }])("rejects malformed or authority-bearing envelopes: %j", async body => {
  expect((await POST(req(body), params)).status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
});
it("rate limits secret mutations before coordinator access", async () => {
  mockLimit.mockReturnValue(new Response(null, { status: 429 }));
  const response = await POST(req({ action: "apply", operationId, llm: byok }), params);
  expect(response.status).toBe(429); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "owner", limit: 20 }));
});
it.each([byok, null])("delivers explicit settings or clear through the owner-bound coordinator: %j", async llm => {
  const response = await POST(req({ action: "apply", operationId, llm }), params);
  expect(response.status).toBe(200);
  expect(mockStart).toHaveBeenCalledWith("owner", agentId, operationId, llm);
  expect(mockNoLaunch).toHaveBeenCalledWith("owner", agentId);
  expect(mockResume).not.toHaveBeenCalled();
  const result = await response.json();
  expect(result).toEqual({ success: true, data: { operationId, status: "applied" } });
  expect(JSON.stringify(result)).not.toMatch(/synthetic-fixture-secret|apiKey|boxPayload|encrypted/);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it("resumes the same operation without requesting or returning its secret", async () => {
  const response = await POST(req({ action: "resume", operationId }), params);
  expect(response.status).toBe(202);
  expect(mockResume).toHaveBeenCalledWith("owner", agentId, operationId);
  expect(mockStart).not.toHaveBeenCalled();
  expect(await response.json()).toEqual({ success: true, data: { operationId, status: "pending", reason: "computer_busy" } });
});
it("reads saved and pending metadata without triggering delivery", async () => {
  const pending = { operationId, requested: null, createdAt: "2026-08-28T00:00:00Z", applying: false };
  mockSummary.mockResolvedValue({ llm: null, pending });
  const response = await GET(req(), params);
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mockSummary).toHaveBeenCalledWith("owner", agentId);
  expect(await response.json()).toEqual({ success: true, data: { llm: null, pending, launch: null } });
  expect(mockLaunchSummary).toHaveBeenCalledWith("owner", agentId);
  expect(mockStart).not.toHaveBeenCalled(); expect(mockResume).not.toHaveBeenCalled();
  expect(mockContinueLaunch).not.toHaveBeenCalled(); expect(mockCancelLaunch).not.toHaveBeenCalled();
});

it("returns key-free launch metadata without automatically delivering", async () => {
  const launch = { requestId, operationId, state: "needs_attention", createdAt: "2026-08-28T00:00:00Z",
    requested: { provider: "venice", mode: "byok", model: "fixture-model" } };
  mockLaunchSummary.mockResolvedValue(launch);
  const response = await GET(req(), params);
  expect(await response.json()).toEqual({ success: true, data: { llm: null, pending: null, launch } });
  expect(mockContinueLaunch).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
});
it("retains recovery when promotion commits during the summary read", async () => {
  const pending = { operationId, requested: { provider: "venice", mode: "byok", model: "fixture-model" },
    createdAt: "2026-08-28T00:00:00Z", applying: false };
  let promoted = false;
  mockSummary.mockImplementation(async () => ({ llm: null, pending: promoted ? pending : null }));
  mockLaunchSummary.mockImplementation(async () => { promoted = true; return null; });
  const response = await GET(req(), params);
  expect(await response.json()).toEqual({ success: true, data: { llm: null, pending, launch: null } });
  expect(mockContinueLaunch).not.toHaveBeenCalled();
});
it.each(["pending", "applied"])("uses later %s evidence instead of a stale waiting precursor", async phase => {
  const config = { provider: "venice", mode: "byok", model: "fixture-model" };
  const settings = { llm: phase === "applied" ? config : null,
    pending: phase === "pending" ? { operationId, requested: config, createdAt: "2026-08-28T00:00:00Z", applying: false } : null };
  mockLaunchSummary.mockResolvedValue({ requestId, operationId, state: "ready_to_apply", requested: config, createdAt: "2026-08-28T00:00:00Z" });
  mockSummary.mockResolvedValue(settings);
  expect(await (await GET(req(), params)).json()).toEqual({ success: true, data: { ...settings, launch: null } });
});
it.each([true, false])("continues only the original owner-scoped launch with automatic=%s", async automatic => {
  const response = await POST(req({ action: "continue_launch", requestId, automatic }), params);
  expect(response.status).toBe(202); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mockContinueLaunch).toHaveBeenCalledWith("owner", agentId, requestId, automatic);
  expect(mockStart).not.toHaveBeenCalled(); expect(mockResume).not.toHaveBeenCalled();
  expect(await response.json()).toEqual({ success: true, data: { requestId, operationId, status: "pending" } });
});
it.each([["waiting", 202], ["applied", 200]])("keeps launch %s distinct from confirmation", async (status, http) => {
  mockContinueLaunch.mockResolvedValue({ requestId, operationId, status });
  expect((await POST(req({ action: "continue_launch", requestId, automatic: false }), params)).status).toBe(http);
});
it("cancels only saved model intent, not the computer or a delivered model", async () => {
  const response = await POST(req({ action: "cancel_launch", requestId }), params);
  expect(response.status).toBe(200); expect(mockCancelLaunch).toHaveBeenCalledWith("owner", agentId, requestId);
  expect(mockContinueLaunch).not.toHaveBeenCalled(); expect(mockStart).not.toHaveBeenCalled();
  expect(await response.json()).toEqual({ success: true, data: { requestId, status: "cancelled" } });
});
it("does not let an ordinary model change overtake a pending launch", async () => {
  mockNoLaunch.mockRejectedValue(new ModelKeyError("pending_change"));
  const response = await POST(req({ action: "apply", operationId, llm: byok }), params);
  expect(response.status).toBe(409); expect(mockStart).not.toHaveBeenCalled();
});
it.each([
  { action: "continue_launch", requestId }, { action: "continue_launch", requestId, automatic: "true" },
  { action: "continue_launch", requestId, automatic: false, llm: byok },
  { action: "continue_launch", requestId: "bad", automatic: true },
  { action: "cancel_launch", requestId, operationId }, { action: "cancel_launch", requestId, userId: "foreign" },
])("rejects ambiguous or authority-bearing launch controls: %j", async body => {
  expect((await POST(req(body), params)).status).toBe(400);
  expect(mockLaunchCreate).not.toHaveBeenCalled(); expect(mockCreate).not.toHaveBeenCalled();
});
it.each(["continue_launch", "cancel_launch"])("does not hide a launch ownership conflict on %s", async action => {
  mockContinueLaunch.mockRejectedValue(new ModelKeyError("operation_conflict"));
  mockCancelLaunch.mockRejectedValue(new ModelKeyError("operation_conflict"));
  const response = await POST(req({ action, requestId, ...(action === "continue_launch" ? { automatic: false } : {}) }), params);
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ success: false, code: "operation_conflict" });
});
it.each([
  ["invalid_request", 400], ["not_found", 404], ["computer_not_ready", 409], ["pending_change", 409],
  ["operation_conflict", 409], ["guest_upgrade_required", 409], ["unsupported_runtime", 409],
  ["guest_unavailable", 503], ["save_unconfirmed", 503], ["stored_setting_unavailable", 503],
  ["configuration_unavailable", 503],
] as const)("returns the truthful %s result instead of success", async (code: ModelKeyProblem, status) => {
  mockStart.mockRejectedValue(new ModelKeyError(code));
  const response = await POST(req({ action: "apply", operationId, llm: byok }), params);
  expect(response.status).toBe(status); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ success: false, code });
});
it.each([new ModelKeyStoreError(), new Error("PRIVATE synthetic-fixture-secret")])("does not leak storage or unexpected exception details", async cause => {
  mockStart.mockRejectedValue(cause);
  const response = await POST(req({ action: "apply", operationId, llm: byok }), params);
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toMatch(/PRIVATE|synthetic-fixture-secret|boxPayload/);
});
