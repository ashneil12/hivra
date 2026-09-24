import "server-only";

import { randomUUID } from "node:crypto";
import { createAttachmentExecutionStore, type AttachmentExecutionStore } from "./attachment-execution-store";
import { attachmentExecutionAgent, attachmentExecutionExpectation, parseAttachmentExecutionSnapshot,
  type AttachmentExecutionSnapshot } from "./attachment-execution-snapshot";
import { observeAttachmentGuestBoot } from "./attachment-host-observer";
import { executeAttachmentGuestAction } from "./attachment-host-executor";

type Dependencies = { store: AttachmentExecutionStore; observeBoot: typeof observeAttachmentGuestBoot;
  execute: typeof executeAttachmentGuestAction; uuid: () => string };
// boot_unobserved: the computer's guest did not answer Hivra at all, so it is
// not ready; boot_unconfirmed: it answered and recording that was not confirmed.
// computer_not_running / computer_not_ready: before the stage dispatch, the
// host refused the VM (stopped, or not the tagged VM on its address) and
// nothing ran in it; the worker ends the claim as failed with that reason.
type Reason = "state_unavailable" | "pending_delete" | "reservation_unconfirmed" | "boot_unobserved" | "boot_unconfirmed"
  | "fetch_unconfirmed" | "dispatch_unconfirmed" | "staging_unconfirmed" | "result_unconfirmed"
  | "computer_not_running" | "computer_not_ready";
const refusalReason = (result: { ok: boolean; code?: string; reason?: string }): Reason | null =>
  !result.ok && result.code === "target_refused"
    ? result.reason === "computer_not_running" ? "computer_not_running" : "computer_not_ready" : null;
export type AttachmentStagingProgress = { operationId: string; state: "staging_recorded" }
  | { operationId: string; state: "held"; reason: Reason };

/** One durable-worker pass, NOT an HTTP launch handler or attachment completion.
 * No retry loops, lease release, cancellation, activation or hidden dispatch on
 * recovery. The attach worker (attachment-worker.ts) is its only caller.
 */
export async function progressAttachmentStaging(
  ownerId: string, operationId: string, architecture: "x86_64" | "aarch64", overrides: Partial<Dependencies> = {},
): Promise<AttachmentStagingProgress> {
  const deps: Dependencies = { store: createAttachmentExecutionStore(), observeBoot: observeAttachmentGuestBoot,
    execute: executeAttachmentGuestAction, uuid: randomUUID, ...overrides };
  let reason: Reason = "state_unavailable";
  const held = (): AttachmentStagingProgress => ({ operationId, state: "held", reason });
  const read = async () => {
    const raw = await deps.store.read(ownerId, operationId);
    return parseAttachmentExecutionSnapshot(raw, ownerId, operationId);
  };
  const sameAuthority = (a: AttachmentExecutionSnapshot, b: AttachmentExecutionSnapshot) => a.computerId === b.computerId
    && a.generation === b.generation && a.authorityCommandId === b.authorityCommandId
    && JSON.stringify(a.guestAuthority) === JSON.stringify(b.guestAuthority);
  try {
    if (!["x86_64", "aarch64"].includes(architecture)) return held();
    let snapshot = await read();
    if (!snapshot) return held();
    if (snapshot.staged !== null) return { operationId, state: "staging_recorded" };
    if (snapshot.phase === "dispatched") {
      // Even a missing journal must not lead back into the stage branch.
      reason = "staging_unconfirmed";
      const expected = attachmentExecutionExpectation(snapshot);
      if (!expected) return held();
      const observed = await deps.execute(ownerId, attachmentExecutionAgent(snapshot), "observe", expected);
      if (!observed.ok || observed.action !== "observe") return held();
      reason = "result_unconfirmed";
      return await deps.store.recordStaged(snapshot, observed.staged) === true
        ? { operationId, state: "staging_recorded" } : held();
    }
    if (snapshot.desiredState !== "running") { reason = "pending_delete"; return held(); }
    if (!snapshot.installation) {
      reason = "reservation_unconfirmed";
      const installationId = deps.uuid(), bindingId = deps.uuid();
      if (await deps.store.reserve(snapshot, installationId, bindingId, architecture) !== true) return held();
      const next = await read();
      if (!next || !sameAuthority(snapshot, next) || next.phase !== "claimed" || next.desiredState !== "running"
        || next.installation?.installationId !== installationId || next.installation.bindingId !== bindingId
        || next.installation.architecture !== architecture) return held();
      snapshot = next;
    }
    if (!snapshot.observation) {
      reason = "boot_unobserved";
      const observed = await deps.observeBoot(ownerId, attachmentExecutionAgent(snapshot), {
        operationId, computerId: snapshot.computerId, sourceId: snapshot.guestAuthority.id,
        architecture: snapshot.installation!.architecture,
      });
      if (!observed.ok) { reason = refusalReason(observed) ?? reason; return held(); }
      reason = "boot_unconfirmed";
      if (await deps.store.recordBoot(snapshot, observed.observation.bootId) !== true) return held();
      const next = await read();
      if (!next || !sameAuthority(snapshot, next) || next.phase !== "claimed" || next.desiredState !== "running"
        || next.observation?.bootId !== observed.observation.bootId
        || JSON.stringify(next.installation) !== JSON.stringify(snapshot.installation)) return held();
      snapshot = next;
    }
    reason = "fetch_unconfirmed";
    const dispatchId = deps.uuid();
    const expected = attachmentExecutionExpectation(snapshot, dispatchId);
    if (!expected) return held();
    const fetched = await deps.execute(ownerId, attachmentExecutionAgent(snapshot), "fetch", expected);
    if (!fetched.ok) { reason = refusalReason(fetched) ?? reason; return held(); }
    if (fetched.action !== "fetch") return held();
    reason = "dispatch_unconfirmed";
    // Only an unambiguous true from THIS pass authorizes one stage call. Lost
    // acknowledgement, false, or exception cannot be converted into a retry.
    if (await deps.store.dispatch(snapshot, dispatchId) !== true) return held();
    // The grant is not a fresh view of desired state. Observe deletion or a
    // changed dispatch/authority before handing the earlier target to a host.
    // A lost read leaves the grant held; a later pass may only observe it.
    const current = await read();
    if (!current) return held();
    if (current.desiredState !== "running") { reason = "pending_delete"; return held(); }
    if (JSON.stringify({ ...snapshot, phase: "dispatched", dispatchId }) !== JSON.stringify(current)) return held();
    snapshot = current;
    reason = "staging_unconfirmed";
    const staged = await deps.execute(ownerId, attachmentExecutionAgent(snapshot), "stage", expected);
    if (!staged.ok || staged.action !== "stage") return held();
    reason = "result_unconfirmed";
    return await deps.store.recordStaged(snapshot, staged.staged) === true
      ? { operationId, state: "staging_recorded" } : held();
  } catch { return held(); }
}
