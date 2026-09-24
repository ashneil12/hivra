import "server-only";

import { randomUUID } from "node:crypto";
import { createAttachmentExecutionStore, type AttachmentExecutionStore } from "./attachment-execution-store";
import { attachmentExecutionAgent, attachmentExecutionExpectation, parseAttachmentExecutionSnapshot,
  type AttachmentExecutionSnapshot } from "./attachment-execution-snapshot";
import { observeAttachmentGuestBoot } from "./attachment-host-observer";
import { executeAttachmentGuestAction, type AttachmentStagingRefusal } from "./attachment-host-executor";
import { ATTACHMENT_ACTION_TIMEOUTS } from "./attachment-host-action";

type Dependencies = { store: AttachmentExecutionStore; observeBoot: typeof observeAttachmentGuestBoot;
  execute: typeof executeAttachmentGuestAction; uuid: () => string;
  /** The worker pass's deadline (epoch ms) and clock: a host step that could outlast it is not started. */
  deadline: number; now: () => number;
  /** When the database granted the stage (the worker's state read), for a guest that shows no stage at all. */
  dispatchedAt: string | null };
/** A guest step sent this long ago has ended: every stage, activation and
 * cleanup deadline (host and guest) is shorter. What it left is then final. */
export const ATTACH_STEP_SETTLE_MS = 15 * 60_000;
// The boot read's own bound (attachment-host-observer.ts).
const OBSERVE_BOOT_MS = 90_000;
// boot_unobserved: the computer's guest did not answer Hivra at all, so it is
// not ready; boot_unconfirmed: it answered and recording that was not confirmed.
// computer_not_running / computer_not_ready: before the stage dispatch, the
// host refused the VM (stopped, or not the tagged VM on its address) and
// nothing ran in it; the worker ends the claim as failed with that reason.
// After the dispatch, computer_not_running means the host saw the VM stopped,
// so the stage cannot be running in it; the worker lets the computer go.
// fetch_refused: before the dispatch the computer's guest ran the download and
// it failed; a later pass fetches again (nothing was dispatched).
type Reason = "state_unavailable" | "pending_delete" | "reservation_unconfirmed" | "boot_unobserved" | "boot_unconfirmed"
  | "fetch_unconfirmed" | "fetch_refused" | "dispatch_unconfirmed" | "staging_unconfirmed" | "result_unconfirmed"
  | "computer_not_running" | "computer_not_ready" | "budget_exhausted";
/** A stage that was dispatched and ended without a receipt: the worker removes
 * what it left and fails the attach with this reason, never holds it (T3). */
export type AttachmentStagingFailure = Exclude<AttachmentStagingRefusal, "staging_in_progress" | "fetch_failed">;
const refusalReason = (result: { ok: boolean; code?: string; reason?: string }): Reason | null =>
  !result.ok && result.code === "target_refused"
    ? result.reason === "computer_not_running" ? "computer_not_running" : "computer_not_ready" : null;
/** After the dispatch only a stopped VM is named; anything else stays unconfirmed. */
const stoppedAfterDispatch = (result: { ok: boolean; code?: string; reason?: string }): boolean =>
  !result.ok && result.code === "target_refused" && result.reason === "computer_not_running";
export type AttachmentStagingProgress = { operationId: string; state: "staging_recorded" }
  | { operationId: string; state: "held"; reason: Reason }
  | { operationId: string; state: "refused"; reason: AttachmentStagingFailure };

/**
 * Whether a refusal the guest named for a dispatched stage is final. A stage
 * still holding its lock is running. One whose journal says it started and
 * whose lock is free ended without a receipt; a computer that restarted can
 * never finish it. No journal at all (the stage never reached the guest, or
 * was refused before it wrote one) or one that is not this stage's is final
 * only once the stage's own deadlines have long passed.
 */
function finalStage(reason: AttachmentStagingRefusal, settled: boolean): AttachmentStagingFailure | null {
  if (reason === "staging_in_progress") return null;
  if (reason === "staging_failed" || reason === "computer_restarted") return reason;
  if (!settled) return null;
  return reason === "fetch_failed" ? "staging_unresolved" : reason;
}

/** One durable-worker pass, NOT an HTTP launch handler or attachment completion.
 * No retry loops, lease release, cancellation, activation or hidden dispatch on
 * recovery. The attach worker (attachment-worker.ts) is its only caller.
 */
export async function progressAttachmentStaging(
  ownerId: string, operationId: string, architecture: "x86_64" | "aarch64", overrides: Partial<Dependencies> = {},
): Promise<AttachmentStagingProgress> {
  const deps: Dependencies = { store: createAttachmentExecutionStore(), observeBoot: observeAttachmentGuestBoot,
    execute: executeAttachmentGuestAction, uuid: randomUUID, deadline: Number.POSITIVE_INFINITY, now: Date.now, dispatchedAt: null,
    ...overrides };
  const fits = (ms: number) => deps.now() + ms <= deps.deadline;
  const dispatchedAt = deps.dispatchedAt ? Date.parse(deps.dispatchedAt) : Number.NaN;
  const settled = () => Number.isFinite(dispatchedAt) && deps.now() - dispatchedAt >= ATTACH_STEP_SETTLE_MS;
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
      if (!fits(ATTACHMENT_ACTION_TIMEOUTS.observe.hostMs)) { reason = "budget_exhausted"; return held(); }
      const observed = await deps.execute(ownerId, attachmentExecutionAgent(snapshot), "observe", expected);
      if (stoppedAfterDispatch(observed)) { reason = "computer_not_running"; return held(); }
      if (!observed.ok && observed.code === "guest_refused") {
        const final = finalStage(observed.reason, settled());
        return final ? { operationId, state: "refused", reason: final } : held();
      }
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
      if (!fits(OBSERVE_BOOT_MS)) { reason = "budget_exhausted"; return held(); }
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
    // Fetch and stage run back to back around the one-time dispatch: both must fit.
    if (!fits(ATTACHMENT_ACTION_TIMEOUTS.fetch.hostMs + ATTACHMENT_ACTION_TIMEOUTS.stage.hostMs)) {
      reason = "budget_exhausted";
      return held();
    }
    reason = "fetch_unconfirmed";
    const dispatchId = deps.uuid();
    const expected = attachmentExecutionExpectation(snapshot, dispatchId);
    if (!expected) return held();
    const fetched = await deps.execute(ownerId, attachmentExecutionAgent(snapshot), "fetch", expected);
    if (!fetched.ok) {
      reason = refusalReason(fetched) ?? (fetched.code === "guest_refused" ? "fetch_refused" : reason);
      return held();
    }
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
    if (stoppedAfterDispatch(staged)) { reason = "computer_not_running"; return held(); }
    // The stage ran in the VM and ended refused: there is no receipt to wait for.
    if (!staged.ok && staged.code === "guest_refused") {
      return { operationId, state: "refused", reason: finalStage(staged.reason, true) ?? "staging_unresolved" };
    }
    if (!staged.ok || staged.action !== "stage") return held();
    reason = "result_unconfirmed";
    return await deps.store.recordStaged(snapshot, staged.staged) === true
      ? { operationId, state: "staging_recorded" } : held();
  } catch { return held(); }
}
