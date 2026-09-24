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
  };
  const deps = {
    store: store as never,
    loadComputer: jest.fn().mockResolvedValue(computerRow),
    hostAddresses: jest.fn().mockResolvedValue(["203.0.113.7"]),
    stage: jest.fn(),
    execute: jest.fn(),
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
    expect(deps.stage).toHaveBeenCalledWith(OWNER, ID, "x86_64");
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

  it("cleans up instead of starting Codex when the computer is deleted after staging", async () => {
    const { store, deps } = fakes();
    store.readState.mockResolvedValue(stateOf({ desiredState: "deleted" }));
    deps.execute.mockResolvedValue({ ok: true, result: removed });
    expect(await progressAttachmentWork({ kind: "attach", ownerId: OWNER, id: ID }, deps))
      .toEqual({ kind: "attach", id: ID, state: "failed", reason: "pending_delete" });
    expect(actions(deps.execute)).toEqual(["remove"]);
    expect(store.dispatchActivation).not.toHaveBeenCalled();
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
    expect(deps.stage).toHaveBeenLastCalledWith(OWNER, ID, "x86_64", { deadline: NOW + 600_000, now: deps.now });
  });
});
