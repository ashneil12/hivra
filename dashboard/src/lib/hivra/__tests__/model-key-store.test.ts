import { createHash, randomUUID } from "node:crypto";
import { createModelKeyStore, modelKeyBinding, ModelKeyStoreError, type ModelKeyAgent } from "../model-key-store";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

const owner = "owner", agentId = randomUUID(), op = randomUUID();
const agent: ModelKeyAgent = { id: agentId, user_id: owner, type: "codex", status: "running", desired_state: "running",
  operation_id: null, deployment_mode: "managed", computer_substrate: "proxmox-kvm", allocation_operation_id: null,
  proxmox_host: "fixture", vmid: 501, infrastructure_connection_id: null, infrastructure_connection_revision: null,
  deployment_target_id: null, provider_capacity_order_id: null, provider_enrollment_attempt_id: null,
  provider_server_id: null, cf_hostname: "computer.hivra.test", cf_tunnel_id: "fixture-tunnel",
  chat_url: "https://computer.hivra.test", ip: null, api_token: "a".repeat(64), llm_config: null, llm_api_key_encrypted: null };
const operation = { operation_id: op, user_id: owner, agent_id: agentId, request_digest: "b".repeat(64), binding: modelKeyBinding(agent),
  admission_connection_revision: null, config: null, payload: null, encrypted_key: null, cipher_digest: null,
  expected_state_digest: "c".repeat(64), expected_receipt: { protocol: "hivra-llm-apply-v1", operationId: op,
    stateDigest: "d".repeat(64), payloadDigest: "e".repeat(64), provider: null, model: null },
  managed_key_id: null, phase: "pending", is_current: false, lease_id: randomUUID(),
  lease_expires_at: new Date(Date.now() + 20_000).toISOString(), dispatch_intent_at: null,
  created_at: new Date().toISOString(), applied_at: null, deleted_at: null };
function fixture(data: unknown = null, error: unknown = null) {
  const query = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn(async () => ({ data, error })) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  const db = { from: jest.fn(() => query), rpc: jest.fn(async () => ({ data, error })) };
  return { db, query, store: createModelKeyStore(db as never) };
}

it("requires a configured private database client", () => {
  expect(() => createModelKeyStore(null)).toThrow(ModelKeyStoreError);
});

it("uses an explicit projection and both identity and owner filters for agent reads", async () => {
  const f = fixture({ ...agent, arbitrary_private_field: "do-not-copy" });
  expect(await f.store.agent(owner, agentId)).toEqual(agent);
  expect(f.db.from).toHaveBeenCalledWith("hivra_agents");
  expect(f.query.select.mock.calls[0][0]).not.toBe("*");
  expect(f.query.eq.mock.calls).toEqual([["id", agentId], ["user_id", owner]]);
});

it.each([undefined, op])("scopes operation reads and distinguishes pending from an exact request: %s", async id => {
  const f = fixture(operation);
  expect(await f.store.operation(owner, agentId, id)).toEqual(operation);
  expect(f.query.select.mock.calls[0][0]).not.toBe("*");
  expect(f.query.eq.mock.calls).toEqual([["agent_id", agentId], ["user_id", owner], id ? ["operation_id", id] : ["phase", "pending"]]);
});

it.each([null, { ...agent, user_id: "foreign" }, { ...agent, id: randomUUID() }, { ...agent, vmid: "not-a-number" }])("distinguishes absence from unsafe returned agents", async data => {
  const f = fixture(data);
  if (data === null) await expect(f.store.agent(owner, agentId)).resolves.toBeNull();
  else await expect(f.store.agent(owner, agentId)).rejects.toThrow(ModelKeyStoreError);
});

it.each([{ user_id: "foreign" }, { agent_id: randomUUID() }, { operation_id: randomUUID() },
  { expected_receipt: { ...operation.expected_receipt, unexpected: "private" } }])("refuses unsafe exact operation rows: %j", async changes => {
  const f = fixture({ ...operation, ...changes });
  await expect(f.store.operation(owner, agentId, op)).rejects.toThrow(ModelKeyStoreError);
});

it("does not mistake a historical operation for a pending change", async () => {
  const f = fixture({ ...operation, phase: "applied" });
  await expect(f.store.operation(owner, agentId)).rejects.toThrow(ModelKeyStoreError);
});

it("uses owner-scoped RPCs and never permits client-generated lease IDs", async () => {
  const f = fixture("pending"), binding = modelKeyBinding(agent), request = { requestDigest: "b".repeat(64) };
  expect(await f.store.admit(owner, agentId, op, binding, request)).toBe("pending");
  expect(f.db.rpc).toHaveBeenLastCalledWith("admit_hivra_model_key_operation", {
    p_user_id: owner, p_agent_id: agentId, p_operation_id: op, p_binding: binding, p_request: request,
  });
  f.db.rpc.mockResolvedValueOnce({ data: operation, error: null });
  expect(await f.store.claim(owner, agentId, op)).toEqual(operation);
  expect(f.db.rpc).toHaveBeenLastCalledWith("claim_hivra_model_key_delivery", { p_user_id: owner, p_agent_id: agentId, p_operation_id: op });
  f.db.rpc.mockResolvedValueOnce({ data: true, error: null });
  expect(await f.store.settle(owner, agentId, op, operation.lease_id, operation.expected_receipt)).toBe(true);
  expect(f.db.rpc).toHaveBeenLastCalledWith("settle_hivra_model_key_operation", { p_user_id: owner, p_agent_id: agentId,
    p_operation_id: op, p_lease_id: operation.lease_id, p_receipt: operation.expected_receipt });
});

it.each([{ phase: "applied" }, { lease_id: null }, { lease_expires_at: null }, { user_id: "foreign" },
  { agent_id: randomUUID() }, { operation_id: randomUUID() }])("rejects an unsafe claim: %j", async changes => {
  const f = fixture({ ...operation, ...changes });
  await expect(f.store.claim(owner, agentId, op)).rejects.toThrow(ModelKeyStoreError);
});

it.each(["agent", "operation", "admit", "claim", "settle"] as const)("redacts returned errors and rejected promises from %s", async method => {
  const f = fixture(null, { message: "PRIVATE-credential" });
  const call = () => f.store[method](owner, agentId, op, "lease" as never, "receipt" as never);
  await expect(call()).rejects.toThrow(ModelKeyStoreError);
  await expect(call()).rejects.not.toThrow("PRIVATE");
  f.query.maybeSingle.mockRejectedValue(new Error("PRIVATE-credential"));
  f.db.rpc.mockRejectedValue(new Error("PRIVATE-credential"));
  await expect(call()).rejects.toThrow(ModelKeyStoreError);
  await expect(call()).rejects.not.toThrow("PRIVATE");
});

it("refuses malformed RPC success values", async () => {
  const f = fixture({ ok: true });
  await expect(f.store.admit(owner, agentId, op, {}, {})).rejects.toThrow(ModelKeyStoreError);
  await expect(f.store.settle(owner, agentId, op, operation.lease_id, {})).rejects.toThrow(ModelKeyStoreError);
  f.db.rpc.mockResolvedValue({ data: null, error: null });
  await expect(f.store.claim(owner, agentId, op)).resolves.toBeNull();
});

it("binds all recipient authority except credential-repair revision, never the raw bearer", () => {
  const binding = modelKeyBinding(agent);
  expect(binding.tokenDigest).toBe(createHash("sha256").update(agent.api_token!).digest("hex"));
  expect(JSON.stringify(binding)).not.toContain(agent.api_token!);
  expect(modelKeyBinding({ ...agent, infrastructure_connection_revision: 2 })).toEqual(binding);
  for (const key of ["id", "user_id", "type", "deployment_mode", "computer_substrate", "allocation_operation_id",
    "proxmox_host", "vmid", "infrastructure_connection_id", "deployment_target_id", "provider_capacity_order_id",
    "provider_enrollment_attempt_id", "provider_server_id", "cf_hostname", "cf_tunnel_id", "chat_url", "api_token"] as const) {
    expect(modelKeyBinding({ ...agent, [key]: "changed" } as ModelKeyAgent)).not.toEqual(binding);
  }
});

it("binds a standalone recipient to its exact public IP and never adopts mixed tunnel state", () => {
  const direct = { ...agent, computer_substrate: "provider-vm", ip: "203.0.113.10",
    chat_url: "https://203-0-113-10.sslip.io", cf_hostname: null, cf_tunnel_id: null };
  const binding = modelKeyBinding(direct);
  expect(binding).toMatchObject({ hostname: "203-0-113-10.sslip.io", tunnelId: null });
  for (const change of [{ ip: "203.0.113.11" }, { computer_substrate: "proxmox-kvm" }, { cf_tunnel_id: "conflict" }]) {
    expect(modelKeyBinding({ ...direct, ...change })).not.toEqual(binding);
  }
});
