// Hivra agent lifecycle: stop / start / restart / force_stop / force_restart /
// update_runtime / resize / snapshot / restore / rename.
// stop: qm shutdown (qm stop if it hasn't shut down after 50 s; the response
// says so) -> status=stopped. force_stop: qm stop at once, under the stop
// lease. force_restart: qm stop at once, then the start helper, under the
// restart lease. start/restart/resize: re-run the host
// start helper (qm start + re-establish the box tunnel + rewrite the prov log)
// and set status=provisioning so the existing [id] poll captures the (new)
// chat_url. update_runtime: refresh the guest's Hivra runtime in place (no VM
// power change) and complete as running on the helper's receipt. rename:
// metadata only (no host call).

export const runtime = "nodejs";
export const maxDuration = 300;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { randomUUID } from "node:crypto";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { advanceProviderAgentPower } from "@/lib/hivra/provider-agent-power";
import { claimProviderAgentPowerOperation } from "@/lib/hivra/provider-agent-power-store";
import type { ProviderAgentPowerStage } from "@/lib/hivra/provider-power-contract";

import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { sanitizeHivraAgentRow } from "@/lib/hivra/agent-llm";
import { log } from "@/lib/logger";
import {
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
  buildAgentContainerCgroupScript,
  type HostScriptResult,
} from "@/lib/services/proxmox-instance-service";
import { resizeFloor, getAgent, MAX_CPU, MAX_RAM } from "@/lib/hivra/agent-catalog";
import { validateAgentResources } from "@/lib/hivra/resource-gate";
import { GOALS } from "@/lib/hivra/agent-identity";
import { MAX_CONTEXT_LEN } from "@/lib/hivra/agent-limits";
import { getPersonaSoul } from "@/lib/persona-souls-accessor";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { priorityToCpuUnits } from "@/lib/proxmox/cpu-priority";
import { checkHostWakeCapacity } from "@/lib/proxmox/wake-admission";
import { resolveRamBurst } from "@/lib/services/ram-burst";
import { buildHostCapacityAdmissionCommand, resolveProxmoxHostCapacityPolicy } from "@/lib/infrastructure/host-capacity-policy";
import { PORTABLE_HIVRA_PROVISIONER_VERSION } from "@/lib/infrastructure/portable-provisioner-contract";
import { buildHivraRestoreIfMissingScript } from "@/lib/hivra/archive-agent";
import {
  resolveHivraIpLastOctetStart,
  resolveHivraSubnetPrefix,
  resolveHivraVmidStart,
  shellQuote,
} from "@/lib/hivra/proxmox-target";
import {
  describeHivraAgentExecutionContextError,
  hivraAgentProvisionLogPath,
  hivraAgentStartLogPath,
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import { checkManagedHivraHostReadiness } from "@/lib/hivra/managed-provisioner-readiness";
import {
  buildHivraSnapshotCreateScript,
  buildHivraSnapshotRestoreScript,
  parseHivraSnapshotCreateEvidence,
  parseHivraSnapshotRestoreEvidence,
} from "@/lib/hivra/agent-snapshots";
import {
  beginHivraAgentSnapshot,
  beginHivraAgentSnapshotRestore,
  claimHivraAgentOperation,
  completeHivraAgentSnapshot,
  completeHivraAgentSnapshotRestore,
  completeHivraAgentOperation,
  continueHivraAgentOperation,
  continueHivraAgentResizeOperation,
  recordHivraAgentOperationFailure,
  releaseHivraAgentOperation,
} from "@/lib/hivra/agent-operation-store";
import type {
  HivraAgentDesiredState,
  HivraAgentOperationKind,
} from "@/lib/hivra/agent-authority";
import {
  matchPreparedCanaryComputer,
  preparedCanaryLifecycleScript,
} from "@/lib/hivra/prepared-canary-computers";
import {
  doSessionActionFor,
  isForcePowerAction,
  isGvisorAction,
  isPreparedAction,
  isPreparedProfile,
  isProxmoxAction,
  isWindowsOnMyServer,
  providerRefusalFor,
  runtimeUpdateRefusal,
} from "@/lib/hivra/lifecycle-support";
import { revokeRemoteDesktopCapability } from "@/lib/remote-computers/session-broker";
import { GvisorComputerError, mutateGvisorComputer } from "@/lib/hivra/gvisor-computer-service";
import { managedSessionAction } from "@/lib/hivra/do-managed-sessions";
import { managedSessionFailure } from "@/app/api/hivra/managed-sessions/route-support";
import {
  issueActivityCollectorCredential,
  parseActivityCollectorMarker,
  recordActivityCollectorIssued,
  recordCollectorInstallResult,
  supportsNativeTracing,
  type ActivityCollectorCredential,
} from "@/lib/activity-observability/collectors";

// Printed by the start kickoff only after the reporter credential file was
// written for a start helper that consumes it.
const ACTIVITY_CREDENTIAL_STAGED = "HIVRA_ACTIVITY_CREDENTIAL_STAGED";

// The in-place runtime update runs synchronously inside this request. Bound the
// host script below maxDuration so a stalled guest yields a recorded unknown
// outcome for the reconciler instead of a killed function with nothing saved.
const RUNTIME_UPDATE_TIMEOUT_MS = 240_000;
// The updater's own deadline, counted on the host from the first line of the
// script (so it includes the FD8 wait). The margin covers the SSH connection
// and the result's trip back before RUNTIME_UPDATE_TIMEOUT_MS; the updater
// skips its optional reporter step rather than run past this deadline.
const RUNTIME_UPDATE_HOST_BUDGET_SECONDS = RUNTIME_UPDATE_TIMEOUT_MS / 1000 - 20;

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function providerFailureDetail(result: HostScriptResult, fallback: string): string {
  return result.stderr.trim() || result.error?.trim() || fallback;
}

function clampCpu(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const halfStep = Math.round(n * 2) / 2;
  return Math.min(max, Math.max(min, halfStep));
}

function clampStr(v: unknown, max: number): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
}

function lifecycleBindingVerificationBody(): string {
  return `if [ -n "$EXPECTED_BINDING_TAG" ]; then
  TAGS="$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')"
  printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG" \
    || { echo "refusing to mutate VMID $VMID without its exact Hivra binding tag" >&2; exit 1; }
fi`;
}

function lifecycleVmAuthorityBody(): string {
  return `qm status "$VMID" >/dev/null
${lifecycleBindingVerificationBody()}`;
}

function lifecycleMutationPrelude(
  vmid: number,
  bindingTag: string | null,
  allowMissingForManagedRestore = false,
): string {
  const vmAuthority = allowMissingForManagedRestore
    ? `if qm status "$VMID" >/dev/null 2>&1; then
  ${lifecycleBindingVerificationBody().replaceAll("\n", "\n  ")}
fi`
    : lifecycleVmAuthorityBody();
  return `set -euo pipefail
VMID=${vmid}
EXPECTED_BINDING_TAG=${shellQuote(bindingTag ?? "")}
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for the Hivra lifecycle lock" >&2; exit 1; }
${vmAuthority}`;
}

// How a stop ended, printed by the host: "graceful" (the computer shut itself
// down in time), "forced <waited> <budget>" (qm shutdown gave up after
// <waited> seconds, measured on the host, of the <budget> it was given, so
// qm stop switched it off) or "already" (it was off). Only "forced" changes
// what the owner is told.
const STOP_MODE_LINE = /^HIVRA_STOP_MODE (graceful|forced|already)\b(.*)$/m;

/**
 * How Stop or Restart ended. `waitedSeconds` (the budget) only when qm
 * shutdown used the whole budget, i.e. the computer didn't shut down in time;
 * a shutdown that failed sooner (the guest refused, or the host couldn't ask
 * it) switched it off with no wait to report.
 */
type StopOutcome = { forced: true; waitedSeconds?: number };

function stopOutcome(stdout: string | undefined): StopOutcome | null {
  const match = STOP_MODE_LINE.exec(stdout || "");
  if (match?.[1] !== "forced") return null;
  const [waited, budget] = match[2].trim().split(/\s+/).map(Number);
  // `date +%s` steps in whole seconds, so a full wait can read one short.
  const timedOut = Number.isInteger(waited) && Number.isInteger(budget) && budget > 0 && waited >= budget - 1;
  return { forced: true, ...(timedOut ? { waitedSeconds: budget } : {}) };
}

/** The History reason for a Stop or Restart that had to switch the computer off. */
function stopOutcomeEvent(outcome: StopOutcome | null): { detail?: { forced: true; reason: "shutdown_timeout" | "shutdown_failed" } } {
  if (!outcome) return {};
  return { detail: { forced: true, reason: outcome.waitedSeconds ? "shutdown_timeout" : "shutdown_failed" } };
}

function verifiedStopVmBody(vmid: number, timeoutSeconds: number): string {
  return `VMID=${vmid}
STOP_MODE=already
CURRENT_STATUS="$(qm status "$VMID" | awk '{print $2}')"
if [ "$CURRENT_STATUS" != "stopped" ]; then
  SHUTDOWN_STARTED="$(date +%s)"
  if qm shutdown "$VMID" --timeout ${timeoutSeconds}; then
    STOP_MODE=graceful
  else
    SHUTDOWN_WAITED="$(( $(date +%s) - SHUTDOWN_STARTED ))"
    [ "$SHUTDOWN_WAITED" -ge 0 ] || SHUTDOWN_WAITED=0
    qm stop "$VMID"
    STOP_MODE="forced $SHUTDOWN_WAITED ${timeoutSeconds}"
  fi
fi
FINAL_STATUS="$(qm status "$VMID" | awk '{print $2}')"
if [ "$FINAL_STATUS" != "stopped" ]; then
  echo "VMID $VMID did not stop (status=$FINAL_STATUS)" >&2
  exit 1
fi
echo "stopped $VMID"
echo "HIVRA_STOP_MODE $STOP_MODE"`;
}

// Force off: switch the computer off at once, without asking it to shut
// down. --overrule-shutdown also ends a shutdown already under way (PVE 8.1
// and later); an older host without that option still gets a plain qm stop.
// Success is only the final status read back as stopped, reported by the
// exact receipt line for this VM.
const FORCE_STOPPED_RECEIPT = "HIVRA_FORCE_STOPPED";

function forcedStopVmBody(vmid: number): string {
  return `VMID=${vmid}
CURRENT_STATUS="$(qm status "$VMID" | awk '{print $2}')"
if [ "$CURRENT_STATUS" != "stopped" ]; then
  if ! qm stop "$VMID" --overrule-shutdown 1 --timeout 30; then
    qm stop "$VMID" --timeout 30 || echo "qm stop did not complete for VMID $VMID" >&2
  fi
fi
FINAL_STATUS="$(qm status "$VMID" | awk '{print $2}')"
if [ "$FINAL_STATUS" != "stopped" ]; then
  echo "VMID $VMID did not switch off (status=$FINAL_STATUS)" >&2
  exit 1
fi
echo "${FORCE_STOPPED_RECEIPT} vmid=$VMID"`;
}

function verifiedStopVmScript(vmid: number, timeoutSeconds: number, bindingTag: string | null): string {
  return `${lifecycleMutationPrelude(vmid, bindingTag)}
${verifiedStopVmBody(vmid, timeoutSeconds)}`;
}

// Live browser-automation state for a box, read from the same source the UI uses
// (the box's /api/browser/status keeper probe — `enabled` is the real runtime
// state). There is no DB column for this, so the authoritative resize gate has to
// ask the box. Fail SAFE: if the box can't be reached (or no URL), assume browser
// ON so the higher 2/4 floor is enforced and a resize can't brick the Chrome stack.
async function probeBoxBrowserEnabled(chatUrl: string | null, token: string | null): Promise<boolean> {
  if (!chatUrl) return true;
  try {
    const r = await fetch(`${chatUrl.replace(/\/$/, "")}/api/browser/status`, {
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!r.ok) return true;
    const j = (await r.json().catch(() => ({}))) as { enabled?: boolean };
    return Boolean(j.enabled);
  } catch {
    return true;
  }
}

/**
 * The runtime updater's host-validated agent CLI line (Claude Code / Codex
 * computers): the installed version, this release's vetted version
 * (AGENT_CLI_VERSIONS) and whether a background swap was scheduled. The swap
 * itself runs on the computer after this request; GET /api/meta agentCli.update
 * reports its progress.
 */
type AgentCliUpdateReport = {
  name: "claude-code" | "codex";
  version: string | null;
  target: string;
  state: "current" | "scheduled" | "running" | "failed";
};
const AGENT_CLI_LINE = /^HIVRA_AGENT_CLI name=(claude-code|codex) version=(\d{1,6}\.\d{1,6}\.\d{1,6}|unknown) target=(\d{1,6}\.\d{1,6}\.\d{1,6}) state=(current|scheduled|running|failed)$/;
function parseAgentCliReport(stdout: string): AgentCliUpdateReport | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = AGENT_CLI_LINE.exec(line);
    if (match) {
      return {
        name: match[1] as AgentCliUpdateReport["name"],
        version: match[2] === "unknown" ? null : match[2],
        target: match[3],
        state: match[4] as AgentCliUpdateReport["state"],
      };
    }
  }
  return null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || "");

    const { data: agent } = await supabaseAdmin
      .from("hivra_agents")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .single();
    if (!agent) return apiError("Agent not found", 404);

    // rename is metadata-only — no box required.
    if (action === "rename") {
      const name = String(body.name ?? "").trim();
      if (name.length < 1 || name.length > 60) return apiError("Name must be 1–60 characters", 400);
      const { data: updated } = await supabaseAdmin
        .from("hivra_agents")
        .update({ name })
        .eq("id", agent.id)
        .select()
        .single();
      return apiSuccess({ name, agent: sanitizeHivraAgentRow(updated || { ...agent, name }) });
    }

    if (action === "onboarding") {
      const goalRaw = clampStr(body.goal, 32);
      const goal = goalRaw && GOALS.some((g) => g.id === goalRaw) ? goalRaw : null;
      const context = clampStr(body.context, MAX_CONTEXT_LEN);
      const firstTask = clampStr(body.firstTask, 700);
      // Onboarding is also used by the provisioning-page autosave, which only
      // owns goal/context/firstTask. Treat persona fields as partial updates so
      // that omitting them cannot erase the persona chosen in the welcome flow.
      // An explicitly supplied empty/null value still clears the field.
      const personalityProvided = Object.prototype.hasOwnProperty.call(body, "personality");
      const emojiProvided = Object.prototype.hasOwnProperty.call(body, "emoji");
      const personality = personalityProvided ? clampStr(body.personality, 48) : null;
      const emoji = emojiProvided ? clampStr(body.emoji, 16) : null;
      // Persona-souls upgrade: only persist a soulPromptId that resolves to an
      // authored soul; anything else (custom persona, unknown/stale id, absent)
      // stays null so the box keeps the generic SOUL.md path (zero-regression).
      const soulPromptRaw = clampStr(body.soulPromptId, 32);
      const soulPromptId = getPersonaSoul(soulPromptRaw) ? soulPromptRaw : null;
      const patch: Record<string, unknown> = {
        goal,
        context,
        first_task: firstTask || null,
        bootstrapped_at: null,
      };
      if (personalityProvided) patch.personality = personality;
      if (emojiProvided) patch.emoji = emoji;
      const { data: updated, error: updateError } = await supabaseAdmin
        .from("hivra_agents")
        .update(patch)
        .eq("id", agent.id)
        .eq("user_id", userId)
        .select()
        .single();
      if (updateError) return apiError("Failed to save onboarding answers", 500, updateError);
      // Best-effort, separate write so a not-yet-applied migration (the soul_prompt_id
      // column) can never break the onboarding critical path. If the column is missing,
      // this no-ops and the box keeps the generic SOUL.md until the migration lands.
      if (soulPromptId) {
        const { error: soulError } = await supabaseAdmin
          .from("hivra_agents")
          .update({ soul_prompt_id: soulPromptId })
          .eq("id", agent.id)
          .eq("user_id", userId);
        if (soulError) {
          log.info("hivra agent soul_prompt_id write skipped (migration pending?)", {
            source: "hivra/agents/[id]/action",
            failureType: "hivra_agent_soul_prompt_id_write_skipped",
            userId,
            agentId: agent.id,
            error: soulError.message,
          });
        }
      }
      log.info("hivra agent onboarding answers saved", {
        source: "hivra/agents/[id]/action",
        failureType: "hivra_agent_onboarding_saved",
        userId,
        agentId: agent.id,
        agentType: agent.type,
        goal,
        hasContext: Boolean(context),
        hasFirstTask: Boolean(firstTask),
        hasPersonality: personalityProvided ? Boolean(personality) : Boolean(agent.personality),
        hasEmoji: emojiProvided ? Boolean(emoji) : Boolean(agent.emoji),
        soulPromptId: soulPromptId ?? null,
      });
      return apiSuccess({ agent: sanitizeHivraAgentRow(updated || { ...agent, ...patch }) });
    }

    if (agent.computer_substrate === "do-managed-session") {
      if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
      const managedAction = doSessionActionFor(action);
      if (!managedAction) {
        return apiError("DigitalOcean sessions support start (resume), stop (pause), and delete.", 400);
      }
      try {
        return apiSuccess({ session: await managedSessionAction(userId, String(agent.id), managedAction) });
      } catch (error) {
        return managedSessionFailure(error, "/api/hivra/agents/[id]/action");
      }
    }

    if (agent.computer_substrate === "gvisor") {
      if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
      if (!isGvisorAction(action)) {
        return apiError("This Linux terminal sandbox does not support that lifecycle operation.", 400);
      }
      let cpu: number | undefined;
      let ramGb: number | undefined;
      if (action === "resize") {
        cpu = Number(body.cpu);
        ramGb = Number(body.ram);
        const maximumCpu = body.maximumCpu === undefined ? cpu : Number(body.maximumCpu);
        const maximumRam = body.maximumRam === undefined ? ramGb : Number(body.maximumRam);
        if (!Number.isFinite(cpu) || cpu < 0.5 || cpu > 32 || Math.round(cpu * 2) !== cpu * 2
          || !Number.isInteger(ramGb) || ramGb < 1 || ramGb > 128
          || maximumCpu !== cpu || maximumRam !== ramGb) {
          return apiError("gVisor computers reserve their full CPU and memory limit; reserved and maximum values must match.", 400);
        }
      }
      try {
        const updated = await mutateGvisorComputer(userId, String(agent.id), {
          action,
          ...(action === "resize" ? { cpu, ramGb } : {}),
        });
        return apiSuccess({ agent: sanitizeHivraAgentRow(updated) });
      } catch (error) {
        if (error instanceof GvisorComputerError) {
          const status = error.code === "not_found" ? 404
            : error.code === "conflict" || error.code === "not_ready" ? 409 : 503;
          return apiError(error.message, status);
        }
        throw error;
      }
    }

    if (!isProxmoxAction(action)) {
      return apiError("Unknown action", 400);
    }
    if ((["update_runtime", "snapshot", "restore"].includes(action) || isForcePowerAction(action)) && !isSameOriginMutationRequest(req)) {
      return apiError("Same-origin request required.", 403);
    }
    // A DeepSeek guest also runs a native adapter and service generation that
    // the gateway-only updater cannot replace, so the guest step refuses before
    // changing anything. Refuse here, before any lease or host call: sent to
    // the host, that refusal would read as an unverified outcome and hold the
    // lease (blocking Stop, Restart and Resize) until the reconciler clears it.
    if (action === "update_runtime" && runtimeUpdateRefusal(agent) === "deepseek") {
      return apiError("DeepSeek computers can’t update their connection service here yet. Nothing was changed.", 409);
    }

    const invalidateDesktopBeforePower = async (operationId: string) => {
      // Fence the previous boot's attestation under the claimed power operation.
      // The existing revocation contract preserves controller release ACKs.
      const revoked = await revokeRemoteDesktopCapability({
        userId, computerKind: "hivra-agent", computerId: String(agent.id),
      });
      if (revoked.ok) return true;
      await releaseHivraAgentOperation({
        userId, agentId: String(agent.id), operationId,
        error: "Desktop capability invalidation failed before a lifecycle command was sent.",
        markError: false,
      }).catch(() => false);
      return false;
    };
    const desktopInvalidationFailure = () => apiError("The desktop capability could not be invalidated. No lifecycle command was sent.", 503);
    // Force off and Force restart are rarer than Stop and can lose unsaved
    // work, so they have their own tighter limit on top of the adapter's.
    const forcePowerLimit = () => enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "hivra_agent_force_power",
      userId,
      limit: 6,
      windowMs: 10 * 60_000,
    });
    const FORCE_BUSY = "Hivra is still finishing another change to this computer. Wait for it to finish, then try again.";

    const preparedProfile = isPreparedProfile(agent);
    const preparedComputer = matchPreparedCanaryComputer(agent);
    // A prepared-profile row must never fall through to the general Ubuntu
    // provisioner merely because its server-side slot configuration is stale.
    // A Windows computer on the owner's own server has no lifecycle adapter
    // yet, and Manage shows its power controls as unavailable for that reason.
    if (preparedProfile && !preparedComputer) {
      return apiError(isWindowsOnMyServer(agent)
        ? "Hivra can't start, stop, restart or change a Windows computer on your own server yet. Use your server's console. Nothing was changed."
        : "This prepared computer no longer matches the setup Hivra has on record, so no command was sent.", 409);
    }
    if (preparedComputer) {
      if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
      if (!isPreparedAction(action)) {
        return apiError("This prepared computer does not support that action yet. Its machine and data are unchanged.", 400);
      }
      const limited = enforceAuthenticatedRouteRateLimit(req, {
        routeKey: "prepared_computer_lifecycle",
        userId,
        limit: 12,
        windowMs: 15 * 60_000,
      });
      if (limited) return limited;
      const forced = isForcePowerAction(action);
      if (forced) {
        const forceLimited = forcePowerLimit();
        if (forceLimited) return forceLimited;
      }
      const env = resolveProxmoxTargetConfiguration(process.env, preparedComputer.slot.host).env;
      if (action === "start") {
        const cap = await checkHostWakeCapacity(Number(agent.ram) * 1024, env);
        if (!cap.ok) return apiError("Host is at capacity — try again shortly", 503);
      }
      const operationId = randomUUID();
      const stopping = action === "stop" || action === "force_stop";
      const desiredState = stopping ? "stopped" : "running";
      // Force off and Force restart take the same lease kinds as Stop and Restart.
      const operationKind = action === "force_stop" ? "stop" : action === "force_restart" ? "restart" : action;
      const claimed = await claimHivraAgentOperation({
        userId,
        agentId: String(agent.id),
        operationId,
        operationKind,
        desiredState,
        operationPayload: null,
      });
      if (!claimed) return apiError(forced ? FORCE_BUSY : "Another lifecycle operation is already in progress.", 409);
      if (!await invalidateDesktopBeforePower(operationId)) return desktopInvalidationFailure();
      const result = await runProxmoxHostScript(
        preparedCanaryLifecycleScript(preparedComputer.profile, preparedComputer.slot, action),
        env,
        { timeoutMs: 120_000, maxOutputBytes: 16_384 },
      );
      const expectedReceipt = `HIVRA_PREPARED_LIFECYCLE ${preparedComputer.profile} ${action} ${desiredState}`;
      if (!result.ok || !result.stdout.split(/\r?\n/).includes(expectedReceipt)) {
        await recordHivraAgentOperationFailure({
          userId,
          agentId: String(agent.id),
          operationId,
          error: providerFailureDetail(result, "Prepared computer lifecycle outcome is unknown").slice(0, 300),
        }).catch(() => false);
        return apiError("The prepared computer lifecycle outcome could not be verified. Its operation is retained for inspection before another command is sent.", 502);
      }
      const completed = await completeHivraAgentOperation({
        userId,
        agentId: String(agent.id),
        operationId,
        expectedDesiredState: desiredState,
        status: desiredState,
      });
      if (!completed) {
        await recordHivraAgentOperationFailure({
          userId,
          agentId: String(agent.id),
          operationId,
          error: "Prepared lifecycle completion was superseded before durable evidence was saved.",
        }).catch(() => false);
        return apiError("The computer reached its requested power state, but its durable status was superseded. Refresh before trying another action.", 409);
      }
      const switchedOff = forced ? null : stopOutcome(result.stdout);
      await logHivraAgentEvent({
        userId,
        event: action === "force_stop" ? "force_stopped"
          : action === "force_restart" ? "force_restarted"
            : action === "stop" ? "stopped" : action === "restart" ? "restarted" : "started",
        agentId: agent.id,
        agentType: agent.type,
        ...stopOutcomeEvent(switchedOff),
      });
      return apiSuccess({
        status: desiredState,
        ...(forced ? { forced: true } : switchedOff ?? {}),
      });
    }
    if (agent.computer_substrate === "provider-vm") {
      if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
      const refusal = providerRefusalFor(action);
      if (refusal) return apiError(refusal, 400);
      const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "provider_agent_power", userId, limit: 30, windowMs: 5 * 60_000 });
      if (limited) return limited;
      const operation = { userId, agentId: String(agent.id), operationId: randomUUID() };
      if (!await claimProviderAgentPowerOperation(operation, action as "start" | "stop" | "restart")) {
        return apiError("This computer cannot accept that power request in its current state. Refresh its status before trying again.", 409);
      }
      let stage: ProviderAgentPowerStage;
      try { stage = await advanceProviderAgentPower(operation, "dispatch"); }
      catch {
        stage = "verification_unavailable";
        log.warn("provider power operation is unverified", { source: "hivra/agents/[id]/action",
          failureType: "provider_agent_power_unverified", userId, agentId: agent.id, action });
      }
      const { data: current, error: reloadError } = await supabaseAdmin.from("hivra_agents").select("*")
        .eq("id", agent.id).eq("user_id", userId).eq("computer_substrate", "provider-vm").single();
      if (reloadError || !current) return apiError("The original power request is retained, but its current status could not be refreshed. Check status before sending another action.", 503);
      const response = apiSuccess({ agent: { ...sanitizeHivraAgentRow(current),
        ...(current.status === "provisioning" && current.operation_id === operation.operationId ? { power_stage: stage } : {}) } }, current.status === "provisioning" ? 202 : 200);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    if (!agent.vmid) return apiError("Agent has no box yet", 400);

    let executionContext: HivraAgentExecutionContext;
    try {
      executionContext = await resolveHivraAgentExecutionContext(userId, agent);
    } catch (contextError) {
      const safeError = describeHivraAgentExecutionContextError(contextError);
      if (safeError) return apiError(safeError.message, safeError.status);
      throw contextError;
    }
    // Self-managed unenforced rows fail during context resolution. Managed
    // N-1 rows are the one narrow compatibility exception: migration cannot
    // safely stamp a provider tag without touching live hosts. Every new row is
    // enforced, and the legacy path remains exact managed host + persisted VMID.
    const lifecycleBindingTag = executionContext.infrastructureBindingTagEnforced
      ? executionContext.infrastructureBindingTag
      : null;
    const env = executionContext.env;

    // start/restart/resize all invoke the versioned start helper after crossing
    // a provider mutation boundary. Existing managed agents may still live on
    // hosts with an older compatible bundle, so prove the exact selected host
    // and persisted channel have an admitted VERSION, intact manifest, and
    // exact-result-path capability before claiming an operation lease or issuing
    // any VM command. Explicit runtime updates require the current version. Stop
    // and Force off do not call the helper and deliberately remain available for
    // stale hosts.
    if (executionContext.kind === "managed" && action !== "stop" && action !== "force_stop") {
      const readiness = await checkManagedHivraHostReadiness({
        targetId: executionContext.host,
        env,
        channel: executionContext.provisionerChannel,
        purpose: action === "update_runtime" ? "runtime-update" : "lifecycle",
      });
      if (!readiness.ok) {
        log.warn("hivra managed lifecycle blocked by stale host provisioner", {
          source: "hivra/agents/[id]/action",
          failureType: "hivra_agent_lifecycle_host_readiness_failed",
          userId,
          agentId: agent.id,
          proxmoxHost: executionContext.host,
          action,
          readinessError: readiness.error,
        });
        return apiError(readiness.message, readiness.status);
      }
    }

    const vmid = Number(agent.vmid);
    const vmidStart = resolveHivraVmidStart(env);
    // The IP we stored at provision time is the source of truth. The octet is no
    // longer a fixed function of VMID (the allocator now skips in-use IPs to avoid
    // collisions) and legacy boxes use an older vmid->octet scheme — so recomputing
    // from VMID would ssh to the wrong guest (or a negative octet for legacy boxes,
    // 500ing their lifecycle ops). Fall back to the VMID-derived octet only when
    // the row predates ip persistence.
    const storedOctet =
      typeof agent.ip === "string"
        ? Number.parseInt(String(agent.ip).split(".").pop() ?? "", 10)
        : NaN;
    const octet = Number.isInteger(storedOctet)
      ? storedOctet
      : resolveHivraIpLastOctetStart(env) + (vmid - vmidStart);
    if (!Number.isInteger(vmid) || !Number.isInteger(octet) || octet < 2 || octet > 254) {
      log.error("hivra agent lifecycle IP octet is outside the host range", new Error("Invalid Hivra IP octet"), {
        source: "hivra/agents/[id]/action",
        failureType: "hivra_agent_lifecycle_invalid_ip_octet",
        userId,
        agentId: agent.id,
        proxmoxHost: agent.proxmox_host ?? null,
        vmid,
        vmidStart,
        octet,
      });
      return apiError("Hivra host IP range is not configured for this box", 500);
    }
    const subnetPrefix = resolveHivraSubnetPrefix(env);
    // Named-tunnel boxes have a stable URL; pass it so the start helper keeps it
    // (reconnects the systemd tunnel) instead of minting a fresh quick-tunnel URL.
    const tunnelEnv = agent.cf_hostname ? `HIVRA_TUNNEL_URL='https://${String(agent.cf_hostname).replace(/[^a-zA-Z0-9.-]/g, "")}' ` : "";
    // Self-healing wake: a COLD-ARCHIVED box has had its disk reclaimed and no
    // longer exists on the host, but its row still says status='stopped' (the
    // Hivra lane has no archive state machine — see lib/hivra/archive-agent.ts).
    // Restore it from the Storage Box first when it is missing; a no-op for a
    // merely-parked box. Runs SYNCHRONOUSLY before the backgrounded start helper
    // so a failed restore surfaces as "Start failed" instead of kicking a start
    // against a VM that isn't there. Coordinate-preserving: same vmid, same IP
    // octet, same named tunnel, so the start helper below is unchanged.
    // FAIL-SOFT on purpose. The restore prefix is an ENHANCEMENT to start; it
    // must never be able to break it. buildHivraRestoreIfMissingScript throws on
    // an id/host it would otherwise interpolate into shell, so an unexpected
    // shape (legacy row, fixture, hand-inserted record) would 500 the whole
    // Start action rather than just skipping the restore. Degrade to today's
    // behaviour — plain start — and log it, since the only cost is that a box
    // whose disk was archived won't self-heal.
    let restorePrefix = "";
    if (executionContext.kind === "managed" && agent.proxmox_host) {
      try {
        restorePrefix = `${buildHivraRestoreIfMissingScript(
          vmid,
          String(agent.proxmox_host),
          String(agent.id),
        )}\n`;
      } catch (e) {
        log.info("hivra restore-on-start prefix skipped", {
          source: "hivra/agents/[id]/action",
          failureType: "hivra_restore_prefix_skipped",
          userId,
          agentId: agent.id,
          proxmoxHost: agent.proxmox_host ?? null,
          vmid,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    const provisionLog = hivraAgentProvisionLogPath(executionContext, vmid);
    const startLog = hivraAgentStartLogPath(executionContext, vmid);
    const startEnvironment = [
      `HIVRA_LOG_DIR=${shellQuote(executionContext.paths.logDirectory)}`,
      `HIVRA_RESULT_LOG_PATH=${shellQuote(startLog)}`,
      executionContext.paths.vmSshKeyPath
        ? `HIVRA_VM_SSH_KEY_PATH=${shellQuote(executionContext.paths.vmSshKeyPath)}`
        : null,
    ].filter((value): value is string => Boolean(value)).join(" ") + " ";
    const startHelper = `${executionContext.paths.provisionerDirectory}/hivra-start-on-host.sh`;
    const capacityPolicy = resolveProxmoxHostCapacityPolicy(executionContext.capacityPolicy);
    const runtimeUpdateHelper = `${executionContext.paths.provisionerDirectory}/hivra-update-guest-runtime.sh`;
    const lifecyclePrelude = lifecycleMutationPrelude(
      vmid,
      lifecycleBindingTag,
    );
    // Managed cold restore is itself a provider mutation. Hold the same FD8
    // lease before checking/restoring a missing VM, then require the restored
    // config to carry the stable binding tag for every enforced row before the
    // start helper inherits that lock. Backfilled managed rows retain only the
    // narrow exact-host/VMID compatibility path (empty binding tag).
    const startLifecyclePrelude = restorePrefix
      ? `${lifecycleMutationPrelude(vmid, lifecycleBindingTag, true)}
${restorePrefix}${lifecycleVmAuthorityBody()}`
      : lifecyclePrelude;
    // Agent-run reporting: every start-helper run (and every in-place runtime
    // update) of a Claude Code / Codex Proxmox computer re-issues its 7-day
    // reporter credential, replacing one that expired while stopped and
    // backfilling computers launched before reporting existed once their host
    // carries the new helper. The credential reaches the host only inside this
    // script (stdin to bash -s) and a root-only file the helper consumes and
    // deletes. Lifecycle readiness admits older helpers that cannot consume it,
    // so the file is written only after probing the exact helper that will run.
    // A deployment without an origin or signing secret skips silently; Activity
    // then shows the computer's coverage as missing.
    const activityCredentialFile = `/run/hivra-lifecycle/${vmid}.activity.env`;
    let stagedActivityCredential: ActivityCollectorCredential | null = null;
    const activityTelemetryKickoff = (helper: string): { stage: string; env: string } => {
      stagedActivityCredential = supportsNativeTracing(agent)
        ? issueActivityCollectorCredential({ userId: String(agent.user_id), agentId: String(agent.id) })
        : null;
      if (!stagedActivityCredential) return { stage: "", env: "" };
      const file = shellQuote(activityCredentialFile);
      const encoded = Buffer.from(JSON.stringify(stagedActivityCredential), "utf8").toString("base64");
      return {
        stage: `HIVRA_ACTIVITY_FILE=''; if grep -Fq HIVRA_ACTIVITY_TELEMETRY_FILE ${shellQuote(helper)} 2>/dev/null && install -d -m 0700 /run/hivra-lifecycle && install -m 0600 /dev/null ${file} && printf '%s\\n' ${shellQuote(`HIVRA_ACTIVITY_TELEMETRY_B64=${encoded}`)} > ${file}; then HIVRA_ACTIVITY_FILE=${file}; echo ${ACTIVITY_CREDENTIAL_STAGED}; else rm -f -- ${file} 2>/dev/null || true; fi; `,
        env: `HIVRA_ACTIVITY_TELEMETRY_FILE="$HIVRA_ACTIVITY_FILE" `,
      };
    };
    // Best effort, and only once the host confirmed the credential file exists:
    // a failed record never fails the lifecycle operation.
    const recordActivityCredentialIssued = async (result: HostScriptResult) => {
      const credential = stagedActivityCredential;
      if (!credential || !supabaseAdmin) return;
      if (!(result.stdout || "").split(/\r?\n/).includes(ACTIVITY_CREDENTIAL_STAGED)) return;
      const recorded = await recordActivityCollectorIssued(supabaseAdmin, {
        agentId: String(agent.id),
        userId: String(agent.user_id),
        expiresAt: credential.expiresAt,
        reason: "start",
      });
      if (!recorded) {
        log.warn("hivra activity collector issuance could not be recorded", {
          source: "hivra/agents/[id]/action",
          failureType: "hivra_activity_collector_issue_record_failed",
          userId,
          agentId: agent.id,
          action,
        });
      }
    };
    // A synchronous helper (the in-place runtime update) reports the reporter
    // install outcome on its own stdout instead of the start log the [id] poll
    // reads. Same closed-enum marker and the same best-effort record.
    const recordActivityCollectorInstall = async (result: HostScriptResult) => {
      if (!stagedActivityCredential || !supabaseAdmin) return;
      const lines = (result.stdout || "").split(/\r?\n/);
      if (!lines.includes(ACTIVITY_CREDENTIAL_STAGED)) return;
      const install = parseActivityCollectorMarker(lines);
      if (!install) return;
      const recorded = await recordCollectorInstallResult(supabaseAdmin, {
        agentId: String(agent.id),
        userId: String(agent.user_id),
        status: install.status,
        ...(install.reason ? { reason: install.reason } : {}),
      });
      if (!recorded) {
        log.warn("hivra agent-run reporter install result could not be recorded", {
          source: "hivra/agents/[id]/action",
          failureType: "hivra_activity_collector_install_record_failed",
          userId,
          agentId: agent.id,
          action,
        });
      }
    };
    const startKickoff = (operationId: string) => {
      const activity = activityTelemetryKickoff(startHelper);
      return `umask 077; install -m 0600 /dev/null ${shellQuote(provisionLog)}; install -m 0600 /dev/null ${shellQuote(startLog)}; printf 'HIVRA_OPERATION_ID %s\\n' ${shellQuote(operationId)} > ${shellQuote(startLog)}; ${activity.stage}nohup env HIVRA_OPERATION_ID=${shellQuote(operationId)} HIVRA_LIFECYCLE_LOCK_FD=8 HIVRA_BINDING_TAG=${shellQuote(lifecycleBindingTag ?? "")} HIVRA_BINDING_TAG_ENFORCED=${executionContext.infrastructureBindingTagEnforced ? "1" : "0"} HIVRA_HOST_MEMORY_RESERVE_MB=${capacityPolicy.hostMemoryReserveMb} HIVRA_ENFORCE_CEILING_DENSITY=${capacityPolicy.mode === "enforce" ? "1" : "0"} HIVRA_CPU_CEILING_DENSITY_MILLI=${Math.round(capacityPolicy.cpuCeilingDensity * 1000)} HIVRA_MEMORY_CEILING_DENSITY_MILLI=${Math.round(capacityPolicy.memoryCeilingDensity * 1000)} ${startEnvironment}HIVRA_SUBNET_PREFIX=${shellQuote(subnetPrefix)} ${tunnelEnv}${activity.env}bash ${shellQuote(startHelper)} ${vmid} ${octet} >>${shellQuote(startLog)} 2>&1 < /dev/null & disown; echo kicked`;
    };

    const claimProviderOperation = async (
      operationKind: Exclude<HivraAgentOperationKind, "provision" | "delete">,
      desiredState: Exclude<HivraAgentDesiredState, "deleted">,
      operationPayload:
        | { cpu: number; ram: number; maximumCpu?: number; maximumRam?: number }
        | { snapshotId: string; providerSnapshotId: string }
        | null = null,
    ): Promise<string | null> => {
      const operationId = randomUUID();
      const claimed = await claimHivraAgentOperation({
        userId,
        agentId: String(agent.id),
        operationId,
        operationKind,
        desiredState,
        operationPayload,
      });
      return claimed ? operationId : null;
    };

    const releaseProviderOperation = async (
      operationId: string,
      error: string,
      markError: boolean,
    ) => {
      await releaseHivraAgentOperation({
        userId,
        agentId: String(agent.id),
        operationId,
        error,
        markError,
      }).catch(() => false);
    };

    // Once a provider command has been submitted, a failed SSH result is an
    // unknown outcome: the remote shell or detached lifecycle helper may still
    // have crossed the mutation boundary. Preserve the exact lease so the
    // bounded reconciler can acquire FD8 and inspect provider evidence before
    // allowing a retry or delete to proceed.
    const retainUnknownProviderOperation = async (
      operationId: string,
      error: string,
    ) => {
      await recordHivraAgentOperationFailure({
        userId,
        agentId: String(agent.id),
        operationId,
        error: error.slice(0, 300),
      }).catch(() => false);
    };

    if (action === "snapshot") {
      if (!executionContext.infrastructureBindingTagEnforced) {
        return apiError("This legacy computer must be re-bound with current ownership evidence before creating restore points.", 409);
      }
      if (agent.status !== "running" && agent.status !== "stopped") {
        return apiError("Wait for the current computer operation to finish before creating a restore point.", 409);
      }
      const limited = enforceAuthenticatedRouteRateLimit(req, {
        routeKey: "hivra_agent_snapshot",
        userId,
        limit: 8,
        windowMs: 10 * 60_000,
      });
      if (limited) return limited;

      const operationId = randomUUID();
      const snapshotId = randomUUID();
      const providerSnapshotId = `hivra_${snapshotId.replaceAll("-", "")}`;
      const claimed = await beginHivraAgentSnapshot({
        userId,
        agentId: String(agent.id),
        operationId,
        snapshotId,
        providerSnapshotId,
      });
      if (!claimed) {
        return apiError("This computer cannot create another restore point right now. Finish its current operation or remove an older restore point first.", 409);
      }

      const result = await runProxmoxHostScript(
        buildHivraSnapshotCreateScript({
          vmid,
          bindingTag: executionContext.infrastructureBindingTag,
          providerSnapshotId,
          snapshotId,
          agentId: String(agent.id),
        }),
        env,
        { timeoutMs: 180_000 },
      );
      const evidence = result.ok
        ? parseHivraSnapshotCreateEvidence(result.stdout || "", providerSnapshotId)
        : null;
      if (!evidence) {
        await retainUnknownProviderOperation(
          operationId,
          providerFailureDetail(result, "Snapshot outcome is unknown"),
        );
        return apiError("The restore point outcome could not be verified yet. Its operation is saved and will be reconciled before another lifecycle change is allowed.", 502);
      }
      const completed = await completeHivraAgentSnapshot({
        userId,
        agentId: String(agent.id),
        operationId,
        snapshotId,
        providerStatus: evidence.providerStatus,
        snapshotConfigSha256: evidence.snapshotConfigSha256,
      });
      if (!completed) {
        await retainUnknownProviderOperation(operationId, "Snapshot completion was superseded before durable evidence was saved.");
        return apiError("The restore point exists, but its durable receipt could not be finalized safely. Refresh before trying another action.", 409);
      }
      await logHivraAgentEvent({
        userId,
        event: "snapshot_created",
        agentId: String(agent.id),
        agentType: String(agent.type),
        detail: { snapshotId },
      });
      return apiSuccess({ snapshotId, status: "ready" });
    }

    if (action === "restore") {
      if (!executionContext.infrastructureBindingTagEnforced) {
        return apiError("This legacy computer must be re-bound with current ownership evidence before restoring it.", 409);
      }
      const snapshotId = typeof body.snapshotId === "string" ? body.snapshotId.trim() : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(snapshotId)) {
        return apiError("Choose a valid restore point.", 400);
      }
      const limited = enforceAuthenticatedRouteRateLimit(req, {
        routeKey: "hivra_agent_restore",
        userId,
        limit: 5,
        windowMs: 10 * 60_000,
      });
      if (limited) return limited;
      const { data: snapshot, error: snapshotError } = await supabaseAdmin
        .from("hivra_agent_snapshots")
        .select("id, provider_snapshot_id, status, snapshot_config_sha256")
        .eq("id", snapshotId)
        .eq("agent_id", agent.id)
        .eq("user_id", userId)
        .maybeSingle();
      if (snapshotError) return apiError("Could not load that restore point.", 503);
      if (!snapshot || snapshot.status !== "ready" || typeof snapshot.snapshot_config_sha256 !== "string") {
        return apiError("That restore point is not ready to restore.", 409);
      }
      const operationId = randomUUID();
      const claimed = await beginHivraAgentSnapshotRestore({
        userId,
        agentId: String(agent.id),
        operationId,
        snapshotId,
      });
      if (!claimed) {
        return apiError("This restore point no longer matches the computer or another lifecycle operation is already in progress.", 409);
      }
      const result = await runProxmoxHostScript(
        buildHivraSnapshotRestoreScript({
          vmid,
          bindingTag: executionContext.infrastructureBindingTag,
          providerSnapshotId: String(snapshot.provider_snapshot_id),
          snapshotConfigSha256: snapshot.snapshot_config_sha256,
          operationId,
        }),
        env,
        { timeoutMs: 240_000 },
      );
      const evidence = result.ok
        ? parseHivraSnapshotRestoreEvidence(
            result.stdout || "",
            String(snapshot.provider_snapshot_id),
            snapshot.snapshot_config_sha256,
          )
        : null;
      if (!evidence) {
        await retainUnknownProviderOperation(
          operationId,
          providerFailureDetail(result, "Restore outcome is unknown"),
        );
        return apiError("The restore outcome could not be verified yet. The computer stays locked from conflicting changes while Hivra reconciles the exact restore point.", 502);
      }
      const completed = await completeHivraAgentSnapshotRestore({
        userId,
        agentId: String(agent.id),
        operationId,
        snapshotId,
        snapshotConfigSha256: evidence.snapshotConfigSha256,
      });
      if (!completed) {
        await retainUnknownProviderOperation(operationId, "Restore completion was superseded before durable evidence was saved.");
        return apiError("The provider restore completed, but its durable receipt could not be finalized safely. Refresh before trying another action.", 409);
      }
      await logHivraAgentEvent({
        userId,
        event: "snapshot_restored",
        agentId: String(agent.id),
        agentType: String(agent.type),
        detail: { snapshotId },
      });
      return apiSuccess({ snapshotId, status: "stopped" });
    }

    if (action === "stop") {
      const operationId = await claimProviderOperation("stop", "stopped");
      if (!operationId) return apiError("Another lifecycle operation is already in progress.", 409);
      if (!await invalidateDesktopBeforePower(operationId)) return desktopInvalidationFailure();
      const r = await runProxmoxHostScript(
        verifiedStopVmScript(vmid, 50, lifecycleBindingTag),
        env,
      );
      if (!r.ok) {
        await retainUnknownProviderOperation(operationId, providerFailureDetail(r, "Stop outcome is unknown"));
        return apiError("Stop failed", 502);
      }
      const completed = await completeHivraAgentOperation({
        userId,
        agentId: String(agent.id),
        operationId,
        expectedDesiredState: "stopped",
        status: "stopped",
      });
      if (!completed) {
        await releaseProviderOperation(operationId, "Stop completion was superseded.", false);
        log.error("hivra agent stopped but operation completion was superseded", new Error("Operation CAS failed"), {
          source: "hivra/agents/[id]/action",
          failureType: "hivra_agent_stop_status_persist_failed",
          userId,
          agentId: agent.id,
          vmid,
        });
        return apiError("The VM stopped, but a newer lifecycle request superseded it. Refresh before retrying.", 409);
      }
      // Stop asks the computer to shut down and switches it off only if it
      // hasn't in time; say which happened.
      const switchedOff = stopOutcome(r.stdout);
      await logHivraAgentEvent({
        userId, event: "stopped", agentId: agent.id, agentType: agent.type,
        ...stopOutcomeEvent(switchedOff),
      });
      return apiSuccess({ status: "stopped", ...switchedOff });
    }

    if (action === "force_stop") {
      const limited = forcePowerLimit();
      if (limited) return limited;
      const operationId = await claimProviderOperation("stop", "stopped");
      if (!operationId) return apiError(FORCE_BUSY, 409);
      if (!await invalidateDesktopBeforePower(operationId)) return desktopInvalidationFailure();
      const r = await runProxmoxHostScript(`${lifecyclePrelude}\n${forcedStopVmBody(vmid)}`, env);
      if (!r.ok || !(r.stdout || "").split(/\r?\n/).includes(`${FORCE_STOPPED_RECEIPT} vmid=${vmid}`)) {
        // Sent but unconfirmed: keep the lease for the reconciler, as Stop does.
        await retainUnknownProviderOperation(operationId, providerFailureDetail(r, "Force off outcome is unknown"));
        return apiError("Hivra couldn't confirm the computer switched off. Refresh before trying again.", 502);
      }
      const completed = await completeHivraAgentOperation({
        userId,
        agentId: String(agent.id),
        operationId,
        expectedDesiredState: "stopped",
        status: "stopped",
      });
      if (!completed) {
        await releaseProviderOperation(operationId, "Force off completion was superseded.", false);
        log.error("hivra agent forced off but operation completion was superseded", new Error("Operation CAS failed"), {
          source: "hivra/agents/[id]/action",
          failureType: "hivra_agent_force_stop_status_persist_failed",
          userId,
          agentId: agent.id,
          vmid,
        });
        return apiError("The computer switched off, but a newer change superseded it. Refresh before trying again.", 409);
      }
      await logHivraAgentEvent({ userId, event: "force_stopped", agentId: agent.id, agentType: agent.type });
      return apiSuccess({ status: "stopped", forced: true });
    }

    if (action === "start") {
      // Wake-admission: don't wake onto a host without headroom (OOM guard).
      const cap = await checkHostWakeCapacity(Number(agent.ram) * 1024, env);
      if (!cap.ok) return apiError("Host is at capacity — try again shortly", 503);
      if (executionContext.kind === "self-managed" && cap.freeMb == null) {
        return apiError(
          "Hivra could not verify live memory headroom on this computer. Check the connection and try again.",
          503,
        );
      }
      const operationId = await claimProviderOperation("start", "running");
      if (!operationId) return apiError("Another lifecycle operation is already in progress.", 409);
      if (!await invalidateDesktopBeforePower(operationId)) return desktopInvalidationFailure();
      const r = await runProxmoxHostScript(
        `${startLifecyclePrelude}\n${startKickoff(operationId)}`,
        env,
      );
      if (!r.ok) {
        await retainUnknownProviderOperation(operationId, providerFailureDetail(r, "Start outcome is unknown"));
        return apiError("Start failed", 502);
      }
      await recordActivityCredentialIssued(r);
      const continued = await continueHivraAgentOperation({
        userId,
        agentId: String(agent.id),
        operationId,
        expectedDesiredState: "running",
        status: "provisioning",
      });
      if (!continued) {
        await retainUnknownProviderOperation(operationId, "Start convergence was superseded before its provider outcome was verified.");
        log.error("hivra agent start kicked off but operation completion was superseded", new Error("Operation CAS failed"), {
          source: "hivra/agents/[id]/action",
          failureType: "hivra_agent_start_status_persist_failed",
          userId,
          agentId: agent.id,
          vmid,
        });
        return apiError("The VM start began, but a newer lifecycle request superseded it. Refresh before retrying.", 409);
      }
      await logHivraAgentEvent({ userId, event: "started", agentId: agent.id, agentType: agent.type });
      return apiSuccess({ status: "provisioning" });
    }

    if (action === "restart") {
      const operationId = await claimProviderOperation("restart", "running");
      if (!operationId) return apiError("Another lifecycle operation is already in progress.", 409);
      if (!await invalidateDesktopBeforePower(operationId)) return desktopInvalidationFailure();
      const r = await runProxmoxHostScript(
        `${lifecyclePrelude}\n${verifiedStopVmBody(vmid, 40)}\nsleep 2\n${startKickoff(operationId)}`,
        env,
      );
      if (!r.ok) {
        await retainUnknownProviderOperation(operationId, providerFailureDetail(r, "Restart outcome is unknown"));
        return apiError("Restart failed", 502);
      }
      await recordActivityCredentialIssued(r);
      const continued = await continueHivraAgentOperation({
        userId,
        agentId: String(agent.id),
        operationId,
        expectedDesiredState: "running",
        status: "provisioning",
      });
      if (!continued) {
        await retainUnknownProviderOperation(operationId, "Restart convergence was superseded before its provider outcome was verified.");
        log.error("hivra agent restart kicked off but operation completion was superseded", new Error("Operation CAS failed"), {
          source: "hivra/agents/[id]/action",
          failureType: "hivra_agent_restart_status_persist_failed",
          userId,
          agentId: agent.id,
          vmid,
        });
        return apiError("The VM restart began, but a newer lifecycle request superseded it. Refresh before retrying.", 409);
      }
      const switchedOff = stopOutcome(r.stdout);
      await logHivraAgentEvent({
        userId, event: "restarted", agentId: agent.id, agentType: agent.type,
        ...stopOutcomeEvent(switchedOff),
      });
      return apiSuccess({ status: "provisioning", ...switchedOff });
    }

    if (action === "force_restart") {
      const limited = forcePowerLimit();
      if (limited) return limited;
      const operationId = await claimProviderOperation("restart", "running");
      if (!operationId) return apiError(FORCE_BUSY, 409);
      if (!await invalidateDesktopBeforePower(operationId)) return desktopInvalidationFailure();
      const r = await runProxmoxHostScript(
        `${lifecyclePrelude}\n${forcedStopVmBody(vmid)}\nsleep 2\n${startKickoff(operationId)}`,
        env,
      );
      if (!r.ok || !(r.stdout || "").split(/\r?\n/).includes(`${FORCE_STOPPED_RECEIPT} vmid=${vmid}`)) {
        await retainUnknownProviderOperation(operationId, providerFailureDetail(r, "Force restart outcome is unknown"));
        return apiError("Hivra couldn't confirm the forced restart. Refresh before trying again.", 502);
      }
      await recordActivityCredentialIssued(r);
      const continued = await continueHivraAgentOperation({
        userId,
        agentId: String(agent.id),
        operationId,
        expectedDesiredState: "running",
        status: "provisioning",
      });
      if (!continued) {
        await retainUnknownProviderOperation(operationId, "Force restart convergence was superseded before its provider outcome was verified.");
        log.error("hivra agent force restart kicked off but operation completion was superseded", new Error("Operation CAS failed"), {
          source: "hivra/agents/[id]/action",
          failureType: "hivra_agent_force_restart_status_persist_failed",
          userId,
          agentId: agent.id,
          vmid,
        });
        return apiError("The forced restart began, but a newer change superseded it. Refresh before trying again.", 409);
      }
      await logHivraAgentEvent({ userId, event: "force_restarted", agentId: agent.id, agentType: agent.type });
      return apiSuccess({ status: "provisioning", forced: true });
    }

    if (action === "update_runtime") {
      if (agent.status !== "running") {
        return apiError("Start this computer before updating its connection service.", 409);
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
          { timeoutMs: 20_000 },
        );
        if (!readiness.ok || !readiness.stdout.includes("HIVRA_RUNTIME_UPDATE_READY")) {
          return apiError("Prepare this infrastructure target with the current Hivra runtime bundle before updating the computer.", 503);
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
      const operationId = await claimProviderOperation("restart", "running");
      if (!operationId) return apiError("Another lifecycle operation is already in progress.", 409);
      const guestIp = `${subnetPrefix}.${octet}`;
      const activity = activityTelemetryKickoff(runtimeUpdateHelper);
      // The helper consumes and deletes a staged credential itself; the trap
      // only covers an exit before it ran (for example a refused prelude step).
      const activityCleanup = activity.stage
        ? `trap ${shellQuote(`rm -f -- ${shellQuote(activityCredentialFile)}`)} EXIT\n`
        : "";
      const updateCommand = `${activity.stage}HIVRA_VM_SSH_KEY_PATH=${shellQuote(executionContext.paths.vmSshKeyPath ?? "")} HIVRA_LIFECYCLE_LOCK_FD=8 HIVRA_RUNTIME_UPDATE_DEADLINE="$HIVRA_RUNTIME_UPDATE_DEADLINE" ${activity.env}bash ${shellQuote(runtimeUpdateHelper)} ${vmid} ${shellQuote(guestIp)}`;
      // The deadline is set before the prelude so it also counts the FD8 wait.
      const r = await runProxmoxHostScript(
        `HIVRA_RUNTIME_UPDATE_DEADLINE="$(( $(date +%s) + ${RUNTIME_UPDATE_HOST_BUDGET_SECONDS} ))"\n${lifecyclePrelude}\n${activityCleanup}${updateCommand}`,
        env,
        { timeoutMs: RUNTIME_UPDATE_TIMEOUT_MS },
      );
      // Only the helper's host-authored receipt for this exact VM proves the
      // guest committed the update; its guest output never reaches stdout.
      const updated = r.ok
        && (r.stdout || "").split(/\r?\n/).includes(`HIVRA_GUEST_RUNTIME_UPDATED vmid=${vmid}`);
      if (!updated) {
        log.warn("hivra runtime update outcome could not be verified", {
          source: "hivra/agents/[id]/action",
          failureType: "hivra_agent_runtime_update_unverified",
          userId,
          agentId: agent.id,
          vmid,
          hostOk: r.ok,
          errorMessage: r.error ?? null,
          stderr: r.stderr?.slice(0, 300) ?? null,
        });
        await retainUnknownProviderOperation(operationId, providerFailureDetail(r, "Runtime update outcome is unknown"));
        return apiError("The connection service update could not be verified. Refresh this computer before trying again.", 502);
      }
      await recordActivityCredentialIssued(r);
      await recordActivityCollectorInstall(r);
      const completed = await completeHivraAgentOperation({
        userId,
        agentId: String(agent.id),
        operationId,
        expectedDesiredState: "running",
        status: "running",
      });
      if (!completed) {
        await releaseProviderOperation(operationId, "Runtime update completion was superseded.", false);
        log.error("hivra agent runtime updated but operation completion was superseded", new Error("Operation CAS failed"), {
          source: "hivra/agents/[id]/action",
          failureType: "hivra_agent_runtime_update_status_persist_failed",
          userId,
          agentId: agent.id,
          vmid,
        });
        return apiError("The connection service was updated, but a newer lifecycle request superseded it. Refresh before retrying.", 409);
      }
      const agentCli = parseAgentCliReport(r.stdout || "");
      await logHivraAgentEvent({
        userId,
        event: "runtime_updated",
        agentId: agent.id,
        agentType: agent.type,
        detail: { inPlace: true, ...(agentCli ? { agentCli } : {}) },
      });
      return apiSuccess({ status: "running", ...(agentCli ? { agentCli } : {}) });
    }

    if (action === "resize") {
      // Authoritative floor. The browser-on surcharge (+1 CPU / +2 GB) only applies
      // to agent types that actually ship a browser, so we only probe those; for the
      // rest the live state is irrelevant and the base floor stands. We read the box's
      // REAL browser state (the same /api/browser/status source the UI's `bOn` uses)
      // instead of assuming OFF — resizing below the 2/4 browser floor can brick the
      // Chrome/Xvfb/VNC stack. probeBoxBrowserEnabled fails safe to ON if unreachable.
      const browserOn =
        Boolean(getAgent(String(agent.type))?.browser) &&
        (await probeBoxBrowserEnabled(
          (agent.chat_url as string | null) ?? null,
          (agent.api_token as string | null) ?? null,
        ));
      const floor = resizeFloor(String(agent.type), browserOn);
      const cpu = clampCpu(body.cpu, agent.cpu, floor.cpu, MAX_CPU);
      const ram = clampInt(body.ram, agent.ram, floor.ram, MAX_RAM);
      const maximumCpu = body.maximumCpu === undefined
        ? Math.max(cpu, clampCpu(agent.cpu_max, cpu, 0.5, MAX_CPU))
        : clampCpu(body.maximumCpu, Number(agent.cpu_max) || cpu, 0.5, MAX_CPU);
      const maximumRam = body.maximumRam === undefined
        ? Math.max(ram, clampInt(agent.ram_max, ram, 1, MAX_RAM))
        : clampInt(body.maximumRam, Number(agent.ram_max) || ram, 1, MAX_RAM);
      if (maximumCpu < cpu || maximumRam < ram) {
        return apiError("A computer's maximum cannot be lower than its reserved allocation.", 400);
      }
      const ramEnvelope = resolveRamBurst(ram * 1024, env, maximumRam * 1024);
      // Same authority as launch: a resize must fit the plan's per-agent cap AND
      // the shared pool. Exclude THIS box from the pool tally so it isn't counted
      // against its own new size. (Previously resize only clamped to the hard
      // 8 CPU / 16 GB ceiling, letting a box grow past the plan it's paying for.)
      if (executionContext.kind === "managed") {
        const gate = await validateAgentResources({
          userId,
          type: String(agent.type),
          cpu,
          ram,
          maximumCpu,
          maximumRam,
          browser: browserOn,
          mode: "resize",
          excludeAgentId: agent.id as string,
          poolExempt: Boolean(getAgent(String(agent.type))?.poolExempt),
          floor,
          agentLabel: getAgent(String(agent.type))?.name,
        });
        if (!gate.ok) return apiError(gate.message, gate.status);
      } else {
        // BYO targets are not governed by Hivra Cloud's subscription pool. Keep
        // the catalog safety floor/ceiling above, then fail before mutation if
        // the requested VM alone exceeds the target's measured physical total.
        const capacity = executionContext.target.capacity;
        if (
          (capacity.cpu.totalCores !== null && maximumCpu > capacity.cpu.totalCores) ||
          (capacity.memoryBytes.total !== null && maximumRam * 1024 * 1024 * 1024 > capacity.memoryBytes.total)
        ) {
          return apiError("This infrastructure target cannot fit the requested agent size.", 409);
        }
      }
      const currentRam = Number(agent.ram);
      const currentMaximumRam = Math.max(Number(agent.ram_max) || currentRam, currentRam);
      const currentMaximumCpu = Math.max(Number(agent.cpu_max) || Number(agent.cpu), Number(agent.cpu));
      const cores = Math.max(1, Math.ceil(maximumCpu));
      // Phase 5: apply per-VM scheduling priority (cgroup CPU weight) from the pool tier.
      const { data: pool } = agent.pool_id
        ? await supabaseAdmin.from("pools").select("priority").eq("id", agent.pool_id).maybeSingle()
        : { data: null };
      const cpuunits = priorityToCpuUnits((pool as { priority?: number } | null)?.priority);
      const operationId = await claimProviderOperation("resize", "running", { cpu, ram, maximumCpu, maximumRam });
      if (!operationId) return apiError("Another lifecycle operation is already in progress.", 409);
      const reductionOnly = Number.isFinite(currentRam)
        && ram <= currentRam
        && maximumRam <= currentMaximumRam
        && maximumCpu <= currentMaximumCpu
        && (ram < currentRam || maximumRam < currentMaximumRam || maximumCpu < currentMaximumCpu);
      const serializedAdmission = buildHostCapacityAdmissionCommand({
        provisionerDirectory: executionContext.paths.provisionerDirectory,
        targetVmid: vmid,
        floorMemoryMb: ram * 1024,
        maximumMemoryMb: ramEnvelope.ceilingMb,
        maximumCpu,
        policy: capacityPolicy,
        allowReduction: reductionOnly,
      });
      const strictContainerCgroup = String(agent.type) !== "linux-desktop"
        ? Buffer.from(buildAgentContainerCgroupScript({
            memoryMb: ramEnvelope.ceilingMb,
            cpus: maximumCpu,
            strict: true,
          }), "utf8").toString("base64")
        : null;
      const previousContainerCgroup = strictContainerCgroup
        ? Buffer.from(buildAgentContainerCgroupScript({
            memoryMb: Math.max(Number(agent.ram_max) || Number(agent.ram), Number(agent.ram)) * 1024,
            cpus: Math.max(Number(agent.cpu_max) || Number(agent.cpu), Number(agent.cpu)),
            strict: true,
          }), "utf8").toString("base64")
        : null;
      const containerCgroupEnforcement = strictContainerCgroup ? `
CGROUP_SCRIPT_B64=${shellQuote(strictContainerCgroup)}
PREVIOUS_CGROUP_SCRIPT_B64=${shellQuote(previousContainerCgroup ?? "")}
GUEST_IP=${shellQuote(`${subnetPrefix}.${octet}`)}
GUEST_SSH_USER=${shellQuote(env.PROXMOX_VM_SSH_USER || "hermes")}
GUEST_SSH_KEY=${shellQuote(executionContext.paths.vmSshKeyPath ?? "")}
apply_guest_cgroup() {
  local script_b64="$1"
  local known_hosts
  [ -r "$GUEST_SSH_KEY" ] || { echo "guest SSH key is unavailable for container ceiling enforcement" >&2; return 1; }
  known_hosts="$(mktemp /tmp/hivra-envelope-known-hosts.XXXXXX)" || return 1
  for _ in $(seq 1 24); do
    if printf '%s' "$script_b64" | base64 -d | ssh -i "$GUEST_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$known_hosts" -o ConnectTimeout=5 "$GUEST_SSH_USER@$GUEST_IP" "sudo bash -s"; then
      rm -f -- "$known_hosts"
      return 0
    fi
    sleep 5
  done
  rm -f -- "$known_hosts"
  return 1
}
` : "";
      const r = await runProxmoxHostScript(
        `${lifecyclePrelude}
HOST_CPU="$(nproc)"
HOST_RAM_MB="$(awk '$1=="MemTotal:" {print int($2/1024)}' /proc/meminfo)"
[[ "$HOST_CPU" =~ ^[0-9]+$ && "$HOST_RAM_MB" =~ ^[0-9]+$ ]] \
  || { echo "could not measure selected host totals" >&2; exit 1; }
if [ "$HOST_CPU" -lt ${Math.ceil(maximumCpu)} ] || [ "$HOST_RAM_MB" -lt ${maximumRam * 1024} ]; then
  echo "HIVRA_RESOURCE_MAXIMUM_REJECTED"
  exit 1
fi
OLD_CONFIG="$(qm config ${vmid})"
OLD_CORES="$(printf '%s\\n' "$OLD_CONFIG" | awk '$1=="cores:" {print $2; exit}')"
OLD_CPULIMIT="$(printf '%s\\n' "$OLD_CONFIG" | awk '$1=="cpulimit:" {print $2; exit}')"
OLD_MEMORY="$(printf '%s\\n' "$OLD_CONFIG" | awk '$1=="memory:" {print $2; exit}')"
OLD_BALLOON="$(printf '%s\\n' "$OLD_CONFIG" | awk '$1=="balloon:" {print $2; exit}')"
OLD_CPUUNITS="$(printf '%s\\n' "$OLD_CONFIG" | awk '$1=="cpuunits:" {print $2; exit}')"
[ -n "$OLD_CPULIMIT" ] || OLD_CPULIMIT=0
[ -n "$OLD_CPUUNITS" ] || OLD_CPUUNITS=1000
[ -n "$OLD_BALLOON" ] || OLD_BALLOON="$OLD_MEMORY"
[[ "$OLD_CORES" =~ ^[0-9]+$ && "$OLD_MEMORY" =~ ^[0-9]+$ ]] \
  || { echo "could not snapshot prior VM sizing" >&2; exit 1; }
${serializedAdmission}
${verifiedStopVmBody(vmid, 40)}
sleep 2
${containerCgroupEnforcement}
restore_previous_size() {
  qm set ${vmid} --cores "$OLD_CORES" --cpulimit "$OLD_CPULIMIT" --memory "$OLD_MEMORY" --balloon "$OLD_BALLOON" --cpuunits "$OLD_CPUUNITS"
}
restore_previous_size_and_restart() {
  local restore_container="\${1:-0}"
  ${verifiedStopVmBody(vmid, 40)}
  restore_previous_size || return 1
  qm start ${vmid} >/dev/null || return 1
  ${strictContainerCgroup ? '[ "$restore_container" = 0 ] || apply_guest_cgroup "$PREVIOUS_CGROUP_SCRIPT_B64" || return 1' : ""}
}
if ! qm set ${vmid} --cores ${cores} --cpulimit ${maximumCpu} --memory ${ramEnvelope.ceilingMb} --balloon ${ramEnvelope.baselineMb} --cpuunits ${cpuunits}; then
  restore_previous_size_and_restart 0 || { echo "resize failed and prior config could not be restored" >&2; exit 1; }
  echo "HIVRA_RESIZE_ROLLED_BACK"
  exit 1
fi
if ! qm start ${vmid} >/dev/null; then
  restore_previous_size_and_restart 0 || { echo "new size failed to start and prior config could not be restored" >&2; exit 1; }
  echo "HIVRA_RESIZE_ROLLED_BACK"
  exit 1
fi
${strictContainerCgroup ? `if ! apply_guest_cgroup "$CGROUP_SCRIPT_B64"; then
  echo "agent container ceiling could not be enforced" >&2
  restore_previous_size_and_restart 1 || { echo "container ceiling failed and prior config could not be restored" >&2; exit 1; }
  echo "HIVRA_RESIZE_ROLLED_BACK"
  exit 1
fi` : ""}
${startKickoff(operationId)}`,
        env,
      );
      if (!r.ok) {
        if (r.stdout.split(/\r?\n/).includes("HIVRA_RESOURCE_MAXIMUM_REJECTED")) {
          await releaseProviderOperation(operationId, "Resize was rejected because its maximum exceeds the selected host's physical capacity.", false);
          return apiError("The selected host cannot enforce that CPU and memory maximum.", 409);
        } else if (r.stdout.split(/\r?\n/).includes("HIVRA_RESIZE_ROLLED_BACK")) {
          await releaseProviderOperation(operationId, "Resize failed and the previous resource envelope was restored.", false);
        } else {
          await retainUnknownProviderOperation(operationId, providerFailureDetail(r, "Resize outcome is unknown"));
        }
        return apiError("Resize failed", 502);
      }
      await recordActivityCredentialIssued(r);
      const continued = await continueHivraAgentResizeOperation({
        userId,
        agentId: String(agent.id),
        operationId,
        expectedDesiredState: "running",
        status: "provisioning",
        cpu,
        ram,
        maximumCpu,
        maximumRam,
      });
      if (!continued) {
        await retainUnknownProviderOperation(operationId, "Resize convergence was superseded before its provider outcome was verified.");
        log.error("hivra agent resized but operation completion was superseded", new Error("Operation CAS failed"), {
          source: "hivra/agents/[id]/action",
          failureType: "hivra_agent_resize_status_persist_failed",
          userId,
          agentId: agent.id,
          vmid,
          cpu,
          ram,
        });
        return apiError("The VM resized, but a newer lifecycle request superseded it. Refresh before retrying.", 409);
      }
      await logHivraAgentEvent({ userId, event: "resized", agentId: agent.id, agentType: agent.type, detail: { cpu, ram, maximumCpu, maximumRam } });
      return apiSuccess({ status: "provisioning", cpu, ram, maximumCpu, maximumRam });
    }

    return apiError("Unknown action", 400);
  } catch (err) {
    return handleApiError(err);
  }
}
