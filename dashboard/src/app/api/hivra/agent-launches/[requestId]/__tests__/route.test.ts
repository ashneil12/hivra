import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { GET } from "../route";

const mockAuth = jest.fn(), mockAllowed = jest.fn();
const mockGenericOriginal = jest.fn(), mockCreateGeneric = jest.fn();
const mockLegacyOriginal = jest.fn(), mockCreateLegacy = jest.fn();
const mockFindGvisorReceipt = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => mockAllowed() }));
jest.mock("@/lib/hivra/launch-operation-store", () => ({ createHivraLaunchOperationService: () => {
  mockCreateGeneric(); return { original: mockGenericOriginal };
} }));
jest.mock("@/lib/hivra/launch-model-admission", () => ({ createLaunchModelAdmissionService: () => {
  mockCreateLegacy(); return { original: mockLegacyOriginal };
} }));
jest.mock("@/lib/hivra/gvisor-computer-service", () => ({
  findGvisorComputerByLaunchRequest: (...args: unknown[]) => mockFindGvisorReceipt(...args),
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
const requestId = randomUUID(), agentId = randomUUID();
const req = new NextRequest(`https://canary.hivra.test/api/hivra/agent-launches/${requestId}`);
const params = { params: Promise.resolve({ requestId }) };
beforeEach(() => {
  jest.resetAllMocks(); mockAllowed.mockReturnValue(true); mockAuth.mockResolvedValue({ userId: "owner" });
  mockGenericOriginal.mockResolvedValue(null);
  mockFindGvisorReceipt.mockResolvedValue(null);
  mockLegacyOriginal.mockResolvedValue({ requestId, phase: "waiting", agent: { id: agentId, type: "codex", user_id: "owner",
    name: "Original", status: "provisioning", llm_api_key_encrypted: "private-fixture", infrastructure_binding_token_hash: "private-binding" } });
});
it("requires authentication before reading private request state", async () => {
  mockAuth.mockResolvedValue({ userId: null });
  const response = await GET(req, params);
  expect(response.status).toBe(401); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mockCreateGeneric).not.toHaveBeenCalled(); expect(mockCreateLegacy).not.toHaveBeenCalled();
});
it("preserves the host feature gate", async () => {
  mockAllowed.mockReturnValue(false);
  expect((await GET(req, params)).status).toBe(404); expect(mockAuth).not.toHaveBeenCalled();
});
it("rejects invalid IDs before constructing private storage", async () => {
  expect((await GET(req, { params: Promise.resolve({ requestId: "invalid" }) })).status).toBe(400);
  expect(mockCreateGeneric).not.toHaveBeenCalled(); expect(mockCreateLegacy).not.toHaveBeenCalled();
});
it("reads the generic receipt first and sanitizes an accepted agent", async () => {
  mockGenericOriginal.mockResolvedValue({ state: "accepted", requestId, phase: "accepted", responseStatus: 201,
    failureStatus: null, failureCode: null, agent: { id: agentId, type: "codex", user_id: "owner", name: "Original",
      status: "provisioning", llm_api_key_encrypted: "private-generic", infrastructure_binding_token_hash: "private-binding" } });
  const response = await GET(req, params), result = await response.json();
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mockGenericOriginal).toHaveBeenCalledWith("owner", requestId);
  expect(mockCreateLegacy).not.toHaveBeenCalled(); expect(mockLegacyOriginal).not.toHaveBeenCalled();
  expect(result).toMatchObject({ success: true, data: { launchRequestId: requestId, phase: "accepted",
    agent: { id: agentId, name: "Original" } } });
  expect(JSON.stringify(result)).not.toMatch(/private-generic|private-binding|encrypted|binding_token/);
});
it.each(["waiting", "promoted", "cancelled", "deleted"])("falls back to the original owner-bound legacy %s request", async phase => {
  const saved = await mockLegacyOriginal(); mockLegacyOriginal.mockClear(); mockLegacyOriginal.mockResolvedValue({ ...saved, phase });
  const response = await GET(req, params), result = await response.json();
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mockGenericOriginal).toHaveBeenCalledWith("owner", requestId);
  expect(mockLegacyOriginal).toHaveBeenCalledTimes(1); expect(mockLegacyOriginal).toHaveBeenCalledWith("owner", requestId);
  expect(mockGenericOriginal.mock.invocationCallOrder[0]).toBeLessThan(mockLegacyOriginal.mock.invocationCallOrder[0]);
  expect(result).toMatchObject({ success: true, data: { launchRequestId: requestId, phase, agent: { id: agentId, name: "Original" } } });
  expect(JSON.stringify(result)).not.toMatch(/private-fixture|private-binding|encrypted|binding_token/);
});
it("returns a generic reconciling receipt as pending without consulting legacy state", async () => {
  mockGenericOriginal.mockResolvedValue({ state: "reconciling", requestId, phase: "reconciling",
    responseStatus: null, agent: null });
  const response = await GET(req, params), result = await response.json();
  expect(response.status).toBe(202); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(result).toEqual({ success: true, data: { launchRequestId: requestId, phase: "reconciling",
    launch: { state: "reconciling", phase: "reconciling" } } });
  expect(mockCreateLegacy).not.toHaveBeenCalled();
});
it("returns a sanitized terminal generic failure without consulting legacy state", async () => {
  mockGenericOriginal.mockResolvedValue({ state: "failed", requestId, phase: "failed", responseStatus: null,
    failureStatus: 409, failureCode: "agent_insert_conflict", agent: null, privateDetail: "PRIVATE provider" });
  const response = await GET(req, params), result = await response.json();
  expect(response.status).toBe(409); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(result).toMatchObject({ success: false, code: "agent_insert_conflict", launchRequestId: requestId,
    launch: { state: "failed", phase: "failed" } });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|provider|privateDetail/);
  expect(mockCreateLegacy).not.toHaveBeenCalled();
});
it("does not distinguish an unknown request from another owner's request", async () => {
  mockGenericOriginal.mockResolvedValue(null); mockLegacyOriginal.mockResolvedValue(null);
  const response = await GET(req, params);
  expect(response.status).toBe(404); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mockGenericOriginal).toHaveBeenCalledWith("owner", requestId);
  expect(mockLegacyOriginal).toHaveBeenCalledWith("owner", requestId);
  expect(mockFindGvisorReceipt).toHaveBeenCalledWith("owner", requestId);
});
it("accepts an owner-bound gVisor launch receipt when the original response was lost", async () => {
  mockLegacyOriginal.mockResolvedValue(null);
  mockFindGvisorReceipt.mockResolvedValue({ id: agentId, type: "linux-terminal", computer_profile: "linux-terminal",
    computer_substrate: "gvisor", user_id: "owner", name: "Sandbox", status: "running",
    infrastructure_binding_token_hash: "private-binding" });

  const response = await GET(req, params), result = await response.json();

  expect(response.status).toBe(200);
  expect(mockFindGvisorReceipt).toHaveBeenCalledWith("owner", requestId);
  expect(result).toMatchObject({ success: true, data: { launchRequestId: requestId, phase: "accepted",
    agent: { id: agentId, name: "Sandbox", status: "running" } } });
  expect(JSON.stringify(result)).not.toContain("private-binding");
});
it("reports unreadable state as uncertainty, not absence, and never reflects raw details", async () => {
  mockGenericOriginal.mockRejectedValue(new Error("PRIVATE model-key"));
  const response = await GET(req, params);
  expect(response.status).toBe(503); expect(await response.text()).not.toMatch(/PRIVATE|model-key/);
  expect(mockCreateLegacy).not.toHaveBeenCalled();
});
