import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { supabaseAdmin } from "@/lib/supabase";
import { hivraInfrastructureBindingTag } from "@/lib/hivra/agent-authority";
import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import { log } from "@/lib/logger";
import { ATTACHED_SERVICE_POLICY_V2_SHA256 } from "./attach-review";
import { ATTACHED_AGENT_PROGRAM_SHA256, ATTACHED_AGENT_TIMEOUTS, executeAttachedAgentStep, type AttachedAccessResult,
  type AttachedActivationResult, type AttachedAgentAction, type AttachedAgentTarget, type AttachedRemoveResult,
  type AttachedStateResult } from "./attached-agent-host";
import { attachedAccessPacket, attachedActivatePacket, attachedObservePacket, attachedRemovePacket,
  attachedStatePacket, type AttachedPacketInput } from "./attached-agent-packet";
import { progressAttachmentStaging } from "./attachment-staging-coordinator";
import { createAttachmentLifecycleStore, type AttachmentInterruptReason, type AttachmentLifecycleStore, type AttachmentState,
  type AttachmentWorkItem } from "./attachment-lifecycle-store";

// The minute worker's one pass over one open attach step (design 5.5): the
// claim through staging and activation to "Chat is ready", and each Change
// access and Remove. Every guest step runs only after this pass won its
// database compare-and-swap; a lost answer is followed by a read-only look,
// never by a blind second install. Anything uncertain stays held, and the
// computer page says so. A step already sent to the computer lets the computer
// go when the host saw the VM stopped (nothing of it can still run there) or
// when the owner asked to delete the computer (the delete destroys the VM):
// the step stays open, and comes back to be finished by what the computer
// shows once the computer runs again (T3).

const COMPUTER_COLUMNS = "id, user_id, name, type, cpu, ram, status, desired_state, operation_id, operation_kind, vmid, ip, chat_url, provisioned_at, "
  + "computer_profile, computer_substrate, deployment_mode, proxmox_host, infrastructure_connection_id, deployment_target_id, "
  + "infrastructure_connection_revision, infrastructure_binding_token_hash, infrastructure_binding_token_enforced, "
  + "managed_provisioner_channel";

type ComputerRow = RemoteDesktopAgentRow & { name: string; cpu: number | null; ram: number | null; provisioned_at?: string | null };

/** A guest that has not answered Hivra for this long since the claim is not ready: the attach fails with that reason. */
export const ATTACH_GUEST_ANSWER_WINDOW_MS = 3 * 60_000;

type Precondition = "computer_not_running" | "computer_not_ready";

/** Running and ready, from the computer's own row (5.8): anything else refuses the attach before it starts. */
export function attachPrecondition(computer: Pick<ComputerRow, "status" | "vmid" | "ip" | "chat_url" | "provisioned_at">,
  desiredState: string | null): Precondition | null {
  if (computer.status !== "running" || desiredState !== "running" || computer.vmid == null || !computer.ip) return "computer_not_running";
  if (!computer.provisioned_at || typeof computer.chat_url !== "string" || !computer.chat_url.trim()) return "computer_not_ready";
  return null;
}

export type AttachmentWorkProgress = {
  kind: AttachmentWorkItem["kind"]; id: string;
  /** interrupted: the computer was let go and the step waits for it (T3). */
  state: "attached" | "failed" | "cancelled" | "completed" | "held" | "progressing" | "interrupted";
  reason?: string;
};

type Dependencies = {
  store: AttachmentLifecycleStore;
  loadComputer: (ownerId: string, sourceId: string) => Promise<ComputerRow | null>;
  hostAddresses: (ownerId: string, computer: ComputerRow) => Promise<string[]>;
  stage: typeof progressAttachmentStaging;
  execute: typeof executeAttachedAgentStep;
  uuid: () => string;
  token: () => string;
  event: typeof logHivraAgentEvent;
  now: () => number;
  /** The pass's own deadline (epoch ms): a host step that could outlast it is not started. */
  deadline: number;
};

async function loadComputer(ownerId: string, sourceId: string): Promise<ComputerRow | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.from("hivra_agents").select(COMPUTER_COLUMNS)
    .eq("id", sourceId).eq("user_id", ownerId).maybeSingle();
  if (error || !data) return null;
  return data as unknown as ComputerRow;
}

/** The Proxmox host's own addresses as Hivra records them; the guest cannot learn them. */
async function hostAddresses(ownerId: string, computer: ComputerRow): Promise<string[]> {
  try {
    const context = await resolveHivraAgentExecutionContext(ownerId, computer);
    const env = context.env as Record<string, string | undefined>;
    return [...new Set([env.PROXMOX_PUBLIC_IP, env.PROXMOX_SSH_HOST].filter((value): value is string =>
      typeof value === "string" && isIP(value.trim()) !== 0).map((value) => value.trim()))].slice(0, 8);
  } catch {
    return [];
  }
}

function defaults(overrides: Partial<Dependencies>): Dependencies {
  return {
    store: createAttachmentLifecycleStore(), loadComputer, hostAddresses, stage: progressAttachmentStaging,
    execute: executeAttachedAgentStep, uuid: randomUUID, token: () => randomBytes(32).toString("hex"),
    event: logHivraAgentEvent, now: Date.now, deadline: Number.POSITIVE_INFINITY, ...overrides,
  };
}

function target(computer: ComputerRow, operationId: string, computerId: string, architecture: "x86_64" | "aarch64"): AttachedAgentTarget | null {
  const hash = computer.infrastructure_binding_token_hash;
  if (typeof hash !== "string" || computer.vmid == null || !computer.ip) return null;
  try {
    return { operationId, computerId, sourceId: computer.id, vmid: computer.vmid, guestIp: computer.ip,
      bindingTag: hivraInfrastructureBindingTag(hash), architecture };
  } catch { return null; }
}

function stagedIds(state: AttachmentState): { uid: number; gid: number } | null {
  const receipt = (state.staged as { receipt?: { uid?: unknown; gid?: unknown } } | null)?.receipt;
  return receipt && Number.isSafeInteger(receipt.uid) && Number.isSafeInteger(receipt.gid)
    ? { uid: receipt.uid as number, gid: receipt.gid as number } : null;
}

function packetInput(state: AttachmentState, computer: ComputerRow, ids: { uid: number; gid: number },
  operationId: string, grants: { workspace: boolean }, revision: number): AttachedPacketInput {
  return {
    operationId, installationId: state.installation!.installationId, bootId: null, uid: ids.uid, gid: ids.gid,
    agentName: state.agentName,
    computer: { name: computer.name, cpu: Number(computer.cpu) || 1, ramGb: Number(computer.ram) || 1,
      deploymentMode: computer.deployment_mode as string | null, deployment_mode: computer.deployment_mode as string | null,
      computer_substrate: computer.computer_substrate as string | null },
    grants, contractRevision: revision,
  };
}

/** Whether a host step with this worst-case duration can finish inside the pass.
 * Checked before each dispatch compare-and-swap, so a step is never granted and
 * then left unstarted; a later pass starts it. */
const fits = (deps: Dependencies, action: AttachedAgentAction) => deps.now() + ATTACHED_AGENT_TIMEOUTS[action].hostMs <= deps.deadline;

/** A held step's reason: the host's refusal when it gave one, else the transport code. */
const stepCode = (result: { code: string; reason?: string }) => result.code === "target_refused" && result.reason ? result.reason : result.code;

/** The host, under its allocation lock, saw the VM not running: nothing of the step can run in it now. */
const vmStopped = (result: { ok: boolean; code?: string; reason?: string }) =>
  !result.ok && result.code === "target_refused" && result.reason === "computer_not_running";

type LetGo = (reason: AttachmentInterruptReason) => Promise<AttachmentWorkProgress>;

/** Release the computer from a step that was sent to it; the step stays open. */
function letGoOf(ownerId: string, kind: AttachmentWorkItem["kind"], id: string, deps: Dependencies): LetGo {
  return async (reason) => {
    if (!await deps.store.interrupt(ownerId, kind, id, reason)) return { kind, id, state: "held", reason: "interrupt_unconfirmed" };
    log.info("attached agent step let its computer go", { source: "agent-computers/attachment-worker",
      failureType: "attachment_step_interrupted", kind, operationId: id, reason });
    return { kind, id, state: "interrupted", reason };
  };
}

/** Whether Hivra's record shows the computer running, wanted running and free again. */
const computerBack = (step: { desiredState: string | null; computerStatus: string | null; computerOperationId?: string | null }) =>
  step.desiredState === "running" && step.computerStatus === "running" && !step.computerOperationId;

const grantsLabel = (grants: { workspace: boolean }) => grants.workspace ? "~/Hivra read and write, internet" : "internet, no shared folder";

/** One pass over one attach: staging, activation, readiness, completion. */
async function progressAttach(ownerId: string, id: string, deps: Dependencies): Promise<AttachmentWorkProgress> {
  const held = (reason: string): AttachmentWorkProgress => ({ kind: "attach", id, state: "held", reason });
  let state = await deps.store.readState(ownerId, id);
  if (!state) return held("state_unavailable");
  if (state.phase === "attached") return { kind: "attach", id, state: "attached" };
  if (!["claimed", "dispatched"].includes(state.phase)) return { kind: "attach", id, state: state.phase === "failed" ? "failed" : "cancelled" };
  const computer = await deps.loadComputer(ownerId, state.sourceId);
  if (!computer) return held("computer_unavailable");
  const architecture = "x86_64" as const;
  const letGo = letGoOf(ownerId, "attach", id, deps);

  // A step that let its computer go waits for it, then takes it back (T3).
  if (state.leaseReleased) {
    if (!computerBack(state)) return { kind: "attach", id, state: "interrupted", reason: state.interruptReason ?? "computer_not_running" };
    if (!await deps.store.resume(ownerId, "attach", id)) return held("resume_unconfirmed");
    state = await deps.store.readState(ownerId, id);
    if (!state || state.phase !== "dispatched" || state.leaseReleased) return held("state_unavailable");
  }
  // A pending delete wins over a step already sent: the delete destroys the VM
  // and whatever the step did in it.
  if (state.phase === "dispatched" && state.desiredState === "deleted") return await letGo("pending_delete");
  // An install the computer stopped under is removed, never finished.
  if (state.phase === "dispatched" && state.interruptReason) {
    const back = state.installation && target(computer, id, state.computerId, state.installation.architecture);
    if (!back) return held("state_unavailable");
    return await cleanUpAndFail(ownerId, state, computer, back, "computer_stopped", deps, letGo);
  }

  // Nothing ran on the computer while the claim is undispatched. A pending
  // delete cancels it; a computer that is not running and ready refuses it:
  // failed with that reason, never held (5.5, 5.8).
  const refuse = async (reason: Precondition): Promise<AttachmentWorkProgress> => {
    if (!await deps.store.refuse(ownerId, id, reason)) return held("failure_unconfirmed");
    await deps.event({ userId: ownerId, event: "agent_attach_failed", agentId: computer.id, agentType: computer.type as string,
      detail: { attachmentId: id, agentName: state!.agentName, computerName: computer.name, reason } });
    return { kind: "attach", id, state: "failed", reason };
  };
  if (state.phase === "claimed") {
    if (state.desiredState === "deleted") {
      return await deps.store.cancel(ownerId, id, "pending_delete")
        ? { kind: "attach", id, state: "cancelled", reason: "pending_delete" } : held("cancel_unconfirmed");
    }
    const precondition = attachPrecondition(computer, state.desiredState);
    if (precondition) return await refuse(precondition);
  }
  if (!state.staged) {
    const staged = Number.isFinite(deps.deadline)
      ? await deps.stage(ownerId, id, architecture, { deadline: deps.deadline, now: deps.now })
      : await deps.stage(ownerId, id, architecture);
    if (staged.state !== "staging_recorded") {
      // After the stage dispatch (in an earlier pass or this one) a stopped VM
      // or a pending delete lets the computer go.
      if (staged.reason === "computer_not_running" || staged.reason === "pending_delete") {
        const latest = state.phase === "dispatched" ? state : await deps.store.readState(ownerId, id);
        if (latest?.phase === "dispatched") return await letGo(staged.reason);
      }
      // The host refused the VM before anything ran in it: failed, with why.
      if ((staged.reason === "computer_not_running" || staged.reason === "computer_not_ready") && state.phase === "claimed") {
        return await refuse(staged.reason);
      }
      // The guest never answered: once the window has passed it is not ready.
      const claimedAt = state.createdAt ? Date.parse(state.createdAt) : Number.NaN;
      if (staged.reason === "boot_unobserved" && state.phase === "claimed" && Number.isFinite(claimedAt)
        && deps.now() - claimedAt >= ATTACH_GUEST_ANSWER_WINDOW_MS) return await refuse("computer_not_ready");
      return held(staged.reason);
    }
    state = await deps.store.readState(ownerId, id);
    if (!state || state.phase !== "dispatched" || !state.staged) return held("state_unavailable");
  }
  const ids = stagedIds(state);
  const hostTarget = state.installation && target(computer, id, state.computerId, state.installation.architecture);
  if (!ids || !hostTarget || !state.bootId || !state.grants) return held("state_unavailable");
  const grants = state.grants;

  let result: AttachedActivationResult | null = null;
  if (!state.activation) {
    if (state.desiredState !== "running") return held("computer_not_wanted");
    if (!fits(deps, "activate")) return held("budget_exhausted");
    const token = deps.token();
    const built = attachedActivatePacket({ ...packetInput(state, computer, ids, id, grants, 1), bootId: state.bootId,
      activationId: deps.uuid(), instanceToken: token, hostAddresses: await deps.hostAddresses(ownerId, computer) });
    const granted = await deps.store.dispatchActivation({ ownerId, operationId: id, activationId: built.packet.activationId,
      generation: state.generation, authority: state.guestAuthority, bootId: state.bootId, staged: state.staged,
      servicePolicySha256: ATTACHED_SERVICE_POLICY_V2_SHA256, programSha256: ATTACHED_AGENT_PROGRAM_SHA256,
      serviceDefinitionSha256: built.serviceDefinitionSha256, instanceToken: token });
    // Only a fresh true from this pass starts Codex. A lost answer is read back
    // and then only observed.
    if (!granted) return held("activation_unconfirmed");
    const started = await deps.execute(ownerId, computer, "activate", hostTarget, built.packet);
    if (!started.ok) return vmStopped(started) ? await letGo("computer_not_running") : held("activation_" + stepCode(started));
    result = started.result as AttachedActivationResult;
    state = await deps.store.readState(ownerId, id);
    if (!state?.activation) return held("state_unavailable");
    await recordContract(ownerId, id, 1, built.contract, grants, result.contract, deps);
  } else {
    const token = await deps.store.readInstanceToken(ownerId, id);
    const activation = state.activation as { activationId?: string; serviceDefinitionSha256?: string };
    if (!token || !activation.activationId || !activation.serviceDefinitionSha256) return held("activation_unavailable");
    if (!fits(deps, "observe")) return held("budget_exhausted");
    const observed = await deps.execute(ownerId, computer, "observe", hostTarget, attachedObservePacket({ operationId: id,
      activationId: activation.activationId, installationId: state.installation!.installationId, bootId: state.bootId,
      serviceDefinitionSha256: activation.serviceDefinitionSha256, instanceToken: token }).packet);
    if (!observed.ok) return vmStopped(observed) ? await letGo("computer_not_running") : held("observation_" + stepCode(observed));
    result = observed.result as AttachedActivationResult;
    if (result.contract) {
      const built = attachedActivatePacket({ ...packetInput(state, computer, ids, id, grants, 1), bootId: state.bootId,
        activationId: activation.activationId, instanceToken: token, hostAddresses: [] });
      await recordContract(ownerId, id, 1, built.contract, grants, result.contract, deps);
    }
  }

  const observationId = deps.uuid();
  if (!await deps.store.recordObservation({ ownerId, operationId: id, generation: state.generation,
    authority: state.guestAuthority, request: state.activation, observationId, result: result.observation })) {
    return held("observation_unrecorded");
  }
  if (result.observation.state === "native_protocol_available") {
    if (!await deps.store.complete({ ownerId, operationId: id, generation: state.generation, authority: state.guestAuthority, observationId })) {
      return held("completion_unconfirmed");
    }
    await deps.event({ userId: ownerId, event: "agent_attached", agentId: computer.id, agentType: computer.type as string,
      detail: { attachmentId: id, agentName: state.agentName, computerName: computer.name, access: grantsLabel(grants) } });
    return { kind: "attach", id, state: "attached" };
  }
  if (result.failure) return await cleanUpAndFail(ownerId, state, computer, hostTarget, result.failure, deps, letGo);
  return held("readiness_unconfirmed");
}

async function recordContract(ownerId: string, attachmentId: string, revision: number,
  contract: { contract: string; contractSha256: string; fileSha256: string }, grants: { workspace: boolean },
  readback: { sha256: string; checked: boolean } | null | undefined, deps: Dependencies) {
  try {
    await deps.store.recordContract({ ownerId, attachmentId, revision, content: contract.contract, contentSha256: contract.contractSha256,
      fileSha256: contract.fileSha256, grants, readback: readback ?? null });
  } catch (error) {
    log.warn("attached agent contract receipt was not recorded", { source: "agent-computers/attachment-worker",
      failureType: "attachment_contract_unrecorded", attachmentId }, error);
  }
}

/** A failed install is removed from the computer first; only an observed cleanup ends it. */
async function cleanUpAndFail(ownerId: string, state: AttachmentState, computer: ComputerRow, hostTarget: AttachedAgentTarget,
  failureCode: string, deps: Dependencies, letGo: LetGo): Promise<AttachmentWorkProgress> {
  const held = (reason: string): AttachmentWorkProgress => ({ kind: "attach", id: state.id, state: "held", reason });
  if (!fits(deps, "remove")) return held("budget_exhausted");
  const cleaned = await deps.execute(ownerId, computer, "remove", hostTarget,
    attachedRemovePacket({ operationId: state.id, installationId: state.installation!.installationId }).packet);
  if (!cleaned.ok) return vmStopped(cleaned) ? await letGo("computer_not_running") : held("cleanup_" + stepCode(cleaned));
  const receipt = cleaned.result as AttachedRemoveResult;
  if (receipt.state !== "removed") return held("cleanup_unresolved");
  if (!await deps.store.fail({ ownerId, operationId: state.id, generation: state.generation, authority: state.guestAuthority,
    cleanup: receipt as unknown as Record<string, unknown>, failureCode })) return held("failure_unconfirmed");
  await deps.event({ userId: ownerId, event: "agent_attach_failed", agentId: computer.id, agentType: computer.type as string,
    detail: { attachmentId: state.id, agentName: state.agentName, computerName: computer.name, reason: failureCode } });
  return { kind: "attach", id: state.id, state: "failed", reason: failureCode };
}

/** One pass over one Change access or Remove step. */
async function progressOperation(item: Extract<AttachmentWorkItem, { kind: "access_change" | "detach" }>, deps: Dependencies):
Promise<AttachmentWorkProgress> {
  const { ownerId, id, kind } = item;
  const held = (reason: string): AttachmentWorkProgress => ({ kind, id, state: "held", reason });
  let operation = await deps.store.readOperation(ownerId, id);
  if (!operation) return held("state_unavailable");
  if (["completed", "failed", "cancelled"].includes(operation.phase)) {
    return { kind, id, state: operation.phase === "completed" ? "completed" : operation.phase === "failed" ? "failed" : "cancelled" };
  }
  const letGo = letGoOf(ownerId, kind, id, deps);
  // A step that let its computer go waits for it, then takes it back and
  // finishes by what the computer shows (T3).
  if (operation.leaseReleased) {
    if (!computerBack(operation)) return { kind, id, state: "interrupted", reason: operation.interruptReason ?? "computer_not_running" };
    if (!await deps.store.resume(ownerId, kind, id)) return held("resume_unconfirmed");
    operation = await deps.store.readOperation(ownerId, id);
    if (!operation || operation.phase !== "dispatched" || operation.leaseReleased) return held("state_unavailable");
  }
  if (operation.phase === "dispatched" && operation.desiredState === "deleted") return await letGo("pending_delete");
  const state = await deps.store.readState(ownerId, operation.attachmentId);
  if (!state || state.phase !== "attached" || !state.installation) return held("state_unavailable");
  const computer = await deps.loadComputer(ownerId, state.sourceId);
  if (!computer) return held("computer_unavailable");
  const hostTarget = target(computer, id, state.computerId, state.installation.architecture);
  const ids = stagedIds(state);
  if (!hostTarget || !ids) return held("state_unavailable");
  const token = await deps.store.readInstanceToken(ownerId, operation.attachmentId);

  let fresh = false;
  if (operation.phase === "claimed") {
    if (operation.desiredState !== "running" || operation.computerStatus !== "running") {
      return await deps.store.cancelOperation(ownerId, id) ? { kind, id, state: "cancelled" } : held("cancel_unconfirmed");
    }
    if (!fits(deps, kind === "detach" ? "remove" : "access")) return held("budget_exhausted");
    if (!await deps.store.dispatchOperation(ownerId, id)) return held("dispatch_unconfirmed");
    fresh = true;
  }

  if (!fresh && !fits(deps, kind === "detach" ? "remove" : "state")) return held("budget_exhausted");
  if (kind === "detach") {
    // Remove converges: each step removes only what is still there, so a
    // pass that lost the previous answer runs it again to observe the end state.
    const removed = await deps.execute(ownerId, computer, "remove", hostTarget,
      attachedRemovePacket({ operationId: id, installationId: state.installation.installationId }).packet);
    if (!removed.ok) return vmStopped(removed) ? await letGo("computer_not_running") : held("remove_" + stepCode(removed));
    const receipt = removed.result as AttachedRemoveResult;
    if (receipt.state !== "removed") return held(receipt.reason ?? "remove_unresolved");
    if (!await deps.store.completeOperation(ownerId, id, receipt as unknown as Record<string, unknown>)) return held("completion_unconfirmed");
    await deps.event({ userId: ownerId, event: "agent_removed", agentId: computer.id, agentType: computer.type as string,
      detail: { attachmentId: operation.attachmentId, agentName: state.agentName, computerName: computer.name, filesKept: true } });
    return { kind, id, state: "completed" };
  }

  if (!token) return held("token_unavailable");
  const revision = (state.contractRevision ?? 1) + 1;
  const input = packetInput(state, computer, ids, id, operation.grants, revision);
  if (fresh) {
    const built = attachedAccessPacket({ ...input, instanceToken: token, previousGrants: operation.previousGrants });
    const changed = await deps.execute(ownerId, computer, "access", hostTarget, built.packet);
    if (!changed.ok) return vmStopped(changed) ? await letGo("computer_not_running") : held("access_" + stepCode(changed));
    const receipt = changed.result as AttachedAccessResult;
    return await finishAccess(ownerId, id, operation.attachmentId, receipt, built.contract, revision, operation.grants, computer, state, deps);
  }
  // The answer to a dispatched change was lost: look, never change again.
  const looked = await deps.execute(ownerId, computer, "state", hostTarget,
    attachedStatePacket({ operationId: id, installationId: state.installation.installationId, instanceToken: token }).packet);
  if (!looked.ok) return vmStopped(looked) ? await letGo("computer_not_running") : held("state_" + stepCode(looked));
  const observed = looked.result as AttachedStateResult;
  const built = attachedAccessPacket({ ...input, instanceToken: token, previousGrants: operation.previousGrants });
  if (observed.chatReady && observed.workspace === operation.grants.workspace && observed.viewMounted === operation.grants.workspace) {
    return await finishAccess(ownerId, id, operation.attachmentId, { version: 1, operationId: id,
      installationId: state.installation.installationId, state: "ready", grants: operation.grants, viewMounted: observed.viewMounted },
    built.contract, revision, operation.grants, computer, state, deps);
  }
  if (observed.chatReady && observed.workspace === operation.previousGrants.workspace
    && observed.viewMounted === operation.previousGrants.workspace) {
    return await finishAccess(ownerId, id, operation.attachmentId, { version: 1, operationId: id,
      installationId: state.installation.installationId, state: "restored", reason: "change_unconfirmed",
      viewMounted: observed.viewMounted }, built.contract, revision, operation.grants, computer, state, deps);
  }
  return held("access_unconfirmed");
}

async function finishAccess(ownerId: string, id: string, attachmentId: string, receipt: AttachedAccessResult,
  contract: { contract: string; contractSha256: string; fileSha256: string }, revision: number, grants: { workspace: boolean },
  computer: ComputerRow, state: AttachmentState, deps: Dependencies): Promise<AttachmentWorkProgress> {
  const held = (reason: string): AttachmentWorkProgress => ({ kind: "access_change", id, state: "held", reason });
  if (receipt.state === "ready") {
    await recordContract(ownerId, attachmentId, revision, contract, grants, receipt.contract, deps);
    const { contract: _readback, ...stored } = receipt;
    void _readback;
    if (!await deps.store.completeOperation(ownerId, id, stored as unknown as Record<string, unknown>)) return held("completion_unconfirmed");
    await deps.event({ userId: ownerId, event: "agent_access_changed", agentId: computer.id, agentType: computer.type as string,
      detail: { attachmentId, agentName: state.agentName, computerName: computer.name, access: grantsLabel(grants) } });
    return { kind: "access_change", id, state: "completed" };
  }
  if (receipt.state === "restored" || receipt.state === "refused") {
    const code = /^[a-z][a-z0-9_]{0,63}$/.test(receipt.reason ?? "") ? receipt.reason! : "change_failed";
    const { contract: _readback, ...stored } = receipt;
    void _readback;
    return await deps.store.failOperation(ownerId, id, code, stored as unknown as Record<string, unknown>)
      ? { kind: "access_change", id, state: "failed", reason: code } : held("failure_unconfirmed");
  }
  return held(receipt.reason ?? "access_unresolved");
}

/** One pass over one open work item. Never throws: an error is a held step. */
export async function progressAttachmentWork(item: AttachmentWorkItem, overrides: Partial<Dependencies> = {}): Promise<AttachmentWorkProgress> {
  const deps = defaults(overrides);
  try {
    return item.kind === "attach" ? await progressAttach(item.ownerId, item.id, deps) : await progressOperation(item, deps);
  } catch (error) {
    log.warn("attached agent step held after an error", { source: "agent-computers/attachment-worker",
      failureType: "attachment_step_error", kind: item.kind, operationId: item.id }, error);
    return { kind: item.kind, id: item.id, state: "held", reason: "error" };
  }
}

export type { AttachedAgentAction };
