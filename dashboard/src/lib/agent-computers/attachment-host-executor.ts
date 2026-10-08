import "server-only";

import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import { parseAttachmentArtifactResult, type AttachmentArtifactResult } from "./attachment-artifact-result";
import { parseAttachmentGuestResult, snapshotAttachmentGuestExpectation,
  type AttachmentGuestResult, type ExpectedAttachmentGuestResult } from "./attachment-guest-result";
import { ATTACHMENT_ACTION_TIMEOUTS, buildAttachmentHostActionScript, type AttachmentGuestAction } from "./attachment-host-action";
import { parseAttachmentTargetRefusal, parseGuestStepRefusal, type AttachmentTargetRefusal } from "./attachment-host-observation";
import { logAttachmentTransportFailure } from "./attachment-transport-diagnostic";

type Dependencies = {
  resolveContext: typeof resolveHivraAgentExecutionContext;
  runHostScript: typeof runProxmoxHostScriptWithStdin;
};
/** What run-attached-codex-bundle.py names when a fetch, stage or observe raised (design 5.5, T3). */
export const ATTACHMENT_STAGING_REFUSALS = ["fetch_failed", "staging_failed", "staging_in_progress", "staging_absent",
  "staging_unresolved", "computer_restarted", "bundle_invalid"] as const;
export type AttachmentStagingRefusal = typeof ATTACHMENT_STAGING_REFUSALS[number];
export type AttachmentHostActionResult =
  | { ok: true; action: "fetch"; artifact: AttachmentArtifactResult }
  | { ok: true; action: "stage" | "observe"; staged: AttachmentGuestResult }
  | { ok: false; code: "invalid_target" | "authority_unavailable" | "transport_failed" | "invalid_result" }
  | { ok: false; code: "target_refused"; reason: AttachmentTargetRefusal }
  /** The program ran in the VM and ended with this refusal: nothing is left to wait for. */
  | { ok: false; code: "guest_refused"; reason: AttachmentStagingRefusal };

/** Internal transport adapter only, deliberately not called by a route yet.
 * Inputs must be loaded from the owned durable claim/reservation/boot records.
 * Stage additionally requires the caller to win the DB dispatch CAS exactly
 * once. This function does not grant dispatch, retry, activate or release leases.
 * Its stage deadline exceeds short HTTP limits: use the durable worker, not a
 * synchronous user request, when wiring orchestration.
 */
export async function executeAttachmentGuestAction(
  ownerId: string, inputAgent: RemoteDesktopAgentRow, action: AttachmentGuestAction,
  inputExpected: ExpectedAttachmentGuestResult, dependencies: Partial<Dependencies> = {},
): Promise<AttachmentHostActionResult> {
  const agent = Object.freeze({ ...inputAgent });
  const expected = snapshotAttachmentGuestExpectation(inputExpected);
  if (!expected || !["fetch", "stage", "observe"].includes(action)
    || !ownerId || agent.user_id !== ownerId || agent.id !== expected.identity.sourceId
    || agent.operation_id !== expected.identity.operationId || agent.operation_kind !== "agent_attach"
    || agent.status !== "running" || (agent.desired_state !== "running" && !(action === "observe" && agent.desired_state === "deleted"))
    || agent.computer_profile !== "ubuntu-desktop" || agent.computer_substrate !== "proxmox-kvm"
    || agent.infrastructure_binding_token_enforced !== true || agent.vmid == null || agent.ip == null) {
    return { ok: false, code: "invalid_target" };
  }
  const deps = { resolveContext: resolveHivraAgentExecutionContext, runHostScript: runProxmoxHostScriptWithStdin, ...dependencies };
  let context;
  try { context = await deps.resolveContext(ownerId, agent); }
  catch { return { ok: false, code: "authority_unavailable" }; }
  if (!context.infrastructureBindingTagEnforced) return { ok: false, code: "authority_unavailable" };
  const { operationId, computerId, sourceId, architecture } = expected.identity;
  let step;
  try {
    step = buildAttachmentHostActionScript(action, { operationId, computerId, sourceId, architecture,
      vmid: agent.vmid, guestIp: agent.ip, bindingTag: context.infrastructureBindingTag }, expected);
  } catch { return { ok: false, code: "invalid_target" }; }
  try {
    const result = await deps.runHostScript(step.script, step.stdin, { ...context.env },
      { timeoutMs: ATTACHMENT_ACTION_TIMEOUTS[action].hostMs, maxOutputBytes: 32 * 1024 });
    if (!result.ok) {
      const refused = parseAttachmentTargetRefusal(result.stdout);
      if (refused) return { ok: false, code: "target_refused", reason: refused };
      const named = parseGuestStepRefusal(result.stdout, ATTACHMENT_STAGING_REFUSALS);
      if (named) return { ok: false, code: "guest_refused", reason: named };
      logAttachmentTransportFailure(action, { sourceId, vmid: agent.vmid }, result);
      return { ok: false, code: "transport_failed" };
    }
    if (action === "fetch") {
      const artifact = parseAttachmentArtifactResult(result.stdout, expected);
      return artifact ? { ok: true, action, artifact } : { ok: false, code: "invalid_result" };
    }
    const staged = parseAttachmentGuestResult(result.stdout, expected);
    return staged ? { ok: true, action, staged } : { ok: false, code: "invalid_result" };
  } catch (error) {
    logAttachmentTransportFailure(action, { sourceId, vmid: agent.vmid }, error);
    return { ok: false, code: "transport_failed" };
  }
}
