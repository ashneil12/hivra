jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/crypto", () => ({
  getSecretDecryptKeyCandidates: () => [{ key: Buffer.alloc(32, 1) }],
  getLaunchFingerprintKeyCandidates: () => [{ key: Buffer.alloc(32, 2), version: 2 }],
}));

import { randomUUID } from "node:crypto";
import { createLaunchModelAdmissionService } from "../launch-model-admission";
import type { LaunchModelIntent, LaunchModelStore, LaunchModelReservation } from "../launch-model-store";

function fixture() {
  const requestId = randomUUID(), agentId = randomUUID(), provisionId = randomUUID();
  const intent: LaunchModelIntent = { type: "codex", name: "My computer", cpu: 2, ram: 4, browser: false, goal: null,
    context: null, personality: null, emoji: null, templateSkills: [], deployment: { mode: "hivra-managed" },
    llm: { provider: "venice", mode: "byok", apiKey: "synthetic-launch-key", model: "test-model" } };
  const row: LaunchModelReservation = { id: agentId, type: "codex", name: "My computer", cpu: 2, ram: 4,
    deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", proxmox_host: "fixture", operation_id: provisionId,
    managed_provisioner_channel: "default",
    infrastructure_binding_token_hash: "a".repeat(64) };
  const saved = { agent_id: agentId, request_id: requestId, phase: "waiting" };
  const agent = jest.fn(async () => ({ id: agentId, user_id: "owner", type: "codex" as const, status: "provisioning" }));
  const store = { existing: jest.fn().mockResolvedValue(null), byRequest: jest.fn().mockResolvedValue(saved),
    reserve: jest.fn().mockResolvedValue({ created: true, agentId, phase: "waiting" }) };
  const newId = jest.fn(() => randomUUID());
  const service = createLaunchModelAdmissionService({ store: store as unknown as LaunchModelStore, agent, newId });
  return { requestId, agentId, intent, row, saved, agent, store, newId, service,
    prepare: () => service.prepare("owner", requestId, intent) };
}

it("prepares normalized intent without reserving, allocating or exposing the secret as request identity", async () => {
  const f = fixture(), result = await f.prepare();
  expect(result.existing).toBeNull(); expect(result.admission).toMatchObject({ userId: "owner", requestId: f.requestId, intent: f.intent });
  expect(JSON.stringify(result.admission!.fingerprints)).not.toContain("synthetic-launch-key");
  expect(f.store.reserve).not.toHaveBeenCalled(); expect(f.agent).not.toHaveBeenCalled();
});

it("returns the original computer before any new allocation identity or reservation", async () => {
  const f = fixture(); f.store.existing.mockResolvedValue(f.saved);
  expect(await f.prepare()).toMatchObject({ admission: null, existing: { requestId: f.requestId, agent: { id: f.agentId } } });
  expect(f.newId).not.toHaveBeenCalled(); expect(f.store.reserve).not.toHaveBeenCalled();
  expect(f.agent).toHaveBeenCalledWith("owner", f.agentId);
});

it.each([undefined, "invalid", null])("rejects a missing or malformed stable request ID before storage: %s", async id => {
  const f = fixture(); await expect(f.service.prepare("owner", id, f.intent)).rejects.toMatchObject({ code: "invalid_request" });
  expect(f.store.existing).not.toHaveBeenCalled(); expect(f.store.reserve).not.toHaveBeenCalled();
});

it("rejects malformed model intent before any storage or identity generation", async () => {
  const f = fixture(); await expect(f.service.prepare("owner", f.requestId, { ...f.intent, llm: null })).rejects.toMatchObject({ code: "invalid_request" });
  expect(f.store.existing).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
});

it("does not recreate an existing request whose original row cannot be loaded", async () => {
  const f = fixture(); f.store.existing.mockResolvedValue(f.saved); f.store.byRequest.mockResolvedValue(null);
  await expect(f.prepare()).rejects.toThrow("Model settings storage is unavailable");
  expect(f.store.reserve).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
});

it.each([{ id: "foreign" }, { user_id: "foreign" }, { type: "claude-code" }])("rejects an unbound original agent response: %j", async changed => {
  const f = fixture(); f.agent.mockResolvedValue({ ...await f.agent(), ...changed } as never);
  await expect(f.service.original("owner", f.requestId)).rejects.toThrow("Model settings storage is unavailable");
});

it.each([true, false])("retains the reservation disposition without performing any dispatch (created=%s)", async created => {
  const f = fixture(), { admission } = await f.prepare(); f.store.reserve.mockResolvedValue({ created, agentId: f.agentId, phase: "waiting" });
  expect(await f.service.reserve(admission!, f.row, 3)).toMatchObject({ created, requestId: f.requestId, agent: { id: f.agentId } });
  expect(f.store.reserve).toHaveBeenCalledWith({ userId: "owner", requestId: f.requestId,
    modelOperationId: admission!.modelOperationId, fingerprints: admission!.fingerprints, agent: f.row, llm: f.intent.llm,
    agentLimit: 3 });
});

it.each([{ cpu: 4 }, { ram: 8 }, { name: "Different" }, { goal: "different" }, { context: "different" },
  { template_skills: ["different"] }, { deployment_mode: "self-managed" }])("does not reserve a row for different canonical intent: %j", async changed => {
  const f = fixture(), { admission } = await f.prepare();
  await expect(f.service.reserve(admission!, { ...f.row, ...changed } as LaunchModelReservation, 3)).rejects.toMatchObject({ code: "invalid_request" });
  expect(f.store.reserve).not.toHaveBeenCalled();
});

it("binds reserved maxima to the model launch intent", async () => {
  const f = fixture();
  const explicit = { ...f.intent, maximumCpu: 4, maximumRam: 8 };
  const { admission } = await f.service.prepare("owner", f.requestId, explicit);
  await expect(f.service.reserve(admission!, { ...f.row, cpu_max: 2, ram_max: 4 }, 3))
    .rejects.toMatchObject({ code: "invalid_request" });
  await expect(f.service.reserve(admission!, { ...f.row, cpu_max: 4, ram_max: 8 }, 3))
    .resolves.toMatchObject({ created: true });
});

it("keeps the exact selected self-managed target and connection revision", async () => {
  const f = fixture(); f.intent.deployment = { mode: "self-managed", connectionId: randomUUID(), targetId: randomUUID(), expectedConnectionRevision: 2 };
  const { admission } = await f.prepare();
  const row: LaunchModelReservation = { ...f.row, deployment_mode: "self-managed", infrastructure_connection_id: f.intent.deployment.connectionId,
    deployment_target_id: f.intent.deployment.targetId, infrastructure_connection_revision: 3 };
  await expect(f.service.reserve(admission!, row, 3)).rejects.toMatchObject({ code: "invalid_request" });
  expect(f.store.reserve).not.toHaveBeenCalled();
  row.infrastructure_connection_revision = 2;
  expect(await f.service.reserve(admission!, row, 3)).toMatchObject({ created: true });
});
