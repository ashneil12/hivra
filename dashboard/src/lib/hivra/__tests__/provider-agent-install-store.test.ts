/** @jest-environment node */
jest.mock("server-only", () => ({}));
const mockRead = jest.fn(), mockRpc = jest.fn();
const mockQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), maybeSingle: (...args: unknown[]) => mockRead(...args) };
const mockFrom = jest.fn((table: unknown) => { void table; return mockQuery; });
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (table: unknown) => mockFrom(table), rpc: (...args: unknown[]) => mockRpc(...args) } }));

import { beginProviderAgentInstall, loadProviderAgentInstallOperation, recordProviderAgentInstallStopped, expireUnstartedProviderAgent } from "../provider-agent-install-store";
import { PORTABLE_HIVRA_PROVISIONER_VERSION } from "@/lib/infrastructure/portable-provisioner-contract";
import { FIRST_BOOT_LEGACY_RECIPE_VERSION, FIRST_BOOT_RECIPE_VERSION } from "@/lib/infrastructure/first-boot-enrollment";
import type { ProviderGuestWorkerIdentity } from "@/lib/infrastructure/provider-guest-worker";

const input = { userId: "owner", agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const identity: ProviderGuestWorkerIdentity = { version: 1 as const, agentId: input.agentId, operationId: input.operationId,
  bundle: { version: 1 as const, state: "bundle_installed" as const, provisionerVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
    bundleSha256: "a".repeat(64), scopeSha256: "b".repeat(64) } };
const receipt = { version: 1 as const, identity, state: "cancelled" as const, stopped: true };
function row() { return { id: input.agentId, user_id: input.userId, operation_id: input.operationId, allocation_operation_id: input.operationId,
  operation_kind: "provision", status: "provisioning", desired_state: "running", computer_substrate: "provider-vm", deployment_mode: "self-managed",
  vmid: null, type: "codex", infrastructure_connection_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", infrastructure_connection_revision: 7,
  deployment_target_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", provider_capacity_order_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  provider_enrollment_attempt_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", provider_server_id: "42",
  cf_tunnel_id: null, cf_hostname: null, chat_url: "https://203-0-113-10.sslip.io", ip: "203.0.113.10",
  provider_install_identity: null, provider_install_not_after: "2026-08-28T00:00:45Z", provider_install_stopped_at: null, provider_install_outcome: null }; }

describe("provider agent install operation store", () => {
  beforeEach(() => { jest.clearAllMocks(); mockRead.mockReset(); mockRpc.mockReset(); });
  it.each([true, false])("preserves the SQL-fenced unstarted expiration decision %s", async data => {
    mockRpc.mockResolvedValue({ data, error: null });
    expect(await expireUnstartedProviderAgent(input)).toBe(data);
    expect(mockRpc).toHaveBeenCalledWith("expire_unstarted_provider_agent", {
      p_user_id: input.userId, p_agent_id: input.agentId, p_operation_id: input.operationId,
    });
  });
  it("loads only the exact reserved operation and original owner/order binding, with no credentials", async () => {
    const r = row();
    mockRead.mockResolvedValueOnce({ data: r, error: null }).mockResolvedValueOnce({ data: { quote_fingerprint_sha256: "c".repeat(64) }, error: null })
      .mockResolvedValueOnce({ data: { recipe_version: FIRST_BOOT_LEGACY_RECIPE_VERSION }, error: null });
    await expect(loadProviderAgentInstallOperation(input)).resolves.toMatchObject({ operation: input,
      accessMode: "direct-https", hostname: "203-0-113-10.sslip.io", tunnelId: null,
      scope: { binding: { userId: input.userId, connectionId: r.infrastructure_connection_id, connectionRevision: 7,
        orderId: r.provider_capacity_order_id, attemptId: r.provider_enrollment_attempt_id, quoteFingerprint: "c".repeat(64) }, providerServerId: "42" } });
    for (const pair of [["user_id", input.userId], ["id", input.agentId], ["operation_id", input.operationId],
      ["computer_substrate", "provider-vm"], ["connection_id", r.infrastructure_connection_id],
      ["active_connection_id", r.infrastructure_connection_id], ["connection_revision", 7], ["provider_resource_id", "42"]]) {
      expect(mockQuery.eq).toHaveBeenCalledWith(...pair);
    }
    expect(mockFrom.mock.calls.map(call => call[0])).toEqual(["hivra_agents", "infrastructure_capacity_orders", "infrastructure_first_boot_enrollments"]);
    expect(mockQuery.select.mock.calls.map(call => call[0]).join(",")).not.toMatch(/private_key|encrypted|api_token|llm_config/);
  });
  it.each([FIRST_BOOT_LEGACY_RECIPE_VERSION, FIRST_BOOT_RECIPE_VERSION])("binds the attempt's own recipe %s, read inside its full binding", async version => {
    const r = row();
    mockRead.mockResolvedValueOnce({ data: r, error: null }).mockResolvedValueOnce({ data: { quote_fingerprint_sha256: "c".repeat(64) }, error: null })
      .mockResolvedValueOnce({ data: { recipe_version: version }, error: null });
    const result = await loadProviderAgentInstallOperation(input);
    expect(result.scope.binding.recipeVersion).toBe(version);
    for (const pair of [["order_id", r.provider_capacity_order_id], ["attempt_id", r.provider_enrollment_attempt_id],
      ["quote_fingerprint_sha256", "c".repeat(64)]]) expect(mockQuery.eq).toHaveBeenCalledWith(...pair);
  });
  it("fails closed when the attempt's recipe is missing or unknown", async () => {
    for (const recipe of [null, { recipe_version: "2026.09.99.1" }]) {
      mockRead.mockReset();
      mockRead.mockResolvedValueOnce({ data: row(), error: null }).mockResolvedValueOnce({ data: { quote_fingerprint_sha256: "c".repeat(64) }, error: null })
        .mockResolvedValueOnce({ data: recipe, error: null });
      await expect(loadProviderAgentInstallOperation(input)).rejects.toThrow("could not be verified");
    }
  });
  it.each(["user_id", "id", "operation_id", "allocation_operation_id", "computer_substrate", "vmid", "type"])("rejects changed %s before loading an order", async field => {
    mockRead.mockResolvedValue({ data: { ...row(), [field]: field === "vmid" ? 42 : "other" }, error: null });
    await expect(loadProviderAgentInstallOperation(input)).rejects.toThrow("could not be verified");
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
  it.each([null, "reserved.hivra.test"])("keeps a pre-access reservation inspectable for recovery: %s", async hostname => {
    mockRead.mockResolvedValueOnce({ data: { ...row(), cf_hostname: hostname, chat_url: null, ip: null }, error: null })
      .mockResolvedValueOnce({ data: { quote_fingerprint_sha256: "c".repeat(64) }, error: null })
      .mockResolvedValueOnce({ data: { recipe_version: FIRST_BOOT_LEGACY_RECIPE_VERSION }, error: null });
    await expect(loadProviderAgentInstallOperation(input)).resolves.toMatchObject({ operation: input,
      accessMode: null, hostname, tunnelId: null, identity: null });
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it.each([["claude-code", "claude"], ["codex", "codex"], ["aeon", "aeon"], ["openclaw", "openclaw"], ["agent-zero", "agent-zero"]])("maps the existing %s catalog record to its %s installer kind", async (catalog, runtime) => {
    mockRead.mockResolvedValueOnce({ data: { ...row(), type: catalog }, error: null })
      .mockResolvedValueOnce({ data: { quote_fingerprint_sha256: "c".repeat(64) }, error: null })
      .mockResolvedValueOnce({ data: { recipe_version: FIRST_BOOT_LEGACY_RECIPE_VERSION }, error: null });
    await expect(loadProviderAgentInstallOperation(input)).resolves.toMatchObject({ runtime });
  });
  it.each([null, { quote_fingerprint_sha256: "invalid" }])("rejects missing or malformed original order", async order => {
    mockRead.mockResolvedValueOnce({ data: row(), error: null }).mockResolvedValueOnce({ data: order, error: null });
    await expect(loadProviderAgentInstallOperation(input)).rejects.toThrow("could not be verified");
  });
  it("snapshots the caller scope before a delayed database response", async () => {
    const mutable = { ...input };
    mockRead.mockImplementationOnce(async () => { mutable.userId = "foreign"; mutable.operationId = "changed"; return { data: row(), error: null }; })
      .mockResolvedValueOnce({ data: { quote_fingerprint_sha256: "c".repeat(64) }, error: null })
      .mockResolvedValueOnce({ data: { recipe_version: FIRST_BOOT_LEGACY_RECIPE_VERSION }, error: null });
    const result = await loadProviderAgentInstallOperation(mutable);
    expect(result.operation).toEqual(input);
    expect(result.scope.binding.userId).toBe(input.userId);
  });
  it.each([{ outcome: "dispatch", dispatchBudgetMs: 30000 }, { outcome: "observe" }, { outcome: "rejected" }])("preserves the precise DB grant %j", async grant => {
    mockRpc.mockResolvedValue({ data: grant, error: null });
    await expect(beginProviderAgentInstall(input, identity)).resolves.toEqual(grant);
    expect(mockRpc).toHaveBeenCalledWith("begin_hivra_provider_install", { p_user_id: input.userId,
      p_agent_id: input.agentId, p_operation_id: input.operationId, p_identity: identity });
  });
  it.each([null, true, { outcome: "dispatch" }, { outcome: "dispatch", dispatchBudgetMs: 60000 }, { outcome: "observe", dispatchBudgetMs: 30000 }])("does not invent authority from malformed grant %j", async grant => {
    mockRpc.mockResolvedValue({ data: grant, error: null });
    await expect(beginProviderAgentInstall(input, identity)).rejects.toThrow("could not be verified");
  });
  it.each([true, false])("returns the exact stop-checkpoint CAS %s", async result => {
    mockRpc.mockResolvedValue({ data: result, error: null });
    await expect(recordProviderAgentInstallStopped(input, receipt)).resolves.toBe(result);
    expect(mockRpc).toHaveBeenCalledWith("record_hivra_provider_install_stopped", { p_user_id: input.userId,
      p_agent_id: input.agentId, p_operation_id: input.operationId, p_receipt: receipt });
  });
  it.each([{ ...receipt, stopped: false }, { ...receipt, state: "running" },
    { ...receipt, identity: { ...identity, operationId: input.agentId } }])("rejects nonterminal or foreign receipt before DB", async value => {
    await expect(recordProviderAgentInstallStopped(input, value as never)).rejects.toThrow("could not be verified");
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it("redacts raw database errors", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "sensitive-database-details" } });
    await expect(beginProviderAgentInstall(input, identity)).rejects.toThrow("Provider agent install operation could not be verified");
  });
});
