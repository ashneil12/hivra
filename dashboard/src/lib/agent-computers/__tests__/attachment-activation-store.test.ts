jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ATTACHED_CODEX_SERVICE_POLICY_SHA256, buildAttachmentActivationRequest,
  createAttachmentActivationStore, parseAttachmentActivationRecord,
  type AttachmentActivationRecord } from "../attachment-activation-store";
import { attachmentExecutionExpectation, parseAttachmentExecutionSnapshot, type AttachmentExecutionSnapshot } from "../attachment-execution-snapshot";
import { buildAttachedCodexServiceDefinition } from "../attachment-native-service";

let execution: AttachmentExecutionSnapshot;
let activation: AttachmentActivationRecord;
beforeAll(() => {
  const raw = JSON.parse(execFileSync(process.execPath, [path.resolve("scripts/test-hivra-attachment-lease.cjs"), "--activation-json"],
    { encoding: "utf8", timeout: 15000 }));
  execution = parseAttachmentExecutionSnapshot(raw.execution, "owner", raw.execution.operationId)!;
  expect(execution).not.toBeNull();
  activation = raw.activation;
});

it("matches actual SQL dispatch evidence to the exact committed service definition", () => {
  expect(buildAttachmentActivationRequest(execution, activation.activationId)).toEqual(activation);
  expect(parseAttachmentActivationRecord(activation, execution)).toEqual(activation);
  expect(createHash("sha256").update(readFileSync(path.resolve("src/lib/agent-computers/attachment-native-service.ts"))).digest("hex"))
    .toBe(ATTACHED_CODEX_SERVICE_POLICY_SHA256);
});

it("matches the independent guest policy renderer byte-for-byte", () => {
  const program = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('preflight',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.service_definition(json.load(sys.stdin))))
`;
  const guest = JSON.parse(execFileSync("python3", ["-I", "-B", "-c", program,
    path.resolve("provisioner/preflight-attached-codex-activation.py")],
  { input: JSON.stringify(activation.staged), encoding: "utf8", timeout: 5000 }));
  expect(guest).toEqual(buildAttachedCodexServiceDefinition(JSON.stringify(activation.staged), attachmentExecutionExpectation(execution)!));
  expect(guest.sha256).toBe(activation.serviceDefinitionSha256);
});

it("rejects incomplete staging, invalid IDs and pending delete before requesting activation", () => {
  for (const change of [{ staged: null }, { desiredState: "deleted" }, { generation: "1" },
    { observation: null }, { dispatchId: null }, { phase: "claimed" }]) {
    expect(() => buildAttachmentActivationRequest({ ...execution, ...change } as AttachmentExecutionSnapshot, activation.activationId)).toThrow();
  }
  for (const id of ["", "invalid", activation.activationId + "\n"]) {
    expect(() => buildAttachmentActivationRequest(execution, id)).toThrow();
  }
});

it("rejects foreign/stale, unknown-field, unpinned and mismatched activation records", () => {
  for (const change of [{ operationId: execution.computerId }, { generation: "3" }, { generation: 2 },
    { version: 2 }, { activationId: "invalid" }, { extra: true },
    { servicePolicySha256: "0".repeat(64) }, { serviceDefinitionSha256: "b".repeat(64) },
    { staged: null }, { staged: { ...activation.staged, bootId: execution.computerId } },
    { staged: { ...activation.staged, receipt: { ...activation.staged.receipt, uid: 1002 } } }]) {
    expect(parseAttachmentActivationRecord({ ...activation, ...change }, execution)).toBeNull();
  }
  for (const value of [null, [], {}, "invalid"]) expect(parseAttachmentActivationRecord(value, execution)).toBeNull();
  expect(parseAttachmentActivationRecord(activation, { ...execution, desiredState: "deleted" })).toEqual(activation);
});

it("sends only the bound private RPC arguments and distinguishes true from false", async () => {
  const rpc = jest.fn().mockResolvedValue({ data: true, error: null });
  const store = createAttachmentActivationStore({ rpc });
  expect(await store.dispatch(execution, activation.activationId)).toBe(true);
  expect(rpc).toHaveBeenLastCalledWith("dispatch_hivra_attachment_activation", {
    p_owner: "owner", p_operation_id: execution.operationId, p_activation_id: activation.activationId,
    p_expected_generation: "2", p_expected_authority: execution.guestAuthority,
    p_observed_boot_id: execution.observation!.bootId, p_expected_staged: activation.staged,
    p_service_policy_sha256: ATTACHED_CODEX_SERVICE_POLICY_SHA256,
    p_service_definition_sha256: activation.serviceDefinitionSha256,
  });
  rpc.mockResolvedValueOnce({ data: false, error: null });
  expect(await store.dispatch(execution, activation.activationId)).toBe(false);
  rpc.mockResolvedValueOnce({ data: activation, error: null });
  expect(await store.read(execution)).toEqual(activation);
  expect(rpc).toHaveBeenLastCalledWith("read_hivra_attachment_activation", { p_owner: "owner", p_operation_id: execution.operationId });
  rpc.mockResolvedValueOnce({ data: null, error: null });
  expect(await store.read(execution)).toBeNull();
});

it("never treats truthy, malformed, missing or failed responses as a grant", async () => {
  const rpc = jest.fn(), store = createAttachmentActivationStore({ rpc });
  for (const response of [{ data: "true", error: null }, { data: null, error: null },
    { data: true }, { data: true, error: "private database details" }, null, []]) {
    rpc.mockResolvedValueOnce(response);
    await expect(store.dispatch(execution, activation.activationId)).rejects.toThrow(/unconfirmed/);
  }
  rpc.mockRejectedValueOnce(new Error("private database details"));
  await expect(store.dispatch(execution, activation.activationId)).rejects.toThrow(/unconfirmed/);
  rpc.mockResolvedValueOnce({ data: { ...activation, serviceDefinitionSha256: "b".repeat(64) }, error: null });
  await expect(store.read(execution)).rejects.toThrow(/unconfirmed/);
  await expect(createAttachmentActivationStore(null).dispatch(execution, activation.activationId)).rejects.toThrow(/unconfirmed/);
});

it("snapshots caller input before asynchronous dispatch and read", async () => {
  const original = structuredClone(execution);
  const rpc = jest.fn().mockImplementation(async () => {
    original.guestAuthority.ip = "10.241.0.99";
    original.generation = "3";
    return { data: true, error: null };
  });
  expect(await createAttachmentActivationStore({ rpc }).dispatch(original, activation.activationId)).toBe(true);
  expect(rpc.mock.calls[0][1].p_expected_generation).toBe("2");
  expect(rpc.mock.calls[0][1].p_expected_authority.ip).toBe(execution.guestAuthority.ip);
  const pending = structuredClone(execution);
  rpc.mockImplementationOnce(async () => {
    pending.operationId = pending.computerId;
    return { data: activation, error: null };
  });
  expect(await createAttachmentActivationStore({ rpc }).read(pending)).toEqual(activation);
});
