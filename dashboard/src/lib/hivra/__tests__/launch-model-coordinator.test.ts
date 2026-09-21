jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/crypto", () => ({ decryptSecret: jest.fn(), encryptSecret: jest.fn() }));
jest.mock("../model-key-coordinator", () => ({
  ModelKeyError: class extends Error { constructor(readonly code: string) { super(code); } },
  createModelKeyCoordinator: jest.fn(),
}));

import { randomUUID } from "node:crypto";
import { createLaunchModelCoordinator } from "../launch-model-coordinator";
import { createModelKeyCoordinator } from "../model-key-coordinator";
import { modelKeyBinding, type ModelKeyAgent } from "../model-key-store";
import type { LaunchModelRequest } from "../launch-model-store";

function fixture() {
  const a: ModelKeyAgent = { id: randomUUID(), user_id: "owner", type: "codex", status: "running", desired_state: "running",
    operation_id: null, deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", allocation_operation_id: randomUUID(),
    proxmox_host: "fixture", vmid: 401, infrastructure_connection_id: null, infrastructure_connection_revision: null,
    deployment_target_id: null, provider_capacity_order_id: null, provider_enrollment_attempt_id: null, provider_server_id: null,
    cf_hostname: "fixture.hivra.test", cf_tunnel_id: randomUUID(), chat_url: "https://fixture.hivra.test", ip: null, api_token: "a".repeat(64),
    llm_config: null, llm_api_key_encrypted: null };
  const q: LaunchModelRequest = { user_id: "owner", request_id: randomUUID(), agent_id: a.id, provision_operation_id: a.allocation_operation_id!,
    model_operation_id: randomUUID(), fingerprint_version: 1, fingerprint_key_tag: "b".repeat(64), request_digest: "c".repeat(64),
    binding: modelKeyBinding(a), selection: { provider: "venice", mode: "byok", model: "test-model" }, encrypted_key: "synthetic-cipher",
    phase: "waiting", attempted_at: null, attempt_id: null, attempt_expires_at: null, created_at: new Date().toISOString(), promoted_at: null, closed_at: null };
  const lease = { ...q, attempted_at: new Date().toISOString(), attempt_id: randomUUID(), attempt_expires_at: new Date(Date.now() + 30_000).toISOString() };
  const store = { agent: jest.fn(async (owner: string) => owner === "owner" ? a : null), operation: jest.fn().mockResolvedValue(null) };
  const launches = { byAgent: jest.fn().mockResolvedValue(q), claim: jest.fn().mockResolvedValue(lease),
    cancel: jest.fn().mockResolvedValue(true), promote: jest.fn().mockResolvedValue("pending") };
  const normal = { start: jest.fn().mockResolvedValue({ operationId: q.model_operation_id, status: "applied" }),
    resume: jest.fn().mockResolvedValue({ operationId: q.model_operation_id, status: "applied" }) };
  jest.mocked(createModelKeyCoordinator).mockReturnValue(normal as never);
  const decrypt = jest.fn(() => "synthetic-launch-key"), encrypt = jest.fn(() => "new-cipher");
  const coordinator = createLaunchModelCoordinator({ store: store as never, launches: launches as never, decrypt, encrypt });
  return { a, q, lease, store, launches, normal, decrypt, encrypt, coordinator,
    run: (automatic = true) => coordinator.continue("owner", a.id, q.request_id, automatic) };
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

it("exposes only the requested key-free selection, never queued credentials or allocation data", async () => {
  const f = fixture(); const result = await f.coordinator.summary("owner", f.a.id);
  expect(result).toEqual({ requestId: f.q.request_id, operationId: f.q.model_operation_id, requested: f.q.selection,
    createdAt: f.q.created_at, state: "ready_to_apply" });
  expect(JSON.stringify(result)).not.toMatch(/synthetic|cipher|binding|provision/);
  expect(f.decrypt).not.toHaveBeenCalled(); expect(f.launches.claim).not.toHaveBeenCalled();
});
it.each([{ status: "provisioning" }, { desired_state: "stopped" }, { operation_id: randomUUID() }])("waits for actual compute readiness: %j", async change => {
  const f = fixture(); Object.assign(f.a, change);
  expect(await f.run()).toMatchObject({ status: "waiting", reason: "computer_not_ready" });
  expect(f.launches.claim).not.toHaveBeenCalled(); expect(f.normal.start).not.toHaveBeenCalled(); expect(f.decrypt).not.toHaveBeenCalled();
});
it("does not admit a request whose original allocation changed", async () => {
  const f = fixture(); f.a.allocation_operation_id = randomUUID();
  await expect(f.run()).rejects.toMatchObject({ code: "computer_not_ready" });
  expect(f.launches.claim).not.toHaveBeenCalled(); expect(f.decrypt).not.toHaveBeenCalled();
});
it.each(["host", "serverId", "targetId", "connectionId", "runtime"])('rejects a changed original binding field %s', async key => {
  const f = fixture(); f.q.binding[key] = "different";
  await expect(f.run()).rejects.toMatchObject({ code: "computer_not_ready" });
  expect(f.normal.start).not.toHaveBeenCalled();
});
it("rejects another owner or request before claim or decryption", async () => {
  const f = fixture();
  await expect(f.coordinator.continue("foreign", f.a.id, f.q.request_id, true)).rejects.toMatchObject({ code: "not_found" });
  await expect(f.coordinator.continue("owner", f.a.id, randomUUID(), true)).rejects.toMatchObject({ code: "operation_conflict" });
  expect(f.launches.claim).not.toHaveBeenCalled(); expect(f.decrypt).not.toHaveBeenCalled();
});
it("passes the durable automatic-attempt gate before reconstructing a secret", async () => {
  const f = fixture(); f.launches.claim.mockResolvedValue(null as never);
  expect(await f.run()).toMatchObject({ status: "waiting", reason: "resume_required" });
  expect(f.launches.claim).toHaveBeenCalledWith("owner", f.a.id, f.q.request_id, true);
  expect(f.decrypt).not.toHaveBeenCalled(); expect(f.normal.start).not.toHaveBeenCalled();
});
it("rejects a suspended claim response after either deadline before reading or sending the key", async () => {
  jest.useFakeTimers(); const f = fixture();
  f.launches.claim.mockImplementation(async () => { jest.advanceTimersByTime(31_000); return f.lease; });
  await expect(f.run()).rejects.toMatchObject({ code: "computer_not_ready" });
  expect(f.decrypt).not.toHaveBeenCalled(); expect(f.normal.start).not.toHaveBeenCalled();
});
it("retains the original encrypted BYOK value at the coordinator admission boundary", async () => {
  const f = fixture();
  f.normal.start.mockImplementation(async () => {
    const adapted = jest.mocked(createModelKeyCoordinator).mock.calls.at(-1)![0]!;
    expect(adapted.encrypt!("synthetic-launch-key")).toBe(f.q.encrypted_key);
    expect(() => adapted.encrypt!("changed-secret")).toThrow();
    expect(await adapted.store!.admit("owner", f.a.id, f.q.model_operation_id, {}, { fixture: true })).toBe("pending");
    return { operationId: f.q.model_operation_id, status: "applied" };
  });
  expect(await f.run()).toMatchObject({ status: "applied" });
  expect(f.encrypt).not.toHaveBeenCalled();
  expect(f.launches.promote).toHaveBeenCalledWith("owner", f.a.id, f.q.request_id, f.lease.attempt_id, {}, { fixture: true });
});
it("does not automatically redeliver a promoted but unconfirmed operation", async () => {
  const f = fixture(); f.q.phase = "promoted";
  f.store.operation.mockResolvedValue({ phase: "pending" });
  expect(await f.run()).toMatchObject({ status: "pending", reason: "resume_required" });
  expect(f.normal.resume).not.toHaveBeenCalled(); expect(f.launches.claim).not.toHaveBeenCalled();
  expect(await f.run(false)).toMatchObject({ status: "applied" });
  expect(f.normal.resume).toHaveBeenCalledWith("owner", f.a.id, f.q.model_operation_id);
  expect(f.normal.start).not.toHaveBeenCalled();
});
it("blocks competing settings until the launch is promoted or explicitly cancelled", async () => {
  const f = fixture();
  await expect(f.coordinator.assertNoPendingLaunch("owner", f.a.id)).rejects.toMatchObject({ code: "pending_change" });
  f.q.phase = "promoted";
  await expect(f.coordinator.assertNoPendingLaunch("owner", f.a.id)).resolves.toBeUndefined();
});
it.each(["cancelled", "deleted"] as const)("never replays a %s request", async phase => {
  const f = fixture(); f.q.phase = phase;
  await expect(f.run(false)).rejects.toMatchObject({ code: "operation_conflict" });
  expect(f.normal.start).not.toHaveBeenCalled(); expect(f.normal.resume).not.toHaveBeenCalled(); expect(f.decrypt).not.toHaveBeenCalled();
});
it("does not discard evidence after atomic promotion won a cancellation race", async () => {
  const f = fixture(); f.launches.cancel.mockResolvedValue(false);
  await expect(f.coordinator.cancel("owner", f.a.id, f.q.request_id)).rejects.toMatchObject({ code: "pending_change" });
  expect(f.normal.start).not.toHaveBeenCalled(); expect(f.normal.resume).not.toHaveBeenCalled();
});
