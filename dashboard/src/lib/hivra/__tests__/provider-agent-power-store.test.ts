/** @jest-environment node */
jest.mock("server-only", () => ({}));
const mockRead = jest.fn(), mockRpc = jest.fn();
const mockQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), maybeSingle: (...args: unknown[]) => mockRead(...args) };
const mockFrom = jest.fn((table: unknown) => { void table; return mockQuery; });
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (table: unknown) => mockFrom(table), rpc: (...args: unknown[]) => mockRpc(...args) } }));

import { beginProviderAgentPowerDispatch, cancelProviderAgentPowerBeforeDispatch, claimProviderAgentPowerOperation,
  loadProviderAgentPowerOperation, recordProviderAgentPowerAction, verifyProviderAgentPowerResult } from "../provider-agent-power-store";
import { providerGuestBundleScopeSha256 } from "@/lib/infrastructure/provider-guest-bundle";
import { FIRST_BOOT_RECIPE_VERSION } from "@/lib/infrastructure/first-boot-enrollment";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "../agent-authority";
import { desktopInstallFixture } from "./provider-desktop-install.fixtures";

const input = { userId: "owner", agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const allocation = "11111111-1111-4111-8111-111111111111", boot = "22222222-2222-4222-8222-222222222222";
const created = "2026-08-28T01:00:00.000Z";
function fixture() {
  const row = { id: input.agentId, user_id: input.userId, operation_id: input.operationId, operation_kind: "restart",
    operation_started_at: created, allocation_operation_id: allocation, status: "provisioning", desired_state: "running",
    computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null, proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL,
    type: "codex", infrastructure_connection_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", infrastructure_connection_revision: 7,
    deployment_target_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", provider_capacity_order_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    provider_enrollment_attempt_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", provider_server_id: "42", cf_tunnel_id: allocation,
    cf_hostname: "owned.example.com", chat_url: null, ip: null, provider_install_identity: {} as unknown,
    provider_install_stopped_at: created, provider_install_outcome: "succeeded" };
  const scope = { binding: { userId: input.userId, connectionId: row.infrastructure_connection_id, connectionRevision: 7,
    orderId: row.provider_capacity_order_id, attemptId: row.provider_enrollment_attempt_id,
    quoteFingerprint: "c".repeat(64), recipeVersion: FIRST_BOOT_RECIPE_VERSION }, providerServerId: "42" };
  row.provider_install_identity = { version: 1, agentId: input.agentId, operationId: allocation,
    bundle: { version: 1, state: "bundle_installed", provisionerVersion: "2026.08.28.1", bundleSha256: "a".repeat(64), scopeSha256: providerGuestBundleScopeSha256(scope) } };
  const journal = { agent_id: input.agentId, user_id: input.userId, operation_id: input.operationId, operation_kind: "restart",
    connection_id: row.infrastructure_connection_id, connection_revision: 7, capacity_order_id: row.provider_capacity_order_id,
    provider_server_id: "42", allocation_operation_id: allocation, original_status: "running", created_at: created,
    dispatch_not_after: "2026-08-28T01:00:45.000Z", dispatch_intent_at: null, before_boot_id: null, action_receipt: null,
    verified_at: null, verified_status: null, verified_boot_id: null, cancelled_at: null };
  return { row, scope, journal, order: { quote_fingerprint_sha256: scope.binding.quoteFingerprint },
    recipe: { recipe_version: scope.binding.recipeVersion } };
}
function reads(f = fixture()) {
  for (const data of [f.row, f.journal, f.order, f.recipe]) mockRead.mockResolvedValueOnce({ data, error: null });
  return f;
}
const action = { id: 81, command: "reboot_server" as const, status: "success" as const, resources: [{ id: 42, type: "server" as const }] };
const expected = { serverId: 42, kind: "restart" as const, actionId: 81 };
const observation = { observedAt: created, status: "running" as const, bootId: boot, runtimeReady: true, publicReady: true };
beforeEach(() => { jest.clearAllMocks(); mockRead.mockReset(); mockRpc.mockReset(); });

it.each(["clean", "profile", "allocation", "scope", "access", "chat"])("loads only original desktop power binding: %s", async fault => {
  const f=fixture(), desktop=desktopInstallFixture();
  const access={mode:"cloudflare-named",hostname:f.row.cf_hostname,tunnelId:f.row.cf_tunnel_id};
  Object.assign(f.row,{type:"linux-desktop",computer_profile:fault==="profile"?"omarchy":"ubuntu-desktop",
    chat_url:`https://${fault==="chat"?"other.example.test":f.row.cf_hostname}`,
    provider_install_desktop_access:{...access,...(fault==="access"?{hostname:"other.example.test"}:{})},
    provider_install_identity:{...desktop.identity,agentId:input.agentId,operationId:fault==="allocation"?input.operationId:allocation,
      bundle:{...desktop.identity.bundle,scopeSha256:fault==="scope"?"a".repeat(64):providerGuestBundleScopeSha256(f.scope)}}});
  reads(f);
  if(fault==="clean") await expect(loadProviderAgentPowerOperation(input)).resolves.toMatchObject({runtime:"linux-desktop",desktopAccess:access,
    identity:{version:3,agentId:input.agentId,operationId:allocation}});
  else await expect(loadProviderAgentPowerOperation(input)).rejects.toThrow("Provider power operation could not be verified");
});

it("loads only the exact power operation, original installer and owner-computer binding without secrets", async () => {
  const f = reads();
  expect(await loadProviderAgentPowerOperation(input)).toMatchObject({ operation: input, kind: "restart", scope: f.scope,
    identity: { agentId: input.agentId, operationId: allocation }, action: null, dispatchIntentAt: null });
  expect(mockFrom.mock.calls.map(call => call[0])).toEqual(["hivra_agents", "hivra_provider_power_operations", "infrastructure_capacity_orders", "infrastructure_first_boot_enrollments"]);
  for (const pair of [["user_id", input.userId], ["agent_id", input.agentId], ["operation_id", input.operationId],
    ["connection_revision", 7], ["provider_resource_id", "42"], ["active_connection_id", f.row.infrastructure_connection_id]]) expect(mockQuery.eq).toHaveBeenCalledWith(...pair);
  expect(mockQuery.select.mock.calls.flat().join(",")).not.toMatch(/private_key|encrypted|api_token|llm_config/);
});
it.each(["id", "user_id", "operation_id", "operation_kind", "allocation_operation_id", "computer_substrate", "proxmox_host", "vmid", "status", "desired_state", "provider_install_outcome", "provider_install_stopped_at"])("rejects changed agent %s", field => {
  const f = fixture(); Object.assign(f.row, { [field]: field === "allocation_operation_id" ? input.operationId : field === "vmid" ? 42 : null }); reads(f);
  return expect(loadProviderAgentPowerOperation(input)).rejects.toThrow("Provider power operation could not be verified");
});
it.each(["agent_id", "user_id", "operation_id", "operation_kind", "connection_id", "connection_revision", "capacity_order_id", "provider_server_id", "allocation_operation_id", "original_status", "created_at", "dispatch_not_after", "before_boot_id", "action_receipt"])("rejects changed journal %s before using the computer", field => {
  const f = fixture();
  Object.assign(f.journal, { [field]: field === "connection_revision" ? 8 : field === "provider_server_id" ? "43"
    : field === "created_at" || field === "dispatch_not_after" ? "2026-08-28T02:00:00Z"
    : field === "before_boot_id" ? boot : field === "action_receipt" ? action : field === "operation_kind" ? "stop"
    : field === "original_status" ? "stopped" : field === "user_id" ? "foreign" : field === "allocation_operation_id" ? input.operationId : allocation });
  reads(f);
  return expect(loadProviderAgentPowerOperation(input)).rejects.toThrow("could not be verified");
});
it("keeps a power request distinct from its successful original installer", async () => {
  const f = fixture();
  Object.assign(f.row.provider_install_identity as object, { operationId: input.operationId }); reads(f);
  await expect(loadProviderAgentPowerOperation(input)).rejects.toThrow("could not be verified");
});
it("accepts deletion intent without inventing a new dispatch", async () => {
  const f = fixture(); f.row.desired_state = "deleted"; reads(f);
  expect(await loadProviderAgentPowerOperation(input)).toMatchObject({ desiredState: "deleted", dispatchIntentAt: null });
  expect(mockRpc).not.toHaveBeenCalled();
});
it("snapshots caller identity across delayed reads", async () => {
  const f = fixture(), mutable = { ...input };
  mockRead.mockImplementationOnce(async () => { mutable.operationId = allocation; mutable.userId = "foreign"; return { data: f.row, error: null }; });
  for (const data of [f.journal,f.order,f.recipe]) mockRead.mockResolvedValueOnce({ data, error: null });
  expect((await loadProviderAgentPowerOperation(mutable)).operation).toEqual(input);
});
it.each(["dispatch", "observe", "rejected"])("preserves the exact one-use dispatch result %s", async result => {
  mockRpc.mockResolvedValue({ data: result, error: null });
  expect(await beginProviderAgentPowerDispatch(input, boot)).toBe(result);
  expect(mockRpc).toHaveBeenCalledWith("begin_hivra_provider_power_dispatch", {
    p_user_id: input.userId, p_agent_id: input.agentId, p_operation_id: input.operationId, p_before_boot_id: boot });
});
it.each([true,false])("returns exact boolean CAS %s, not a truthy fallback", async result => {
  mockRpc.mockResolvedValue({ data: result, error: null });
  expect(await claimProviderAgentPowerOperation(input, "restart")).toBe(result);
  expect(await recordProviderAgentPowerAction(input, expected, action)).toBe(result);
  expect(await verifyProviderAgentPowerResult(input, observation)).toBe(result);
  expect(await cancelProviderAgentPowerBeforeDispatch(input)).toBe(result);
});
it.each([null,{},"true",1])("rejects malformed RPC authority %j", async data => {
  mockRpc.mockResolvedValue({ data, error: null });
  for (const call of [() => claimProviderAgentPowerOperation(input, "start"), () => beginProviderAgentPowerDispatch(input, null),
    () => recordProviderAgentPowerAction(input, expected, action), () => verifyProviderAgentPowerResult(input, observation),
    () => cancelProviderAgentPowerBeforeDispatch(input)]) await expect(call()).rejects.toThrow("could not be verified");
});
it("rejects foreign or malformed arguments before any RPC", async () => {
  await expect(claimProviderAgentPowerOperation(input, "poweroff" as never)).rejects.toThrow();
  await expect(beginProviderAgentPowerDispatch(input, "not-a-boot-id")).rejects.toThrow();
  await expect(recordProviderAgentPowerAction(input, { ...expected, serverId: 43 }, action)).rejects.toThrow();
  await expect(recordProviderAgentPowerAction(input, expected, { ...action, id: 82 })).rejects.toThrow();
  await expect(verifyProviderAgentPowerResult(input, { ...observation, runtimeReady: "true" as never })).rejects.toThrow();
  await expect(cancelProviderAgentPowerBeforeDispatch({ ...input, userId: "" })).rejects.toThrow();
  expect(mockRpc).not.toHaveBeenCalled();
});
it("redacts database failure details", async () => {
  mockRead.mockRejectedValue(new Error("private-db-detail")); mockRpc.mockResolvedValue({ data: true, error: { message: "private-db-detail" } });
  await expect(loadProviderAgentPowerOperation(input)).rejects.toThrow("Provider power operation could not be verified");
  await expect(claimProviderAgentPowerOperation(input, "restart")).rejects.toThrow("Provider power operation could not be verified");
});
