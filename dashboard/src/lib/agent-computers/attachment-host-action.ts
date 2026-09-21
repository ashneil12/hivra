import "server-only";

import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";
import { buildAttachmentGuestBundle } from "./attachment-guest-bundle";
import { snapshotAttachmentGuestExpectation, type ExpectedAttachmentGuestResult } from "./attachment-guest-result";
import { ATTACHMENT_HOST_LOCK_PROGRAM, snapshotAttachmentObservationTarget,
  type AttachmentObservationTarget } from "./attachment-host-observation";

export type AttachmentGuestAction = "fetch" | "stage" | "observe";
// Guest fetch/stage already have 180s/300s internal deadlines. Leave room for
// validation and final receipt output; host metadata calls remain bounded at 20s.
export const ATTACHMENT_ACTION_TIMEOUTS = Object.freeze({
  fetch: Object.freeze({ guestSeconds: 210, hostMs: 290_000 }),
  stage: Object.freeze({ guestSeconds: 330, hostMs: 410_000 }),
  observe: Object.freeze({ guestSeconds: 20, hostMs: 100_000 }),
});

/** Internal transport, not dispatch authority. The durable orchestrator must
 * admit the exact operation and win the one-time stage CAS before invoking it.
 * Never retry stage on timeout; use observe with the same durable expectation.
 */
export function buildAttachmentHostActionScript(
  action: AttachmentGuestAction, inputTarget: AttachmentObservationTarget, inputExpected: ExpectedAttachmentGuestResult,
): string {
  if (!Object.hasOwn(ATTACHMENT_ACTION_TIMEOUTS, action)) throw new Error("Invalid attachment action.");
  const target = snapshotAttachmentObservationTarget(inputTarget);
  const expected = snapshotAttachmentGuestExpectation(inputExpected);
  if (!expected || (["operationId", "computerId", "sourceId", "architecture"] as const)
    .some(key => expected.identity[key] !== target[key])) throw new Error("Attachment target does not match the durable expectation.");
  const bundle = buildAttachmentGuestBundle(action, expected);
  const body = `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
umask 077
VMID=${target.vmid}
EXPECTED_BINDING_TAG=${shellQuote(target.bindingTag)}
GUEST_IP=${shellQuote(target.guestIp)}
qm() { command timeout --kill-after=5 20 qm "$@"; }
[ "$(qm status "$VMID" | awk '{print $2}')" = running ]
VM_CONFIG="$(qm config "$VMID")"
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\\n' | grep -Fxq "ip=$GUEST_IP/24"
${buildVmidBoundGuestExecPrelude()}
# Only the guest command gets the action deadline. No private-IP SSH fallback.
qm() { command timeout --kill-after=5 ${ATTACHMENT_ACTION_TIMEOUTS[action].guestSeconds} qm "$@"; }
printf '%s' ${shellQuote(bundle.stdin)} | run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -c ${shellQuote(bundle.program)}
`;
  return `#!/usr/bin/env bash\nset -Eeuo pipefail\nexec /usr/bin/python3 -I -B -c ${shellQuote(ATTACHMENT_HOST_LOCK_PROGRAM)} ${shellQuote(body)}\n`;
}
