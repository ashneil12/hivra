import "server-only";

import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import { parseAttachmentArtifactResult, type AttachmentArtifactResult } from "./attachment-artifact-result";
import { parseAttachmentGuestResult, snapshotAttachmentGuestExpectation,
  type AttachmentGuestResult, type ExpectedAttachmentGuestResult } from "./attachment-guest-result";
import { ATTACHMENT_ACTION_TIMEOUTS, buildAttachmentHostActionScript, type AttachmentGuestAction } from "./attachment-host-action";

type Dependencies = {
  resolveContext: typeof resolveHivraAgentExecutionContext;
  runHostScript: typeof runProxmoxHostScript;
};
export type AttachmentHostActionResult =
  | { ok: true; action: "fetch"; artifact: AttachmentArtifactResult }
  | { ok: true; action: "stage" | "observe"; staged: AttachmentGuestResult }
  | { ok: false; code: "invalid_target" | "authority_unavailable" | "transport_failed" | "invalid_result" };

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
  const deps = { resolveContext: resolveHivraAgentExecutionContext, runHostScript: runProxmoxHostScript, ...dependencies };
  let context;
  try { context = await deps.resolveContext(ownerId, agent); }
  catch { return { ok: false, code: "authority_unavailable" }; }
  if (!context.infrastructureBindingTagEnforced) return { ok: false, code: "authority_unavailable" };
  const { operationId, computerId, sourceId, architecture } = expected.identity;
  let script;
  try {
    script = buildAttachmentHostActionScript(action, { operationId, computerId, sourceId, architecture,
      vmid: agent.vmid, guestIp: agent.ip, bindingTag: context.infrastructureBindingTag }, expected);
  } catch { return { ok: false, code: "invalid_target" }; }
  try {
    const result = await deps.runHostScript(script, { ...context.env },
      { timeoutMs: ATTACHMENT_ACTION_TIMEOUTS[action].hostMs, maxOutputBytes: 32 * 1024 });
    if (!result.ok) return { ok: false, code: "transport_failed" };
    if (action === "fetch") {
      const artifact = parseAttachmentArtifactResult(result.stdout, expected);
      return artifact ? { ok: true, action, artifact } : { ok: false, code: "invalid_result" };
    }
    const staged = parseAttachmentGuestResult(result.stdout, expected);
    return staged ? { ok: true, action, staged } : { ok: false, code: "invalid_result" };
  } catch { return { ok: false, code: "transport_failed" }; }
}
