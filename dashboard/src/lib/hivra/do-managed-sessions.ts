import "server-only";

// DigitalOcean Managed Agents sessions as Hivra agents.
//
// One Hivra agent row (computer_substrate = do-managed-session) owns exactly
// one DigitalOcean harness session. Hivra drives it through DigitalOcean's
// session API so the owner never needs doctl or a terminal: create from a
// manifest, stream canonical events, forward chat input, resolve approvals,
// pause/resume, and destroy with a verified-absence receipt.
//
// Truthfulness rules: the row only reaches `running` after DigitalOcean reports
// READY, `stopped` after it reports PAUSED, and `deleted` after a read confirms
// the session is gone. An ambiguous create is reconciled by the deterministic
// session name before anything is created again.

import { createHash, randomUUID } from "node:crypto";

import {
  createDigitalOceanManagedAgentsClient,
  DigitalOceanApiError,
  type DigitalOceanManagedAgentsClient,
  type DigitalOceanSandboxSize,
  type DigitalOceanSession,
} from "@/lib/digitalocean/managed-agents-client";
import {
  DIGITALOCEAN_HARNESSES,
  DIGITALOCEAN_MANAGED_AGENTS_ADAPTER_VERSION,
  DIGITALOCEAN_SANDBOX_SIZES,
  type DigitalOceanConnectionDto,
  type DigitalOceanConnectionErrorCode,
  type DigitalOceanDeploymentTargetDto,
  type DigitalOceanHarness,
  type DigitalOceanSandboxSize as DigitalOceanSizeSlug,
} from "@/lib/infrastructure/contracts";
import {
  createDigitalOceanConnectionRecord,
  loadDigitalOceanConnectionSecret,
  loadDigitalOceanTarget,
  refreshDigitalOceanTargetRecord,
  type DigitalOceanTargetEvidence,
} from "@/lib/infrastructure/digitalocean-store";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  sanitizeManagedSessionEvent,
  type ManagedSessionEvent,
} from "@/lib/hivra/managed-session-transcript";
import type { ManagedSessionDto, ManagedSessionLaunchInput } from "@/lib/hivra/managed-session-contracts";

const LOG_SOURCE = "do-managed-sessions";
const SUBSTRATE = "do-managed-session";
const NO_AMBIENT_AUTHORITY = "__hivra_self_managed_no_ambient_authority__";
const READY_WAIT_MS = 25_000;
const DELETE_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 1_000;
const HISTORY_EVENT_LIMIT = 1_000;
const HISTORY_PROMPT_LIMIT = 200;
const AMBIGUOUS_CREATE_WINDOW_MS = 2 * 60_000;

export type ManagedSessionErrorCode =
  | "not_found"
  | "invalid_request"
  | "not_ready"
  | "conflict"
  | "invalid_credentials"
  | "provider_forbidden"
  | "payment_required"
  | "model_key_rejected"
  | "provider_rejected"
  | "provider_unavailable"
  | "database_failed";

export class ManagedSessionError extends Error {
  constructor(public readonly code: ManagedSessionErrorCode, message: string, public readonly agentId?: string) {
    super(message);
    this.name = "ManagedSessionError";
  }
}

type AgentRow = {
  id: string;
  user_id: string;
  type: string;
  name: string;
  status: string;
  desired_state: string;
  error: string | null;
  created_at: string;
  provisioned_at: string | null;
  computer_substrate: string;
  infrastructure_connection_id: string | null;
  deployment_target_id: string | null;
  infrastructure_connection_revision: number | null;
  do_session_name: string;
  do_session_id: string | null;
  do_session_harness: DigitalOceanHarness;
  do_session_size: DigitalOceanSizeSlug;
  do_launch_request_id: string;
  do_session_observation: Record<string, unknown> | null;
};

const AGENT_SELECT = [
  "id", "user_id", "type", "name", "status", "desired_state", "error", "created_at", "provisioned_at",
  "computer_substrate", "infrastructure_connection_id", "deployment_target_id", "infrastructure_connection_revision",
  "do_session_name", "do_session_id", "do_session_harness", "do_session_size", "do_launch_request_id",
  "do_session_observation",
].join(",");

type Dependencies = {
  client(apiToken: string): DigitalOceanManagedAgentsClient;
  now(): Date;
  sleep(ms: number): Promise<void>;
  fetch: typeof fetch;
};

const defaultDependencies: Dependencies = {
  client: (apiToken) => createDigitalOceanManagedAgentsClient(apiToken),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetch: (...args) => fetch(...args),
};

let deps: Dependencies = defaultDependencies;

/** Test seam: replace provider access and time. Returns a restore function. */
export function setManagedSessionDependenciesForTest(overrides: Partial<Dependencies>): () => void {
  const previous = deps;
  deps = { ...deps, ...overrides };
  return () => { deps = previous; };
}

function db() {
  if (!supabaseAdmin) throw new ManagedSessionError("database_failed", "The agent store is unavailable.");
  return supabaseAdmin;
}

function ownerHash(userId: string): string {
  return createHash("sha256").update("hivra-do-managed-session-owner-v1\0").update(userId).digest("hex");
}

export function digitalOceanSessionName(agentId: string): string {
  return `hivra-${agentId.replaceAll("-", "")}`;
}

function sizeResources(size: DigitalOceanSizeSlug): { cpu: number; ram: number } {
  const match = /^mars-(\d+)vcpu-(\d+)gb$/.exec(size);
  if (!match) throw new ManagedSessionError("invalid_request", "Choose a supported DigitalOcean size.");
  return { cpu: Number(match[1]), ram: Number(match[2]) };
}

function connectionErrorFor(error: unknown): DigitalOceanConnectionErrorCode {
  if (error instanceof DigitalOceanApiError) {
    if (error.code === "unauthorized") return "invalid_credentials";
    if (error.code === "forbidden" || error.code === "not_found") return "managed_agents_forbidden";
    if (error.code === "response_invalid") return "provider_response_invalid";
  }
  return "provider_unavailable";
}

function providerError(error: unknown, action: string, agentId?: string): ManagedSessionError {
  if (error instanceof ManagedSessionError) return error;
  if (error instanceof InfrastructureConnectionStoreError) {
    if (error.code === "not_found") return new ManagedSessionError("not_found", "That DigitalOcean connection was not found.", agentId);
    if (error.code === "credential_error") return new ManagedSessionError("invalid_credentials", "Reconnect DigitalOcean: the saved token could not be read.", agentId);
    if (error.code === "conflict") return new ManagedSessionError("conflict", `DigitalOcean ${action} conflicted with a newer change. Refresh and try again.`, agentId);
    return new ManagedSessionError("database_failed", `DigitalOcean ${action} could not be recorded.`, agentId);
  }
  if (error instanceof DigitalOceanApiError) {
    switch (error.code) {
      case "unauthorized":
        return new ManagedSessionError("invalid_credentials", "DigitalOcean rejected the saved token. Reconnect DigitalOcean with a new token.", agentId);
      case "forbidden":
        return new ManagedSessionError("provider_forbidden", "This DigitalOcean token cannot manage Managed Agents. Use a token with write access to a team enrolled in the Managed Agents preview.", agentId);
      case "payment_required":
        return new ManagedSessionError("payment_required", "DigitalOcean needs a positive prepaid Harness Runtime balance before it can run this session.", agentId);
      case "not_found":
        return new ManagedSessionError("not_found", "DigitalOcean no longer has this session.", agentId);
      case "conflict":
      case "invalid_request":
        return new ManagedSessionError("provider_rejected", `DigitalOcean rejected the ${action} request.`, agentId);
      default:
        return new ManagedSessionError("provider_unavailable", `DigitalOcean did not confirm the ${action}. Try again shortly.`, agentId);
    }
  }
  return new ManagedSessionError("provider_unavailable", `DigitalOcean did not confirm the ${action}.`, agentId);
}

/** A definitive refusal means DigitalOcean created nothing; retrying is safe. */
function isDefinitiveRejection(error: unknown): boolean {
  return error instanceof DigitalOceanApiError
    && ["unauthorized", "forbidden", "payment_required", "invalid_request", "conflict"].includes(error.code);
}

function targetEvidence(sizes: DigitalOceanSandboxSize[]): DigitalOceanTargetEvidence {
  const supported = new Set<string>(DIGITALOCEAN_SANDBOX_SIZES);
  const offered = sizes.filter((size) => supported.has(size.slug)) as Array<DigitalOceanSandboxSize & { slug: DigitalOceanSizeSlug }>;
  return {
    capacity: {
      model: "serverless-sessions",
      sizes: offered.map((size) => ({ slug: size.slug, vcpus: Math.max(0, Math.trunc(size.vcpus)), memoryMb: Math.max(0, Math.trunc(size.memoryMb)) })),
    },
    capabilities: {
      kind: "digitalocean-managed-agents",
      launchReady: offered.length > 0,
      adapter: { version: DIGITALOCEAN_MANAGED_AGENTS_ADAPTER_VERSION },
      harnesses: [...DIGITALOCEAN_HARNESSES],
      sizes: offered.map((size) => size.slug),
      access: { chat: "hivra-relay-v1", approvals: "hivra-relay-v1", terminal: false, publicPorts: false },
      desktop: false,
      windows: false,
    },
  };
}

/**
 * Validate a DigitalOcean token by reading the Managed Agents size catalog —
 * a free, read-only call that fails for tokens without Managed Agents access —
 * then store the encrypted token and its single target together.
 */
export async function connectDigitalOcean(userId: string, input: { name: string; apiToken: string }): Promise<{
  connection: DigitalOceanConnectionDto;
  target: DigitalOceanDeploymentTargetDto;
}> {
  let sizes: DigitalOceanSandboxSize[];
  try {
    sizes = await deps.client(input.apiToken).listSandboxSizes();
  } catch (error) {
    const code = connectionErrorFor(error);
    throw new ManagedSessionError(
      code === "invalid_credentials" ? "invalid_credentials"
        : code === "managed_agents_forbidden" ? "provider_forbidden" : "provider_unavailable",
      code === "invalid_credentials" ? "DigitalOcean rejected this token."
        : code === "managed_agents_forbidden"
          ? "This token cannot use DigitalOcean Managed Agents. Opt the team into the Managed Agents preview and use a token with write access."
          : "DigitalOcean could not be reached to validate this token. Try again shortly.",
    );
  }
  const evidence = targetEvidence(sizes);
  if (!evidence.capabilities.launchReady) {
    throw new ManagedSessionError("provider_forbidden", "DigitalOcean did not offer any sandbox size Hivra supports for this team.");
  }
  try {
    return await createDigitalOceanConnectionRecord({
      userId, name: input.name, apiToken: input.apiToken, checkedAt: deps.now().toISOString(), target: evidence,
    });
  } catch (error) {
    throw providerError(error, "connection");
  }
}

/** Re-validate the stored token and republish (or withdraw) launch authority. */
export async function refreshDigitalOceanConnection(userId: string, connectionId: string) {
  const loaded = await loadDigitalOceanConnectionSecret(userId, connectionId).catch((error) => { throw providerError(error, "refresh"); });
  let evidence: DigitalOceanTargetEvidence | null = null;
  let errorCode: DigitalOceanConnectionErrorCode | null = null;
  try {
    evidence = targetEvidence(await deps.client(loaded.apiToken).listSandboxSizes());
    if (!evidence.capabilities.launchReady) errorCode = "managed_agents_forbidden";
  } catch (error) {
    errorCode = connectionErrorFor(error);
  }
  try {
    return await refreshDigitalOceanTargetRecord({
      userId, connectionId, expectedRevision: loaded.revision, checkedAt: deps.now().toISOString(),
      target: errorCode ? null : evidence, errorCode,
    });
  } catch (error) {
    throw providerError(error, "refresh");
  }
}

function manifestFor(agent: { sessionName: string; name: string; harness: DigitalOceanHarness; size: DigitalOceanSizeSlug }, model: ManagedSessionLaunchInput["model"]) {
  const secrets: Record<string, string> = {};
  const env: Record<string, string> = {};
  if (model.mode === "digitalocean-inference") {
    secrets.HARNESS_INFERENCE_API_KEY = model.apiKey;
    env.HARNESS_INFERENCE_MODEL = model.model;
  } else if (agent.harness === "claude-code") {
    secrets.ANTHROPIC_API_KEY = model.apiKey;
  } else {
    secrets.OPENAI_API_KEY = model.apiKey;
  }
  return {
    name: agent.sessionName,
    agent: agent.harness,
    description: `Hivra agent ${agent.name}`.slice(0, 1024),
    size: agent.size,
    persistent_workspace: true,
    // Hermes defaults to keep_warm (billed while idle). Hivra sessions pause on
    // idle like the coding adapters; the next message resumes them.
    ...(agent.harness === "hermes" ? { keep_warm: false } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    secrets,
    // Every consequential action waits for the owner's approval in Hivra.
    permissions: { default: "ask" },
  };
}

/**
 * Check a vendor model key before creating a billable session that could
 * never answer, mirroring doctl's pre-create Anthropic validation. A key the
 * vendor cannot be reached to check is allowed through: DigitalOcean still
 * reports the failure on the first run.
 */
async function validateVendorModelKey(harness: DigitalOceanHarness, model: ManagedSessionLaunchInput["model"]) {
  if (model.mode !== "vendor") return;
  const request: { url: string; headers: Record<string, string> } = harness === "claude-code"
    ? { url: "https://api.anthropic.com/v1/models?limit=1", headers: { "x-api-key": model.apiKey, "anthropic-version": "2023-06-01" } }
    : { url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${model.apiKey}` } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await deps.fetch(request.url, { headers: request.headers, signal: controller.signal, cache: "no-store" });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      throw new ManagedSessionError("model_key_rejected", harness === "claude-code"
        ? "Anthropic rejected this API key."
        : "OpenAI rejected this API key.");
    }
  } catch (error) {
    if (error instanceof ManagedSessionError) throw error;
    log.warn("vendor model key could not be pre-validated", { source: LOG_SOURCE, failureType: "do_model_key_prevalidation_unreachable", harness });
  } finally {
    clearTimeout(timer);
  }
}

function toDto(row: AgentRow): ManagedSessionDto {
  const observation = row.do_session_observation ?? {};
  return {
    agentId: row.id,
    name: row.name,
    harness: row.do_session_harness,
    size: row.do_session_size,
    status: row.status === "running" ? "ready"
      : row.status === "stopped" ? "paused"
        : row.status === "deleted" ? "deleted"
          : row.status === "error" ? "error"
            : row.desired_state === "deleted" ? "deleting" : "provisioning",
    providerStatus: typeof observation.status === "string" ? observation.status : null,
    pauseReason: typeof observation.pauseReason === "string" ? observation.pauseReason : null,
    sessionId: row.do_session_id,
    connectionId: row.infrastructure_connection_id,
    error: row.error,
    createdAt: row.created_at,
  };
}

async function loadAgent(userId: string, agentId: string): Promise<AgentRow> {
  const { data, error } = await db().from("hivra_agents").select(AGENT_SELECT)
    .eq("id", agentId).eq("user_id", userId).eq("computer_substrate", SUBSTRATE).maybeSingle();
  if (error) throw new ManagedSessionError("database_failed", "The agent could not be read.", agentId);
  if (!data) throw new ManagedSessionError("not_found", "That DigitalOcean agent was not found.", agentId);
  return data as unknown as AgentRow;
}

async function updateAgent(row: AgentRow, patch: Record<string, unknown>, guard: { status?: string } = {}): Promise<AgentRow> {
  let query = db().from("hivra_agents").update(patch).eq("id", row.id).eq("user_id", row.user_id);
  if (guard.status) query = query.eq("status", guard.status);
  const { data, error } = await query.select(AGENT_SELECT).maybeSingle();
  if (error) {
    log.error("DigitalOcean agent update failed", error, { source: LOG_SOURCE, failureType: "do_agent_update_failed", agentId: row.id });
    throw new ManagedSessionError("database_failed", "The agent state could not be recorded.", row.id);
  }
  if (!data) throw new ManagedSessionError("conflict", "The agent changed while this request ran. Refresh and try again.", row.id);
  return data as unknown as AgentRow;
}

function observation(session: DigitalOceanSession, at: Date): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    status: session.status,
    pauseReason: session.pauseReason,
    observedAt: at.toISOString(),
    adapterVersion: DIGITALOCEAN_MANAGED_AGENTS_ADAPTER_VERSION,
  };
}

/** Fold one provider observation into the row. Never advances past evidence. */
async function applyObservation(row: AgentRow, session: DigitalOceanSession | null): Promise<AgentRow> {
  const at = deps.now();
  if (row.status === "deleted") return row;
  if (!session) {
    if (row.desired_state === "deleted") {
      // A create whose response was lost can still land shortly after a
      // name lookup misses it. Only trust absence once that window has passed.
      if (!row.do_session_id && at.getTime() - Date.parse(row.created_at) < AMBIGUOUS_CREATE_WINDOW_MS) return row;
      return finishDelete(row, null);
    }
    if (!row.do_session_id) return row; // create not observed yet
    return updateAgent(row, { status: "error", error: "DigitalOcean no longer has this session. Delete the agent to release it." });
  }
  const patch: Record<string, unknown> = { do_session_observation: observation(session, at) };
  if (!row.do_session_id) patch.do_session_id = session.sessionId;
  if (row.desired_state === "deleted") {
    if (session.status === "SESSION_STATUS_DESTROYED") return finishDelete({ ...row, do_session_id: row.do_session_id ?? session.sessionId }, session);
    return updateAgent(row, patch);
  }
  switch (session.status) {
    case "SESSION_STATUS_READY":
    case "SESSION_STATUS_DETACHED":
      Object.assign(patch, { status: "running", error: null, provisioned_at: row.provisioned_at ?? at.toISOString() });
      if (row.desired_state === "stopped") patch.desired_state = "running";
      break;
    case "SESSION_STATUS_PAUSED":
      Object.assign(patch, { status: "stopped", desired_state: "stopped", error: null });
      break;
    case "SESSION_STATUS_FAILED":
      Object.assign(patch, { status: "error", error: "DigitalOcean reported that this session failed. Delete it and launch again." });
      break;
    case "SESSION_STATUS_DESTROYING":
    case "SESSION_STATUS_DESTROYED":
      Object.assign(patch, { status: "error", error: "This session was removed in DigitalOcean. Delete the agent to release it." });
      break;
    default:
      break;
  }
  return updateAgent(row, patch);
}

async function observeSession(client: DigitalOceanManagedAgentsClient, row: AgentRow): Promise<DigitalOceanSession | null> {
  try {
    if (row.do_session_id) return await client.getSession(row.do_session_id);
    return await client.findSessionByName(row.do_session_name);
  } catch (error) {
    if (error instanceof DigitalOceanApiError && error.code === "not_found") return null;
    throw error;
  }
}

async function waitForSettledSession(client: DigitalOceanManagedAgentsClient, row: AgentRow, timeoutMs: number): Promise<AgentRow> {
  const deadline = Date.now() + timeoutMs;
  let current = row;
  for (;;) {
    const session = await observeSession(client, current);
    current = await applyObservation(current, session);
    const status = session?.status;
    if (status !== "SESSION_STATUS_PROVISIONING" && status !== "SESSION_STATUS_UNSPECIFIED"
      && !(current.desired_state === "deleted" && status === "SESSION_STATUS_DESTROYING")) return current;
    if (Date.now() >= deadline) return current;
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

async function finishDelete(row: AgentRow, session: DigitalOceanSession | null): Promise<AgentRow> {
  const receipt = {
    state: row.do_session_id || session ? "absent" : "never-created",
    sessionName: row.do_session_name,
    ...(row.do_session_id ? { sessionId: row.do_session_id } : {}),
    observedStatus: session?.status ?? "not_found",
    verifiedAt: deps.now().toISOString(),
    binding: {
      connectionId: row.infrastructure_connection_id,
      targetId: row.deployment_target_id,
      connectionRevision: String(row.infrastructure_connection_revision),
    },
  };
  return updateAgent(row, {
    status: "deleted", desired_state: "deleted", error: null,
    infrastructure_connection_id: null, deployment_target_id: null, infrastructure_connection_revision: null,
    do_cleanup_receipt: receipt,
  });
}

async function recordPrompt(row: AgentRow, runId: string | null, text: string) {
  if (!runId) return;
  const { error } = await db().from("hivra_do_session_inputs").insert({ agent_id: row.id, user_id: row.user_id, run_id: runId, text });
  if (error && (error as { code?: string }).code !== "23505") {
    // The prompt was delivered; only its transcript copy is missing.
    log.warn("DigitalOcean session prompt was not recorded", { source: LOG_SOURCE, failureType: "do_prompt_record_failed", agentId: row.id });
  }
}

export async function launchDigitalOceanSession(userId: string, input: ManagedSessionLaunchInput): Promise<ManagedSessionDto> {
  const { data: replay, error: replayError } = await db().from("hivra_agents").select(AGENT_SELECT)
    .eq("user_id", userId).eq("computer_substrate", SUBSTRATE).eq("do_launch_request_id", input.launchRequestId).maybeSingle();
  if (replayError) throw new ManagedSessionError("database_failed", "The launch request could not be reconciled.");
  if (replay) {
    const row = replay as unknown as AgentRow;
    if (row.deployment_target_id !== input.targetId || row.do_session_harness !== input.harness || row.do_session_size !== input.size) {
      throw new ManagedSessionError("conflict", "This launch request already created an agent with different settings.", row.id);
    }
    return toDto(row);
  }

  let target: DigitalOceanDeploymentTargetDto;
  try {
    target = await loadDigitalOceanTarget(userId, input.targetId);
  } catch (error) {
    throw providerError(error, "launch");
  }
  if (target.connectionId !== input.connectionId || target.status !== "ready"
    || !target.capabilities.harnesses.includes(input.harness) || !target.capabilities.sizes.includes(input.size)) {
    throw new ManagedSessionError("not_ready", "This DigitalOcean connection is not ready for that agent and size. Refresh the connection and try again.");
  }
  const loaded = await loadDigitalOceanConnectionSecret(userId, input.connectionId).catch((error) => { throw providerError(error, "launch"); });
  if (loaded.revision !== target.evidenceConnectionRevision || loaded.connection.status !== "ready") {
    throw new ManagedSessionError("not_ready", "Refresh the DigitalOcean connection before launching.");
  }
  if (input.harness === "hermes" && input.model.mode !== "digitalocean-inference") {
    throw new ManagedSessionError("invalid_request", "Hermes on DigitalOcean uses DigitalOcean Inference. Enter a model access key and model.");
  }
  await validateVendorModelKey(input.harness, input.model);

  const agentId = randomUUID();
  const sessionName = digitalOceanSessionName(agentId);
  const resources = sizeResources(input.size);
  const { data: inserted, error: insertError } = await db().from("hivra_agents").insert({
    id: agentId, user_id: userId, type: input.harness, name: input.name,
    status: "provisioning", desired_state: "running", deployment_mode: "self-managed",
    computer_substrate: SUBSTRATE, proxmox_host: NO_AMBIENT_AUTHORITY, vmid: null,
    cpu: resources.cpu, ram: resources.ram, cpu_max: resources.cpu, ram_max: resources.ram,
    infrastructure_connection_id: input.connectionId, deployment_target_id: input.targetId,
    infrastructure_connection_revision: loaded.revision,
    infrastructure_binding_token_hash: ownerHash(userId), infrastructure_binding_token_enforced: true,
    do_session_name: sessionName, do_session_harness: input.harness, do_session_size: input.size,
    do_launch_request_id: input.launchRequestId,
    first_task: input.firstTask ?? null,
  }).select(AGENT_SELECT).single();
  if (insertError || !inserted) {
    const code = (insertError as { code?: string } | null)?.code;
    if (code === "23505") throw new ManagedSessionError("conflict", "This launch request is already being processed. Refresh to see it.");
    log.error("DigitalOcean agent reservation failed", insertError, { source: LOG_SOURCE, failureType: "do_agent_reservation_failed" });
    throw new ManagedSessionError(code === "55006" ? "not_ready" : "database_failed", "The DigitalOcean agent could not be reserved.");
  }
  let row = inserted as unknown as AgentRow;
  const client = deps.client(loaded.apiToken);

  let created: DigitalOceanSession;
  try {
    created = await client.createSessionFromManifest(manifestFor({ sessionName, name: input.name, harness: input.harness, size: input.size }, input.model));
  } catch (error) {
    if (isDefinitiveRejection(error)) {
      // Nothing billable exists. Close the reservation with its receipt so the
      // failed launch leaves no live authority behind.
      await finishDelete(row, null).catch(() => undefined);
      throw providerError(error, "launch", agentId);
    }
    // Ambiguous: the session may exist. Keep the reservation; reconciliation
    // finds it by name instead of creating a second one.
    await updateAgent(row, { error: "DigitalOcean did not confirm the launch yet. Hivra will reconcile it by name." }).catch(() => undefined);
    throw providerError(error, "launch", agentId);
  }
  if (created.name && created.name !== sessionName) {
    log.warn("DigitalOcean returned a different session name", { source: LOG_SOURCE, failureType: "do_session_name_mismatch", agentId });
  }
  row = await applyObservation(row, created);
  row = await waitForSettledSession(client, row, READY_WAIT_MS).catch((error) => {
    log.warn("DigitalOcean session readiness was not observed", { source: LOG_SOURCE, failureType: "do_session_ready_unobserved", agentId, code: error instanceof Error ? error.name : "unknown" });
    return row;
  });

  if (input.firstTask && row.status === "running" && row.do_session_id) {
    try {
      const { runId } = await client.sendInput(row.do_session_id, input.firstTask);
      await recordPrompt(row, runId, input.firstTask);
    } catch (error) {
      log.warn("DigitalOcean first task was not delivered", { source: LOG_SOURCE, failureType: "do_first_task_failed", agentId, code: error instanceof DigitalOceanApiError ? error.code : "unknown" });
    }
  }
  return toDto(row);
}

async function clientFor(row: AgentRow): Promise<DigitalOceanManagedAgentsClient> {
  if (!row.infrastructure_connection_id) throw new ManagedSessionError("not_found", "This agent no longer has a DigitalOcean connection.", row.id);
  const loaded = await loadDigitalOceanConnectionSecret(row.user_id, row.infrastructure_connection_id)
    .catch((error) => { throw providerError(error, "request", row.id); });
  if (loaded.revision !== row.infrastructure_connection_revision) {
    throw new ManagedSessionError("not_ready", "The DigitalOcean connection changed. Reconnect it to manage this agent.", row.id);
  }
  return deps.client(loaded.apiToken);
}

export async function getManagedSession(userId: string, agentId: string, options: { reconcile?: boolean } = {}): Promise<ManagedSessionDto> {
  let row = await loadAgent(userId, agentId);
  if (options.reconcile && row.status !== "deleted") {
    try {
      const client = await clientFor(row);
      row = await applyObservation(row, await observeSession(client, row));
    } catch (error) {
      // A failed observation is reported without rewriting the last known state.
      throw providerError(error, "status check", agentId);
    }
  }
  return toDto(row);
}

export async function listManagedSessions(userId: string): Promise<ManagedSessionDto[]> {
  const { data, error } = await db().from("hivra_agents").select(AGENT_SELECT)
    .eq("user_id", userId).eq("computer_substrate", SUBSTRATE).neq("status", "deleted")
    .order("created_at", { ascending: false }).limit(100);
  if (error) throw new ManagedSessionError("database_failed", "DigitalOcean agents could not be listed.");
  return (data ?? []).map((row) => toDto(row as unknown as AgentRow));
}

export async function managedSessionAction(userId: string, agentId: string, action: "pause" | "resume" | "delete"): Promise<ManagedSessionDto> {
  let row = await loadAgent(userId, agentId);
  if (row.status === "deleted") {
    if (action === "delete") return toDto(row);
    throw new ManagedSessionError("not_ready", "This agent was deleted.", agentId);
  }
  const client = await clientFor(row);
  try {
    if (action === "delete") {
      if (row.desired_state !== "deleted") row = await updateAgent(row, { desired_state: "deleted" });
      const session = await observeSession(client, row);
      if (session && session.status !== "SESSION_STATUS_DESTROYED") {
        try {
          await client.destroySession(session.sessionId);
        } catch (error) {
          if (!(error instanceof DigitalOceanApiError && error.code === "not_found")) throw error;
        }
        row = row.do_session_id ? row : await updateAgent(row, { do_session_id: session.sessionId });
      }
      row = await waitForSettledSession(client, row, DELETE_WAIT_MS);
      return toDto(row);
    }
    if (!row.do_session_id) throw new ManagedSessionError("not_ready", "This session is still starting.", agentId);
    if (action === "pause") {
      await client.pauseSession(row.do_session_id);
    } else {
      await client.resumeSession(row.do_session_id);
    }
    row = await applyObservation(row, await observeSession(client, row));
    if (action === "resume" && row.status !== "running") row = await waitForSettledSession(client, row, READY_WAIT_MS);
    return toDto(row);
  } catch (error) {
    throw providerError(error, action, agentId);
  }
}

async function liveSession(userId: string, agentId: string): Promise<{ row: AgentRow; client: DigitalOceanManagedAgentsClient; sessionId: string }> {
  const row = await loadAgent(userId, agentId);
  if (row.status === "deleted" || row.desired_state === "deleted") throw new ManagedSessionError("not_ready", "This agent was deleted.", agentId);
  if (!row.do_session_id) throw new ManagedSessionError("not_ready", "This session is still starting.", agentId);
  return { row, client: await clientFor(row), sessionId: row.do_session_id };
}

export async function sendManagedSessionInput(userId: string, agentId: string, text: string): Promise<{ runId: string | null }> {
  const { row, client, sessionId } = await liveSession(userId, agentId);
  if (row.status === "error") throw new ManagedSessionError("not_ready", row.error ?? "This session needs attention.", agentId);
  try {
    // DigitalOcean resumes a paused session when it receives input.
    const result = await client.sendInput(sessionId, text);
    await recordPrompt(row, result.runId, text);
    if (row.status === "stopped") {
      await applyObservation(row, await observeSession(client, row)).catch(() => undefined);
    }
    return result;
  } catch (error) {
    throw providerError(error, "message", agentId);
  }
}

export async function resolveManagedSessionApproval(
  userId: string,
  agentId: string,
  requestId: string,
  outcome: "approve" | "reject",
): Promise<void> {
  const { client, sessionId } = await liveSession(userId, agentId);
  try {
    await client.resolveHitl(sessionId, requestId, outcome === "approve" ? "HITL_OUTCOME_APPROVE" : "HITL_OUTCOME_REJECT",
      outcome === "reject" ? "Rejected in Hivra" : undefined);
  } catch (error) {
    throw providerError(error, "approval", agentId);
  }
}

/** Authority check for the event relay, run before any stream bytes are sent. */
export async function assertManagedSessionStreamable(userId: string, agentId: string): Promise<void> {
  await liveSession(userId, agentId);
}

/** Live, sanitized event tail. Resume with the last event id Hivra delivered. */
export async function* streamManagedSessionEvents(
  userId: string,
  agentId: string,
  options: { after: string | null; signal: AbortSignal },
): AsyncGenerator<ManagedSessionEvent, void, void> {
  const { client, sessionId } = await liveSession(userId, agentId);
  try {
    for await (const event of client.streamEvents(sessionId, { replayFrom: options.after, signal: options.signal })) {
      const sanitized = sanitizeManagedSessionEvent(event);
      if (sanitized) yield sanitized;
    }
  } catch (error) {
    if (options.signal.aborted) return;
    throw providerError(error, "event stream", agentId);
  }
}

/** Stored history: the newest window of sanitized events plus Hivra-recorded prompts. */
export async function readManagedSessionHistory(userId: string, agentId: string): Promise<{
  events: ManagedSessionEvent[];
  prompts: Array<{ runId: string; text: string; createdAt: string }>;
}> {
  const { row, client, sessionId } = await liveSession(userId, agentId);
  const events: ManagedSessionEvent[] = [];
  const controller = new AbortController();
  try {
    for await (const event of client.streamEvents(sessionId, { replayOnly: true, signal: controller.signal })) {
      const sanitized = sanitizeManagedSessionEvent(event);
      if (sanitized) events.push(sanitized);
      if (events.length >= HISTORY_EVENT_LIMIT) {
        controller.abort();
        break;
      }
    }
  } catch (error) {
    throw providerError(error, "history", agentId);
  }
  const { data, error } = await db().from("hivra_do_session_inputs").select("run_id,text,created_at")
    .eq("agent_id", row.id).eq("user_id", userId).order("created_at", { ascending: false }).limit(HISTORY_PROMPT_LIMIT);
  if (error) throw new ManagedSessionError("database_failed", "The conversation prompts could not be read.", agentId);
  const prompts = (data ?? []).reverse().map((prompt) => ({
    runId: String((prompt as { run_id: unknown }).run_id),
    text: String((prompt as { text: unknown }).text),
    createdAt: String((prompt as { created_at: unknown }).created_at),
  }));
  return { events, prompts };
}
