import "server-only";

import { buildAttachmentGuestBundle } from "./attachment-guest-bundle";
import { snapshotAttachmentGuestExpectation, type ExpectedAttachmentGuestResult } from "./attachment-guest-result";
import { buildAttachmentHostStepScript, snapshotAttachmentObservationTarget,
  type AttachmentObservationTarget } from "./attachment-host-observation";

export type AttachmentGuestAction = "fetch" | "stage" | "observe";
// Guest fetch/stage already have 180s/300s internal deadlines. Leave room for
// validation and final receipt output; host metadata calls remain bounded at 20s.
// The host allocation lock is held only to check the VM and start the step.
export const ATTACHMENT_ACTION_TIMEOUTS = Object.freeze({
  fetch: Object.freeze({ guestSeconds: 210, hostMs: 290_000 }),
  stage: Object.freeze({ guestSeconds: 330, hostMs: 410_000 }),
  observe: Object.freeze({ guestSeconds: 20, hostMs: 100_000 }),
});

/** Internal transport, not dispatch authority. The durable orchestrator must
 * admit the exact operation and win the one-time stage CAS before invoking it.
 * Never retry stage on timeout; use observe with the same durable expectation.
 * Run the script with its bundle as a separate stdin stream
 * (runProxmoxHostScriptWithStdin).
 */
export function buildAttachmentHostActionScript(
  action: AttachmentGuestAction, inputTarget: AttachmentObservationTarget, inputExpected: ExpectedAttachmentGuestResult,
): { script: string; stdin: string } {
  if (!Object.hasOwn(ATTACHMENT_ACTION_TIMEOUTS, action)) throw new Error("Invalid attachment action.");
  const target = snapshotAttachmentObservationTarget(inputTarget);
  const expected = snapshotAttachmentGuestExpectation(inputExpected);
  if (!expected || (["operationId", "computerId", "sourceId", "architecture"] as const)
    .some(key => expected.identity[key] !== target[key])) throw new Error("Attachment target does not match the durable expectation.");
  const bundle = buildAttachmentGuestBundle(action, expected);
  return { script: buildAttachmentHostStepScript(target, bundle.program, ATTACHMENT_ACTION_TIMEOUTS[action].guestSeconds), stdin: bundle.stdin };
}
