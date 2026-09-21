/** @jest-environment node */
jest.mock("server-only", () => ({}));
const mockRead = jest.fn();
const mockQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), maybeSingle: () => mockRead() };
const mockFrom = jest.fn((table: unknown) => { void table; return mockQuery; });
const mockRpc = jest.fn();
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (table: unknown) => mockFrom(table), rpc: (...args: unknown[]) => mockRpc(...args) } }));

import { receiverFixture } from "@/lib/infrastructure/__tests__/first-boot-receiver.fixtures";
import { loadProviderAgentInstallOperation, loadProviderNativeInstallBinding, loadProviderDesktopInstallBinding } from "../provider-agent-install-store";

const f = receiverFixture();
const operation = { userId: f.binding.userId, agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
function row() { return { id: operation.agentId, user_id: operation.userId, operation_id: operation.operationId,
  allocation_operation_id: operation.operationId, operation_kind: "provision", status: "provisioning", desired_state: "running",
  computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null, type: "linux-desktop", computer_profile: "ubuntu-desktop",
  infrastructure_connection_id: f.binding.connectionId, infrastructure_connection_revision: f.binding.connectionRevision,
  deployment_target_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", provider_capacity_order_id: f.binding.orderId,
  provider_enrollment_attempt_id: f.binding.attemptId, provider_server_id: "42", cf_tunnel_id: null, cf_hostname: null,
  chat_url: null, ip: null, provider_install_identity: null, provider_install_not_after: null,
  provider_install_stopped_at: null, provider_install_outcome: null }; }
function load(value: unknown) {
  mockRead.mockResolvedValueOnce({ data: value, error: null })
    .mockResolvedValueOnce({ data: { quote_fingerprint_sha256: f.binding.quoteFingerprint }, error: null });
}

describe("original provider desktop installation binding", () => {
  beforeEach(() => { jest.clearAllMocks(); mockRead.mockReset(); });
  it.each(["running", "deleted"])("loads Ubuntu for original-owner recovery before access exists: %s", async desired_state => {
    load({ ...row(), desired_state });
    await expect(loadProviderDesktopInstallBinding(operation)).resolves.toMatchObject({ operation,
      runtime: "linux-desktop", computerProfile: "ubuntu-desktop", desiredState: desired_state,
      accessMode: null, hostname: null, identity: null });
    expect(mockFrom.mock.calls.map(call => call[0])).toEqual(["hivra_agents", "infrastructure_capacity_orders"]);
    for (const pair of [["user_id", operation.userId], ["id", operation.agentId], ["operation_id", operation.operationId],
      ["connection_revision", f.binding.connectionRevision], ["provider_resource_id", "42"], ["status", "created_off"]]) {
      expect(mockQuery.eq).toHaveBeenCalledWith(...pair);
    }
    expect(mockQuery.select.mock.calls.flat().join(",")).not.toMatch(/private_key|encrypted|api_token|llm_config/);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it.each(["omarchy", "windows", null, undefined, "unknown"])("does not reinterpret profile %s as Ubuntu", async computer_profile => {
    load({ ...row(), computer_profile });
    await expect(loadProviderDesktopInstallBinding(operation)).rejects.toThrow("could not be verified");
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
  it.each(["claude-code", "codex", "aeon", "openclaw", "agent-zero", "deepseek-harness"])("rejects agent %s before reading its order", async type => {
    load({ ...row(), type });
    await expect(loadProviderDesktopInstallBinding(operation)).rejects.toThrow("could not be verified");
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
  it.each([loadProviderAgentInstallOperation, loadProviderNativeInstallBinding])("keeps desktops out of older operation loaders", async loader => {
    load(row());
    await expect(loader(operation)).rejects.toThrow("could not be verified");
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
  it.each(["id", "user_id", "operation_id", "allocation_operation_id", "computer_substrate", "deployment_mode", "vmid", "status"])("rejects mismatched %s", async key => {
    load({ ...row(), [key]: key === "vmid" ? 42 : "foreign" });
    await expect(loadProviderDesktopInstallBinding(operation)).rejects.toThrow("could not be verified");
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
  it.each(["claude-code", "codex", "aeon", "openclaw", "agent-zero"])("preserves legacy runtime %s", async type => {
    load({ ...row(), type, computer_profile: null });
    await expect(loadProviderAgentInstallOperation(operation)).resolves.toMatchObject({ runtime: type === "claude-code" ? "claude" : type });
  });
  it("preserves the explicit native runtime binding", async () => {
    load({ ...row(), type: "deepseek-harness", computer_profile: null });
    await expect(loadProviderNativeInstallBinding(operation)).resolves.toMatchObject({ runtime: "deepseek-harness" });
  });
});
