import "server-only";

import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import { buildAttachmentHostObservationScript, parseAttachmentHostObservation, parseAttachmentTargetRefusal,
  type AttachmentHostObservation, type AttachmentObservationTarget, type AttachmentTargetRefusal } from "./attachment-host-observation";

type Request = Pick<AttachmentObservationTarget, "operationId" | "computerId" | "sourceId" | "architecture">;
type Dependencies = {
  resolveContext: typeof resolveHivraAgentExecutionContext;
  runHostScript: typeof runProxmoxHostScript;
};
type Result = { ok: true; observation: AttachmentHostObservation } | {
  ok: false; code: "invalid_target" | "authority_unavailable" | "transport_failed" | "invalid_observation";
} | { ok: false; code: "target_refused"; reason: AttachmentTargetRefusal };

/** Internal read-only observer. The orchestrator must load the row and request
 * from the authorized durable claim, not directly from browser input. Recheck
 * that same claim in SQL when saving the observation and obtaining dispatch.
 */
export async function observeAttachmentGuestBoot(
  ownerId: string, inputAgent: RemoteDesktopAgentRow, inputRequest: Request, dependencies: Partial<Dependencies> = {},
): Promise<Result> {
  // Snapshot the scalar authority/target fields before the first async boundary.
  // Caller mutation during context resolution must not retarget an admitted read.
  const agent = Object.freeze({ ...inputAgent });
  const request = Object.freeze({ ...inputRequest });
  if (!ownerId || agent.user_id !== ownerId || agent.id !== request.sourceId
    || agent.operation_id !== request.operationId || agent.operation_kind !== "agent_attach"
    || agent.status !== "running" || agent.desired_state !== "running"
    || agent.computer_profile !== "ubuntu-desktop" || agent.computer_substrate !== "proxmox-kvm"
    || agent.infrastructure_binding_token_enforced !== true || agent.vmid == null || agent.ip == null) {
    return { ok: false, code: "invalid_target" };
  }
  const deps = { resolveContext: resolveHivraAgentExecutionContext, runHostScript: runProxmoxHostScript, ...dependencies };
  let context;
  try { context = await deps.resolveContext(ownerId, agent); }
  catch { return { ok: false, code: "authority_unavailable" }; }
  if (!context.infrastructureBindingTagEnforced) return { ok: false, code: "authority_unavailable" };
  const target = { ...request, vmid: agent.vmid, guestIp: agent.ip, bindingTag: context.infrastructureBindingTag };
  let script;
  try { script = buildAttachmentHostObservationScript(target); }
  catch { return { ok: false, code: "invalid_target" }; }
  try {
    const result = await deps.runHostScript(script, context.env, { timeoutMs: 90_000, maxOutputBytes: 16 * 1024 });
    if (!result.ok) {
      // The host refused the VM before anything ran in it: say why.
      const refused = parseAttachmentTargetRefusal(result.stdout);
      return refused ? { ok: false, code: "target_refused", reason: refused } : { ok: false, code: "transport_failed" };
    }
    const observation = parseAttachmentHostObservation(result.stdout, target);
    return observation ? { ok: true, observation } : { ok: false, code: "invalid_observation" };
  } catch { return { ok: false, code: "transport_failed" }; }
}
