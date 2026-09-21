jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));

import { execFileSync } from "node:child_process";
import path from "node:path";
import { progressAttachmentActivation, progressAttachmentNativeObservation } from "../attachment-activation-coordinator";
import { createAttachmentActivationObservationStore } from "../attachment-activation-observation-store";
import { parseAttachmentExecutionSnapshot, type AttachmentExecutionSnapshot } from "../attachment-execution-snapshot";
import type { AttachmentActivationRecord } from "../attachment-activation-store";
import type { AttachmentActivationObservation } from "../attachment-activation-result";

let snapshot: AttachmentExecutionSnapshot;
let activation: AttachmentActivationRecord;
let observation: AttachmentActivationObservation;
let observationId: string;
let nativeObservation: unknown;
let nativeObservationId: string;
beforeAll(() => {
  const raw = JSON.parse(execFileSync(process.execPath, [path.resolve("scripts/test-hivra-attachment-lease.cjs"), "--activation-json"],
    { encoding: "utf8", timeout: 15000 }));
  snapshot = parseAttachmentExecutionSnapshot(raw.execution, "owner", raw.execution.operationId)!;
  expect(snapshot).not.toBeNull();
  activation = raw.activation; observation = raw.observation; observationId = raw.observationId;
  nativeObservation = raw.nativeObservation; nativeObservationId = raw.nativeObservationId;
});

function fixture(existing = false) {
  const execution = { read: jest.fn().mockResolvedValue(snapshot) };
  const store = { read: jest.fn().mockResolvedValue(activation), dispatch: jest.fn().mockResolvedValue(true) };
  const uuid = jest.fn().mockReturnValue(observationId);
  if (!existing) { store.read.mockResolvedValueOnce(null); uuid.mockReturnValueOnce(activation.activationId); }
  const observations = { record: jest.fn().mockResolvedValue(true) };
  const execute = jest.fn().mockImplementation(async (_owner, action, request) => ({ ok: true, action,
    result: action === "start" ? { version: 1, request, phase: "service_started", unitIdentity: [2049, 12345], mainPid: 4321 } : observation }));
  return { execution, activation: store, observations, execute, uuid };
}
const run = (deps: ReturnType<typeof fixture>) => progressAttachmentActivation("owner", snapshot.operationId, deps);
const completed = () => ({ operationId: snapshot.operationId, state: "activation_observed", observationId, observationState: "process_running" });

it("wins one fresh grant, rechecks it, starts once, observes and records without release", async () => {
  const deps = fixture();
  expect(await run(deps)).toEqual(completed());
  expect(deps.execute.mock.calls.map(call => call[1])).toEqual(["start", "observe"]);
  expect(deps.activation.dispatch).toHaveBeenCalledTimes(1);
  expect(deps.activation.dispatch).toHaveBeenCalledWith(snapshot, activation.activationId);
  expect(deps.activation.dispatch.mock.invocationCallOrder[0]).toBeLessThan(deps.execute.mock.invocationCallOrder[0]);
  expect(deps.observations.record).toHaveBeenCalledWith(snapshot, activation, observationId, observation);
});

it("observes historical attempts only, including pending deletion", async () => {
  const deps = fixture(true);
  deps.execution.read.mockResolvedValue({ ...snapshot, desiredState: "deleted" });
  expect(await run(deps)).toEqual(completed());
  expect(deps.execute.mock.calls.map(call => call[1])).toEqual(["observe"]);
  expect(deps.activation.dispatch).not.toHaveBeenCalled();
});

it.each([false, "true", null])("does not start on a non-confirming grant %j", async grant => {
  const deps = fixture(); deps.activation.dispatch.mockResolvedValueOnce(grant);
  expect(await run(deps)).toMatchObject({ state: "held", reason: "dispatch_unconfirmed" });
  expect(deps.execute).not.toHaveBeenCalled();
  expect(deps.observations.record).not.toHaveBeenCalled();
});

it("a lost grant acknowledgement resumes as observation only", async () => {
  const deps = fixture(); deps.activation.dispatch.mockRejectedValueOnce(new Error("lost response"));
  expect((await run(deps)).state).toBe("held");
  expect(await run(deps)).toEqual(completed());
  expect(deps.execute.mock.calls.map(call => call[1])).toEqual(["observe"]);
  expect(deps.activation.dispatch).toHaveBeenCalledTimes(1);
});

it("a lost start acknowledgement is never restarted on the next pass", async () => {
  const deps = fixture(); deps.execute.mockResolvedValueOnce({ ok: false, code: "transport_failed" });
  expect(await run(deps)).toMatchObject({ state: "held", reason: "start_unconfirmed" });
  expect(await run(deps)).toEqual(completed());
  expect(deps.execute.mock.calls.map(call => call[1])).toEqual(["start", "observe"]);
  expect(deps.activation.dispatch).toHaveBeenCalledTimes(1);
});

it("rejects a newly queued delete or changed authority after the grant", async () => {
  for (const changed of [{ ...snapshot, desiredState: "deleted" }, { ...snapshot, generation: "3" },
    { ...snapshot, guestAuthority: { ...snapshot.guestAuthority, vmid: 9999 } }]) {
    const deps = fixture(); deps.execution.read.mockReset().mockResolvedValueOnce(snapshot).mockResolvedValue(changed);
    expect((await run(deps)).state).toBe("held");
    expect(deps.execute).not.toHaveBeenCalled();
  }
  const deps = fixture(); deps.activation.read.mockReset().mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ ...activation, activationId: snapshot.computerId });
  expect((await run(deps)).state).toBe("held"); expect(deps.execute).not.toHaveBeenCalled();
});

it("does not execute without staged state or for a delete without a prior grant", async () => {
  for (const value of [null, { ...snapshot, staged: null }, { ...snapshot, desiredState: "deleted" }]) {
    const deps = fixture(); deps.execution.read.mockResolvedValue(value);
    expect((await run(deps)).state).toBe("held");
    expect(deps.execute).not.toHaveBeenCalled(); expect(deps.activation.dispatch).not.toHaveBeenCalled();
  }
});

it("rejects changed results and retains persistence uncertainty without re-execution", async () => {
  const invalid = fixture(true);
  invalid.execute.mockResolvedValueOnce({ ok: true, action: "observe", result: { ...observation, bootId: snapshot.computerId } });
  expect(await run(invalid)).toMatchObject({ state: "held", reason: "observation_unconfirmed" });
  expect(invalid.observations.record).not.toHaveBeenCalled();
  for (const confirmation of [false, "true", null]) {
    const deps = fixture(true); deps.observations.record.mockResolvedValueOnce(confirmation);
    expect(await run(deps)).toMatchObject({ state: "held", reason: "persistence_unconfirmed" });
    expect(deps.execute).toHaveBeenCalledTimes(1);
  }
});

it("passes exact SQL-bound observations to private persistence and accepts literal booleans only", async () => {
  const rpc = jest.fn().mockResolvedValue({ data: true, error: null });
  const store = createAttachmentActivationObservationStore({ rpc });
  expect(await store.record(snapshot, activation, observationId, observation)).toBe(true);
  expect(rpc).toHaveBeenCalledWith("record_hivra_attachment_activation_observation", {
    p_owner: "owner", p_operation_id: snapshot.operationId, p_expected_generation: "2",
    p_expected_authority: snapshot.guestAuthority, p_expected_request: activation, p_observation_id: observationId, p_result: observation,
  });
  for (const value of [{ data: "true", error: null }, { data: true }, { data: null, error: null }, { data: true, error: "private" }, null]) {
    rpc.mockResolvedValueOnce(value);
    await expect(store.record(snapshot, activation, observationId, observation)).rejects.toThrow(/unconfirmed/);
  }
  rpc.mockResolvedValueOnce({ data: false, error: null });
  expect(await store.record(snapshot, activation, observationId, observation)).toBe(false);
  await expect(store.record(snapshot, activation, observationId, { ...observation, ready: true })).rejects.toThrow(/unconfirmed/);
});

it("persists the actual SQL native observation without flattening it into process status", async () => {
  const rpc = jest.fn().mockResolvedValue({ data: true, error: null });
  const store = createAttachmentActivationObservationStore({ rpc });
  expect(await store.record(snapshot, activation, nativeObservationId, nativeObservation)).toBe(true);
  expect(rpc.mock.calls[0][1].p_result).toEqual(nativeObservation);
  expect(rpc.mock.calls[0][1].p_result.state).toBe("native_protocol_available");
  for (const data of [false, "true", null]) {
    rpc.mockResolvedValueOnce({ data, error: null });
    if (data === false) expect(await store.record(snapshot, activation, nativeObservationId, nativeObservation)).toBe(false);
    else await expect(store.record(snapshot, activation, nativeObservationId, nativeObservation)).rejects.toThrow(/unconfirmed/);
  }
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  await expect(store.record(snapshot, activation, nativeObservationId, cycle)).rejects.toThrow(/unconfirmed/);
});

function nativeFixture() {
  const deps = fixture(true);
  deps.execute.mockResolvedValue({ ok: true, action: "native", result: nativeObservation });
  deps.uuid.mockReturnValue(nativeObservationId);
  return deps;
}
const runNative = (deps: ReturnType<typeof fixture>) => progressAttachmentNativeObservation("owner", snapshot.operationId, deps);

it("records native evidence through an observation-only pass without dispatch or release", async () => {
  const deps = nativeFixture();
  expect(await runNative(deps)).toEqual({ operationId: snapshot.operationId, state: "native_protocol_observed", observationId: nativeObservationId });
  expect(deps.execute.mock.calls.map(call => call[1])).toEqual(["native"]);
  expect(deps.activation.dispatch).not.toHaveBeenCalled();
  expect(deps.observations.record).toHaveBeenCalledWith(snapshot, activation, nativeObservationId, nativeObservation);
});

it("does not create an activation or probe changed authority", async () => {
  const missing = nativeFixture(); missing.activation.read.mockResolvedValue(null);
  expect((await runNative(missing)).state).toBe("held");
  expect(missing.activation.dispatch).not.toHaveBeenCalled(); expect(missing.execute).not.toHaveBeenCalled();
  for (const changed of [null, { ...snapshot, generation: "3" }, { ...snapshot, guestAuthority: { ...snapshot.guestAuthority, vmid: 9999 } }]) {
    const deps = nativeFixture(); deps.execution.read.mockReset().mockResolvedValueOnce(snapshot).mockResolvedValue(changed);
    expect((await runNative(deps)).state).toBe("held"); expect(deps.execute).not.toHaveBeenCalled();
  }
});

it("rechecks authority after native execution and refuses generic or lost results", async () => {
  const changed = nativeFixture(); changed.execution.read.mockReset().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(snapshot)
    .mockResolvedValue({ ...snapshot, generation: "3" });
  expect((await runNative(changed)).state).toBe("held"); expect(changed.observations.record).not.toHaveBeenCalled();
  for (const response of [{ ok: false, code: "transport_failed" }, { ok: true, action: "native", result: observation },
    { ok: true, action: "observe", result: nativeObservation }]) {
    const deps = nativeFixture(); deps.execute.mockResolvedValue(response);
    expect(await runNative(deps)).toMatchObject({ state: "held", reason: "observation_unconfirmed" });
    expect(deps.observations.record).not.toHaveBeenCalled();
  }
});

it("pending deletion may record facts but persistence ambiguity cannot succeed", async () => {
  const deps = nativeFixture(); deps.execution.read.mockResolvedValue({ ...snapshot, desiredState: "deleted" });
  expect((await runNative(deps)).state).toBe("native_protocol_observed");
  expect(deps.activation.dispatch).not.toHaveBeenCalled();
  for (const confirmation of [false, "true", null]) {
    const uncertain = nativeFixture(); uncertain.observations.record.mockResolvedValue(confirmation);
    expect(await runNative(uncertain)).toMatchObject({ state: "held", reason: "persistence_unconfirmed" });
    expect(uncertain.execute).toHaveBeenCalledTimes(1);
  }
  const lost = nativeFixture(); lost.observations.record.mockRejectedValueOnce(new Error("lost acknowledgment"));
  expect((await runNative(lost)).state).toBe("held");
  expect((await runNative(lost)).state).toBe("native_protocol_observed");
  expect(lost.execute.mock.calls.map(call => call[1])).toEqual(["native", "native"]);
  expect(lost.activation.dispatch).not.toHaveBeenCalled();
});
