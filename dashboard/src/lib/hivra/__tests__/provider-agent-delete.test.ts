import { advanceProviderAgentDelete, loadProviderAgentDeleteContext } from "../provider-agent-delete";
import { firstBootCleanupFixture, cleanupConnection, cleanupOrder } from "@/lib/infrastructure/__tests__/hetzner-cleanup.fixtures";
import { hetznerCleanupManifest } from "@/lib/infrastructure/hetzner-cleanup-policy";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "../agent-authority";
import type { advanceProviderAgentInstaller } from "../provider-agent-installer";
import type { advanceProviderNativeInstaller } from "../provider-native-installer";
import type { advanceProviderDesktopInstaller } from "../provider-desktop-installer";
import type { requestHivraAgentDelete } from "../agent-operation-store";
import type { advanceHetznerCleanup } from "@/lib/infrastructure/hetzner-cleanup";

const mockQuery = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn() };
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: jest.fn(() => mockQuery) } }));
const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const allocationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
type Active = Exclude<Awaited<ReturnType<typeof loadProviderAgentDeleteContext>>, { status: "deleted" }>;

function setup() {
  const { order, firstBoot } = firstBootCleanupFixture();
  const owner = { userId: "owner", agentId };
  const agent: Active = { id: agentId, user_id: owner.userId, type: "codex", computer_substrate: "provider-vm", deployment_mode: "self-managed",
    proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL, vmid: null, status: "running", desired_state: "running",
    operation_id: null, operation_kind: null, allocation_operation_id: allocationId,
    infrastructure_connection_id: cleanupConnection, infrastructure_connection_revision: 7,
    deployment_target_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", provider_capacity_order_id: cleanupOrder,
    provider_enrollment_attempt_id: firstBoot.binding.attemptId, provider_server_id: "42" };
  const manifest = hetznerCleanupManifest(order, firstBoot);
  const result: Awaited<ReturnType<typeof advanceHetznerCleanup>> = { orderId: cleanupOrder, connectionId: cleanupConnection,
    status: "cleaning", serverName: manifest.serverName, resources: manifest.resources,
    fingerprint: manifest.fingerprint, eligible: true, busy: false,
    cleanup: { idempotencyKey: agentId, fingerprint: manifest.fingerprint,
      absence: { server: true, ipv4: false, ipv6: false, sshKey: false, firewall: false },
      error: null, startedAt: "2026-08-28T00:00:00Z", observedAt: null, finishedAt: null } };
  const deps = {
    load: jest.fn<ReturnType<typeof loadProviderAgentDeleteContext>, [unknown]>(async () => structuredClone(agent)),
    request: jest.fn<ReturnType<typeof requestHivraAgentDelete>, [unknown]>(async () => {
      agent.desired_state = "deleted";
      if (agent.operation_id) return "pending";
      agent.operation_id = operationId; agent.operation_kind = "delete"; return "claimed";
    }),
    installer: jest.fn<ReturnType<typeof advanceProviderAgentInstaller>, [unknown]>(async () => ({ stage: "worker_observed", state: "running", stopped: false })),
    nativeInstaller: jest.fn<ReturnType<typeof advanceProviderNativeInstaller>, [unknown]>(async () => ({ stage: "worker_observed", state: "failed",
      stopped: true, nativeCleanup: "pending", cleanupRecorded: false, cancellationRequested: true })),
    desktopInstaller: jest.fn<ReturnType<typeof advanceProviderDesktopInstaller>, [unknown]>(async () => ({ stage: "worker_observed", state: "failed",
      stopped: true, desktopCleanup: "pending", cleanupRecorded: false, cancellationRequested: true })),
    absentDesktop: jest.fn(async () => false),
    power: jest.fn(async () => "cancellation_pending" as const),
    resize: jest.fn(async () => ({ stage: "request_uncertain" } as never)),
    absentResize: jest.fn(async () => false),
    release: jest.fn(async () => true), order: jest.fn(async () => order), boot: jest.fn(async () => firstBoot),
    retire: jest.fn(async () => true), complete: jest.fn(async () => true), failure: jest.fn(async () => true), newId: () => operationId,
    cleanup: jest.fn<ReturnType<typeof advanceHetznerCleanup>, Parameters<typeof advanceHetznerCleanup>>(async (_user, _connection, _request, overrides) => {
      if (!await overrides!.retireUnused!({ userId: owner.userId, connectionId: cleanupConnection, expectedRevision: 7,
        orderId: cleanupOrder, providerServerId: "42" })) throw Error("retirement refused");
      return structuredClone(result);
    }),
  };
  function completed() {
    result.status = "deleted"; result.cleanup!.finishedAt = "2026-08-28T00:01:00Z";
    result.cleanup!.absence = { server: true, ipv4: true, ipv6: true, sshKey: true, firewall: true };
  }
  return { owner, agent, order, firstBoot, manifest, result, deps, completed };
}

beforeEach(() => {
  mockQuery.select.mockReset().mockReturnValue(mockQuery); mockQuery.eq.mockReset().mockReturnValue(mockQuery);
  mockQuery.maybeSingle.mockReset();
});

it("reads exact provider ownership without secrets or provider I/O", async () => {
  const h = setup(); mockQuery.maybeSingle.mockResolvedValue({ data: h.agent, error: null });
  await expect(loadProviderAgentDeleteContext(h.owner)).resolves.toEqual(h.agent);
  expect(mockQuery.eq.mock.calls).toEqual([["user_id", "owner"], ["id", agentId], ["computer_substrate", "provider-vm"]]);
  expect(mockQuery.select.mock.calls[0][0]).not.toMatch(/api_token|llm_config|encrypted|private/);
});
it.each(["owner", "id", "substrate", "vmid"])("rejects invalid %s identity before deletion", async field => {
  const h = setup();
  if (field === "owner") h.agent.user_id = "different-owner";
  if (field === "id") h.agent.id = allocationId;
  if (field === "substrate") Object.assign(h.agent, { computer_substrate: "proxmox-kvm" });
  if (field === "vmid") Object.assign(h.agent, { vmid: 1104 });
  mockQuery.maybeSingle.mockResolvedValue({ data: h.agent, error: null });
  await expect(loadProviderAgentDeleteContext(h.owner)).rejects.toMatchObject({ code: "authority_changed" });
});
it("retires only the reserved computer under its original delete operation, then advances one bounded cleanup step", async () => {
  const h = setup();
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).resolves.toEqual({ ok: false, pending: true, stage: "provider_cleanup" });
  expect(h.deps.request).toHaveBeenCalledWith({ ...h.owner, operationId });
  expect(h.deps.retire).toHaveBeenCalledWith({ ...h.owner, operationId }, expect.objectContaining({
    provider_server_id: "42", provider_capacity_order_id: cleanupOrder, desired_state: "deleted", operation_kind: "delete",
  }));
  expect(h.deps.cleanup).toHaveBeenCalledWith("owner", cleanupConnection, {
    orderId: cleanupOrder, idempotencyKey: agentId, fingerprint: h.manifest.fingerprint, serverName: h.manifest.serverName,
    confirmation: "Delete this setup computer, its data and all original resources",
  }, expect.objectContaining({ retireUnused: expect.any(Function) }));
  expect(h.deps.complete).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
it("resumes an existing delete operation and cleanup key without renewing the agent lease", async () => {
  const h = setup(); h.agent.operation_id = allocationId; h.agent.operation_kind = "delete"; h.agent.desired_state = "deleted";
  h.order.cleanup = { ...h.result.cleanup!, idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" };
  h.order.cleanupFirewallReceipt = h.firstBoot.firewallReceipt;
  await advanceProviderAgentDelete(h.owner, h.deps);
  expect(h.deps.retire).toHaveBeenCalledWith({ ...h.owner, operationId: allocationId }, expect.any(Object));
  expect(h.deps.cleanup).toHaveBeenCalledWith("owner", cleanupConnection, expect.objectContaining({ idempotencyKey: h.order.cleanup.idempotencyKey }), expect.any(Object));
  expect(h.deps.release).not.toHaveBeenCalled();
});
it.each(["server", "ipv4", "ipv6", "sshKey", "firewall"] as const)("never revokes access or finalizes with missing %s absence", async kind => {
  const h = setup(); h.completed(); h.result.cleanup!.absence[kind] = false;
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toMatchObject({ code: "receipts_unavailable" });
  expect(h.deps.complete).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
it("uses the existing access/finalization proof only after all five original absences", async () => {
  const h = setup(); h.completed();
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).resolves.toEqual({ ok: true });
  expect(h.deps.complete).toHaveBeenCalledWith({ ...h.owner, operationId });
  expect(h.deps.cleanup.mock.invocationCallOrder[0]).toBeLessThan(h.deps.complete.mock.invocationCallOrder[0]);
  expect(h.deps.release).not.toHaveBeenCalled();
});
it("does not declare deletion if the shared terminal proof loses its compare-and-set", async () => {
  const h = setup(); h.completed(); h.deps.complete.mockResolvedValue(false);
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toMatchObject({ code: "authority_changed" });
  expect(h.deps.release).not.toHaveBeenCalled(); expect(h.deps.failure).toHaveBeenCalled();
});
it.each(["order", "connection", "revision", "server", "attempt", "firewall", "abandoned"])("stops before resource cleanup for changed %s evidence", async field => {
  const h = setup();
  if (field === "order") h.order.operation.id = allocationId;
  if (field === "connection") h.order.operation.connectionId = allocationId;
  if (field === "revision") h.order.connectionRevision = 8;
  if (field === "server") h.order.operation.providerServerId = "43";
  if (field === "attempt") h.firstBoot.binding.attemptId = allocationId;
  if (field === "firewall") h.firstBoot.firewallReceipt = null;
  if (field === "abandoned") h.order.cleanup = { ...h.result.cleanup!, abandonedAt: "2026-08-28T00:01:00Z" };
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toThrow();
  expect(h.deps.cleanup).not.toHaveBeenCalled(); expect(h.deps.retire).not.toHaveBeenCalled();
});
it("does not let the cleanup engine retire a different target", async () => {
  const h = setup(); h.deps.cleanup.mockImplementation(async (_user, _connection, _request, overrides) => {
    await overrides!.retireUnused!({ userId: "owner", connectionId: cleanupConnection, expectedRevision: 7, orderId: cleanupOrder, providerServerId: "43" });
    return h.result;
  });
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toMatchObject({ code: "authority_changed" });
  expect(h.deps.retire).not.toHaveBeenCalled();
});
it.each(["resource_changed", "provider_unavailable", "connection_changed"] as const)("leaves %s cleanup visible without automatically releasing its operation", async error => {
  const h = setup(); h.result.cleanup!.error = error;
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toMatchObject({ code: "cleanup_needs_attention" });
  expect(h.deps.complete).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
it("continues observed provider deletion under the same operation and cleanup key", async () => {
  const h = setup(); h.result.cleanup!.error = "resource_busy";
  h.agent.operation_id = allocationId; h.agent.operation_kind = "delete"; h.agent.desired_state = "deleted";
  h.order.cleanup = { ...h.result.cleanup!, idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" };
  h.order.cleanupFirewallReceipt = h.firstBoot.firewallReceipt;
  for (let pass = 0; pass < 2; pass++) {
    await expect(advanceProviderAgentDelete(h.owner, h.deps)).resolves.toEqual({ ok: false, pending: true, stage: "provider_cleanup" });
  }
  expect(h.deps.failure).not.toHaveBeenCalled(); expect(h.deps.complete).not.toHaveBeenCalled();
  h.result.cleanup!.error = null; h.completed();
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).resolves.toEqual({ ok: true });
  for (const call of h.deps.cleanup.mock.calls) expect(call[2].idempotencyKey).toBe(h.order.cleanup.idempotencyKey);
  expect(h.deps.complete).toHaveBeenCalledWith({ ...h.owner, operationId: allocationId });
  expect(h.deps.release).not.toHaveBeenCalled();
});
it("does not accept a contradictory deleted-but-busy result", async () => {
  const h = setup(); h.completed(); h.result.cleanup!.error = "resource_busy";
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toMatchObject({ code: "cleanup_needs_attention" });
  expect(h.deps.complete).not.toHaveBeenCalled();
});
it.each(["orderId", "connectionId", "fingerprint"] as const)("checks changed %s before acknowledging busy cleanup", async field => {
  const h = setup(); h.result.cleanup!.error = "resource_busy"; h.result[field] = "changed";
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toMatchObject({ code: "authority_changed" });
  expect(h.deps.complete).not.toHaveBeenCalled();
});
it.each(["running", "unknown", "failed", "cancelled", "succeeded", "not_dispatched"] as const)("handles installer %s before any retirement or cleanup", async state => {
  const h = setup(); h.agent.status = "provisioning"; h.agent.operation_kind = "provision";
  h.agent.operation_id = allocationId;
  const stopped = !["running", "unknown"].includes(state);
  h.deps.installer.mockResolvedValue(state === "not_dispatched" ? { stage: "not_dispatched" }
    : { stage: "worker_observed", state, stopped });
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).resolves.toEqual({ ok: false, pending: true, stage: "installer_stopping" });
  expect(h.deps.installer).toHaveBeenCalledWith({ ...h.owner, operationId: allocationId, action: "cancel" });
  expect(h.deps.request.mock.invocationCallOrder[0]).toBeLessThan(h.deps.installer.mock.invocationCallOrder[0]);
  expect(h.deps.release).toHaveBeenCalledTimes(stopped ? 1 : 0);
  expect(h.deps.retire).not.toHaveBeenCalled(); expect(h.deps.cleanup).not.toHaveBeenCalled();
});
it("does not adopt authority if the delete claim is not reflected in the current row", async () => {
  const h = setup(); h.deps.request.mockResolvedValue("claimed");
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toMatchObject({ code: "authority_changed" });
  expect(h.deps.cleanup).not.toHaveBeenCalled(); expect(h.deps.installer).not.toHaveBeenCalled();
});
it.each(["pending", "status-only", "cleaned", "not_started", "not_dispatched", "provider_pending", "contradictory"])("native provision deletion requires separate cleanup: %s", async proof => {
  const h = setup(); h.agent.type = "deepseek-harness"; h.agent.status = "provisioning";
  h.agent.operation_kind = "provision"; h.agent.operation_id = allocationId;
  const record = { stage: "worker_observed", state: "succeeded", stopped: true,
    nativeCleanup: proof === "not_started" ? "not_started" : proof === "pending" || proof === "contradictory" ? "pending" : "verified_stopped",
    cleanupRecorded: ["cleaned", "not_started", "contradictory"].includes(proof), cancellationRequested: true } as const;
  h.deps.nativeInstaller.mockResolvedValue(proof === "not_dispatched" ? { stage: "not_dispatched" }
    : proof === "provider_pending" ? { stage: "waiting_for_provider" }
      : { ...record, state: proof === "not_started" ? "cancelled" : "succeeded" });
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).resolves.toEqual({ ok: false, pending: true, stage: "installer_stopping" });
  expect(h.deps.installer).not.toHaveBeenCalled();
  expect(h.deps.nativeInstaller).toHaveBeenCalledWith({ ...h.owner, operationId: allocationId, action: "cancel" });
  expect(h.deps.request.mock.invocationCallOrder[0]).toBeLessThan(h.deps.nativeInstaller.mock.invocationCallOrder[0]);
  expect(h.deps.release).toHaveBeenCalledTimes(["cleaned", "not_started", "not_dispatched"].includes(proof) ? 1 : 0);
  expect(h.deps.retire).not.toHaveBeenCalled(); expect(h.deps.cleanup).not.toHaveBeenCalled(); expect(h.deps.complete).not.toHaveBeenCalled();
});
it.each(["unknown", "expired-proof"])("retains native original provision authority after %s", async failure => {
  const h = setup(); h.agent.type = "deepseek-harness"; h.agent.status = "provisioning";
  h.agent.operation_kind = "provision"; h.agent.operation_id = allocationId;
  if (failure === "unknown") h.deps.nativeInstaller.mockRejectedValue(new Error("private transport details"));
  else {
    h.deps.nativeInstaller.mockResolvedValue({ stage: "worker_observed", state: "failed", stopped: true,
      nativeCleanup: "verified_stopped", cleanupRecorded: true, cancellationRequested: true });
    h.deps.release.mockResolvedValue(false);
  }
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toThrow("Provider computer removal could not continue:");
  expect(h.deps.retire).not.toHaveBeenCalled(); expect(h.deps.cleanup).not.toHaveBeenCalled(); expect(h.deps.complete).not.toHaveBeenCalled();
  expect(h.deps.installer).not.toHaveBeenCalled();
  expect(JSON.stringify(h.deps.failure.mock.calls)).not.toContain("private transport details");
});
it("does not switch runtime adapters after delete intent changes a pre-dispatch row", async () => {
  const h = setup(), request = h.deps.request.getMockImplementation()!;
  h.agent.type = "deepseek-harness"; h.agent.status = "provisioning"; h.agent.operation_kind = "provision"; h.agent.operation_id = allocationId;
  h.deps.request.mockImplementation(async input => { const result = await request(input); h.agent.type = "codex"; return result; });
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toMatchObject({ code: "authority_changed" });
  expect(h.deps.installer).not.toHaveBeenCalled(); expect(h.deps.nativeInstaller).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
it.each([true, false])("later native computer deletion still needs all five original resource absences: %s", async complete => {
  const h = setup(); h.agent.type = "deepseek-harness";
  if (complete) h.completed();
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).resolves.toEqual(complete ? { ok: true } : { ok: false, pending: true, stage: "provider_cleanup" });
  expect(h.deps.complete).toHaveBeenCalledTimes(complete ? 1 : 0);
  expect(h.deps.nativeInstaller).not.toHaveBeenCalled(); expect(h.deps.installer).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
it("continues original cleanup after independently recorded server absence without fabricating guest cleanup", async () => {
  const h = setup(); h.agent.type = "linux-desktop"; h.agent.computer_profile = "ubuntu-desktop";
  h.agent.status = "provisioning"; h.agent.operation_kind = "provision"; h.agent.operation_id = allocationId;
  h.deps.absentDesktop.mockResolvedValue(true);
  await expect(advanceProviderAgentDelete(h.owner,h.deps)).resolves.toEqual({ok:false,pending:true,stage:"operation_finishing"});
  expect(h.deps.absentDesktop).toHaveBeenCalledWith({...h.owner,operationId:allocationId});
  expect(h.deps.desktopInstaller).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
  expect(h.deps.complete).not.toHaveBeenCalled(); expect(h.deps.cleanup).not.toHaveBeenCalled();
});
it.each(["pending", "status-only", "cleaned", "not_started", "not_dispatched", "provider_pending", "contradictory", "not-stopped", "not-cancelled"])("desktop provision deletion requires separate cleanup: %s", async proof => {
  const h = setup(); h.agent.type = "linux-desktop"; h.agent.computer_profile = "ubuntu-desktop";
  h.agent.status = "provisioning"; h.agent.operation_kind = "provision"; h.agent.operation_id = allocationId;
  h.deps.desktopInstaller.mockResolvedValue(proof === "not_dispatched" ? { stage: "not_dispatched" }
    : proof === "provider_pending" ? { stage: "waiting_for_provider" }
      : { stage: "worker_observed", state: proof === "not_started" ? "cancelled" : "succeeded",
        stopped: proof !== "not-stopped", cancellationRequested: proof !== "not-cancelled",
        desktopCleanup: proof === "not_started" ? "not_started" : ["pending", "contradictory"].includes(proof) ? "pending" : "verified_stopped",
        cleanupRecorded: !["pending", "status-only"].includes(proof) });
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).resolves.toEqual({ ok: false, pending: true,
    stage: proof === "pending" ? "provider_cleanup" : "installer_stopping" });
  expect(h.deps.desktopInstaller).toHaveBeenCalledWith({ ...h.owner, operationId: allocationId, action: "cancel" });
  expect(h.deps.request.mock.invocationCallOrder[0]).toBeLessThan(h.deps.desktopInstaller.mock.invocationCallOrder[0]);
  expect(h.deps.release).toHaveBeenCalledTimes(["cleaned", "not_started", "not_dispatched"].includes(proof) ? 1 : 0);
  expect(h.deps.installer).not.toHaveBeenCalled(); expect(h.deps.nativeInstaller).not.toHaveBeenCalled();
  expect(h.deps.retire).toHaveBeenCalledTimes(proof === "pending" ? 1 : 0);
  expect(h.deps.cleanup).toHaveBeenCalledTimes(proof === "pending" ? 1 : 0); expect(h.deps.complete).not.toHaveBeenCalled();
});
it("does not finalize a retained provision even when provider cleanup reports all resources absent", async () => {
  const h = setup(); h.agent.type = "linux-desktop"; h.agent.computer_profile = "ubuntu-desktop";
  h.agent.status = "provisioning"; h.agent.operation_kind = "provision"; h.agent.operation_id = allocationId;
  h.completed();
  await expect(advanceProviderAgentDelete(h.owner,h.deps)).resolves.toEqual({ok:false,pending:true,stage:"operation_finishing"});
  expect(h.deps.cleanup).toHaveBeenCalledTimes(1);
  expect(h.deps.release).not.toHaveBeenCalled(); expect(h.deps.complete).not.toHaveBeenCalled();
  expect(h.agent.operation_id).toBe(allocationId);
});
it.each(["unknown", "expired-proof"])("retains desktop original provision authority after %s", async failure => {
  const h = setup(); h.agent.type = "linux-desktop"; h.agent.computer_profile = "ubuntu-desktop";
  h.agent.status = "provisioning"; h.agent.operation_kind = "provision"; h.agent.operation_id = allocationId;
  if (failure === "unknown") h.deps.desktopInstaller.mockRejectedValue(new Error("private transport details"));
  else {
    h.deps.desktopInstaller.mockResolvedValue({ stage: "worker_observed", state: "failed", stopped: true,
      desktopCleanup: "verified_stopped", cleanupRecorded: true, cancellationRequested: true });
    h.deps.release.mockResolvedValue(false);
  }
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toThrow("Provider computer removal could not continue:");
  expect(h.deps.retire).not.toHaveBeenCalled(); expect(h.deps.cleanup).not.toHaveBeenCalled(); expect(h.deps.complete).not.toHaveBeenCalled();
  expect(h.deps.installer).not.toHaveBeenCalled(); expect(h.deps.nativeInstaller).not.toHaveBeenCalled();
  expect(JSON.stringify(h.deps.failure.mock.calls)).not.toContain("private transport details");
});
it.each([undefined, null, "omarchy", "windows-desktop"])("rejects unsupported provisioning desktop profile %s before delete intent", async profile => {
  const h = setup(); h.agent.type = "linux-desktop"; h.agent.computer_profile = profile;
  h.agent.status = "provisioning"; h.agent.operation_kind = "provision"; h.agent.operation_id = allocationId;
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toMatchObject({ code: "authority_changed" });
  expect(h.deps.request).not.toHaveBeenCalled(); expect(h.deps.desktopInstaller).not.toHaveBeenCalled();
});
it.each(["profile", "allocation"])("does not adopt changed desktop %s after delete intent", async field => {
  const h = setup(), request = h.deps.request.getMockImplementation()!;
  h.agent.type = "linux-desktop"; h.agent.computer_profile = "ubuntu-desktop";
  h.agent.status = "provisioning"; h.agent.operation_kind = "provision"; h.agent.operation_id = allocationId;
  h.deps.request.mockImplementation(async input => {
    const result = await request(input);
    if (field === "profile") h.agent.computer_profile = "omarchy";
    else h.agent.allocation_operation_id = operationId;
    return result;
  });
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toMatchObject({ code: "authority_changed" });
  expect(h.deps.desktopInstaller).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled(); expect(h.deps.cleanup).not.toHaveBeenCalled();
});
it.each([true, false])("later desktop deletion still needs all five original resource absences: %s", async complete => {
  const h = setup(); h.agent.type = "linux-desktop"; h.agent.computer_profile = "ubuntu-desktop";
  if (complete) h.completed();
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).resolves.toEqual(complete ? { ok: true } : { ok: false, pending: true, stage: "provider_cleanup" });
  expect(h.deps.complete).toHaveBeenCalledTimes(complete ? 1 : 0);
  expect(h.deps.desktopInstaller).not.toHaveBeenCalled(); expect(h.deps.installer).not.toHaveBeenCalled();
  expect(h.deps.nativeInstaller).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
it.each(["start", "stop", "restart"] as const)("observes the existing %s before allowing retirement or cleanup", async kind => {
  const h = setup(); h.agent.operation_kind = kind; h.agent.operation_id = allocationId; h.agent.status = "provisioning";
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).resolves.toEqual({ ok: false, pending: true, stage: "operation_finishing" });
  expect(h.deps.power).toHaveBeenCalledWith({ ...h.owner, operationId: allocationId }, "observe");
  expect(h.deps.retire).not.toHaveBeenCalled(); expect(h.deps.cleanup).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
it("settles an existing resize without redispatch, then claims deletion and continues original-resource cleanup", async () => {
  const h = setup();
  h.agent.operation_kind = "resize"; h.agent.operation_id = allocationId; h.agent.status = "provisioning";
  h.deps.resize.mockImplementation(async () => {
    h.agent.operation_kind = null; h.agent.operation_id = null; h.agent.status = "stopped";
    return { stage: "succeeded" } as never;
  });

  await expect(advanceProviderAgentDelete(h.owner, h.deps))
    .resolves.toEqual({ ok: false, pending: true, stage: "provider_cleanup" });

  expect(h.deps.resize).toHaveBeenCalledWith({ ...h.owner, operationId: allocationId }, "cancel_if_undispatched");
  expect(h.deps.request).toHaveBeenCalledTimes(2);
  expect(h.deps.request).toHaveBeenLastCalledWith({ ...h.owner, operationId });
  expect(h.deps.power).not.toHaveBeenCalled();
  expect(h.deps.cleanup).toHaveBeenCalledTimes(1);
});
it("returns an already deleted agent without new intent, resource calls or credentials", async () => {
  const h = setup(); h.deps.load.mockResolvedValue({ status: "deleted" });
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).resolves.toEqual({ ok: true });
  expect(h.deps.request).not.toHaveBeenCalled(); expect(h.deps.cleanup).not.toHaveBeenCalled();
});

it("hands an absent resize server to normal cleanup without claiming resize success or skipping the other resources", async () => {
  const h = setup(); h.agent.operation_kind = "resize"; h.agent.operation_id = allocationId; h.agent.status = "provisioning";
  h.deps.absentResize.mockImplementation(async () => {
    h.agent.operation_kind = null; h.agent.operation_id = null; h.agent.status = "error";
    return true;
  });
  await expect(advanceProviderAgentDelete(h.owner, h.deps))
    .resolves.toEqual({ ok: false, pending: true, stage: "provider_cleanup" });
  expect(h.deps.absentResize).toHaveBeenCalledWith({ ...h.owner, operationId: allocationId });
  expect(h.deps.resize).not.toHaveBeenCalled();
  expect(h.deps.request).toHaveBeenCalledTimes(2);
  expect(h.deps.cleanup).toHaveBeenCalledTimes(1);
  expect(h.deps.complete).not.toHaveBeenCalled();
});
it("does not expose raw provider, SSH or database details on an uncertain result", async () => {
  const h = setup(); h.deps.cleanup.mockRejectedValue(new Error("PRIVATE_PROVIDER_TOKEN"));
  await expect(advanceProviderAgentDelete(h.owner, h.deps)).rejects.toThrow("Provider computer removal could not continue: operation_unconfirmed");
  expect(JSON.stringify(h.deps.failure.mock.calls)).not.toContain("PRIVATE_PROVIDER_TOKEN");
});
