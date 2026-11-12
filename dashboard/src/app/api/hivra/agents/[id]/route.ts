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
import { observeProviderRuntimeUpdate, recordProviderSoftwareUpdate, type ProviderRuntimeUpdateStage } from "@/lib/hivra/provider-runtime-update";
import type { ProviderAgentPowerStage } from "@/lib/hivra/provider-power-contract";
import { advanceProviderResize } from "@/lib/hivra/provider-agent-resize";
import type { ProviderResizeStage } from "@/lib/hivra/provider-agent-resize-contract";
import { randomUUID } from "node:crypto";

import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
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
import { readStoredLlmConfig, buildBoxLlmPayload, sanitizeHivraAgentRow, type BoxLlmPayload } from "@/lib/hivra/agent-llm";
import { decryptApiKey } from "@/lib/crypto";
import { HivraAgentDeleteCleanupError } from "@/lib/hivra/agent-delete-cleanup";
import { advanceProxmoxProvisionPoll } from "@/lib/hivra/proxmox-provision-poll";
import { deleteProxmoxHivraAgent } from "@/lib/hivra/delete-hivra-agent";
import {
  describeHivraAgentExecutionContextError,
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import {
  completeHivraAgentDelete,
  releaseHivraAgentOperation,
  requestHivraAgentDelete,
} from "@/lib/hivra/agent-operation-store";
import { GvisorComputerError, mutateGvisorComputer } from "@/lib/hivra/gvisor-computer-service";
import { managedSessionAction } from "@/lib/hivra/do-managed-sessions";
import { manageCapabilitiesFor } from "@/lib/hivra/manage-capabilities";
import { isComputerMissingOnHostRow } from "@/lib/hivra/computer-usage-contract";
import { readStoredUsage } from "@/lib/hivra/computer-usage";
import { readComputerUsageCache } from "@/lib/hivra/computer-usage-cache";
import { preparedOmarchyRefreshPending } from "@/lib/hivra/prepared-omarchy-refresh-contract";
import { advancePreparedOmarchyRefresh, cancelPreparedOmarchyRefresh } from "@/lib/hivra/prepared-omarchy-refresh";
import { matchPreparedCanaryComputer } from "@/lib/hivra/prepared-canary-computers";
import { managedSessionFailure } from "@/app/api/hivra/managed-sessions/route-support";
import { agentLinkEndpoint, syncAgentLinkKit } from "@/lib/agent-links/kit-delivery";
import { loadKeyRecord } from "@/lib/agent-links/store";



// Bootstrap seeding: once a box is running, push its SOUL.md / USER.md /
// first-conversation prompt (built from the launch onboarding) onto it — exactly
// once, guarded by `bootstrapped_at`. Best-effort and idempotent: if the SSH seed
// fails we leave `bootstrapped_at` null and retry on the next poll, well before
// the user finishes connecting their account and sends a first message.
// Resolves true once it has stamped the column; the poll reads the row back.
async function maybeSeedBootstrap(
  agent: Record<string, unknown>,
  userId: string,
  authority: HivraAgentExecutionContext,
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
      vmid: (agent.vmid as number | null) ?? null,
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
    authority,
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
  authority: HivraAgentExecutionContext,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  if (agent.status !== "running" || agent.bankr_skills_seeded_at || !agent.ip) return false;
  if (!bankrSkillsDirForType(agent.type as string | null)) return false; // unsupported type — never attempt
  const res = await seedBankrSkillsOntoBox(
    {
      id: String(agent.id),
      type: (agent.type as string | null) ?? null,
      ip: (agent.ip as string | null) ?? null,
      vmid: (agent.vmid as number | null) ?? null,
    },
    authority,
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
  authority: HivraAgentExecutionContext,
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
      vmid: (agent.vmid as number | null) ?? null,
    },
    skillIds,
    authority,
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

// Every agent the poll returns carries its Manage capability map: what the
// owner can do with this computer, and why not. It is computed here, where
// the private fields that decide it are visible, and adds no host call.
function publicAgent(row: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    ...sanitizeHivraAgentRow(row),
    ...extra,
    manage: manageCapabilitiesFor(row, { preparedMatch: Boolean(matchPreparedCanaryComputer(row)) }),
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const pollStartedAt = Date.now();
  try {
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
    // .single() reports zero rows as PGRST116 and a malformed id as 22P02: both
    // mean no such agent. Any other error is a failed read, not a missing agent.
    if (error && !["PGRST116", "22P02"].includes(error.code)) return apiError("Could not load this computer.", 503);
    if (!agent) return apiError("Agent not found", 404);

    if (preparedOmarchyRefreshPending(agent)) {
      const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "prepared_omarchy_refresh", userId, limit: 100, windowMs: 5 * 60_000 });
      if (limited) return limited;
      let observed = agent;
      try { observed = await advancePreparedOmarchyRefresh(userId, agent); }
      catch { log.warn("Prepared Omarchy update remains unconfirmed", { source: "hivra/agents/[id]", agentId: id }); }
      const response = apiSuccess({ agent: publicAgent(observed) });
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    if (agent.computer_substrate === "provider-vm") {
      let readiness: ProviderAgentReadinessStage | undefined;
      let power: ProviderAgentPowerStage | undefined;
      let resize: ProviderResizeStage | "verification_unavailable" | undefined;
      let runtimeUpdate: ProviderRuntimeUpdateStage | undefined;
      let latest = agent;
      if (agent.status === "provisioning" && ["provision", "start", "stop", "restart", "resize", "runtime_update"].includes(String(agent.operation_kind))) {
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
          else if (agent.operation_kind === "runtime_update") {
            const observed = await observeProviderRuntimeUpdate(operation);
            runtimeUpdate = observed.stage;
            if (observed.stage === "updated") {
              await logHivraAgentEvent({ userId, event: "runtime_updated", agentId: agent.id, agentType: agent.type,
                detail: { inPlace: true, myCloud: true, ...(observed.agentCli ? { agentCli: observed.agentCli } : {}), ...(observed.agentApp ? { agentApp: observed.agentApp } : {}) } });
              await recordProviderSoftwareUpdate(agent, observed);
            }
          }
          else power = await advanceProviderAgentPower(operation, "observe");
        } catch {
          if (agent.operation_kind === "provision") readiness = "verification_unavailable";
          else if (agent.operation_kind === "resize") resize = "verification_unavailable";
          else if (agent.operation_kind === "runtime_update") runtimeUpdate = "verification_unavailable";
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
      const response = apiSuccess({ agent: publicAgent(latest, {
        ...(sameOperation && latest.status === "provisioning" && readiness ? { readiness_stage: readiness } : {}),
        ...(sameOperation && latest.status === "provisioning" && power ? { power_stage: power } : {}),
        ...(sameOperation && latest.status === "provisioning" && resize ? { resize_stage: resize } : {}),
        ...(runtimeUpdate && (runtimeUpdate === "updated" || runtimeUpdate === "failed" || (sameOperation && latest.status === "provisioning"))
          ? { runtime_update_stage: runtimeUpdate } : {}) }) });
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    if (agent.computer_substrate === "do-managed-session") {
      // DigitalOcean sessions are observed through their own reconcile path;
      // never pass them to the Proxmox poll, seed, or managed-fleet fallback.
      const response = apiSuccess({ agent: publicAgent(agent) });
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    if (agent.computer_substrate === "gvisor") {
      const response = apiSuccess({ agent: publicAgent(agent) });
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
      const polled = await advanceProxmoxProvisionPoll(userId, current, getExecutionContext);
      if ("error" in polled) return apiError(polled.error.message, polled.error.status);
      if (polled.stop) return apiSuccess({ agent: publicAgent(polled.agent) });
      current = polled.agent;
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
      const seeds = await Promise.allSettled([
        needsBootstrap ? maybeSeedBootstrap(current, userId, context) : false,
        (async () => {
          const bankrStamped = needsBankrSkills && await maybeSeedBankrSkills(current, userId, context);
          const templateStamped = needsTemplateSkills && await maybeSeedTemplateSkills(current, userId, context);
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
        () => advanceProxmoxComputerContract(userId, snapshot, getExecutionContext, "auto",
          { deadline: pollStartedAt + BACKGROUND_UPKEEP_DEADLINE_MS }),
        { source: "hivra/agents/[id]", failureType: "computer_contract_step_skipped", userId, agentId: String(snapshot.id) },
      );
    }

    // Linked computers: a link that changed while this agent was stopped
    // reaches it now. Only an agent whose kit is marked out of date is read.
    if (current.status === "running" && current.ip) {
      const linkAgentId = String(current.id), endpoint = agentLinkEndpoint(new URL(req.url).origin);
      runAfterResponse(async () => {
        const record = await loadKeyRecord(linkAgentId);
        if (record && record.kit_sha256 === null) await syncAgentLinkKit(userId, linkAgentId, endpoint);
      }, { source: "hivra/agents/[id]", failureType: "agent_link_kit_sync_skipped", userId, agentId: linkAgentId });
    }

    return apiSuccess({ agent: publicAgent(current) });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
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

    if (preparedOmarchyRefreshPending(existingAgent)) {
      if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
      const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "prepared_omarchy_cancel", userId, limit: 12, windowMs: 60_000 });
      if (limited) return limited;
      try {
        const observed = await cancelPreparedOmarchyRefresh(userId, existingAgent);
        const response = apiSuccess({ ok: observed.status === "deleted", agent: publicAgent(observed) }, observed.status === "deleted" ? 200 : 202);
        response.headers.set("Cache-Control", "no-store"); return response;
      } catch {
        return apiError("Cancellation is still being confirmed. This prepared computer remains reserved until its updater has stopped.", 409);
      }
    }

    // "Remove from Hivra": the record of a computer its host already reported
    // gone (and the host's latest read still says so). It runs the same
    // delete lease and access cleanup as Delete but never sends the host a
    // destroy for a VM that no longer exists.
    if (new URL(req.url).searchParams.get("recordOnly") === "1") {
      if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
      const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra_forget_record", userId, limit: 20, windowMs: 60_000 });
      if (limited) return limited;
      const proxmox = existingAgent.computer_substrate == null || existingAgent.computer_substrate === "proxmox-kvm";
      let hostSaysMissing = false;
      if (proxmox && isComputerMissingOnHostRow(existingAgent)
        && existingAgent.operation_id == null && existingAgent.operation_kind == null) {
        try {
          hostSaysMissing = readStoredUsage((await readComputerUsageCache(String(existingAgent.id), userId))?.sample)?.result === "missing";
        } catch {
          hostSaysMissing = false;
        }
      }
      if (!hostSaysMissing) {
        return apiError("Hivra can only remove the record of a computer its host confirms is gone. Refresh this computer and try again.", 409);
      }
      const forgetOperationId = randomUUID();
      const disposition = await requestHivraAgentDelete({ userId, agentId: String(existingAgent.id), operationId: forgetOperationId });
      if (disposition === "not_found") return apiError("Agent not found", 404);
      if (disposition === "deleted") return apiSuccess({ ok: true });
      if (disposition === "pending") return apiError("Another operation on this computer is still finishing. Try again shortly.", 409);
      const forgetLease = { userId, agentId: String(existingAgent.id), operationId: forgetOperationId };
      try {
        const completed = await completeHivraAgentDelete(forgetLease);
        if (!completed) {
          await releaseHivraAgentOperation({ ...forgetLease, error: "Removing the record could not be finalized.", markError: true }).catch(() => false);
          return apiError("The record couldn't be removed safely. Refresh and try again.", 409);
        }
      } catch (forgetError) {
        await releaseHivraAgentOperation({
          ...forgetLease,
          error: forgetError instanceof HivraAgentDeleteCleanupError ? forgetError.message : "Removing the record failed before it finished.",
          markError: true,
        }).catch(() => false);
        if (forgetError instanceof HivraAgentDeleteCleanupError) return apiError(forgetError.message, 502);
        throw forgetError;
      }
      await logHivraAgentEvent({
        userId, event: "deleted", agentId: String(existingAgent.id), agentType: typeof existingAgent.type === "string" ? existingAgent.type : null,
        detail: { recordOnly: true, reason: "computer_missing_on_host" },
      });
      return apiSuccess({ ok: true });
    }

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

    const deleted = await deleteProxmoxHivraAgent(userId, existingAgent);
    return deleted.ok ? apiSuccess({ ok: true }) : apiError(deleted.message, deleted.status);
  } catch (err) {
    return handleApiError(err);
  }
}
