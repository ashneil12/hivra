jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));

import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseAttachmentExecutionSnapshot, attachmentExecutionExpectation,
  type AttachmentExecutionSnapshot } from "../attachment-execution-snapshot";
import { createAttachmentExecutionStore } from "../attachment-execution-store";
import { progressAttachmentStaging } from "../attachment-staging-coordinator";
import { parseAttachmentGuestResult, type AttachmentGuestResult } from "../attachment-guest-result";

let claimed: AttachmentExecutionSnapshot;
let dispatched: AttachmentExecutionSnapshot;
let completed: AttachmentExecutionSnapshot;
let prepared: AttachmentExecutionSnapshot;
let staged: AttachmentGuestResult;
beforeAll(() => {
  const values = JSON.parse(execFileSync(process.execPath, [path.resolve(process.cwd(), "scripts/test-hivra-attachment-lease.cjs"), "--json"],
    { encoding: "utf8", timeout: 15000 }));
  [claimed, dispatched, completed] = values.map((value: AttachmentExecutionSnapshot) => {
    const parsed = parseAttachmentExecutionSnapshot(value, "owner", value.operationId);
    expect(parsed).not.toBeNull();
    return parsed!;
  });
  prepared = { ...dispatched, phase: "claimed", dispatchId: null, staged: null };
  staged = parseAttachmentGuestResult(JSON.stringify(completed.staged), attachmentExecutionExpectation(dispatched)!)!;
  expect(staged).not.toBeNull();
});

function fixture() {
  let current = prepared;
  const store = { read: jest.fn().mockImplementation(async () => current), reserve: jest.fn().mockResolvedValue(true),
    recordBoot: jest.fn().mockResolvedValue(true), dispatch: jest.fn().mockResolvedValue(true), recordStaged: jest.fn().mockResolvedValue(true) };
  store.dispatch.mockImplementation(async () => { current = dispatched; return true; });
  const execute = jest.fn().mockImplementation(async (_owner, _agent, action) => action === "fetch"
    ? { ok: true, action: "fetch", artifact: {} }
    : { ok: true, action, staged });
  const observeBoot = jest.fn().mockResolvedValue({ ok: true, observation: { bootId: dispatched.observation!.bootId } });
  const uuid = jest.fn().mockReturnValue(dispatched.dispatchId);
  return { store, execute, observeBoot, uuid };
}
const run = (deps: ReturnType<typeof fixture>) => progressAttachmentStaging("owner", dispatched.operationId, "x86_64", deps);

it("parses actual SQL snapshots across admission, dispatch and pending-delete receipt recording", () => {
  expect(claimed.phase).toBe("claimed");
  expect(claimed.installation).toBeNull();
  expect(dispatched.phase).toBe("dispatched");
  expect(completed.desiredState).toBe("deleted");
  expect(completed.staged).toEqual(staged);
  expect(claimed.generation).toBe("2");
});

it("rejects foreign, malformed and inconsistent execution snapshots", () => {
  for (const change of [{ ownerId: "other" }, { operationId: claimed.operationId }, { generation: "900719925474099300000" },
    { generation: 2 }, { generation: "1" }, { generation: "2\n" }, { generation: "garbage" },
    { phase: "ready" }, { installation: null }, { observation: null },
    { dispatchId: null }, { guestAuthority: { ...dispatched.guestAuthority, user_id: "other" } },
    { guestAuthority: { ...dispatched.guestAuthority, infrastructure_binding_token_enforced: false } },
    { observation: { ...dispatched.observation, workerSha256: "f".repeat(64) } }, { extra: true },
    { staged: { ...staged, bootId: claimed.operationId } }]) {
    expect(parseAttachmentExecutionSnapshot({ ...dispatched, ...change }, "owner", dispatched.operationId)).toBeNull();
  }
  expect(parseAttachmentExecutionSnapshot({ ...prepared, staged }, "owner", prepared.operationId)).toBeNull();
  expect(parseAttachmentExecutionSnapshot({ ...claimed, observation: dispatched.observation }, "owner", claimed.operationId)).toBeNull();
  expect(parseAttachmentExecutionSnapshot(null, "owner", claimed.operationId)).toBeNull();
});

it("uses exact private RPC arguments and requires literal confirmation, not truthy responses", async () => {
  const rpc = jest.fn().mockResolvedValue({ data: prepared, error: null });
  const store = createAttachmentExecutionStore({ rpc });
  expect(await store.read("owner", prepared.operationId)).toEqual(prepared);
  expect(rpc).toHaveBeenLastCalledWith("read_hivra_attachment_execution", { p_owner: "owner", p_operation_id: prepared.operationId });
  rpc.mockResolvedValue({ data: true, error: null });
  expect(await store.dispatch(prepared, dispatched.dispatchId!)).toBe(true);
  expect(rpc).toHaveBeenLastCalledWith("dispatch_hivra_agent_attachment_v2", expect.objectContaining({
    p_expected_generation: "2", p_expected_authority: prepared.guestAuthority, p_dispatch_id: dispatched.dispatchId,
  }));
  for (const response of [{ data: true }, { data: "true", error: null }, { data: null, error: null },
    { data: true, error: "private" }, null, []]) {
    rpc.mockResolvedValueOnce(response);
    await expect(store.dispatch(prepared, dispatched.dispatchId!)).rejects.toThrow(/could not be confirmed/);
  }
  rpc.mockResolvedValueOnce({ data: false, error: null });
  expect(await store.dispatch(prepared, dispatched.dispatchId!)).toBe(false);
  rpc.mockResolvedValueOnce({ data: null, error: null });
  expect(await store.read("owner", prepared.operationId)).toBeNull();
  rpc.mockResolvedValueOnce({ data: completed, error: null });
  await expect(store.read("other", prepared.operationId)).rejects.toThrow(/could not be confirmed/);
});

it("fetches, wins one CAS, stages exactly once and records without activation", async () => {
  const deps = fixture();
  expect(await run(deps)).toEqual({ operationId: dispatched.operationId, state: "staging_recorded" });
  expect(deps.execute.mock.calls.map(call => call[2])).toEqual(["fetch", "stage"]);
  expect(deps.store.dispatch).toHaveBeenCalledTimes(1);
  expect(deps.store.dispatch).toHaveBeenCalledWith(prepared, dispatched.dispatchId);
  expect(deps.execute.mock.invocationCallOrder[0]).toBeLessThan(deps.store.dispatch.mock.invocationCallOrder[0]);
  expect(deps.store.dispatch.mock.invocationCallOrder[0]).toBeLessThan(deps.execute.mock.invocationCallOrder[1]);
  expect(deps.store.read).toHaveBeenCalledTimes(2);
  expect(deps.store.dispatch.mock.invocationCallOrder[0]).toBeLessThan(deps.store.read.mock.invocationCallOrder[1]);
  expect(deps.store.read.mock.invocationCallOrder[1]).toBeLessThan(deps.execute.mock.invocationCallOrder[1]);
  expect(deps.store.recordStaged).toHaveBeenCalledWith(dispatched, staged);
  expect(deps.observeBoot).not.toHaveBeenCalled();
});

it("reserves identities and saves independently observed boot before acquisition and dispatch", async () => {
  const deps = fixture();
  const unreserved = { ...prepared, installation: null, observation: null };
  const reserved = { ...prepared, observation: null };
  deps.store.read.mockReset().mockResolvedValueOnce(unreserved).mockResolvedValueOnce(reserved).mockResolvedValueOnce(prepared)
    .mockResolvedValue(dispatched);
  deps.uuid.mockReset().mockReturnValueOnce(prepared.installation!.installationId).mockReturnValueOnce(prepared.installation!.bindingId)
    .mockReturnValueOnce(dispatched.dispatchId);
  expect(await run(deps)).toEqual({ operationId: dispatched.operationId, state: "staging_recorded" });
  expect(deps.store.reserve).toHaveBeenCalledWith(unreserved, prepared.installation!.installationId, prepared.installation!.bindingId, "x86_64");
  expect(deps.store.recordBoot).toHaveBeenCalledWith(reserved, prepared.observation!.bootId);
  expect(deps.store.recordBoot.mock.invocationCallOrder[0]).toBeLessThan(deps.execute.mock.invocationCallOrder[0]);
});

it.each([false, "true", null])("never stages on non-confirming dispatch result %j", async result => {
  const deps = fixture();
  deps.store.dispatch.mockResolvedValueOnce(result);
  expect(await run(deps)).toEqual({ operationId: dispatched.operationId, state: "held", reason: "dispatch_unconfirmed" });
  expect(deps.execute.mock.calls.map(call => call[2])).toEqual(["fetch"]);
  expect(deps.store.recordStaged).not.toHaveBeenCalled();
});

it("does not stage when deletion is observed immediately after a confirmed dispatch", async () => {
  const deps = fixture();
  deps.store.read.mockResolvedValueOnce(prepared).mockResolvedValueOnce({ ...dispatched, desiredState: "deleted" });
  expect(await run(deps)).toEqual({ operationId: dispatched.operationId, state: "held", reason: "pending_delete" });
  expect(deps.store.dispatch).toHaveBeenCalledTimes(1);
  expect(deps.execute.mock.calls.map(call => call[2])).toEqual(["fetch"]);
  expect(deps.store.recordStaged).not.toHaveBeenCalled();
});

it("requires the exact dispatched snapshot before calling the staging host", async () => {
  for (const current of [null, prepared,
    { ...dispatched, dispatchId: prepared.installation!.bindingId },
    { ...dispatched, generation: "3" },
    { ...dispatched, authorityCommandId: prepared.installation!.bindingId },
    { ...dispatched, guestAuthority: { ...dispatched.guestAuthority, ip: "10.241.0.99" } },
    { ...dispatched, installation: { ...dispatched.installation!, bindingId: dispatched.operationId } },
    { ...dispatched, observation: { ...dispatched.observation!, bootId: dispatched.operationId } },
    { ...dispatched, staged },
  ]) {
    const deps = fixture();
    deps.store.read.mockResolvedValueOnce(prepared).mockResolvedValueOnce(current);
    expect(await run(deps)).toEqual({ operationId: dispatched.operationId, state: "held", reason: "dispatch_unconfirmed" });
    expect(deps.execute.mock.calls.map(call => call[2])).toEqual(["fetch"]);
    expect(deps.store.recordStaged).not.toHaveBeenCalled();
  }
});

it("a lost post-dispatch read remains held and the next pass observes instead of restaging", async () => {
  const deps = fixture();
  deps.store.read.mockResolvedValueOnce(prepared).mockRejectedValueOnce(new Error("read unavailable"));
  expect(await run(deps)).toEqual({ operationId: dispatched.operationId, state: "held", reason: "dispatch_unconfirmed" });
  expect(deps.execute.mock.calls.map(call => call[2])).toEqual(["fetch"]);
  expect((await run(deps)).state).toBe("staging_recorded");
  expect(deps.execute.mock.calls.map(call => call[2])).toEqual(["fetch", "observe"]);
  expect(deps.store.dispatch).toHaveBeenCalledTimes(1);
});

it("a lost dispatch acknowledgement leads to observation only on the next worker pass", async () => {
  const deps = fixture();
  deps.store.dispatch.mockRejectedValueOnce(new Error("lost acknowledgement"));
  expect((await run(deps)).state).toBe("held");
  deps.store.read.mockResolvedValueOnce(dispatched);
  expect((await run(deps)).state).toBe("staging_recorded");
  expect(deps.execute.mock.calls.map(call => call[2])).toEqual(["fetch", "observe"]);
  expect(deps.store.dispatch).toHaveBeenCalledTimes(1);
});

it.each(["stage", "observe"] as const)("keeps %s uncertainty held without another dispatch", async action => {
  const deps = fixture();
  if (action === "observe") deps.store.read.mockResolvedValueOnce(dispatched);
  deps.execute.mockImplementation(async (_owner, _agent, requested) => requested === "fetch"
    ? { ok: true, action: "fetch", artifact: {} } : { ok: false, code: "transport_failed" });
  expect(await run(deps)).toEqual({ operationId: dispatched.operationId, state: "held", reason: "staging_unconfirmed" });
  expect(deps.execute.mock.calls.map(call => call[2])).toEqual(action === "stage" ? ["fetch", "stage"] : ["observe"]);
  expect(deps.store.recordStaged).not.toHaveBeenCalled();
});

it("returns a previously recorded receipt state without touching the host", async () => {
  const deps = fixture();
  deps.store.read.mockResolvedValueOnce(completed);
  expect((await run(deps)).state).toBe("staging_recorded");
  expect(deps.execute).not.toHaveBeenCalled();
  expect(deps.store.dispatch).not.toHaveBeenCalled();
});

it("does not fetch or dispatch claimed work with a pending deletion", async () => {
  const deps = fixture();
  deps.store.read.mockResolvedValueOnce({ ...prepared, desiredState: "deleted" });
  expect(await run(deps)).toEqual({ operationId: dispatched.operationId, state: "held", reason: "pending_delete" });
  expect(deps.execute).not.toHaveBeenCalled();
});

it("does not adopt changed authority after a reservation or saved boot", async () => {
  const deps = fixture();
  deps.store.read.mockReset().mockResolvedValueOnce({ ...prepared, installation: null, observation: null })
    .mockResolvedValueOnce({ ...prepared, generation: "3" });
  expect((await run(deps)).state).toBe("held");
  expect(deps.execute).not.toHaveBeenCalled();
  expect(deps.store.dispatch).not.toHaveBeenCalled();
});

it("unconfirmed result persistence stays held even after staging succeeded", async () => {
  const deps = fixture();
  deps.store.recordStaged.mockRejectedValueOnce(new Error("private database error"));
  expect(await run(deps)).toEqual({ operationId: dispatched.operationId, state: "held", reason: "result_unconfirmed" });
  expect(deps.execute.mock.calls.map(call => call[2])).toEqual(["fetch", "stage"]);
});

it.each(["reservation", "boot", "fetch"] as const)("does not dispatch after unconfirmed %s", async step => {
  const deps = fixture();
  if (step === "reservation") {
    deps.store.read.mockResolvedValueOnce({ ...prepared, installation: null, observation: null });
    deps.store.reserve.mockResolvedValueOnce(false);
  } else if (step === "boot") {
    deps.store.read.mockResolvedValueOnce({ ...prepared, observation: null });
    deps.store.recordBoot.mockRejectedValueOnce(new Error("lost acknowledgement"));
  } else deps.execute.mockResolvedValueOnce({ ok: false, code: "transport_failed" });
  expect(await run(deps)).toEqual({ operationId: dispatched.operationId, state: "held", reason: `${step}_unconfirmed` });
  expect(deps.store.dispatch).not.toHaveBeenCalled();
  expect(deps.store.recordStaged).not.toHaveBeenCalled();
  expect(deps.execute.mock.calls.some(call => call[2] === "stage")).toBe(false);
});

it("does not execute against unavailable or wrong-owner state", async () => {
  const deps = fixture();
  for (const state of [null, { ...prepared, ownerId: "other" }]) {
    deps.store.read.mockResolvedValueOnce(state);
    expect(await run(deps)).toEqual({ operationId: dispatched.operationId, state: "held", reason: "state_unavailable" });
  }
  expect(deps.execute).not.toHaveBeenCalled();
  expect(deps.store.dispatch).not.toHaveBeenCalled();
});
