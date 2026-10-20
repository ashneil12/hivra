import "server-only";

// The in-place connection-service update of a Proxmox agent (the lifecycle
// route's update_runtime), as one function the owner's request and the
// automatic-update sweep both run: the same host and binding checks, the same
// operation lease, the same host-authored receipt and the same records.
// Moved here from the lifecycle route unchanged; the route keeps its request
// gates (sign-in, same origin, and the refusals for kinds of computer that
// can't be updated here) and answers with this outcome.
//
// For Claude Code and Codex the same update also schedules the move to the
// version Hivra has tested (AGENT_CLI_VERSIONS); the helper's report of that
// comes back as agentCli, and is recorded for the Updates section.

import { randomUUID } from "node:crypto";
import { log } from "@/lib/logger";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { AGENT_CLI_VERSIONS, PORTABLE_HIVRA_PROVISIONER_VERSION } from "@/lib/infrastructure/portable-provisioner-contract";
import { logHivraAgentEvent } from "./agent-events";
import { shellQuote } from "./proxmox-target";
import { lifecycleMutationPrelude } from "./agent-power-scripts";
import {
  claimHivraAgentOperation,
  completeHivraAgentOperation,
  recordHivraAgentOperationFailure,
  releaseHivraAgentOperation,
} from "./agent-operation-store";
import { isPreparedProfile, runtimeUpdateRefusal } from "./lifecycle-support";
import {
  lifecycleActivityCredential,
  providerFailureDetail,
  resolveHivraLifecycleTarget,
  type HivraLifecycleAgentRow,
} from "./agent-lifecycle-host";
import { agentSoftwareSubject, parseAgentCliReport, type AgentCliUpdateReport } from "./agent-cli-status";
import { HOST_READINESS_TIMEOUT_MS, RUNTIME_UPDATE_TIMEOUT_MS } from "./lifecycle-timeouts";
import {
  readAgentSoftwareRecord,
  recordAutomaticAgentSoftwareResult,
  recordOwnerAgentSoftwareRequest,
  requestResultOf,
} from "./agent-cli-store";

// The host script's bound (RUNTIME_UPDATE_TIMEOUT_MS) and the readiness
// check's live in lifecycle-timeouts.ts, which the automatic-update cron
// budgets around.
//
// The updater's own deadline, counted on the host from the first line of the
// script (so it includes the FD8 wait). The margin covers the SSH connection
// and the result's trip back before RUNTIME_UPDATE_TIMEOUT_MS; the updater
// skips its optional reporter step rather than run past this deadline.
const RUNTIME_UPDATE_HOST_BUDGET_SECONDS = RUNTIME_UPDATE_TIMEOUT_MS / 1000 - 20;

export type HivraAgentRuntimeUpdateTrigger = "owner" | "auto";

export type HivraAgentRuntimeUpdateFailureCode =
  | "unsupported"
  | "no_computer"
  | "infrastructure_unavailable"
  | "host_not_ready"
  | "misconfigured"
  | "not_running"
  | "busy"
  | "unverified"
  | "superseded";

export type HivraAgentRuntimeUpdateOutcome =
  | { ok: true; agentCli: AgentCliUpdateReport | null }
  | { ok: false; code: HivraAgentRuntimeUpdateFailureCode; status: number; message: string };

const failure = (code: HivraAgentRuntimeUpdateFailureCode, status: number, message: string): HivraAgentRuntimeUpdateOutcome =>
  ({ ok: false, code, status, message });

type RuntimeUpdateInput = {
  userId: string;
  agent: HivraLifecycleAgentRow;
  trigger: HivraAgentRuntimeUpdateTrigger;
  source?: string;
};

/**
 * Refreshes the agent's connection service in place (no VM power change) and
 * completes the operation as running on the helper's receipt for this exact
 * VM. The caller has already loaded `agent` scoped to `userId`. Returns why it
 * didn't run instead of throwing, except for unexpected errors.
 *
 * For a Claude Code or Codex agent it then records the request against the
 * version Hivra has tested: an owner's request here; an automatic one's result
 * against the claim the sweep made before calling.
 */
export async function runHivraAgentRuntimeUpdate(input: RuntimeUpdateInput): Promise<HivraAgentRuntimeUpdateOutcome> {
  const requestedAt = new Date();
  const outcome = await updateInPlace(input);
  const subject = agentSoftwareSubject(input.agent);
  if (subject?.cli && typeof input.agent.id === "string" && typeof input.agent.user_id === "string") {
    const ref = { id: input.agent.id, user_id: input.agent.user_id, type: subject.type };
    const report = outcome.ok ? outcome.agentCli : null;
    const target = report?.target ?? AGENT_CLI_VERSIONS[subject.cli];
    const result = requestResultOf(outcome);
    // An owner's request is recorded once it reached the host (or found it
    // not ready or busy); the sweep's claim always gets its result.
    const reached = outcome.ok || outcome.code === "host_not_ready" || outcome.code === "busy" || outcome.code === "unverified";
    if (input.trigger === "auto") {
      await recordAutomaticAgentSoftwareResult(ref, AGENT_CLI_VERSIONS[subject.cli], result, report);
    } else if (reached) {
      await recordOwnerAgentSoftwareRequest({
        agent: ref, subject, target, requestedAt, result, report,
        previous: await readAgentSoftwareRecord(ref.id, ref.user_id),
      });
    }
  }
  return outcome;
}

async function updateInPlace(input: RuntimeUpdateInput): Promise<HivraAgentRuntimeUpdateOutcome> {
  const { userId, agent, trigger } = input;
  const source = input.source ?? "hivra/agents/[id]/action";
  // The route refuses these before calling; the sweep never selects them.
  // A DeepSeek update restarts DeepSeek and ends a task it is working on, so
  // only its owner starts one; the automatic sweep never does. A Linux Sandbox
  // updates through its adapter (mutateGvisorComputer), never this Proxmox helper.
  if (runtimeUpdateRefusal(agent) || isPreparedProfile(agent) || agent.computer_substrate === "gvisor"
    || (agent.type === "deepseek-harness" && trigger === "auto")) {
    return failure("unsupported", 409, "This computer can't update its connection service here. Nothing was changed.");
  }

  const prepared = await resolveHivraLifecycleTarget({ userId, agent, action: "update_runtime", source });
  if (!prepared.ok) return failure(prepared.code, prepared.status, prepared.message);
  const { executionContext, bindingTag, env, vmid, octet, subnetPrefix } = prepared.target;

  if (agent.status !== "running") {
    return failure("not_running", 409, "Start this computer before updating its connection service.");
  }
  if (executionContext.kind === "self-managed") {
    const readiness = await runProxmoxHostScript(
      `set -euo pipefail
PROVISIONER_DIR=${shellQuote(executionContext.paths.provisionerDirectory)}
test "$(tr -d '[:space:]' < "$PROVISIONER_DIR/VERSION")" = ${shellQuote(PORTABLE_HIVRA_PROVISIONER_VERSION)}
(cd "$PROVISIONER_DIR" && sha256sum -c --status BUNDLE.sha256)
test -x "$PROVISIONER_DIR/hivra-update-guest-runtime.sh"
bash -n "$PROVISIONER_DIR/hivra-update-guest-runtime.sh"
printf 'HIVRA_RUNTIME_UPDATE_READY\\n'`,
      env,
      { timeoutMs: HOST_READINESS_TIMEOUT_MS },
    );
    if (!readiness.ok || !readiness.stdout.includes("HIVRA_RUNTIME_UPDATE_READY")) {
      return failure("host_not_ready", 503, "Prepare this infrastructure target with the current Hivra runtime bundle before updating the computer.");
    }
  }

  // The update is in place: the helper restarts only the guest's chat
  // gateway (detached runs survive it), so the VM, its agent services,
  // tmux-backed agent terminals and desktop apps keep running. It still
  // takes the same operation lease as before (the "restart" kind; a stale
  // one settles from provider state in the reconciler). FD8 is taken here
  // for the host-side checks; the helper releases it before its guest
  // steps, as the start helper does, so a slow guest never holds other
  // lifecycle work on this host past its own 60 s lock wait.
  const operationId = randomUUID();
  const claimed = await claimHivraAgentOperation({
    userId,
    agentId: String(agent.id),
    operationId,
    operationKind: "restart",
    desiredState: "running",
    operationPayload: null,
  });
  if (!claimed) return failure("busy", 409, "Another lifecycle operation is already in progress.");

  const runtimeUpdateHelper = `${executionContext.paths.provisionerDirectory}/hivra-update-guest-runtime.sh`;
  const guestIp = `${subnetPrefix}.${octet}`;
  const activityCredential = lifecycleActivityCredential({ agent, userId, vmid, action: "update_runtime", source });
  const activity = activityCredential.kickoff(runtimeUpdateHelper);
  // The helper consumes and deletes a staged credential itself; the trap
  // only covers an exit before it ran (for example a refused prelude step).
  const activityCleanup = activity.stage
    ? `trap ${shellQuote(`rm -f -- ${shellQuote(activityCredential.file)}`)} EXIT\n`
    : "";
  const updateCommand = `${activity.stage}HIVRA_VM_SSH_KEY_PATH=${shellQuote(executionContext.paths.vmSshKeyPath ?? "")} HIVRA_LIFECYCLE_LOCK_FD=8 HIVRA_RUNTIME_UPDATE_DEADLINE="$HIVRA_RUNTIME_UPDATE_DEADLINE" ${activity.env}bash ${shellQuote(runtimeUpdateHelper)} ${vmid} ${shellQuote(guestIp)}`;
  // The deadline is set before the prelude so it also counts the FD8 wait.
  const r = await runProxmoxHostScript(
    `HIVRA_RUNTIME_UPDATE_DEADLINE="$(( $(date +%s) + ${RUNTIME_UPDATE_HOST_BUDGET_SECONDS} ))"\n${lifecycleMutationPrelude(vmid, bindingTag)}\n${activityCleanup}${updateCommand}`,
    env,
    { timeoutMs: RUNTIME_UPDATE_TIMEOUT_MS },
  );
  // Only the helper's host-authored receipt for this exact VM proves the
  // guest committed the update; its guest output never reaches stdout.
  const updated = r.ok
    && (r.stdout || "").split(/\r?\n/).includes(`HIVRA_GUEST_RUNTIME_UPDATED vmid=${vmid}`);
  if (!updated) {
    log.warn("hivra runtime update outcome could not be verified", {
      source,
      failureType: "hivra_agent_runtime_update_unverified",
      userId,
      agentId: agent.id,
      vmid,
      trigger,
      hostOk: r.ok,
      errorMessage: r.error ?? null,
      stderr: r.stderr?.slice(0, 300) ?? null,
    });
    // Once a provider command has been submitted, a failed SSH result is an
    // unknown outcome: keep the exact lease so the bounded reconciler can
    // inspect provider evidence before allowing a retry.
    await recordHivraAgentOperationFailure({
      userId,
      agentId: String(agent.id),
      operationId,
      error: providerFailureDetail(r, "Runtime update outcome is unknown").slice(0, 300),
    }).catch(() => false);
    return failure("unverified", 502, "The connection service update could not be verified. Refresh this computer before trying again.");
  }
  await activityCredential.recordIssued(r);
  await activityCredential.recordInstall(r);
  const completed = await completeHivraAgentOperation({
    userId,
    agentId: String(agent.id),
    operationId,
    expectedDesiredState: "running",
    status: "running",
  });
  if (!completed) {
    await releaseHivraAgentOperation({
      userId,
      agentId: String(agent.id),
      operationId,
      error: "Runtime update completion was superseded.",
      markError: false,
    }).catch(() => false);
    log.error("hivra agent runtime updated but operation completion was superseded", new Error("Operation CAS failed"), {
      source,
      failureType: "hivra_agent_runtime_update_status_persist_failed",
      userId,
      agentId: agent.id,
      vmid,
    });
    return failure("superseded", 409, "The connection service was updated, but a newer lifecycle request superseded it. Refresh before retrying.");
  }
  const agentCli = parseAgentCliReport(r.stdout || "");
  await logHivraAgentEvent({
    userId,
    event: "runtime_updated",
    agentId: String(agent.id),
    agentType: typeof agent.type === "string" ? agent.type : null,
    // An owner's update is recorded exactly as before; only the sweep's says so.
    detail: { inPlace: true, ...(agentCli ? { agentCli } : {}), ...(trigger === "auto" ? { trigger } : {}) },
  });
  return { ok: true, agentCli };
}
