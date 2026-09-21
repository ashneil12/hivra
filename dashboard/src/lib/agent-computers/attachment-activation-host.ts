import "server-only";

import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";
import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { ATTACHMENT_HOST_LOCK_PROGRAM } from "./attachment-host-observation";
import { attachmentExecutionAgent, parseAttachmentExecutionSnapshot, type AttachmentExecutionSnapshot } from "./attachment-execution-snapshot";
import { buildAttachmentActivationGuestBundle } from "./attachment-activation-guest-bundle";
import { parseAttachmentActivationRecord } from "./attachment-activation-store";
import { parseAttachmentActivationResult, type AttachmentActivationObservation, type AttachmentActivationStarted } from "./attachment-activation-result";
import { buildAttachmentNativeProbeBundle, parseAttachmentNativeProbeResult, type AttachmentNativeObservation } from "./attachment-native-probe-bundle";

export const ACTIVATION_ACTION_TIMEOUTS = Object.freeze({
  start: Object.freeze({ guestSeconds: 210, hostMs: 290_000 }),
  observe: Object.freeze({ guestSeconds: 90, hostMs: 170_000 }),
  native: Object.freeze({ guestSeconds: 90, hostMs: 170_000 }),
});
type Action = keyof typeof ACTIVATION_ACTION_TIMEOUTS;
type Dependencies = { resolveContext: typeof resolveHivraAgentExecutionContext; runHostScript: typeof runProxmoxHostScript };
type Result = { ok: true; action: Action; result: AttachmentActivationStarted | AttachmentActivationObservation | AttachmentNativeObservation }
  | { ok: false; code: "invalid_target" | "authority_unavailable" | "transport_failed" | "invalid_result" };

/** Fixed QGA route under the existing allocation lock. Not a dispatch grant. */
export function buildAttachmentActivationHostScript(action: Action, record: unknown, input: AttachmentExecutionSnapshot): string {
  if (!Object.hasOwn(ACTIVATION_ACTION_TIMEOUTS, action)) throw new Error("Invalid activation action.");
  const snapshot = parseAttachmentExecutionSnapshot(input, input?.ownerId, input?.operationId);
  if (!snapshot) throw new Error("Invalid activation target.");
  const bundle = action === "native" ? buildAttachmentNativeProbeBundle(record, snapshot)
    : buildAttachmentActivationGuestBundle(action, record, snapshot);
  const target = snapshot.guestAuthority;
  const body = `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
umask 077
VMID=${target.vmid}
EXPECTED_BINDING_TAG=${shellQuote("hivra-bind-" + target.infrastructure_binding_token_hash.slice(0, 32))}
GUEST_IP=${shellQuote(target.ip)}
qm() { command timeout --kill-after=5 20 qm "$@"; }
[ "$(qm status "$VMID" | awk '{print $2}')" = running ]
VM_CONFIG="$(qm config "$VMID")"
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\\n' | grep -Fxq "ip=$GUEST_IP/24"
${buildVmidBoundGuestExecPrelude()}
qm() { command timeout --kill-after=5 ${ACTIVATION_ACTION_TIMEOUTS[action].guestSeconds} qm "$@"; }
printf '%s' ${shellQuote(bundle.stdin)} | run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -S -c ${shellQuote(bundle.program)}
`;
  return `#!/usr/bin/env bash\nset -Eeuo pipefail\nexec /usr/bin/python3 -I -B -S -c ${shellQuote(ATTACHMENT_HOST_LOCK_PROGRAM)} ${shellQuote(body)}\n`;
}

/** Internal only; no registered route or worker calls this yet. Start requires a fresh
 * successful DB dispatch CAS in the calling worker while it holds the original
 * operation/generation fence. Never call start from a historical read or retry
 * it after an uncertain response. These deadlines require a durable worker.
 */
export async function executeAttachmentActivationAction(
  ownerId: string, action: Action, record: unknown, input: AttachmentExecutionSnapshot,
  dependencies: Partial<Dependencies> = {},
): Promise<Result> {
  const snapshot = parseAttachmentExecutionSnapshot(input, ownerId, input?.operationId);
  const request = snapshot && parseAttachmentActivationRecord(record, snapshot);
  if (!snapshot || !request || !Object.hasOwn(ACTIVATION_ACTION_TIMEOUTS, action)
    || (action === "start" && snapshot.desiredState !== "running")) return { ok: false, code: "invalid_target" };
  const deps = { resolveContext: resolveHivraAgentExecutionContext, runHostScript: runProxmoxHostScript, ...dependencies };
  let context;
  try { context = await deps.resolveContext(ownerId, attachmentExecutionAgent(snapshot)); }
  catch { return { ok: false, code: "authority_unavailable" }; }
  const tag = "hivra-bind-" + snapshot.guestAuthority.infrastructure_binding_token_hash.slice(0, 32);
  if (!context.infrastructureBindingTagEnforced || context.infrastructureBindingTag !== tag) {
    return { ok: false, code: "authority_unavailable" };
  }
  let script;
  try { script = buildAttachmentActivationHostScript(action, request, snapshot); }
  catch { return { ok: false, code: "invalid_target" }; }
  try {
    const response = await deps.runHostScript(script, { ...context.env },
      { timeoutMs: ACTIVATION_ACTION_TIMEOUTS[action].hostMs, maxOutputBytes: 32768 });
    if (!response.ok) return { ok: false, code: "transport_failed" };
    const result = action === "native" ? parseAttachmentNativeProbeResult(response.stdout, request, snapshot)
      : parseAttachmentActivationResult(action, response.stdout, request, snapshot);
    return result ? { ok: true, action, result } : { ok: false, code: "invalid_result" };
  } catch { return { ok: false, code: "transport_failed" }; }
}
