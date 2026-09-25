/** @jest-environment node */

// The minute worker's pass over one attach step (design 5.5; threats T3, T20,
// T23, T25, T30). Only a compare-and-swap this pass won starts a guest step; a
// lost answer is followed by a read-only look, never by a second install or a
// second change; anything unconfirmed stays held; a failed install ends only
// after an observed cleanup; Remove never touches ~/Hivra.

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: jest.fn() }));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import { progressAttachmentWork } from "../attachment-worker";
import { ATTACHED_SERVICE_POLICY_V2_SHA256 } from "../attach-review";
import { ATTACHED_AGENT_PROGRAM_SHA256 } from "../attached-agent-host";

const OWNER = "owner-1";
const ID = "00000000-0000-4100-8000-000000000001";
const SOURCE = "00000000-0000-4100-8000-000000000002";
const COMPUTER = "00000000-0000-4100-8000-000000000003";
const INSTALLATION = "00000000-0000-4100-8000-000000000004";
const BOOT = "00000000-0000-4100-8000-000000000005";
const OPERATION = "00000000-0000-4100-8000-000000000006";
const ACTIVATION = "00000000-0000-4100-8000-000000000007";
const TOKEN = "a".repeat(64);
const DEFINITION = "d".repeat(64);

const computerRow = {
  id: SOURCE, user_id: OWNER, name: "MY_UBUNTU_DESKTOP", type: "linux-desktop", cpu: 2, ram: 4, status: "running", vmid: 1201,
  ip: "192.0.2.10", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed",
  infrastructure_binding_token_hash: "b".repeat(64), infrastructure_binding_token_enforced: true,
  chat_url: "https://desk.example.test", provisioned_at: "2026-09-24T10:00:00.000Z",
};
const NOW = Date.parse("2026-09-24T12:00:00.000Z");

function stateOf(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, id: ID, ownerId: OWNER, phase: "dispatched", sourceId: SOURCE, computerId: COMPUTER, generation: "2",
    guestAuthority: { id: SOURCE, vmid: 1201 }, agentName: "Codex", grants: { workspace: true }, reviewSha256: "c".repeat(64),
    dispatchId: null, installation: { installationId: INSTALLATION, bindingId: OPERATION, architecture: "x86_64" }, bootId: BOOT,
    staged: { receipt: { uid: 61001, gid: 61001 } }, activation: null, readyObservationId: null, contractRevision: null,
    desiredState: "running", computerStatus: "running", ...overrides,
  };
}

const observation = (state: string) => ({ version: 1, state, journalPhase: "service_started", operationId: ID, activationId: ACTIVATION,
  installationId: INSTALLATION, bootId: BOOT, serviceDefinitionSha256: DEFINITION, mainPid: 4242 });
const removed = { version: 1, operationId: ID, installationId: INSTALLATION, state: "removed", workspaceTouched: false, stagingCleared: true };

function fakes() {
  const store = {
    readState: jest.fn(), cancel: jest.fn().mockResolvedValue(true), refuse: jest.fn().mockResolvedValue(true), dispatchActivation: jest.fn().mockResolvedValue(true),
    readInstanceToken: jest.fn().mockResolvedValue(TOKEN), recordObservation: jest.fn().mockResolvedValue(true),
    complete: jest.fn().mockResolvedValue(true), fail: jest.fn().mockResolvedValue(true), recordContract: jest.fn().mockResolvedValue(true),
    readOperation: jest.fn(), dispatchOperation: jest.fn().mockResolvedValue(true), cancelOperation: jest.fn().mockResolvedValue(true),
    completeOperation: jest.fn().mockResolvedValue(true), failOperation: jest.fn().mockResolvedValue(true),
    interrupt: jest.fn().mockResolvedValue(true), resume: jest.fn().mockResolvedValue(true),
  };
  const deps = {
    store: store as never,
    loadComputer: jest.fn().mockResolvedValue(computerRow),
    hostAddresses: jest.fn().mockResolvedValue(["203.0.113.7"]),
    stage: jest.fn(),
    execute: jest.fn(),
    gatewayProtocol: jest.fn().mockResolvedValue("current"),
    uuid: jest.fn(() => ACTIVATION),
    token: jest.fn(() => TOKEN),
    event: jest.fn().mockResolvedValue(undefined),
    now: jest.fn(() => NOW),
  };
  return { store, deps };
}
const actions = (execute: jest.Mock) => execute.mock.calls.map((call) => call[2]);

describe("adding Codex", () => {
  it("fails a claim on a computer that stopped, with that reason, and cancels one being deleted, before anything runs on it", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ phase: "claimed", staged: null, computerStatus: "stopped" }));
    deps.loadComputer.mockResolvedValue({ ...computerRow, status: "stopped" });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "failed", reason: "computer_not_running" });
    expect(store.refuse).toHaveBeenLastCalledWith(OWNER, ID, "computer_not_running");
    expect(store.cancel).not.toHaveBeenCalled();
    expect(deps.event).toHaveBeenLastCalledWith(expect.objectContaining({ event: "agent_attach_failed",
      detail: expect.objectContaining({ reason: "computer_not_running" }) }));
    store.readState.mockResolvedValue(stateOf({ phase: "claimed", staged: null, desiredState: "deleted" }));
    deps.loadComputer.mockResolvedValue(computerRow);
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "cancelled", reason: "pending_delete" });
    expect(store.cancel).toHaveBeenLastCalledWith(OWNER, ID, "pending_delete");
    expect(deps.stage).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["has not been seen ready", { provisioned_at: null }],
    ["has no gateway for the agent's chat", { chat_url: null }],
  ])("fails a claim on a running computer that %s as computer_not_ready, never held", async (_label, row) => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ phase: "claimed", staged: null }));
    deps.loadComputer.mockResolvedValue({ ...computerRow, ...row });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "failed", reason: "computer_not_ready" });
    expect(store.refuse).toHaveBeenCalledWith(OWNER, ID, "computer_not_ready");
    expect(deps.stage).not.toHaveBeenCalled();
  });

  it("retries a guest that has not answered yet, then fails the claim as computer_not_ready once the window has passed", async () => {
    const { store, deps } = fakes();
    deps.stage.mockResolvedValue({ operationId: ID, state: "held", reason: "boot_unobserved" });
    store.readState.mockResolvedValue(stateOf({ phase: "claimed", staged: null, createdAt: new Date(NOW - 60_000).toISOString() }));
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "held", reason: "boot_unobserved" });
    expect(store.refuse).not.toHaveBeenCalled();
    store.readState.mockResolvedValue(stateOf({ phase: "claimed", staged: null, createdAt: new Date(NOW - 3 * 60_000).toISOString() }));
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "failed", reason: "computer_not_ready" });
    expect(store.refuse).toHaveBeenCalledWith(OWNER, ID, "computer_not_ready");
    // A guest that answered but whose record was not confirmed is not a refusal.
    store.refuse.mockClear();
    deps.stage.mockResolvedValue({ operationId: ID, state: "held", reason: "boot_unconfirmed" });
    expect((await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps)).state).toBe("held");
    expect(store.refuse).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it.each(["computer_not_running", "computer_not_ready"] as const)(
    "fails a claim at once when the host refused the VM before staging (%s), never held", async (reason) => {
      const { store, deps } = fakes();
      deps.stage.mockResolvedValue({ operationId: ID, state: "held", reason });
      store.readState.mockResolvedValue(stateOf({ phase: "claimed", staged: null, createdAt: new Date(NOW - 10_000).toISOString() }));
      expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
        .toEqual({ kind: "attach", id: ID, state: "failed", reason });
      expect(store.refuse).toHaveBeenCalledWith(OWNER, ID, reason);
      expect(deps.execute).not.toHaveBeenCalled();
    });

  it("keeps a refusal the database did not confirm held, to be read again", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ phase: "claimed", staged: null }));
    store.refuse.mockResolvedValue(false);
    deps.loadComputer.mockResolvedValue({ ...computerRow, provisioned_at: null });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "held", reason: "failure_unconfirmed" });
  });

  it("stages, starts Codex once after winning the activation dispatch, and completes only with the readiness observation", async () => {
    const { store, deps } = fakes();
    store.readState
      .mockResolvedValueOnce(stateOf({ phase: "claimed", staged: null }))
      .mockResolvedValueOnce(stateOf())
      .mockResolvedValueOnce(stateOf({ activation: { activationId: ACTIVATION, serviceDefinitionSha256: DEFINITION } }));
    deps.stage.mockResolvedValue({ operationId: ID, state: "staging_recorded" });
    deps.execute.mockResolvedValue({ ok: true, result: { observation: observation("native_protocol_available"),
      contract: { sha256: "e".repeat(64), checked: true } } });

    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps)).toEqual({ kind: "attach", id: ID, state: "attached" });
    expect(deps.stage).toHaveBeenCalledWith(OWNER, ID, "x86_64", { dispatchedAt: null });
    expect(actions(deps.execute)).toEqual(["activate"]);
    const dispatched = store.dispatchActivation.mock.calls[0][0];
    expect(dispatched).toMatchObject({ ownerId: OWNER, operationId: ID, activationId: ACTIVATION, bootId: BOOT, instanceToken: TOKEN,
      servicePolicySha256: ATTACHED_SERVICE_POLICY_V2_SHA256, programSha256: ATTACHED_AGENT_PROGRAM_SHA256 });
    const packet = deps.execute.mock.calls[0][4];
    expect(packet).toMatchObject({ action: "activate", installationId: INSTALLATION, uid: 61001, gid: 61001, grants: { workspace: true },
      instanceToken: TOKEN, hostAddresses: ["203.0.113.7"], serviceDefinitionSha256: dispatched.serviceDefinitionSha256 });
    expect(packet.agentsMd).toContain("You were added to your user's computer \"MY_UBUNTU_DESKTOP\"");
    expect(store.recordObservation).toHaveBeenCalledWith(expect.objectContaining({ result: observation("native_protocol_available") }));
    expect(store.complete).toHaveBeenCalledWith(expect.objectContaining({ observationId: ACTIVATION }));
    expect(deps.event).toHaveBeenCalledWith(expect.objectContaining({ event: "agent_attached",
      detail: expect.objectContaining({ access: "~/Hivra read and write, internet" }) }));
  });

  it("never starts Codex when another pass holds the activation dispatch", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf());
    store.dispatchActivation.mockResolvedValue(false);
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "held", reason: "activation_unconfirmed" });
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("only observes an activation that is already recorded, with the stored token", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ activation: { activationId: ACTIVATION, serviceDefinitionSha256: DEFINITION } }));
    deps.execute.mockResolvedValue({ ok: true, result: { observation: observation("process_running"), contract: null } });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "held", reason: "readiness_unconfirmed" });
    expect(actions(deps.execute)).toEqual(["observe"]);
    expect(deps.execute.mock.calls[0][4]).toMatchObject({ action: "observe", activationId: ACTIVATION, instanceToken: TOKEN });
    expect(store.dispatchActivation).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("removes a failed install from the computer before it records the failure", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ activation: { activationId: ACTIVATION, serviceDefinitionSha256: DEFINITION } }));
    deps.execute
      .mockResolvedValueOnce({ ok: true, result: { observation: observation("service_inactive"), contract: null, failure: "network_not_enforced" } })
      .mockResolvedValueOnce({ ok: true, result: removed });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "failed", reason: "network_not_enforced" });
    expect(actions(deps.execute)).toEqual(["observe", "remove"]);
    expect(store.fail).toHaveBeenCalledWith(expect.objectContaining({ failureCode: "network_not_enforced", cleanup: removed }));
    expect(deps.event).toHaveBeenCalledWith(expect.objectContaining({ event: "agent_attach_failed" }));
  });

  it("keeps a failed install held while its cleanup is not observed", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ activation: { activationId: ACTIVATION, serviceDefinitionSha256: DEFINITION } }));
    deps.execute
      .mockResolvedValueOnce({ ok: true, result: { observation: observation("service_inactive"), contract: null, failure: "chat_not_ready" } })
      .mockResolvedValueOnce({ ok: true, result: { ...removed, state: "unresolved" } });
    expect((await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps)).reason).toBe("cleanup_unresolved");
    expect(store.fail).not.toHaveBeenCalled();
  });

  it.each([
    ["after staging", {}],
    ["while Codex starts", { activation: { activationId: ACTIVATION, serviceDefinitionSha256: DEFINITION } }],
  ])("lets a computer being deleted go %s, without starting Codex or waiting for the guest (T3)", async (_label, overrides) => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ desiredState: "deleted", ...overrides }));
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "interrupted", reason: "pending_delete" });
    expect(store.interrupt).toHaveBeenCalledWith(OWNER, "attach", ID, "pending_delete");
    expect(deps.execute).not.toHaveBeenCalled();
    expect(store.dispatchActivation).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["starting Codex", {}, "activate"],
    ["looking at Codex", { activation: { activationId: ACTIVATION, serviceDefinitionSha256: DEFINITION } }, "observe"],
  ])("lets the computer go when the host saw the VM stopped while %s, and marks nothing done (T3)", async (_label, overrides, action) => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf(overrides));
    deps.execute.mockResolvedValue({ ok: false, code: "target_refused", reason: "computer_not_running" });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "interrupted", reason: "computer_not_running" });
    expect(actions(deps.execute)).toEqual([action]);
    expect(store.interrupt).toHaveBeenCalledWith(OWNER, "attach", ID, "computer_not_running");
    expect(store.fail).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("keeps a guest that does not answer held: only a stopped VM or a delete lets the computer go", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ activation: { activationId: ACTIVATION, serviceDefinitionSha256: DEFINITION } }));
    deps.execute.mockResolvedValue({ ok: false, code: "transport_failed" });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "held", reason: "observation_transport_failed" });
    expect(store.interrupt).not.toHaveBeenCalled();
  });

  it("lets the computer go when the stage was sent and the host then saw the VM stopped", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ staged: null }));
    deps.stage.mockResolvedValue({ operationId: ID, state: "held", reason: "computer_not_running" });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "interrupted", reason: "computer_not_running" });
    expect(store.refuse).not.toHaveBeenCalled();
    // The stage was sent in this same pass: the claim read before it is not refused.
    const second = fakes();
    second.store.readState.mockResolvedValueOnce(stateOf({ phase: "claimed", staged: null })).mockResolvedValueOnce(stateOf({ staged: null }));
    second.deps.stage.mockResolvedValue({ operationId: ID, state: "held", reason: "computer_not_running" });
    expect((await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, second.deps)).state).toBe("interrupted");
    expect(second.store.refuse).not.toHaveBeenCalled();
  });

  it("keeps an unconfirmed release held, to be tried again", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ desiredState: "deleted" }));
    store.interrupt.mockResolvedValue(false);
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "held", reason: "interrupt_unconfirmed" });
  });

  it("leaves an interrupted install alone until the computer runs again, free", async () => {
    for (const overrides of [{ computerStatus: "stopped" }, { desiredState: "deleted", interruptReason: "pending_delete" },
      { computerOperationId: OPERATION }]) {
      const { store, deps } = fakes();
      store.readState.mockResolvedValue(stateOf({ leaseReleased: true, interruptReason: "computer_not_running", ...overrides }));
      expect((await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps)).state).toBe("interrupted");
      expect(store.resume).not.toHaveBeenCalled();
      expect(deps.execute).not.toHaveBeenCalled();
    }
  });

  it("takes the computer back for an interrupted install, removes it and ends it failed, never finished", async () => {
    const { store, deps } = fakes();
    store.readState
      .mockResolvedValueOnce(stateOf({ leaseReleased: true, interruptReason: "computer_not_running" }))
      .mockResolvedValueOnce(stateOf({ leaseReleased: false, interruptReason: "computer_not_running" }));
    deps.execute.mockResolvedValue({ ok: true, result: removed });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "failed", reason: "computer_stopped" });
    expect(store.resume).toHaveBeenCalledWith(OWNER, "attach", ID);
    expect(actions(deps.execute)).toEqual(["remove"]);
    expect(store.fail).toHaveBeenCalledWith(expect.objectContaining({ failureCode: "computer_stopped", cleanup: removed }));
    expect(store.dispatchActivation).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    // Stopped again before the cleanup could run: let go again.
    const again = fakes();
    again.store.readState.mockResolvedValue(stateOf({ interruptReason: "computer_not_running" }));
    again.deps.execute.mockResolvedValue({ ok: false, code: "target_refused", reason: "computer_not_running" });
    expect((await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, again.deps)).state).toBe("interrupted");
    expect(again.store.fail).not.toHaveBeenCalled();
  });

  it("holds when staging is not recorded, and turns an error into a held step", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ staged: null }));
    deps.stage.mockResolvedValue({ operationId: ID, state: "held", reason: "guest_unreachable" });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "held", reason: "guest_unreachable" });
    store.readState.mockRejectedValue(new Error("database down"));
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "held", reason: "error" });
  });
});

describe("a refusal the computer names ends the attach as failed, never held (T3, 5.5, 5.8)", () => {
  const activating = { activation: { activationId: ACTIVATION, serviceDefinitionSha256: DEFINITION } };
  const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  const unresolved = (journalPhase: string, state = "activation_unresolved") =>
    ({ ...observation(state), journalPhase, mainPid: undefined });

  it("fails a claim on a computer whose gateway predates attached agents before anything runs, and goes on when it can't tell", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ phase: "claimed", staged: null }));
    deps.gatewayProtocol.mockResolvedValue("update_required");
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "failed", reason: "computer_update_required" });
    expect(deps.gatewayProtocol).toHaveBeenCalledWith(computerRow.chat_url);
    expect(store.refuse).toHaveBeenCalledWith(OWNER, ID, "computer_update_required");
    expect(deps.stage).not.toHaveBeenCalled();
    const unknown = fakes();
    unknown.store.readState.mockResolvedValue(stateOf({ phase: "claimed", staged: null }));
    unknown.deps.gatewayProtocol.mockResolvedValue("unavailable");
    unknown.deps.stage.mockResolvedValue({ operationId: ID, state: "held", reason: "boot_unconfirmed" });
    expect((await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, unknown.deps)).state).toBe("held");
    expect(unknown.store.refuse).not.toHaveBeenCalled();
    expect(unknown.deps.stage).toHaveBeenCalled();
  });

  it.each([
    ["computer_update_required", "computer_update_required"], ["workspace_path_not_plain", "workspace_path_not_plain"],
    ["service_definition_mismatch", "service_definition_mismatch"], ["gateway_group_has_members", "gateway_group_has_members"],
    ["step_refused", "activation_refused"],
  ])("removes what an activation refused with %s left, then fails it with %s and frees the computer", async (refusal, reason) => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf());
    deps.execute.mockResolvedValueOnce({ ok: false, code: "guest_refused", reason: refusal }).mockResolvedValueOnce({ ok: true, result: removed });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps)).toEqual({ kind: "attach", id: ID, state: "failed", reason });
    expect(actions(deps.execute)).toEqual(["activate", "remove"]);
    expect(store.fail).toHaveBeenCalledWith(expect.objectContaining({ failureCode: reason, cleanup: removed }));
    expect(deps.event).toHaveBeenCalledWith(expect.objectContaining({ event: "agent_attach_failed", detail: expect.objectContaining({ reason }) }));
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.interrupt).not.toHaveBeenCalled();
  });

  it("keeps a refused activation held while its cleanup is not observed, and fails it on a later pass once it is", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf());
    deps.execute.mockResolvedValueOnce({ ok: false, code: "guest_refused", reason: "computer_update_required" })
      .mockResolvedValueOnce({ ok: false, code: "transport_failed" });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "held", reason: "cleanup_transport_failed" });
    expect(store.fail).not.toHaveBeenCalled();
    // The next pass only observes; the activation ended without starting, so once its deadlines pass it is removed.
    store.readState.mockResolvedValue(stateOf({ ...activating, activationDispatchedAt: minutesAgo(5) }));
    deps.execute.mockReset().mockResolvedValue({ ok: true, result: { observation: unresolved("preparing"), contract: null } });
    expect((await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps)).reason).toBe("readiness_unconfirmed");
    store.readState.mockResolvedValue(stateOf({ ...activating, activationDispatchedAt: minutesAgo(15) }));
    deps.execute.mockReset().mockResolvedValueOnce({ ok: true, result: { observation: unresolved("preparing"), contract: null } })
      .mockResolvedValueOnce({ ok: true, result: removed });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "failed", reason: "activation_unresolved" });
    expect(actions(deps.execute)).toEqual(["observe", "remove"]);
  });

  it.each([
    ["an activation that crashed after starting", unresolved("start_requested", "process_running"), 15, "activation_unresolved"],
    ["a start failure whose answer was lost", unresolved("start_failed", "service_inactive"), 1, "start_failed"],
  ])("removes %s and fails it", async (_label, observed, minutes, reason) => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ ...activating, activationDispatchedAt: minutesAgo(minutes) }));
    deps.execute.mockResolvedValueOnce({ ok: true, result: { observation: observed, contract: null } }).mockResolvedValueOnce({ ok: true, result: removed });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps)).toEqual({ kind: "attach", id: ID, state: "failed", reason });
    expect(store.fail).toHaveBeenCalledWith(expect.objectContaining({ failureCode: reason }));
  });

  it("keeps Codex that started but does not answer yet held, with no deadline (T3)", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ ...activating, activationDispatchedAt: minutesAgo(120) }));
    deps.execute.mockResolvedValue({ ok: true, result: { observation: observation("process_running"), contract: null } });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "held", reason: "readiness_unconfirmed" });
    expect(actions(deps.execute)).toEqual(["observe"]);
  });

  it("removes an activation on a computer that restarted under it at once, and waits out any other observation refusal", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ ...activating, activationDispatchedAt: minutesAgo(2) }));
    deps.execute.mockResolvedValueOnce({ ok: false, code: "guest_refused", reason: "computer_restarted" }).mockResolvedValueOnce({ ok: true, result: removed });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "failed", reason: "computer_restarted" });
    const other = fakes();
    other.store.readState.mockResolvedValue(stateOf({ ...activating, activationDispatchedAt: minutesAgo(2) }));
    other.deps.execute.mockResolvedValue({ ok: false, code: "guest_refused", reason: "step_refused" });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, other.deps))
      .toEqual({ kind: "attach", id: ID, state: "held", reason: "observation_guest_refused" });
    expect(other.store.fail).not.toHaveBeenCalled();
  });

  it("removes what a stage that ended without a receipt left, then fails it with that reason", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValueOnce(stateOf({ phase: "claimed", staged: null, installation: null }))
      .mockResolvedValueOnce(stateOf({ staged: null, dispatchedAt: minutesAgo(1) }));
    deps.stage.mockResolvedValue({ operationId: ID, state: "refused", reason: "staging_failed" });
    deps.execute.mockResolvedValue({ ok: true, result: removed });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "failed", reason: "staging_failed" });
    expect(actions(deps.execute)).toEqual(["remove"]);
    expect(deps.execute.mock.calls[0][4]).toMatchObject({ action: "remove", installationId: INSTALLATION });
    expect(store.fail).toHaveBeenCalledWith(expect.objectContaining({ failureCode: "staging_failed", cleanup: removed }));
    expect(store.dispatchActivation).not.toHaveBeenCalled();
    // The worker hands the stage's dispatch time to the stager, to judge a stage that left no journal.
    store.readState.mockReset().mockResolvedValue(stateOf({ staged: null, dispatchedAt: minutesAgo(1) }));
    deps.stage.mockResolvedValue({ operationId: ID, state: "held", reason: "staging_unconfirmed" });
    await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps);
    expect(deps.stage).toHaveBeenLastCalledWith(OWNER, ID, "x86_64", { dispatchedAt: minutesAgo(1) });
  });

  it("retries a download the computer refused, then fails the claim as download_failed once the window has passed", async () => {
    const { store, deps } = fakes();
    deps.stage.mockResolvedValue({ operationId: ID, state: "held", reason: "fetch_refused" });
    store.readState.mockResolvedValue(stateOf({ phase: "claimed", staged: null, createdAt: minutesAgo(4) }));
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "held", reason: "fetch_refused" });
    store.readState.mockResolvedValue(stateOf({ phase: "claimed", staged: null, createdAt: minutesAgo(10) }));
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "failed", reason: "download_failed" });
    deps.stage.mockResolvedValue({ operationId: ID, state: "held", reason: "fetch_unconfirmed" });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "failed", reason: "computer_not_ready" });
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("removes an install whose computer came back changed, and fails it as computer_changed", async () => {
    const { store, deps } = fakes();
    store.readState
      .mockResolvedValueOnce(stateOf({ leaseReleased: true, interruptReason: "computer_not_running" }))
      .mockResolvedValueOnce(stateOf({ leaseReleased: false, interruptReason: "computer_changed" }));
    deps.execute.mockResolvedValue({ ok: true, result: removed });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "failed", reason: "computer_changed" });
    expect(actions(deps.execute)).toEqual(["remove"]);
    expect(store.fail).toHaveBeenCalledWith(expect.objectContaining({ failureCode: "computer_changed" }));
  });
});

describe("Change access and Remove", () => {
  function operationOf(kind: "access_change" | "detach", overrides: Record<string, unknown> = {}) {
    return { version: 1, operationId: OPERATION, attachmentId: ID, ownerId: OWNER, kind, phase: "claimed",
      grants: kind === "detach" ? { workspace: true } : { workspace: false }, previousGrants: { workspace: true },
      guestAuthority: { id: SOURCE }, reviewSha256: "c".repeat(64), installationId: INSTALLATION, agentName: "Codex",
      desiredState: "running", computerStatus: "running", createdAt: "2026-09-24T10:00:00Z", ...overrides };
  }
  const attachedState = () => stateOf({ phase: "attached", contractRevision: 1,
    activation: { activationId: ACTIVATION, serviceDefinitionSha256: DEFINITION } });

  it("Remove runs the guest remove once, completes with its receipt and keeps ~/Hivra (T23)", async () => {
    const { store, deps } = fakes();
    store.readOperation.mockResolvedValue(operationOf("detach"));
    store.readState.mockResolvedValue(attachedState());
    deps.execute.mockResolvedValue({ ok: true, result: { ...removed, operationId: OPERATION } });
    expect(await progressAttachmentWork({ kind: "detach", ownerId: OWNER, id: OPERATION, attachmentId: ID }, deps))
      .toEqual({ kind: "detach", id: OPERATION, state: "completed" });
    expect(store.dispatchOperation).toHaveBeenCalledWith(OWNER, OPERATION);
    expect(actions(deps.execute)).toEqual(["remove"]);
    expect(deps.execute.mock.calls[0][4]).toEqual({ version: 1, action: "remove", operationId: OPERATION, installationId: INSTALLATION });
    expect(store.completeOperation).toHaveBeenCalledWith(OWNER, OPERATION, expect.objectContaining({ workspaceTouched: false }));
    expect(deps.event).toHaveBeenCalledWith(expect.objectContaining({ event: "agent_removed", detail: expect.objectContaining({ filesKept: true }) }));
  });

  it("never dispatches a Remove or Change access that could outlast the pass", async () => {
    for (const kind of ["detach", "access_change"] as const) {
      const { store, deps } = fakes();
      store.readOperation.mockResolvedValue(operationOf(kind));
      store.readState.mockResolvedValue(attachedState());
      expect(await progressAttachmentWork({ kind, ownerId: OWNER, id: OPERATION, attachmentId: ID }, { ...deps, deadline: NOW + 300_000 }))
        .toEqual({ kind, id: OPERATION, state: "held", reason: "budget_exhausted" });
      expect(store.dispatchOperation).not.toHaveBeenCalled();
      expect(deps.execute).not.toHaveBeenCalled();
    }
  });

  it("Remove stays held until the computer confirms everything is gone", async () => {
    const { store, deps } = fakes();
    store.readOperation.mockResolvedValue(operationOf("detach", { phase: "dispatched" }));
    store.readState.mockResolvedValue(attachedState());
    deps.execute.mockResolvedValue({ ok: true, result: { ...removed, operationId: OPERATION, state: "unresolved", reason: "mount_busy" } });
    expect((await progressAttachmentWork({ kind: "detach", ownerId: OWNER, id: OPERATION, attachmentId: ID }, deps)).reason).toBe("mount_busy");
    expect(store.dispatchOperation).not.toHaveBeenCalled();
    expect(store.completeOperation).not.toHaveBeenCalled();
  });

  it.each([
    ["detach", "remove"],
    ["access_change", "access"],
  ] as const)("a %s the computer stopped under lets the computer go, and marks nothing done (T3)", async (kind, action) => {
    const { store, deps } = fakes();
    store.readOperation.mockResolvedValue(operationOf(kind));
    store.readState.mockResolvedValue(attachedState());
    deps.execute.mockResolvedValue({ ok: false, code: "target_refused", reason: "computer_not_running" });
    expect(await progressAttachmentWork({ kind, ownerId: OWNER, id: OPERATION, attachmentId: ID }, deps))
      .toEqual({ kind, id: OPERATION, state: "interrupted", reason: "computer_not_running" });
    expect(actions(deps.execute)).toEqual([action]);
    expect(store.interrupt).toHaveBeenCalledWith(OWNER, kind, OPERATION, "computer_not_running");
    expect(store.completeOperation).not.toHaveBeenCalled();
    expect(store.failOperation).not.toHaveBeenCalled();
  });

  it("a Remove sent before a delete was asked for lets the computer go to the delete", async () => {
    const { store, deps } = fakes();
    store.readOperation.mockResolvedValue(operationOf("detach", { phase: "dispatched", desiredState: "deleted" }));
    store.readState.mockResolvedValue(attachedState());
    expect(await progressAttachmentWork({ kind: "detach", ownerId: OWNER, id: OPERATION, attachmentId: ID }, deps))
      .toEqual({ kind: "detach", id: OPERATION, state: "interrupted", reason: "pending_delete" });
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("an interrupted Remove waits for the computer, then takes it back and runs again to finish", async () => {
    const { store, deps } = fakes();
    store.readOperation.mockResolvedValue(operationOf("detach", { phase: "dispatched", leaseReleased: true,
      interruptReason: "computer_not_running", computerStatus: "stopped" }));
    store.readState.mockResolvedValue(attachedState());
    expect((await progressAttachmentWork({ kind: "detach", ownerId: OWNER, id: OPERATION, attachmentId: ID }, deps)).state).toBe("interrupted");
    expect(store.resume).not.toHaveBeenCalled();
    store.readOperation
      .mockResolvedValueOnce(operationOf("detach", { phase: "dispatched", leaseReleased: true, interruptReason: "computer_not_running" }))
      .mockResolvedValueOnce(operationOf("detach", { phase: "dispatched", interruptReason: "computer_not_running" }));
    deps.execute.mockResolvedValue({ ok: true, result: { ...removed, operationId: OPERATION } });
    expect(await progressAttachmentWork({ kind: "detach", ownerId: OWNER, id: OPERATION, attachmentId: ID }, deps))
      .toEqual({ kind: "detach", id: OPERATION, state: "completed" });
    expect(store.resume).toHaveBeenCalledWith(OWNER, "detach", OPERATION);
    expect(store.dispatchOperation).not.toHaveBeenCalled();
    expect(actions(deps.execute)).toEqual(["remove"]);
  });

  it("cancels a step on a computer that stopped, without touching it", async () => {
    const { store, deps } = fakes();
    store.readOperation.mockResolvedValue(operationOf("access_change", { computerStatus: "stopped" }));
    store.readState.mockResolvedValue(attachedState());
    expect(await progressAttachmentWork({ kind: "access_change", ownerId: OWNER, id: OPERATION, attachmentId: ID }, deps))
      .toEqual({ kind: "access_change", id: OPERATION, state: "cancelled" });
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("Change access sends the new and previous grants once, then records the next contract revision", async () => {
    const { store, deps } = fakes();
    store.readOperation.mockResolvedValue(operationOf("access_change"));
    store.readState.mockResolvedValue(attachedState());
    deps.execute.mockResolvedValue({ ok: true, result: { version: 1, operationId: OPERATION, installationId: INSTALLATION, state: "ready",
      grants: { workspace: false }, viewMounted: false, contract: { sha256: "e".repeat(64), checked: true } } });
    expect(await progressAttachmentWork({ kind: "access_change", ownerId: OWNER, id: OPERATION, attachmentId: ID }, deps))
      .toEqual({ kind: "access_change", id: OPERATION, state: "completed" });
    expect(actions(deps.execute)).toEqual(["access"]);
    expect(deps.execute.mock.calls[0][4]).toMatchObject({ grants: { workspace: false }, previousGrants: { workspace: true }, instanceToken: TOKEN });
    expect(deps.execute.mock.calls[0][4].agentsMd).toContain("has not shared their Hivra folder with you");
    expect(store.recordContract).toHaveBeenCalledWith(expect.objectContaining({ revision: 2, grants: { workspace: false },
      readback: { sha256: "e".repeat(64), checked: true } }));
    expect(store.completeOperation.mock.calls[0][2]).not.toHaveProperty("contract");
    expect(deps.event).toHaveBeenCalledWith(expect.objectContaining({ event: "agent_access_changed" }));
  });

  it("records a refused or restored change as failed with its reason", async () => {
    const { store, deps } = fakes();
    store.readOperation.mockResolvedValue(operationOf("access_change"));
    store.readState.mockResolvedValue(attachedState());
    deps.execute.mockResolvedValue({ ok: true, result: { version: 1, operationId: OPERATION, installationId: INSTALLATION, state: "refused",
      reason: "workspace_path_not_plain" } });
    expect(await progressAttachmentWork({ kind: "access_change", ownerId: OWNER, id: OPERATION, attachmentId: ID }, deps))
      .toEqual({ kind: "access_change", id: OPERATION, state: "failed", reason: "workspace_path_not_plain" });
    expect(store.completeOperation).not.toHaveBeenCalled();
  });

  it.each([
    ["access_change", "claimed", "staged_installation_mismatch", "staged_installation_mismatch"],
    ["detach", "claimed", "detach_mount_found", "detach_mount_found"],
    ["detach", "dispatched", "step_refused", "remove_refused"],
  ] as const)("ends a %s the computer refused (%s, %s) as failed with %s and frees the computer (T3)", async (kind, phase, refusal, reason) => {
    const { store, deps } = fakes();
    store.readOperation.mockResolvedValue(operationOf(kind, { phase }));
    store.readState.mockResolvedValue(attachedState());
    deps.execute.mockResolvedValue({ ok: false, code: "guest_refused", reason: refusal });
    expect(await progressAttachmentWork({ kind, ownerId: OWNER, id: OPERATION, attachmentId: ID }, deps))
      .toEqual({ kind, id: OPERATION, state: "failed", reason });
    expect(store.failOperation).toHaveBeenCalledWith(OWNER, OPERATION, reason,
      { version: 1, operationId: OPERATION, installationId: INSTALLATION, state: "refused", reason });
    expect(store.completeOperation).not.toHaveBeenCalled();
    expect(store.interrupt).not.toHaveBeenCalled();
  });

  it("after a lost answer only looks, and finishes by what the computer shows", async () => {
    const { store, deps } = fakes();
    store.readOperation.mockResolvedValue(operationOf("access_change", { phase: "dispatched" }));
    store.readState.mockResolvedValue(attachedState());
    const look = (workspace: boolean) => ({ ok: true, result: { version: 1, operationId: OPERATION, installationId: INSTALLATION,
      accountPresent: true, unitsPresent: true, workspace, viewMounted: workspace, agentActive: true, chatReady: true } });
    const item = { kind: "access_change" as const, ownerId: OWNER, id: OPERATION, attachmentId: ID };

    deps.execute.mockResolvedValueOnce(look(false));
    expect(await progressAttachmentWork(item, deps)).toEqual({ kind: "access_change", id: OPERATION, state: "completed" });
    deps.execute.mockResolvedValueOnce(look(true));
    expect(await progressAttachmentWork(item, deps)).toEqual({ kind: "access_change", id: OPERATION, state: "failed", reason: "change_unconfirmed" });
    deps.execute.mockResolvedValueOnce({ ok: true, result: { ...look(false).result, chatReady: false } });
    expect(await progressAttachmentWork(item, deps)).toEqual({ kind: "access_change", id: OPERATION, state: "held", reason: "access_unconfirmed" });

    expect(actions(deps.execute)).toEqual(["state", "state", "state"]);
    expect(store.dispatchOperation).not.toHaveBeenCalled();
  });

  it("returns a finished step as it is, without touching the computer", async () => {
    const { store, deps } = fakes();
    store.readOperation.mockResolvedValue(operationOf("detach", { phase: "completed" }));
    expect(await progressAttachmentWork({ kind: "detach", ownerId: OWNER, id: OPERATION, attachmentId: ID }, deps))
      .toEqual({ kind: "detach", id: OPERATION, state: "completed" });
    expect(store.readState).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });
});

describe("the pass deadline", () => {
  it("never grants an activation, Change access or Remove that could outlast the pass, and a later pass starts it", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ phase: "dispatched", activation: null }));
    // 10 minutes left: less than an activation's worst case (620 s).
    const short = { ...deps, deadline: NOW + 600_000 };
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, short))
      .toEqual({ kind: "attach", id: ID, state: "held", reason: "budget_exhausted" });
    expect(store.dispatchActivation).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
    // The stage call carries the same deadline down to the staging steps.
    store.readState.mockResolvedValue(stateOf({ phase: "claimed", staged: null }));
    deps.stage.mockResolvedValue({ operationId: ID, state: "held", reason: "budget_exhausted" });
    await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, short);
    expect(deps.stage).toHaveBeenLastCalledWith(OWNER, ID, "x86_64", { deadline: NOW + 600_000, now: deps.now, dispatchedAt: null });
  });
});
