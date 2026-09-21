/** @jest-environment node */
jest.mock("server-only", () => ({}));
const mockTunnel = jest.fn();
const mockRevoke = jest.fn();
const mockDesktopRevoke = jest.fn();
const mockPrivateAccessClear = jest.fn();
jest.mock("@/lib/services/cloudflare-tunnel-cleanup", () => ({
  deleteBoxTunnelVerified: (...args: unknown[]) => mockTunnel(...args),
}));
jest.mock("@/lib/venice/proxy-keys", () => ({
  revokeManagedVeniceProxyKey: (...args: unknown[]) => mockRevoke(...args),
}));
jest.mock("@/lib/remote-computers/session-broker", () => ({
  revokeRemoteDesktopCapability: (...args: unknown[]) => mockDesktopRevoke(...args),
}));
jest.mock("@/lib/hivra/private-access-store", () => ({
  clearHivraPrivateAccessAfterDelete: (...args: unknown[]) => mockPrivateAccessClear(...args),
}));
import { cleanupHivraAgentAccess } from "../agent-delete-cleanup";

const input = { userId: "owner", agentId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222", tunnelId: "tunnel", hostname: "box.example.test", llmConfig: null as unknown };
const managed = { provider: "venice", mode: "managed", proxyKeyId: "key-id" };
beforeEach(() => {
  mockTunnel.mockReset().mockResolvedValue(undefined);
  mockRevoke.mockReset().mockResolvedValue({ revoked: true });
  mockDesktopRevoke.mockReset().mockResolvedValue({ ok: true, revoked: true });
  mockPrivateAccessClear.mockReset().mockResolvedValue(true);
});

it("clears the exact owner's private-access authority before managed keys and tunnel cleanup", async () => {
  await cleanupHivraAgentAccess({ ...input, llmConfig: managed });
  expect(mockPrivateAccessClear).toHaveBeenCalledWith({ userId: input.userId, agentId: input.agentId, operationId: input.operationId });
  expect(mockPrivateAccessClear.mock.invocationCallOrder[0]).toBeLessThan(mockRevoke.mock.invocationCallOrder[0]);
});

it("retains deletion when private-access cleanup is unverified", async () => {
  mockPrivateAccessClear.mockResolvedValue(false);
  await expect(cleanupHivraAgentAccess(input)).rejects.toMatchObject({ stage: "private_access" });
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockTunnel).not.toHaveBeenCalled();
});

it("revokes desktop capability before every other access identity", async () => {
  await cleanupHivraAgentAccess({ ...input, llmConfig: managed });
  expect(mockDesktopRevoke).toHaveBeenCalledWith({
    userId: input.userId,
    computerKind: "hivra-agent",
    computerId: input.agentId,
  });
  expect(mockDesktopRevoke.mock.invocationCallOrder[0]).toBeLessThan(mockRevoke.mock.invocationCallOrder[0]);
});

it("retains deletion when desktop capability revocation is unverified", async () => {
  mockDesktopRevoke.mockResolvedValue({ ok: false, code: "database_unavailable" });
  await expect(cleanupHivraAgentAccess(input)).rejects.toMatchObject({ stage: "remote_desktop" });
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockTunnel).not.toHaveBeenCalled();
});

it("revokes the exact owner's managed key before tunnel cleanup", async () => {
  await cleanupHivraAgentAccess({ ...input, llmConfig: managed });
  expect(mockRevoke).toHaveBeenCalledWith({ userId: input.userId, keyId: managed.proxyKeyId });
  expect(mockRevoke.mock.invocationCallOrder[0]).toBeLessThan(mockTunnel.mock.invocationCallOrder[0]);
  expect(mockTunnel).toHaveBeenCalledWith({ tunnelId: input.tunnelId, hostname: input.hostname });
});

it.each([null, { provider: "venice", mode: "byok" }])("does not revoke user-owned/native provider keys %j", async (llmConfig) => {
  await cleanupHivraAgentAccess({ ...input, llmConfig });
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockTunnel).toHaveBeenCalledTimes(1);
});

it.each([{}, { provider: "unknown", mode: "managed" }, { provider: "venice", mode: "managed" }])(
  "does not erase incomplete managed-key evidence %j", async (llmConfig) => {
    await expect(cleanupHivraAgentAccess({ ...input, llmConfig })).rejects.toMatchObject({ stage: "managed_key" });
    expect(mockTunnel).not.toHaveBeenCalled();
  },
);

it("propagates managed-key revocation failure without leaking a backend error", async () => {
  mockRevoke.mockRejectedValue(new Error("sensitive provider detail"));
  await expect(cleanupHivraAgentAccess({ ...input, llmConfig: managed })).rejects.toMatchObject({ stage: "managed_key" });
  expect(mockTunnel).not.toHaveBeenCalled();
});

it("does not swallow unverified tunnel cleanup", async () => {
  mockTunnel.mockRejectedValue(new Error("provider failure"));
  await expect(cleanupHivraAgentAccess(input)).rejects.toMatchObject({ stage: "tunnel" });
});
