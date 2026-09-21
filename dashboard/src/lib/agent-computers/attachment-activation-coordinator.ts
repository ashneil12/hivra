import "server-only";
import { randomUUID } from "node:crypto";
import { createAttachmentExecutionStore } from "./attachment-execution-store";
import { buildAttachmentActivationRequest, createAttachmentActivationStore, parseAttachmentActivationRecord } from "./attachment-activation-store";
import { createAttachmentActivationObservationStore } from "./attachment-activation-observation-store";
import { parseAttachmentExecutionSnapshot, type AttachmentExecutionSnapshot } from "./attachment-execution-snapshot";
import { executeAttachmentActivationAction } from "./attachment-activation-host";
import { parseAttachmentActivationResult, type AttachmentActivationObservation } from "./attachment-activation-result";
import { parseAttachmentNativeProbeResult } from "./attachment-native-probe-bundle";

type Dependencies = { execution: Pick<ReturnType<typeof createAttachmentExecutionStore>, "read">;
  activation: ReturnType<typeof createAttachmentActivationStore>;
  observations: ReturnType<typeof createAttachmentActivationObservationStore>;
  execute: typeof executeAttachmentActivationAction; uuid: () => string };
type Reason = "state_unavailable" | "pending_delete" | "dispatch_unconfirmed" | "start_unconfirmed" | "observation_unconfirmed" | "persistence_unconfirmed";
export type AttachmentActivationProgress = { operationId: string; state: "held"; reason: Reason }
  | { operationId: string; state: "activation_observed"; observationId: string; observationState: AttachmentActivationObservation["state"] };
export type AttachmentNativeProgress = { operationId: string; state: "held"; reason: Reason }
  | { operationId: string; state: "native_protocol_observed"; observationId: string };

/** One durable-worker pass. Not registered, not an HTTP handler, and never
 * attachment readiness or release. A fresh true CAS in this pass is the only
 * path to start; historical records always take the observation path.
 */
export async function progressAttachmentActivation(ownerId: string, operationId: string, overrides: Partial<Dependencies> = {}): Promise<AttachmentActivationProgress> {
  const deps: Dependencies = { execution: createAttachmentExecutionStore(), activation: createAttachmentActivationStore(),
    observations: createAttachmentActivationObservationStore(), execute: executeAttachmentActivationAction, uuid: randomUUID, ...overrides };
  let reason: Reason = "state_unavailable";
  const held = (): AttachmentActivationProgress => ({ operationId, state: "held", reason });
  const read = async () => parseAttachmentExecutionSnapshot(await deps.execution.read(ownerId, operationId), ownerId, operationId);
  const same = (a: AttachmentExecutionSnapshot, b: AttachmentExecutionSnapshot) =>
    JSON.stringify({ ...a, desiredState: b.desiredState }) === JSON.stringify(b);
  try {
    let snapshot = await read();
    if (!snapshot || snapshot.phase !== "dispatched" || !snapshot.staged) return held();
    const saved = await deps.activation.read(snapshot);
    let request = saved === null ? null : parseAttachmentActivationRecord(saved, snapshot);
    if (saved !== null && !request) return held();
    if (!request) {
      if (snapshot.desiredState !== "running") { reason = "pending_delete"; return held(); }
      request = buildAttachmentActivationRequest(snapshot, deps.uuid());
      reason = "dispatch_unconfirmed";
      if (await deps.activation.dispatch(snapshot, request.activationId) !== true) return held();
      // Re-read after the grant. Changed authority or a newly queued delete
      // cannot start; a lost/read acknowledgement is never retried as start.
      const current = await read();
      if (!current || !same(snapshot, current)) return held();
      if (current.desiredState !== "running") { reason = "pending_delete"; return held(); }
      const confirmed = parseAttachmentActivationRecord(await deps.activation.read(current), current);
      if (!confirmed || JSON.stringify(confirmed) !== JSON.stringify(request)) return held();
      snapshot = current;
      reason = "start_unconfirmed";
      const started = await deps.execute(ownerId, "start", request, snapshot);
      if (!started.ok || started.action !== "start"
        || !parseAttachmentActivationResult("start", JSON.stringify(started.result), request, snapshot)) return held();
    }
    reason = "observation_unconfirmed";
    const current = await read();
    if (!current || !same(snapshot, current)) return held();
    snapshot = current; // Observation remains allowed when deletion is pending.
    const observed = await deps.execute(ownerId, "observe", request, snapshot);
    if (!observed.ok || observed.action !== "observe") return held();
    const result = parseAttachmentActivationResult("observe", JSON.stringify(observed.result), request, snapshot);
    if (!result || !("state" in result)) return held();
    reason = "persistence_unconfirmed";
    const observationId = deps.uuid();
    if (await deps.observations.record(snapshot, request, observationId, result) !== true) return held();
    return { operationId, state: "activation_observed", observationId, observationState: result.state };
  } catch { return held(); }
}

/** One observation-only pass over an existing activation. Never dispatches,
 * starts, repairs, publishes a binding or releases the held operation. A future
 * durable worker must register this explicitly; it is not an HTTP handler.
 */
export async function progressAttachmentNativeObservation(
  ownerId: string, operationId: string, overrides: Partial<Dependencies> = {},
): Promise<AttachmentNativeProgress> {
  const deps: Dependencies = { execution: createAttachmentExecutionStore(), activation: createAttachmentActivationStore(),
    observations: createAttachmentActivationObservationStore(), execute: executeAttachmentActivationAction, uuid: randomUUID, ...overrides };
  let reason: Reason = "state_unavailable";
  const held = (): AttachmentNativeProgress => ({ operationId, state: "held", reason });
  const read = async () => parseAttachmentExecutionSnapshot(await deps.execution.read(ownerId, operationId), ownerId, operationId);
  const same = (a: AttachmentExecutionSnapshot, b: AttachmentExecutionSnapshot) =>
    JSON.stringify({ ...a, desiredState: b.desiredState }) === JSON.stringify(b);
  try {
    const initial = await read();
    if (!initial || initial.phase !== "dispatched" || !initial.staged) return held();
    const request = parseAttachmentActivationRecord(await deps.activation.read(initial), initial);
    if (!request) return held();
    const snapshot = await read();
    if (!snapshot || !same(initial, snapshot)) return held();
    reason = "observation_unconfirmed";
    const observed = await deps.execute(ownerId, "native", request, snapshot);
    if (!observed.ok || observed.action !== "native") return held();
    const result = parseAttachmentNativeProbeResult(JSON.stringify(observed.result), request, snapshot);
    if (!result) return held();
    const current = await read();
    if (!current || !same(snapshot, current)) return held();
    reason = "persistence_unconfirmed";
    const observationId = deps.uuid();
    if (await deps.observations.record(current, request, observationId, result) !== true) return held();
    return { operationId, state: "native_protocol_observed", observationId };
  } catch { return held(); }
}
