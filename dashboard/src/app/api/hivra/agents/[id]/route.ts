// Hivra agent — poll status (GET) + destroy (DELETE).
// On poll, if still provisioning, SSH the host and read the orchestrator's
// result JSON from the log; when ready, persist chat_url + flip to running.

export const runtime = "nodejs";
// Provider cleanup dispatches within a 45s window, then records exact-ID
// observations. Leave room for its bounded provider calls and finalization.
export const maxDuration = 120;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { advanceProviderAgentDelete, ProviderAgentDeleteError } from "@/lib/hivra/provider-agent-delete";
import { advanceProviderAgentReadiness } from "@/lib/hivra/provider-agent-readiness";
import { advanceProviderNativeReadiness } from "@/lib/hivra/provider-native-readiness";
import { advanceProviderDesktopReadiness } from "@/lib/hivra/provider-desktop-readiness";
import type { ProviderAgentReadinessStage } from "@/lib/hivra/provider-readiness-contract";
import { advanceProviderAgentPower } from "@/lib/hivra/provider-agent-power";
import type { ProviderAgentPowerStage } from "@/lib/hivra/provider-power-contract";
import { advanceProviderResize } from "@/lib/hivra/provider-agent-resize";
import type { ProviderResizeStage } from "@/lib/hivra/provider-agent-resize-contract";
import { randomUUID } from "node:crypto";

import { supabaseAdmin } from "@/lib/supabase";
import { reconcileBankrEnvAfterHivraBoot } from "@/lib/agent-wallets/hivra-lane";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { deleteBoxTunnel } from "@/lib/services/cloudflare-tunnel";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { captureHivraAgentComputerReady } from "@/lib/hivra/agent-ready-telemetry";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { seedAgentBox } from "@/lib/hivra/agent-bootstrap";
import { advanceProxmoxComputerContract } from "@/lib/hivra/computer-contract-delivery";
import { advanceProviderAgentUpkeep, providerAgentUpkeepApplies } from "@/lib/hivra/provider-agent-upkeep";
import { runAfterResponse } from "@/lib/hivra/after-response";
import { computerContractPlanFor } from "@/lib/agent-computers/computer-contract-input";
import { getAccountMemory } from "@/lib/account-memory";
import { bankrSkillsDirForType, seedBankrSkillsOntoBox } from "@/lib/hivra/bankr-skills-seed";
import { installCuratedSkillsOnBox } from "@/lib/hivra/skill-install";
import { coerceSkillIds } from "@/lib/hivra/template-skills";
import { log } from "@/lib/logger";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { readStoredLlmConfig, buildBoxLlmPayload, sanitizeHivraAgentRow, type BoxLlmPayload } from "@/lib/hivra/agent-llm";
import { decryptApiKey } from "@/lib/crypto";
import { validateHivraHostRunningResult } from "@/lib/hivra/agent-host-result";
import {
  buildRemoteDesktopCapabilityInspectionScript,
  parseRemoteDesktopCapabilityReceipt,
} from "@/lib/remote-computers/capability-inspection";
import { HivraAgentDeleteCleanupError } from "@/lib/hivra/agent-delete-cleanup";
import {
  describeHivraAgentExecutionContextError,
  hivraAgentProvisionLogPath,
  hivraAgentProvisionSecretPath,
  hivraAgentStartLogPath,
  resolveHivraAgentExecutionContext,
  resolveHivraAgentTeardownExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import {
  checkpointHivraAgentOperation,
  completeHivraAgentDelete,
  completeHivraAgentRunning,
  releaseHivraAgentOperation,
  requestHivraAgentDelete,
} from "@/lib/hivra/agent-operation-store";
import {
  hivraPrivateAccessAuthority,
  prepareHivraTailscaleForDelete,
  sameHivraPrivateAccessAuthority,
  type HivraPrivateAccessAgentRow,
} from "@/lib/hivra/tailscale-private-access";
import { GvisorComputerError, mutateGvisorComputer } from "@/lib/hivra/gvisor-computer-service";
import { managedSessionAction } from "@/lib/hivra/do-managed-sessions";
import { managedSessionFailure } from "@/app/api/hivra/managed-sessions/route-support";
import {
  recordCollectorInstallResult,
  supportsNativeTracing,
  type ActivityCollectorInstallStatus,
} from "@/lib/activity-observability/collectors";

type ProxmoxEnvironment = Record<string, string | undefined>;

// The one agent-run reporter install line the launch installer and the start
// helper write into the host log (docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md).
// Closed enum only; anything else is ignored.
const ACTIVITY_COLLECTOR_MARKER_PATTERN = "^HIVRA_ACTIVITY_COLLECTOR status=(installed|failed reason=[a-z_]{1,40})$";

function parseActivityCollectorMarker(
  lines: string[],
): { status: ActivityCollectorInstallStatus; reason?: string } | null {
  let parsed: { status: ActivityCollectorInstallStatus; reason?: string } | null = null;
  for (const candidate of lines) {
    const line = candidate.trim();
    if (line === "HIVRA_ACTIVITY_COLLECTOR status=installed") parsed = { status: "installed" };
    const failed = line.match(/^HIVRA_ACTIVITY_COLLECTOR status=failed reason=([a-z_]{1,40})$/);
    if (failed) parsed = { status: "failed", reason: failed[1] };
  }
  return parsed;
}

function verifiedDestroyHivraVmScript(input: {
  vmid: number;
  storage: string;
  expectedAllocationOperationId: string | null;
  expectedInfrastructureBindingTag: string | null;
  allowManagedLegacyAuthority: boolean;
  cleanupPaths: string[];
}): string {
  const expectedTag = input.expectedAllocationOperationId
    ? `hivra-op-${input.expectedAllocationOperationId.replace(/-/g, "").toLowerCase()}`
    : null;
  const cleanupPaths = input.cleanupPaths.map((path) => shellQuote(path)).join(" ");
  return `set -euo pipefail
VMID='${input.vmid}'
STORAGE=${shellQuote(input.storage)}
${expectedTag ? `EXPECTED_TAG=${shellQuote(expectedTag)}` : "EXPECTED_TAG='' # pre-operation-tag managed VM"}
${input.expectedInfrastructureBindingTag ? `EXPECTED_BINDING_TAG=${shellQuote(input.expectedInfrastructureBindingTag)}` : "EXPECTED_BINDING_TAG='' # legacy managed VM pending guarded adoption"}
ALLOW_MANAGED_LEGACY=${input.allowManagedLegacyAuthority ? "1" : "0"}
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for Hivra deletion lock" >&2; exit 1; }
PIDFILE="/run/hivra-provision/$VMID.pid"
if [ -r "$PIDFILE" ]; then
  PID="$(tr -dc '0-9' < "$PIDFILE")"
  if [ -z "$PID" ]; then
    echo "Provision PID file is invalid for VMID $VMID" >&2
    exit 1
  fi
  if kill -0 "$PID" 2>/dev/null; then
    CMD="$(tr '\\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"
    if ! printf '%s' "$CMD" | grep -Fq "hivra-provision-on-host.sh $VMID "; then
      echo "Refusing to stop unexpected PID $PID for VMID $VMID" >&2
      exit 1
    fi
    if [ "$ALLOW_MANAGED_LEGACY" != 1 ]; then
      [ -n "$EXPECTED_TAG" ] && [ -n "$EXPECTED_BINDING_TAG" ] \
        || { echo "Tagged provision process ownership evidence is incomplete" >&2; exit 1; }
      [ -r "/proc/$PID/environ" ] \
        && tr '\\0' '\\n' < "/proc/$PID/environ" | grep -Fxq "HIVRA_OPERATION_ID=${input.expectedAllocationOperationId ?? ""}" \
        && tr '\\0' '\\n' < "/proc/$PID/environ" | grep -Fxq "HIVRA_BINDING_TAG=${input.expectedInfrastructureBindingTag ?? ""}" \
        || { echo "Refusing to stop an unowned provision process" >&2; exit 1; }
    fi
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 40); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "Provision process $PID is still active for VMID $VMID" >&2
      exit 1
    fi
  fi
fi
rm -f -- "$PIDFILE"
if qm status "$VMID" >/dev/null 2>&1; then
  if [ "$ALLOW_MANAGED_LEGACY" != 1 ] && { [ -z "$EXPECTED_TAG" ] || [ -z "$EXPECTED_BINDING_TAG" ]; }; then
    echo "Refusing to destroy VMID $VMID without complete provider ownership evidence" >&2
    exit 1
  fi
  for _ in 1 2 3; do
    qm status "$VMID" >/dev/null 2>&1 || break
    if [ "$ALLOW_MANAGED_LEGACY" != 1 ]; then
      TAGS="$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')"
      printf '%s' "$TAGS" | tr ';' '\\n' | grep -Fxq "$EXPECTED_TAG" \
        && printf '%s' "$TAGS" | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG" \
        || { echo "VMID $VMID ownership changed before deletion" >&2; exit 1; }
    fi
    qm stop "$VMID" --timeout 30 >/dev/null 2>&1 || true
    qm destroy "$VMID" --purge 1 --destroy-unreferenced-disks 1 >/dev/null 2>&1 || true
    sleep 1
  done
fi
if qm status "$VMID" >/dev/null 2>&1; then
  echo "VMID $VMID still exists after destroy" >&2
  exit 1
fi
VOLUMES="$(pvesm list "$STORAGE" 2>/dev/null)" \
  || { echo "Could not verify storage $STORAGE after deletion" >&2; exit 1; }
if printf '%s\\n' "$VOLUMES" | grep -E "vm-${input.vmid}-"; then
  echo "VMID $VMID still has volumes on $STORAGE after destroy" >&2
  exit 1
fi
rm -f -- ${cleanupPaths} \
  "/run/hivra-provision/$VMID.env" \
  "/run/hivra-provision/$VMID.secret" \
  "/run/hivra-provision/$VMID.allocated" \
  "/var/lib/hivra/provision-results/$VMID.secret"
echo "destroyed $VMID"`;
}

// Bootstrap seeding: once a box is running, push its SOUL.md / USER.md /
// first-conversation prompt (built from the launch onboarding) onto it — exactly
// once, guarded by `bootstrapped_at`. Best-effort and idempotent: if the SSH seed
// fails we leave `bootstrapped_at` null and retry on the next poll, well before
// the user finishes connecting their account and sends a first message.
// Resolves true once it has stamped the column; the poll reads the row back.
async function maybeSeedBootstrap(
  agent: Record<string, unknown>,
  userId: string,
  env: ProxmoxEnvironment,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  if (agent.status !== "running" || agent.bootstrapped_at || !agent.ip) return false;
  // Deploy-time LLM choice rides the same one-time seed: decrypt the stored key
  // and have the guest script write ~/.hivra/llm-provider.json alongside the
  // identity files. Decrypt failures degrade to native auth rather than blocking
  // the whole bootstrap (the Manage tab can re-apply later).
  let llm: BoxLlmPayload | null = null;
  const llmConfig = readStoredLlmConfig(agent.llm_config);
  if (llmConfig && typeof agent.llm_api_key_encrypted === "string" && agent.llm_api_key_encrypted) {
    try {
      llm = buildBoxLlmPayload(llmConfig, decryptApiKey(agent.llm_api_key_encrypted));
    } catch (e) {
      log.warn("hivra bootstrap could not decrypt llm key; seeding without llm config", {
        source: "hivra/agents/[id]",
        failureType: "hivra_agent_llm_key_decrypt_failed",
        userId,
        agentId: String(agent.id),
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // Wave 5.1: fold the account-level shared memory into the new box's USER.md
  // (read-only). Best-effort — getAccountMemory never throws (returns "" on any
  // failure), so a memory lookup miss can't block the one-time identity seed.
  const sharedMemory = await getAccountMemory(userId);
  const res = await seedAgentBox(
    {
      id: String(agent.id),
      name: (agent.name as string | null) ?? null,
      type: (agent.type as string | null) ?? null,
      ip: (agent.ip as string | null) ?? null,
      goal: (agent.goal as string | null) ?? null,
      context: (agent.context as string | null) ?? null,
      personality: (agent.personality as string | null) ?? null,
      emoji: (agent.emoji as string | null) ?? null,
      // Persona-souls upgrade: when the chosen persona has an authored soul, this
      // id makes buildSoul seed SOUL.md with the FULL prompt. A null/unknown id
      // (custom "Build your own", or any pre-upgrade row) → generic template.
      soulPromptId: (agent.soul_prompt_id as string | null) ?? null,
      llm,
      sharedMemory,
    },
    env,
  );
  if (!res.ok) return false; // retry next poll
  await supabaseAdmin
    .from("hivra_agents")
    .update({ bootstrapped_at: new Date().toISOString() })
    .eq("id", agent.id as string);
  await logHivraAgentEvent({ userId, event: "bootstrapped", agentId: agent.id as string, agentType: agent.type as string });
  return true;
}

// Bankr skills seeding: once a box is running, push the curated Bankr skill suite
// onto it — exactly once, guarded by `bankr_skills_seeded_at`. Best-effort and
// idempotent (retry on next poll if the SSH write fails). Only CLI boxes that
// expose a skills dir get them (codex / claude-code); other agent types are
// skipped without ever stamping the column. Independent of bootstrap + wallet:
// the skills are static content and don't need a wallet to be useful.
// Resolves true once it has stamped the column; the poll reads the row back.
async function maybeSeedBankrSkills(
  agent: Record<string, unknown>,
  userId: string,
  env: ProxmoxEnvironment,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  if (agent.status !== "running" || agent.bankr_skills_seeded_at || !agent.ip) return false;
  if (!bankrSkillsDirForType(agent.type as string | null)) return false; // unsupported type — never attempt
  const res = await seedBankrSkillsOntoBox(
    {
      id: String(agent.id),
      type: (agent.type as string | null) ?? null,
      ip: (agent.ip as string | null) ?? null,
    },
    env,
  );
  if (!res.ok) return false; // retry next poll
  await supabaseAdmin
    .from("hivra_agents")
    .update({ bankr_skills_seeded_at: new Date().toISOString() })
    .eq("id", agent.id as string);
  await logHivraAgentEvent({
    userId,
    event: "bankr_skills_seeded",
    agentId: agent.id as string,
    agentType: agent.type as string,
    detail: { count: res.count },
  });
  return true;
}

// Template skills seeding (Wave 5.2 follow-up): when a box was forked from a
// template, re-install the curated skills the template carried (template_skills)
// onto it — exactly once, guarded by `template_skills_seeded_at`, mirroring the
// Bankr seed. Best-effort + idempotent (installCuratedSkillsOnBox overwrites and
// the SSH write is atomic, so a transport failure just retries next poll). CLI
// boxes only; the skill bodies come from the catalog, never the DB.
// Resolves true once it has stamped the column; the poll reads the row back.
async function maybeSeedTemplateSkills(
  agent: Record<string, unknown>,
  userId: string,
  env: ProxmoxEnvironment,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  if (agent.status !== "running" || agent.template_skills_seeded_at || !agent.ip) return false;
  if (!bankrSkillsDirForType(agent.type as string | null)) return false; // unsupported type — never attempt
  // Nothing to seed (not a template fork, or the template carried no skills):
  // bail without a DB write so this never causes a fleet-wide write on first poll.
  // The check is an in-memory coerce, cheap to repeat each poll; the column stays
  // NULL forever for non-forks (which is correct — no template skills were seeded).
  const skillIds = coerceSkillIds(agent.template_skills);
  if (skillIds.length === 0) return false;
  const res = await installCuratedSkillsOnBox(
    {
      id: String(agent.id),
      type: (agent.type as string | null) ?? null,
      ip: (agent.ip as string | null) ?? null,
    },
    skillIds,
    env,
  );
  if (!res.ok) return false; // transport failure — retry next poll
  await supabaseAdmin
    .from("hivra_agents")
    .update({ template_skills_seeded_at: new Date().toISOString() })
    .eq("id", agent.id as string);
  await logHivraAgentEvent({
    userId,
    event: "template_skills_seeded",
    agentId: agent.id as string,
    agentType: agent.type as string,
    detail: { count: res.installed.length, installed: res.installed, skipped: res.skipped },
  });
  return true;
}

// Upkeep that reaches the computer (the provider launch seeds and the Computer
// Contract) runs after this poll's response, never before it. It shares the
// invocation's maxDuration (120 s), so every round trip it starts must be able
// to finish by this deadline, measured from the start of the poll.
const BACKGROUND_UPKEEP_DEADLINE_MS = 110_000;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const pollStartedAt = Date.now();
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { data: agent, error } = await supabaseAdmin
      .from("hivra_agents")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .single();
    if (error || !agent) return apiError("Agent not found", 404);

    if (agent.computer_substrate === "provider-vm") {
      let readiness: ProviderAgentReadinessStage | undefined;
      let power: ProviderAgentPowerStage | undefined;
      let resize: ProviderResizeStage | "verification_unavailable" | undefined;
      let latest = agent;
      if (agent.status === "provisioning" && ["provision", "start", "stop", "restart", "resize"].includes(String(agent.operation_kind))) {
        const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "provider_agent_readiness", userId, limit: 120, windowMs: 5 * 60_000 });
        if (limited) return limited;
        try {
          const operation = { userId, agentId: String(agent.id), operationId: String(agent.operation_id) };
          if (agent.operation_kind === "provision") {
            if (agent.type === "linux-desktop") {
              if (agent.computer_profile !== "ubuntu-desktop") throw new Error("Unsupported provider desktop profile");
              readiness = await advanceProviderDesktopReadiness(operation);
            } else readiness = agent.type === "deepseek-harness"
              ? await advanceProviderNativeReadiness(operation)
              : await advanceProviderAgentReadiness(operation);
          }
          else if (agent.operation_kind === "resize") resize = (await advanceProviderResize(operation, "observe")).stage;
          else power = await advanceProviderAgentPower(operation, "observe");
        } catch {
          if (agent.operation_kind === "provision") readiness = "verification_unavailable";
          else if (agent.operation_kind === "resize") resize = "verification_unavailable";
          else power = "verification_unavailable";
          log.warn("provider lifecycle observation is unavailable", {
            source: "hivra/agents/[id]", failureType: "provider_agent_lifecycle_unverified", userId, agentId: agent.id, operationKind: agent.operation_kind,
          });
        }
        const { data: observed, error: reloadError } = await supabaseAdmin.from("hivra_agents").select("*")
          .eq("id", agent.id).eq("user_id", userId).eq("computer_substrate", "provider-vm").maybeSingle();
        if (reloadError || !observed) return apiError("Could not refresh the computer’s current state. No replacement was started.", 503);
        latest = observed;
      }
      // Provider computers have no Proxmox VMID or host-side bootstrap lane.
      // Never pass them to the legacy poll, seed or managed-fleet fallback;
      // their seeds and contract use the enrolled provider pin instead, after
      // this response, so an unreachable computer never holds up the page.
      if (providerAgentUpkeepApplies(latest)) {
        const snapshot = latest;
        runAfterResponse(
          () => advanceProviderAgentUpkeep(userId, snapshot, { deadline: pollStartedAt + BACKGROUND_UPKEEP_DEADLINE_MS }),
          { source: "hivra/agents/[id]", failureType: "provider_agent_upkeep_failed", userId, agentId: String(snapshot.id) },
        );
      }
      const sameOperation = latest.operation_id === agent.operation_id && latest.operation_kind === agent.operation_kind;
      const response = apiSuccess({ agent: { ...sanitizeHivraAgentRow(latest),
        ...(sameOperation && latest.status === "provisioning" && readiness ? { readiness_stage: readiness } : {}),
        ...(sameOperation && latest.status === "provisioning" && power ? { power_stage: power } : {}),
        ...(sameOperation && latest.status === "provisioning" && resize ? { resize_stage: resize } : {}) } });
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    if (agent.computer_substrate === "do-managed-session") {
      // DigitalOcean sessions are observed through their own reconcile path;
      // never pass them to the Proxmox poll, seed, or managed-fleet fallback.
      const response = apiSuccess({ agent: sanitizeHivraAgentRow(agent) });
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    if (agent.computer_substrate === "gvisor") {
      const response = apiSuccess({ agent: sanitizeHivraAgentRow(agent) });
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    let current = agent;
    let executionContext: HivraAgentExecutionContext | null = null;
    const getExecutionContext = async (): Promise<HivraAgentExecutionContext> => {
      if (!executionContext) {
        executionContext = await resolveHivraAgentExecutionContext(userId, current);
      }
      return executionContext;
    };
    if (current.status === "provisioning" && current.vmid) {
      const convergenceOperationKind =
        ["provision", "start", "restart", "resize"].includes(String(current.operation_kind))
          ? current.operation_kind as "provision" | "start" | "restart" | "resize"
          : null;
      const provisionOperationId =
        convergenceOperationKind && typeof current.operation_id === "string"
          ? current.operation_id
          : null;
      if (!convergenceOperationKind || !provisionOperationId) {
        return apiError("Provisioning state is missing its durable operation lease", 409);
      }
      const provisionStillCurrent = await checkpointHivraAgentOperation({
        userId,
        agentId: String(current.id),
        operationId: provisionOperationId,
        expectedDesiredState: "running",
      });
      // Once desired_state changes, never persist a stale host result. The
      // provision lease owner verifies/compensates its allocation; start-like
      // leases release so a retrying DELETE can claim teardown exclusively.
      if (!provisionStillCurrent) {
        if (current.desired_state === "deleted") {
          if (convergenceOperationKind === "provision") {
            const allocationOperationId =
              typeof current.allocation_operation_id === "string"
                ? current.allocation_operation_id
                : null;
            if (allocationOperationId !== provisionOperationId) {
              return apiError("Provision cancellation lacks verified VM ownership evidence", 409);
            }
            let cancellationContext: HivraAgentExecutionContext;
            try {
              cancellationContext = await resolveHivraAgentTeardownExecutionContext(
                userId,
                current,
              );
            } catch (contextError) {
              const safeError = describeHivraAgentExecutionContextError(contextError);
              if (safeError) return apiError(safeError.message, safeError.status);
              throw contextError;
            }
            const cancellationVmid = Number(current.vmid);
            const cancellationPaths = [
              hivraAgentProvisionLogPath(cancellationContext, cancellationVmid),
              hivraAgentStartLogPath(cancellationContext, cancellationVmid),
              hivraAgentProvisionSecretPath(cancellationContext, cancellationVmid),
            ].filter((path): path is string => Boolean(path));
            const cleanup = await runProxmoxHostScript(
              verifiedDestroyHivraVmScript({
                vmid: cancellationVmid,
                storage: cancellationContext.paths.storage,
                expectedAllocationOperationId: allocationOperationId,
                expectedInfrastructureBindingTag: cancellationContext.infrastructureBindingTag,
                allowManagedLegacyAuthority: false,
                cleanupPaths: cancellationPaths,
              }),
              cancellationContext.env,
            );
            if (!cleanup.ok) {
              return apiError(
                "Provision cancellation was requested, but VM cleanup could not be verified.",
                502,
              );
            }
            const deleted = await completeHivraAgentDelete({
              userId,
              agentId: String(current.id),
              operationId: provisionOperationId,
            });
            if (!deleted) {
              return apiError("Verified VM cleanup could not be finalized safely.", 409);
            }
          } else {
            // The detached start helper inherits FD8 until its qm mutation is
            // complete. A poll cannot safely clear this lease from DB evidence
            // alone: DELETE could then destroy the VM while the helper is still
            // about to start it. The bounded recovery sweep acquires that same
            // host lock, verifies the stable binding/provider state, and only
            // then releases the exact lease for a retrying delete.
          }
          const { data: superseded } = await supabaseAdmin
            .from("hivra_agents")
            .select("*")
            .eq("id", current.id)
            .eq("user_id", userId)
            .maybeSingle();
          return apiSuccess({ agent: sanitizeHivraAgentRow(superseded || current) });
        }
        return apiSuccess({ agent: sanitizeHivraAgentRow(current) });
      }
      const vmid = Number(current.vmid);
      let context: HivraAgentExecutionContext;
      try {
        context = await getExecutionContext();
      } catch (contextError) {
        const safeError = describeHivraAgentExecutionContextError(contextError);
        if (safeError) return apiError(safeError.message, safeError.status);
        throw contextError;
      }
      // Grep the FULL log, not a tail window: anything appended after the
      // result marker must never make a converged box look "not ready yet".
      const provisionLog = hivraAgentProvisionLogPath(context, vmid);
      const startLog = hivraAgentStartLogPath(context, vmid);
      const convergenceLog = convergenceOperationKind === "provision"
        ? provisionLog
        : startLog;
      const provisionSecret = hivraAgentProvisionSecretPath(context, vmid);
      const compatibilityPayload =
        current.operation_payload && typeof current.operation_payload === "object"
          ? current.operation_payload as Record<string, unknown>
          : null;
      const nMinusOneCompatibility =
        current.deployment_mode === "hivra-managed" &&
        current.infrastructure_binding_token_enforced === false &&
        compatibilityPayload?.compatibility === "n_minus_one";
      const startReceiptProbe = convergenceOperationKind === "provision"
        ? ""
        : `if grep -Fxq ${shellQuote(`HIVRA_OPERATION_ID ${provisionOperationId}`)} ${shellQuote(startLog)} 2>/dev/null; then
  printf 'HIVRA_OPERATION_RECEIPT %s\\n' ${shellQuote(provisionOperationId)}
fi`;
      const provisionOwnershipProbe =
        convergenceOperationKind === "provision" &&
        context.infrastructureBindingTagEnforced &&
        current.allocation_operation_id === provisionOperationId
          ? `TAGS="$(qm config ${vmid} 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')"
if printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq ${shellQuote(context.infrastructureBindingTag)} \
  && printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq ${shellQuote(`hivra-op-${provisionOperationId.replace(/-/g, "")}`)}; then
  printf 'HIVRA_PROVIDER_OWNERSHIP %s\\n' ${shellQuote(provisionOperationId)}
fi`
          : "";
      // Claude Code / Codex Proxmox computers: the reporter install outcome the
      // launch installer (provision log) or start helper (start log) wrote for
      // this operation. The log is recreated per operation, so the last line wins.
      const activityCollectorProbe = supportsNativeTracing(current)
        ? `COLLECTOR="$(grep -E ${shellQuote(ACTIVITY_COLLECTOR_MARKER_PATTERN)} ${shellQuote(convergenceLog)} 2>/dev/null | tail -1 || true)"
if [ -n "$COLLECTOR" ]; then printf '%s\\n' "$COLLECTOR"; fi`
        : "";
      const script = `MARKER="$(grep -oE '\\{"vmid":[^{}]*"ready":(true|false)[^{}]*\\}' ${shellQuote(convergenceLog)} 2>/dev/null | tail -1 || true)"
if [ -n "$MARKER" ]; then printf '%s\\n' "$MARKER"; fi
${activityCollectorProbe}
${startReceiptProbe}
${provisionOwnershipProbe}
${provisionSecret ? `if printf '%s' "$MARKER" | grep -q '"ready":true' && [ -f ${shellQuote(provisionSecret)} ]; then
  TOKEN="$(tr -d '[:space:]' < ${shellQuote(provisionSecret)})"
  if [ "\${#TOKEN}" -eq 64 ] && ! printf '%s' "$TOKEN" | grep -q '[^0-9a-f]'; then
    printf 'HIVRA_PROVISION_SECRET %s\\n' "$TOKEN"
  fi
fi` : ""}`;
      const result = await runProxmoxHostScript(script, context.env);
      if (!result.ok) {
        log.warn("hivra agent provision status poll failed", {
          source: "hivra/agents/[id]",
          failureType: "hivra_agent_provision_poll_failed",
          userId,
          agentId: current.id,
          agentType: current.type,
          vmid,
          proxmoxHost: context.host,
          errorMessage: result.error ?? null,
          stdoutBytes: result.stdout?.length ?? 0,
          stderr: result.stderr?.slice(0, 500) ?? null,
        });
      }
      const outputLines = (result.stdout || "").split(/\r?\n/);
      const line = outputLines.find((candidate) => candidate.trim().startsWith("{"))?.trim() || "";
      const secretMatch = outputLines
        .map((candidate) => candidate.trim().match(/^HIVRA_PROVISION_SECRET ([0-9a-f]{64})$/))
        .find((candidate) => candidate);
      const returnedSecret = secretMatch?.[1] || null;
      const operationReceiptObserved = outputLines.some(
        (candidate) => candidate.trim() === `HIVRA_OPERATION_RECEIPT ${provisionOperationId}`,
      );
      const providerOwnershipObserved = outputLines.some(
        (candidate) => candidate.trim() === `HIVRA_PROVIDER_OWNERSHIP ${provisionOperationId}`,
      );
      if (line) {
        try {
          const j = JSON.parse(line) as {
            ready?: boolean;
            vmid?: number;
            agent_kind?: string;
            chat_url?: string;
            ip?: string;
            api_token?: string;
            error?: string;
          };
          if (j.ready === true) {
            if (
              !nMinusOneCompatibility &&
              convergenceOperationKind !== "provision" &&
              !operationReceiptObserved
            ) {
              log.warn("hivra lifecycle result lacks its durable operation receipt", {
                source: "hivra/agents/[id]",
                failureType: "hivra_agent_lifecycle_operation_receipt_missing",
                userId,
                agentId: current.id,
                operationKind: convergenceOperationKind,
                vmid,
              });
              return apiSuccess({ agent: sanitizeHivraAgentRow(current) });
            }
            if (
              !nMinusOneCompatibility &&
              convergenceOperationKind === "provision" &&
              context.infrastructureBindingTagEnforced &&
              !providerOwnershipObserved
            ) {
              log.warn("hivra provision result lacks provider ownership evidence", {
                source: "hivra/agents/[id]",
                failureType: "hivra_agent_provision_ownership_missing",
                userId,
                agentId: current.id,
                vmid,
              });
              return apiSuccess({ agent: sanitizeHivraAgentRow(current) });
            }
            // Portable provisioning deliberately omits the bearer from the
            // persistent host log. Do not converge to running until its
            // root-only one-shot result is available and well-formed.
            if (
              convergenceOperationKind === "provision" &&
              context.kind === "self-managed" &&
              !returnedSecret
            ) {
              log.warn("hivra provision result is ready but its secret result is unavailable", {
                source: "hivra/agents/[id]",
                failureType: "hivra_agent_provision_secret_unavailable",
                userId,
                agentId: current.id,
                agentType: current.type,
                vmid,
                proxmoxHost: context.host,
              });
              return apiSuccess({ agent: sanitizeHivraAgentRow(current) });
            }
            const validatedResult = validateHivraHostRunningResult({
              result: j,
              expectedVmid: vmid,
              expectedIp: typeof current.ip === "string" ? current.ip : "",
              // Fresh provisioning owns the runtime-kind decision and publishes
              // that evidence. Start/restart/resize operate on the already-bound
              // VM and the lifecycle helper intentionally reports only its stable
              // coordinates, so requiring agent_kind there rejects a healthy
              // Ubuntu computer after every reboot.
              expectedAgentKind:
                convergenceOperationKind === "provision" && current.type === "linux-desktop"
                  ? "linux-desktop"
                  : null,
              namedHostname:
                typeof current.cf_hostname === "string" ? current.cf_hostname : null,
              oneShotApiToken: returnedSecret,
              existingApiToken:
                typeof current.api_token === "string" ? current.api_token : null,
            });
            if (!validatedResult.ok) {
              await releaseHivraAgentOperation({
                userId,
                agentId: String(current.id),
                operationId: provisionOperationId,
                error: `Host result validation failed: ${validatedResult.reason}`,
                markError: true,
              });
              log.error("hivra host result failed authority validation", new Error(validatedResult.reason), {
                source: "hivra/agents/[id]",
                failureType: "hivra_agent_host_result_invalid",
                userId,
                agentId: current.id,
                vmid,
                resultVmid: typeof j.vmid === "number" ? j.vmid : null,
                resultIpMatches: j.ip === current.ip,
                verboseErrors: true,
              });
              const { data: failed } = await supabaseAdmin
                .from("hivra_agents")
                .select("*")
                .eq("id", current.id)
                .eq("user_id", userId)
                .maybeSingle();
              return apiSuccess({ agent: sanitizeHivraAgentRow(failed || current) });
            }
            if (current.type === "linux-desktop") {
              const capabilityResult = await runProxmoxHostScript(
                buildRemoteDesktopCapabilityInspectionScript({
                  vmid,
                  guestIp: validatedResult.value.ip,
                  infrastructureBindingTag: context.infrastructureBindingTag,
                }),
                context.env,
                {
                  timeoutMs: 45_000,
                  maxOutputBytes: 16 * 1024,
                  earlyFinishMarker: "HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ",
                },
              );
              const capability = capabilityResult.ok
                ? parseRemoteDesktopCapabilityReceipt(capabilityResult.stdout || "")
                : null;
              if (
                !capability ||
                capability.computerId !== current.id ||
                capability.brokerOrigin !== validatedResult.value.chatUrl
              ) {
                await releaseHivraAgentOperation({
                  userId,
                  agentId: String(current.id),
                  operationId: provisionOperationId,
                  error: "Ubuntu Desktop did not publish its exact remote-desktop capability receipt.",
                  markError: true,
                });
                log.warn("linux desktop readiness capability is unavailable", {
                  source: "hivra/agents/[id]",
                  failureType: "hivra_linux_desktop_capability_unavailable",
                  userId,
                  agentId: current.id,
                  vmid,
                  capabilityCommandOk: capabilityResult.ok,
                });
                const { data: failed } = await supabaseAdmin
                  .from("hivra_agents")
                  .select("*")
                  .eq("id", current.id)
                  .eq("user_id", userId)
                  .maybeSingle();
                return apiSuccess({ agent: sanitizeHivraAgentRow(failed || current) });
              }
            }
            const isFirstProvision =
              convergenceOperationKind === "provision" &&
              !(typeof current.provisioned_at === "string" && current.provisioned_at);
            const firstProvisionedAt = typeof current.provisioned_at === "string" && current.provisioned_at
              ? current.provisioned_at
              : new Date().toISOString();
            const provisionCompleted = await completeHivraAgentRunning({
              userId,
              agentId: String(current.id),
              operationId: provisionOperationId,
              operationKind: convergenceOperationKind,
              chatUrl: validatedResult.value.chatUrl,
              ip: validatedResult.value.ip,
              apiToken: validatedResult.value.apiToken,
              provisionedAt: firstProvisionedAt,
            });
            if (!provisionCompleted) {
              const { data: superseded } = await supabaseAdmin
                .from("hivra_agents")
                .select("*")
                .eq("id", current.id)
                .eq("user_id", userId)
                .maybeSingle();
              return apiSuccess({ agent: sanitizeHivraAgentRow(superseded || current) });
            }
            if (provisionSecret && returnedSecret) {
              const cleanupResult = await runProxmoxHostScript(
                `rm -f -- ${shellQuote(provisionSecret)} && [ ! -e ${shellQuote(provisionSecret)} ]`,
                context.env,
              );
              if (!cleanupResult.ok) {
                log.warn("hivra provision secret cleanup failed", {
                  source: "hivra/agents/[id]",
                  failureType: "hivra_agent_provision_secret_cleanup_failed",
                  userId,
                  agentId: current.id,
                  agentType: current.type,
                  vmid,
                  proxmoxHost: context.host,
                  errorMessage: cleanupResult.error ?? cleanupResult.stderr?.slice(0, 300) ?? null,
                });
              }
            }
            // Only the completion winner records the reporter install outcome,
            // separately from issuance (recorded when the credential was
            // staged). Best effort: it never holds up or fails convergence.
            const collectorInstall = supportsNativeTracing(current)
              ? parseActivityCollectorMarker(outputLines)
              : null;
            if (collectorInstall) {
              const recorded = await recordCollectorInstallResult(supabaseAdmin, {
                agentId: String(current.id),
                userId,
                status: collectorInstall.status,
                ...(collectorInstall.reason ? { reason: collectorInstall.reason } : {}),
              });
              if (!recorded) {
                log.warn("hivra agent-run reporter install result could not be recorded", {
                  source: "hivra/agents/[id]",
                  failureType: "hivra_activity_collector_install_record_failed",
                  userId,
                  agentId: current.id,
                  operationKind: convergenceOperationKind,
                });
              }
            }
            await logHivraAgentEvent({ userId, event: "provisioned", agentId: current.id, agentType: current.type, detail: { vmid: current.vmid } });
            // completeHivraAgentRunning is an atomic operation-lease claim. Only
            // its winner may report first activation, and only after the host's
            // ready result, provider ownership, endpoint and bearer have passed
            // validation above. Start/restart/resize transitions never re-fire.
            if (isFirstProvision) {
              await captureHivraAgentComputerReady({
                userId,
                agentId: String(current.id),
                agentType: typeof current.type === "string" ? current.type : null,
                deploymentMode:
                  typeof current.deployment_mode === "string" ? current.deployment_mode : null,
                operationId: provisionOperationId,
                vmid: Number.isInteger(Number(current.vmid)) ? Number(current.vmid) : null,
                evidence: current.type === "linux-desktop"
                  ? "remote_desktop_capability_receipt"
                  : "host_ready_result",
              });
            }
            const { data: updated, error: reloadError } = await supabaseAdmin
              .from("hivra_agents")
              .select("*")
              .eq("id", current.id)
              .eq("user_id", userId)
              .single();
            if (reloadError || !updated) {
              throw new Error("Could not reload the completed provision result");
            }
            current = updated;
            // A wallet connected or disconnected while the box was stopped, or
            // a restored snapshot's old bankr.env, is applied before the poll
            // reports running. Best effort: it never fails convergence.
            if (current.status === "running") {
              try {
                await reconcileBankrEnvAfterHivraBoot({ userId, agent: current, executionContext: context, trigger: "poll" });
              } catch (walletError) {
                log.warn("hivra agent wallet boot sync threw", {
                  source: "hivra/agents/[id]",
                  failureType: "hivra_agent_wallet_boot_env_sync_failed",
                  userId,
                  agentId: current.id,
                  errorMessage: walletError instanceof Error ? walletError.message : String(walletError),
                });
              }
            }
          } else if (j.ready === false) {
            const reportedError = typeof j.error === "string"
              ? j.error.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240)
              : "";
            const failureMessage = reportedError || "Provisioning failed on the selected host.";
            const released = await releaseHivraAgentOperation({
              userId,
              agentId: String(current.id),
              operationId: provisionOperationId,
              error: failureMessage,
              markError: true,
            });
            // This terminal transition is the last automatic owner of the
            // named tunnel/CNAME created before kickoff. Only the guarded
            // release winner may remove it; a losing poll may be observing an
            // operation another request already advanced to a live box.
            if (released && (current.cf_tunnel_id || current.cf_hostname)) {
              await deleteBoxTunnel({
                tunnelId: current.cf_tunnel_id,
                hostname: current.cf_hostname,
              });
            }
            const { data: updated } = await supabaseAdmin
              .from("hivra_agents")
              .select("*")
              .eq("id", current.id)
              .eq("user_id", userId)
              .maybeSingle();
            if (released) {
              await logHivraAgentEvent({
                userId,
                event: "failed",
                agentId: current.id,
                agentType: current.type,
                detail: { reason: "provisioner_reported_failure", vmid: current.vmid },
              });
            }
            current = updated || current;
          }
        } catch (parseOrPersistError) {
          if (!(parseOrPersistError instanceof SyntaxError)) throw parseOrPersistError;
        }
      }
    }

    const needsBootstrap =
      current.type !== "linux-desktop" &&
      current.status === "running" && !current.bootstrapped_at && Boolean(current.ip);
    const supportsBoxSkills = Boolean(bankrSkillsDirForType(current.type as string | null));
    const needsBankrSkills =
      current.status === "running" &&
      !current.bankr_skills_seeded_at &&
      Boolean(current.ip) &&
      supportsBoxSkills;
    const needsTemplateSkills =
      current.status === "running" &&
      !current.template_skills_seeded_at &&
      Boolean(current.ip) &&
      supportsBoxSkills &&
      coerceSkillIds(current.template_skills).length > 0;

    if (needsBootstrap || needsBankrSkills || needsTemplateSkills) {
      let context: HivraAgentExecutionContext;
      try {
        context = await getExecutionContext();
      } catch (contextError) {
        const safeError = describeHivraAgentExecutionContextError(contextError);
        if (safeError) return apiError(safeError.message, safeError.status);
        throw contextError;
      }
      // Resolve once, then give every directly invoked guest seed the exact same
      // owner-scoped execution environment. None may reconstruct ambient fleet
      // credentials from a hostname.
      //
      // The identity seed and the skills seeds write different files, so they
      // run side by side instead of adding up (about 2 s and 3 s over SSH) before
      // the page sees its agent running. The Bankr and template skills write into
      // the same skills folder, and a template can name a Bankr skill, so those
      // two stay in order and the template's copy still lands last. A seed that
      // throws still fails this poll, as before.
      const seedEnv = context.env;
      const seeds = await Promise.allSettled([
        needsBootstrap ? maybeSeedBootstrap(current, userId, seedEnv) : false,
        (async () => {
          const bankrStamped = needsBankrSkills && await maybeSeedBankrSkills(current, userId, seedEnv);
          const templateStamped = needsTemplateSkills && await maybeSeedTemplateSkills(current, userId, seedEnv);
          return bankrStamped || templateStamped;
        })(),
      ]);
      const seedFailure = seeds.find((seed): seed is PromiseRejectedResult => seed.status === "rejected");
      if (seedFailure) throw seedFailure.reason;
      // Each seed stamps only its own column. Read the row back once so the
      // response and the Computer Contract step below see every stamp.
      if (seeds.some((seed) => seed.status === "fulfilled" && seed.value)) {
        const { data: seeded, error: seededReloadError } = await supabaseAdmin
          .from("hivra_agents")
          .select("*")
          .eq("id", current.id)
          .eq("user_id", userId)
          .maybeSingle();
        if (seeded) {
          current = seeded;
        } else {
          log.warn("hivra agent row could not be read back after seeding", {
            source: "hivra/agents/[id]",
            failureType: "hivra_agent_seed_reload_failed",
            userId,
            agentId: current.id,
            errorMessage: seededReloadError?.message ?? null,
          });
        }
      }
    }

    // Computer Contract: keep what the agent is told about its computer
    // current. Unlike the one-shot identity seed it is revisioned: a rename or
    // resize mints a new revision, and delivery is compare-and-swap with a
    // read-back receipt. It runs after this response and never fails it.
    const contractPlan = computerContractPlanFor(current as Parameters<typeof computerContractPlanFor>[0]);
    // It waits for the confirmed bootstrap, which rewrites the same
    // system-prompt.md: a bootstrap retry on the next poll could otherwise
    // overwrite a contract block this poll just delivered.
    if (current.status === "running" && current.ip && current.bootstrapped_at
      && contractPlan.status === "deliverable" && contractPlan.channel === "proxmox-seed") {
      const snapshot = current;
      // The owner-scoped host environment is resolved only when a round trip
      // is due, not on every page load.
      runAfterResponse(
        () => advanceProxmoxComputerContract(userId, snapshot, async () => (await getExecutionContext()).env, "auto",
          { deadline: pollStartedAt + BACKGROUND_UPKEEP_DEADLINE_MS }),
        { source: "hivra/agents/[id]", failureType: "computer_contract_step_skipped", userId, agentId: String(snapshot.id) },
      );
    }

    return apiSuccess({ agent: sanitizeHivraAgentRow(current) });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let deleteLease: { userId: string; agentId: string; operationId: string } | null = null;
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { data: existingAgent } = await supabaseAdmin
      .from("hivra_agents")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .single();
    if (!existingAgent) return apiError("Agent not found", 404);

    if (existingAgent.computer_substrate === "do-managed-session") {
      if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
      const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra_managed_session_lifecycle", userId, limit: 20, windowMs: 60_000 });
      if (limited) return limited;
      try {
        const session = await managedSessionAction(userId, String(existingAgent.id), "delete");
        const response = apiSuccess({ ok: session.status === "deleted", session });
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch (error) {
        return managedSessionFailure(error, "/api/hivra/agents/[id]");
      }
    }

    if (existingAgent.computer_substrate === "gvisor") {
      if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
      const limited = enforceAuthenticatedRouteRateLimit(req, {
        routeKey: "gvisor_computer_delete",
        userId,
        limit: 30,
        windowMs: 5 * 60_000,
      });
      if (limited) return limited;
      try {
        const deleted = await mutateGvisorComputer(userId, String(existingAgent.id), { action: "delete" });
        const response = apiSuccess({ ok: true, agent: sanitizeHivraAgentRow(deleted) });
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch (error) {
        if (error instanceof GvisorComputerError) {
          const status = error.code === "not_found" ? 404
            : error.code === "conflict" || error.code === "not_ready" ? 409 : 503;
          return apiError(error.message, status);
        }
        throw error;
      }
    }

    if (existingAgent.computer_substrate === "provider-vm") {
      if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
      const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "provider_agent_delete", userId, limit: 120, windowMs: 15 * 60_000 });
      if (limited) return limited;
      try {
        const result = await advanceProviderAgentDelete({ userId, agentId: String(existingAgent.id) });
        const response = apiSuccess({ ...result, agentId: String(existingAgent.id) }, result.ok ? 200 : 202);
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch (failure) {
        const code = failure instanceof ProviderAgentDeleteError ? failure.code : "operation_unconfirmed";
        log.warn("provider computer deletion is incomplete", {
          source: "hivra/agents/[id]", failureType: "provider_agent_delete_incomplete", userId, agentId: existingAgent.id, code,
        });
        const response = apiError("Computer deletion is incomplete. The original operation is saved; inspect this computer before resuming. Provider billing may continue until all resources are removed.", 409, undefined, { code });
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    }

    const operationId = randomUUID();
    const disposition = await requestHivraAgentDelete({
      userId,
      agentId: String(existingAgent.id),
      operationId,
    });
    if (disposition === "not_found") return apiError("Agent not found", 404);
    if (disposition === "deleted") return apiSuccess({ ok: true });
    if (disposition === "pending") {
      return apiError(
        "Delete is requested. The current provider operation must finish or compensate before deletion can continue; retry shortly.",
        409,
      );
    }

    deleteLease = { userId, agentId: String(existingAgent.id), operationId };
    const { data: agent, error: reloadError } = await supabaseAdmin
      .from("hivra_agents")
      .select("*")
      .eq("id", existingAgent.id)
      .eq("user_id", userId)
      .single();
    if (
      reloadError ||
      !agent ||
      agent.operation_kind !== "delete" ||
      agent.operation_id !== operationId ||
      agent.desired_state !== "deleted"
    ) {
      await releaseHivraAgentOperation({ ...deleteLease, error: "Delete lease reload failed.", markError: true });
      deleteLease = null;
      return apiError("Delete authority changed before provider cleanup. Refresh and retry.", 409);
    }

    if (agent.vmid) {
      const vmid = Number(agent.vmid);
      const allocationOperationId =
        typeof agent.allocation_operation_id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          agent.allocation_operation_id,
        )
          ? agent.allocation_operation_id
          : null;
      if (agent.deployment_mode === "self-managed" && !allocationOperationId) {
        await releaseHivraAgentOperation({
          ...deleteLease,
          error: "Portable VM ownership evidence is missing.",
          markError: true,
        }).catch(() => false);
        deleteLease = null;
        return apiError(
          "This computer lacks verified VM ownership evidence. Verify and remove the VM on the target before finalizing deletion.",
          409,
        );
      }
      let context: HivraAgentExecutionContext;
      try {
        context = await resolveHivraAgentTeardownExecutionContext(userId, agent);
      } catch (contextError) {
        await releaseHivraAgentOperation({
          ...deleteLease,
          error: "Infrastructure authority could not be resolved for deletion.",
          markError: true,
        }).catch(() => false);
        deleteLease = null;
        const safeError = describeHivraAgentExecutionContextError(contextError);
        if (safeError) return apiError(safeError.message, safeError.status);
        throw contextError;
      }
      const provisionLog = hivraAgentProvisionLogPath(context, vmid);
      const provisionSecret = hivraAgentProvisionSecretPath(context, vmid);
      const startLog = hivraAgentStartLogPath(context, vmid);
      const cleanupPaths = [provisionLog, startLog, provisionSecret]
        .filter((path): path is string => Boolean(path));
      const { data: privateAccess, error: privateAccessError } = await supabaseAdmin
        .from("hivra_private_access_connections")
        .select("authority,login_server")
        .eq("agent_id", agent.id)
        .eq("user_id", userId)
        .maybeSingle();
      if (privateAccessError) {
        await releaseHivraAgentOperation({
          ...deleteLease,
          error: "Private-access authority could not be checked before deletion.",
          markError: true,
        }).catch(() => false);
        deleteLease = null;
        return apiError("Private access could not be checked before VM deletion. Retry Delete.", 503);
      }
      const privateAccessAgent = agent as unknown as HivraPrivateAccessAgentRow;
      if (privateAccess && sameHivraPrivateAccessAuthority(
        privateAccess.authority,
        hivraPrivateAccessAuthority(privateAccessAgent),
      )) {
        const revocation = await prepareHivraTailscaleForDelete(privateAccessAgent, context);
        if (!revocation.ok) {
          await releaseHivraAgentOperation({
            ...deleteLease,
            error: `Private-access guest logout was not confirmed (${revocation.failureCode ?? "unknown"}).`,
            markError: true,
          }).catch(() => false);
          deleteLease = null;
          return apiError(
            "The running computer's private-network logout could not be confirmed, so its VM was retained. Retry Delete.",
            502,
          );
        }
      }
      const destroy = await runProxmoxHostScript(
        verifiedDestroyHivraVmScript({
          vmid,
          storage: context.paths.storage,
          expectedAllocationOperationId: allocationOperationId,
          expectedInfrastructureBindingTag: context.infrastructureBindingTagEnforced
            ? context.infrastructureBindingTag
            : null,
          allowManagedLegacyAuthority:
            agent.deployment_mode === "hivra-managed" &&
            !context.infrastructureBindingTagEnforced,
          cleanupPaths,
        }),
        context.env,
      );
      if (!destroy.ok) {
        await releaseHivraAgentOperation({
          ...deleteLease,
          error: (destroy.error || destroy.stderr || "destroy failed").slice(0, 300),
          markError: true,
        }).catch(() => false);
        deleteLease = null;
        await logHivraAgentEvent({
          userId,
          event: "failed",
          agentId: agent.id,
          agentType: agent.type,
          detail: {
            reason: "delete_destroy_failed",
            vmid,
            proxmox_host: context.host,
            error: (destroy.error || destroy.stderr || "destroy failed").slice(0, 200),
          },
        });
        log.error("hivra agent destroy failed; not marking deleted", new Error(destroy.error || "destroy failed"), {
          source: "hivra/agents/[id]",
          failureType: "hivra_agent_destroy_failed",
          userId,
          agentId: agent.id,
          vmid,
          proxmoxHost: context.host,
          stdout: destroy.stdout?.slice(0, 500) ?? null,
          stderr: destroy.stderr?.slice(0, 500) ?? null,
          verboseErrors: true,
        });
        return apiError("Agent VM destroy failed", 502);
      }
    }
    // The shared finalizer verifies tunnel/DNS/key revocation before the
    // terminal CAS, exactly as it does for background operation recovery.
    const completed = await completeHivraAgentDelete(deleteLease);
    if (!completed) {
      await releaseHivraAgentOperation({
        ...deleteLease,
        error: "Verified provider deletion could not be persisted.",
        markError: true,
      }).catch(() => false);
      deleteLease = null;
      return apiError("The VM was removed, but deletion could not be finalized safely. Refresh and retry.", 409);
    }
    deleteLease = null;
    await logHivraAgentEvent({ userId, event: "deleted", agentId: agent.id, agentType: agent.type });
    return apiSuccess({ ok: true });
  } catch (err) {
    if (deleteLease) {
      await releaseHivraAgentOperation({
        ...deleteLease,
        error: err instanceof HivraAgentDeleteCleanupError
          ? err.message : "Delete operation failed before verified completion.",
        markError: true,
      }).catch(() => false);
    }
    if (err instanceof HivraAgentDeleteCleanupError) {
      log.warn("hivra agent deletion awaits access cleanup", {
        source: "hivra/agents/[id]",
        failureType: "hivra_agent_delete_cleanup_pending",
        agentId: deleteLease?.agentId,
        stage: err.stage,
      });
      return apiError(err.message, 502);
    }
    return handleApiError(err);
  }
}
