import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { MAX_CONTEXT_LEN } from "./agent-limits";
import { parseProviderDesktopWorkerIdentity } from "@/lib/infrastructure/provider-desktop-worker";
import { parseProviderGuestWorkerReceipt, type ProviderGuestWorkerIdentity } from "@/lib/infrastructure/provider-guest-worker";

const Id = z.string().uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const FailureCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const HttpsOrigin = z.string().max(2048).refine(value => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
});

const DeploymentSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("hivra-managed") }).strict(),
  z.object({
    mode: z.literal("self-managed"),
    connectionId: Id,
    targetId: Id,
    expectedConnectionRevision: z.number().int().positive().safe(),
  }).strict(),
]);

/** Secret-free, client-submitted identity. Values inherited from a mutable
 * template or installation configuration intentionally do not belong here. */
const HivraLaunchRequestIntentSchema = z.object({
  type: z.string().max(128).nullable(),
  name: z.string().max(256).nullable(),
  computerProfile: z.string().max(128).nullable(),
  cpu: z.number().finite().nullable(),
  ram: z.number().finite().nullable(),
  maximumCpu: z.number().finite().nullable().optional(),
  maximumRam: z.number().finite().nullable().optional(),
  browser: z.boolean(),
  goal: z.string().max(32).nullable(),
  context: z.string().max(MAX_CONTEXT_LEN).nullable(),
  personality: z.string().max(48).nullable(),
  emoji: z.string().max(16).nullable(),
  managedVenice: z.boolean(),
  templateRef: z.string().max(256).nullable(),
  modelMode: z.enum(["native", "explicit"]),
  deployment: DeploymentSchema,
}).strict();
export type HivraLaunchRequestIntent = z.infer<typeof HivraLaunchRequestIntentSchema>;

/** Effective launch identity after catalog, template, and installation-derived
 * values have been resolved. */
const HivraLaunchIntentSchema = z.object({
  resourceKind: z.enum(["agent", "computer"]),
  runtimeId: z.enum(["codex", "linux-desktop"]),
  name: z.string().trim().min(1).max(256),
  computerProfile: z.enum(["ubuntu-desktop", "omarchy", "windows"]).nullable(),
  cpu: z.number().min(0.5).max(9999).multipleOf(0.5),
  ram: z.number().int().positive().max(9999),
  maximumCpu: z.number().min(0.5).max(9999).multipleOf(0.5).optional(),
  maximumRam: z.number().int().positive().max(9999).optional(),
  browser: z.boolean(),
  goal: z.string().max(32).nullable(),
  context: z.string().max(MAX_CONTEXT_LEN).nullable(),
  personality: z.string().max(48).nullable(),
  emoji: z.string().max(16).nullable(),
  managedVenice: z.boolean(),
  templateRef: z.string().max(256).nullable(),
  templateSkills: z.array(z.string().max(128)).max(100),
  desktopControlOrigin: HttpsOrigin.nullable(),
  deployment: DeploymentSchema,
}).strict().superRefine((value, context) => {
  const validCodex = value.runtimeId === "codex"
    && value.resourceKind === "agent"
    && value.computerProfile === null
    && value.desktopControlOrigin === null;
  const validUbuntu = value.runtimeId === "linux-desktop"
    && value.resourceKind === "computer"
    && value.computerProfile === "ubuntu-desktop"
    && value.browser === false
    && value.managedVenice === false
    && value.desktopControlOrigin !== null;
  if (!validCodex && !validUbuntu) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Launch kind and runtime do not match." });
  }
});
export type HivraLaunchIntent = z.infer<typeof HivraLaunchIntentSchema>;

const HivraLaunchOperationSchema = z.object({
  user_id: z.string().min(1).max(256),
  request_id: Id,
  operation_id: Id,
  request_digest: Digest,
  intent_digest: Digest,
  resource_kind: z.enum(["agent", "computer"]),
  runtime_id: z.enum(["codex", "linux-desktop"]),
  phase: z.enum(["reserved", "reconciling", "bound", "accepted", "failed"]),
  agent_id: Id.nullable(),
  response_status: z.union([z.literal(201), z.literal(202)]).nullable(),
  failure_status: z.number().int().min(400).max(599).nullable(),
  failure_code: FailureCode.nullable(),
  created_at: z.string(),
  bound_at: z.string().nullable(),
  accepted_at: z.string().nullable(),
  failed_at: z.string().nullable(),
}).strict();
export type HivraLaunchOperation = z.infer<typeof HivraLaunchOperationSchema>;

export type HivraLaunchOperationScope = {
  userId: string;
  requestId: string;
  operationId: string;
  requestDigest: string;
  intentDigest: string;
  resourceKind: HivraLaunchIntent["resourceKind"];
  runtimeId: HivraLaunchIntent["runtimeId"];
};

export type HivraLaunchOperationAdmission = HivraLaunchOperationScope & {
  requestIntent: HivraLaunchRequestIntent;
  intent: HivraLaunchIntent;
};

export type HivraLaunchOperationReplay =
  | { state: "accepted"; requestId: string; phase: "accepted"; responseStatus: 201 | 202; agent: Record<string, unknown> }
  | { state: "reconciling"; requestId: string; phase: "reserved" | "reconciling" | "bound"; responseStatus: null; agent: null }
  | { state: "failed"; requestId: string; phase: "failed"; responseStatus: null; failureStatus: number; failureCode: string; agent: null };

export class HivraLaunchOperationRequestError extends Error {
  constructor(readonly code: "invalid_request" | "request_conflict") {
    super(code === "invalid_request"
      ? "Include a valid stable launch request ID and complete launch settings."
      : "That launch request ID already belongs to different launch settings. Use the original computer or start a new request.");
    this.name = "HivraLaunchOperationRequestError";
  }
}

export class HivraLaunchOperationStoreError extends Error {
  constructor() {
    super("The saved launch operation could not be confirmed.");
    this.name = "HivraLaunchOperationStoreError";
  }
}

function validateOwnerRequest(userId: string, requestId: unknown): asserts requestId is string {
  if (!userId.trim() || userId.length > 256 || !Id.safeParse(requestId).success) {
    throw new HivraLaunchOperationRequestError("invalid_request");
  }
}

function digest(domain: string, userId: string, requestId: string, value: unknown): string {
  return createHash("sha256").update(JSON.stringify([domain, userId, requestId, value])).digest("hex");
}

/** Hashes only normalized, secret-free submitted fields. */
export function hivraLaunchRequestDigest(userId: string, requestId: string, raw: unknown): string {
  validateOwnerRequest(userId, requestId);
  const parsed = HivraLaunchRequestIntentSchema.safeParse(raw);
  if (!parsed.success) throw new HivraLaunchOperationRequestError("invalid_request");
  return digest("hivra-launch-request-v1", userId, requestId, parsed.data);
}

/** Hashes normalized effective intent. Raw settings and credentials never enter
 * the journal; owner and request ID are included in the digest domain. */
export function hivraLaunchIntentDigest(userId: string, requestId: string, raw: unknown): string {
  validateOwnerRequest(userId, requestId);
  const parsed = HivraLaunchIntentSchema.safeParse(raw);
  if (!parsed.success) throw new HivraLaunchOperationRequestError("invalid_request");
  return digest("hivra-launch-operation-v2", userId, requestId, parsed.data);
}

type DbResult = { data: unknown; error: unknown };
type SelectQuery = {
  eq(column: string, value: unknown): SelectQuery;
  maybeSingle(): PromiseLike<DbResult>;
};
type LaunchOperationDb = {
  from(table: string): { select(columns: string): SelectQuery };
  rpc(name: string, args: Record<string, unknown>): PromiseLike<DbResult>;
};

function exactOperation(raw: unknown, owner: string, requestId: string): HivraLaunchOperation {
  const parsed = HivraLaunchOperationSchema.safeParse(raw);
  if (!parsed.success || parsed.data.user_id !== owner || parsed.data.request_id !== requestId) {
    throw new HivraLaunchOperationStoreError();
  }
  return parsed.data;
}

function operationScope(operation: HivraLaunchOperation): HivraLaunchOperationScope {
  return {
    userId: operation.user_id,
    requestId: operation.request_id,
    operationId: operation.operation_id,
    requestDigest: operation.request_digest,
    intentDigest: operation.intent_digest,
    resourceKind: operation.resource_kind,
    runtimeId: operation.runtime_id,
  };
}

function matchesScope(operation: HivraLaunchOperation, value: HivraLaunchOperationScope): boolean {
  return operation.user_id === value.userId
    && operation.request_id === value.requestId
    && operation.operation_id === value.operationId
    && operation.request_digest === value.requestDigest
    && operation.intent_digest === value.intentDigest
    && operation.resource_kind === value.resourceKind
    && operation.runtime_id === value.runtimeId;
}

type ReserveOutcome = { created: boolean; operation: HivraLaunchOperation } | { conflict: true };

export type HivraLaunchOperationStore = {
  byRequest(userId: string, requestId: string): Promise<HivraLaunchOperation | null>;
  reserve(admission: HivraLaunchOperationAdmission): Promise<ReserveOutcome>;
  bindAgent(value: HivraLaunchOperationScope, agentId: string): Promise<HivraLaunchOperation | null>;
  accept(value: HivraLaunchOperationScope, agentId: string, responseStatus: 201 | 202): Promise<HivraLaunchOperation | null>;
  markReconciling(value: HivraLaunchOperationScope): Promise<HivraLaunchOperation | null>;
  fail(value: HivraLaunchOperationScope, failureStatus: number, failureCode: string): Promise<HivraLaunchOperation | null>;
};

export function createHivraLaunchOperationStore(
  database: LaunchOperationDb | null = supabaseAdmin as unknown as LaunchOperationDb | null,
): HivraLaunchOperationStore {
  async function byRequest(userId: string, requestId: string) {
    validateOwnerRequest(userId, requestId);
    if (!database) throw new HivraLaunchOperationStoreError();
    try {
      const { data, error } = await database.from("hivra_launch_operations").select("*")
        .eq("user_id", userId).eq("request_id", requestId).maybeSingle();
      if (error) throw new HivraLaunchOperationStoreError();
      return data === null ? null : exactOperation(data, userId, requestId);
    } catch (error) {
      if (error instanceof HivraLaunchOperationRequestError || error instanceof HivraLaunchOperationStoreError) throw error;
      throw new HivraLaunchOperationStoreError();
    }
  }

  async function rpc(name: string, args: Record<string, unknown>) {
    if (!database) throw new HivraLaunchOperationStoreError();
    const { data, error } = await database.rpc(name, args);
    if (error) throw new HivraLaunchOperationStoreError();
    return data;
  }

  function scopeArgs(value: HivraLaunchOperationScope) {
    return {
      p_user_id: value.userId,
      p_request_id: value.requestId,
      p_operation_id: value.operationId,
      p_request_digest: value.requestDigest,
      p_intent_digest: value.intentDigest,
    };
  }

  return {
    byRequest,
    async reserve(admission) {
      let result: unknown;
      try {
        result = await rpc("reserve_hivra_launch_operation", {
          ...scopeArgs(admission),
          p_resource_kind: admission.intent.resourceKind,
          p_runtime_id: admission.intent.runtimeId,
        });
      } catch {
        const saved = await byRequest(admission.userId, admission.requestId);
        if (!saved) throw new HivraLaunchOperationStoreError();
        if (saved.request_digest !== admission.requestDigest) throw new HivraLaunchOperationRequestError("request_conflict");
        return { created: false, operation: saved };
      }
      const parsed = z.discriminatedUnion("status", [
        z.object({ status: z.literal("reserved"), operation: HivraLaunchOperationSchema }).strict(),
        z.object({ status: z.literal("existing"), operation: HivraLaunchOperationSchema }).strict(),
        z.object({ status: z.literal("request_conflict") }).strict(),
        z.object({ status: z.literal("invalid_request") }).strict(),
      ]).safeParse(result);
      if (!parsed.success) throw new HivraLaunchOperationStoreError();
      if (parsed.data.status === "invalid_request") throw new HivraLaunchOperationRequestError("invalid_request");
      if (parsed.data.status === "request_conflict") return { conflict: true };
      const operation = exactOperation(parsed.data.operation, admission.userId, admission.requestId);
      if (operation.request_digest !== admission.requestDigest) throw new HivraLaunchOperationStoreError();
      if (parsed.data.status === "reserved" && !matchesScope(operation, admission)) throw new HivraLaunchOperationStoreError();
      return { created: parsed.data.status === "reserved", operation };
    },
    async bindAgent(value, agentId) {
      if (!Id.safeParse(agentId).success) throw new HivraLaunchOperationStoreError();
      try {
        const result = await rpc("bind_hivra_launch_operation_agent", { ...scopeArgs(value), p_agent_id: agentId });
        if (result === null) return null;
        const operation = exactOperation(result, value.userId, value.requestId);
        return matchesScope(operation, value) && operation.agent_id === agentId ? operation : null;
      } catch {
        const saved = await byRequest(value.userId, value.requestId);
        return saved && matchesScope(saved, value) && saved.agent_id === agentId
          && (saved.phase === "bound" || saved.phase === "accepted") ? saved : null;
      }
    },
    async accept(value, agentId, responseStatus) {
      if (!Id.safeParse(agentId).success || ![201, 202].includes(responseStatus)) throw new HivraLaunchOperationStoreError();
      try {
        const result = await rpc("accept_hivra_launch_operation", {
          ...scopeArgs(value), p_agent_id: agentId, p_response_status: responseStatus,
        });
        if (result === null) return null;
        const operation = exactOperation(result, value.userId, value.requestId);
        const acceptedStatus = responseStatus === 202
          ? operation.response_status === 202 || operation.response_status === 201
          : operation.response_status === 201;
        return matchesScope(operation, value) && operation.agent_id === agentId
          && operation.phase === "accepted" && acceptedStatus ? operation : null;
      } catch {
        const saved = await byRequest(value.userId, value.requestId);
        const acceptedStatus = responseStatus === 202
          ? saved?.response_status === 202 || saved?.response_status === 201
          : saved?.response_status === 201;
        return saved && matchesScope(saved, value) && saved.agent_id === agentId
          && saved.phase === "accepted" && acceptedStatus ? saved : null;
      }
    },
    async markReconciling(value) {
      try {
        const result = await rpc("reconcile_hivra_launch_operation", scopeArgs(value));
        if (result === null) return null;
        const operation = exactOperation(result, value.userId, value.requestId);
        return matchesScope(operation, value) && ["reconciling", "bound", "accepted"].includes(operation.phase)
          ? operation : null;
      } catch {
        const saved = await byRequest(value.userId, value.requestId);
        return saved && matchesScope(saved, value) && ["reconciling", "bound", "accepted"].includes(saved.phase)
          ? saved : null;
      }
    },
    async fail(value, failureStatus, failureCode) {
      if (!Number.isInteger(failureStatus) || failureStatus < 400 || failureStatus > 599
        || !FailureCode.safeParse(failureCode).success) throw new HivraLaunchOperationStoreError();
      try {
        const result = await rpc("fail_hivra_launch_operation", {
          ...scopeArgs(value), p_failure_status: failureStatus, p_failure_code: failureCode,
        });
        if (result === null) return null;
        const operation = exactOperation(result, value.userId, value.requestId);
        return matchesScope(operation, value) && operation.phase === "failed"
          && operation.failure_status === failureStatus && operation.failure_code === failureCode ? operation : null;
      } catch {
        const saved = await byRequest(value.userId, value.requestId);
        return saved && matchesScope(saved, value) && saved.phase === "failed"
          && saved.failure_status === failureStatus && saved.failure_code === failureCode ? saved : null;
      }
    },
  };
}

type ServiceDependencies = {
  store?: HivraLaunchOperationStore;
  agent?: (userId: string, agentId: string) => Promise<Record<string, unknown> | null>;
  agentByOperation?: (userId: string, operationId: string, runtimeId: HivraLaunchIntent["runtimeId"])
    => Promise<Record<string, unknown> | null>;
  newId?: () => string;
};

export function createHivraLaunchOperationService(dependencies: ServiceDependencies = {}) {
  const store = dependencies.store ?? createHivraLaunchOperationStore();
  const database = supabaseAdmin as unknown as LaunchOperationDb | null;
  const readAgent = dependencies.agent ?? (async (userId: string, agentId: string) => {
    if (!database) throw new HivraLaunchOperationStoreError();
    try {
      const { data, error } = await database.from("hivra_agents").select("*")
        .eq("user_id", userId).eq("id", agentId).maybeSingle();
      if (error || !data || typeof data !== "object") throw new HivraLaunchOperationStoreError();
      const agent = data as Record<string, unknown>;
      return agent.id === agentId && agent.user_id === userId ? agent : null;
    } catch (error) {
      if (error instanceof HivraLaunchOperationStoreError) throw error;
      throw new HivraLaunchOperationStoreError();
    }
  });
  const readAgentByOperation = dependencies.agentByOperation ?? (async (userId, operationId, runtimeId) => {
    if (!database) throw new HivraLaunchOperationStoreError();
    try {
      let { data, error } = await database.from("hivra_agents").select("*")
        .eq("user_id", userId).eq("operation_id", operationId).eq("type", runtimeId).maybeSingle();
      if (error) throw new HivraLaunchOperationStoreError();
      if (data === null) {
        ({ data, error } = await database.from("hivra_agents").select("*")
          .eq("user_id", userId).eq("allocation_operation_id", operationId).eq("type", runtimeId)
          .eq("computer_substrate", "provider-vm").maybeSingle());
        if (error) throw new HivraLaunchOperationStoreError();
        if (data === null) return null;
      }
      if (!data || typeof data !== "object") throw new HivraLaunchOperationStoreError();
      const agent = data as Record<string, unknown>;
      return agent.user_id === userId && agent.type === runtimeId && (agent.operation_id === operationId
        || (agent.computer_substrate === "provider-vm" && agent.allocation_operation_id === operationId)) ? agent : null;
    } catch (error) {
      if (error instanceof HivraLaunchOperationStoreError) throw error;
      throw new HivraLaunchOperationStoreError();
    }
  });
  const newId = dependencies.newId ?? randomUUID;

  function exactAgent(operation: HivraLaunchOperation, agent: Record<string, unknown> | null) {
    if (!agent || !Id.safeParse(agent.id).success || agent.user_id !== operation.user_id
      || agent.type !== operation.runtime_id
      || (operation.agent_id !== null && agent.id !== operation.agent_id)
      || (operation.runtime_id === "codex" && agent.computer_profile != null)
      || (operation.runtime_id === "linux-desktop" && agent.computer_profile !== "ubuntu-desktop")) {
      throw new HivraLaunchOperationStoreError();
    }
    return agent;
  }

  function acceptedReplay(operation: HivraLaunchOperation, agent: Record<string, unknown>): HivraLaunchOperationReplay {
    if (operation.phase !== "accepted" || operation.response_status === null) throw new HivraLaunchOperationStoreError();
    return { state: "accepted", requestId: operation.request_id, phase: "accepted",
      responseStatus: operation.response_status, agent };
  }
  function recoverableProvider(operation: HivraLaunchOperation, agent: Record<string, unknown>) {
    if (agent.allocation_operation_id !== operation.operation_id) return false;
    if (agent.operation_id === operation.operation_id && agent.operation_kind === "provision" && agent.status === "provisioning") return true;
    if (agent.operation_id != null || agent.operation_kind != null || !["running", "stopped", "error", "deleted"].includes(String(agent.status))) return false;
    // An installer can finish while the original response is lost. Recover
    // by its immutable allocation, not by a now-cleared lifecycle operation.
    if (agent.provider_install_identity == null) {
      return ["error", "deleted"].includes(String(agent.status)) && agent.provider_install_dispatched_at == null
        && typeof agent.provider_install_not_after === "string"
        && Date.parse(agent.provider_install_not_after) <= Date.now();
    }
    try {
      const outcome=z.enum(["succeeded","failed","cancelled"]).parse(agent.provider_install_outcome);
      if (!["error","deleted"].includes(String(agent.status)) && outcome!=="succeeded") return false;
      if (typeof agent.provider_install_stopped_at!=="string" || !Number.isFinite(Date.parse(agent.provider_install_stopped_at))) return false;
      const identity=operation.runtime_id==="linux-desktop" ? parseProviderDesktopWorkerIdentity(agent.provider_install_identity)
        : parseProviderGuestWorkerReceipt(`HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify({version:1,identity:agent.provider_install_identity,state:outcome,stopped:true})}\n`,
          agent.provider_install_identity as ProviderGuestWorkerIdentity).identity;
      return identity.agentId===agent.id && identity.operationId===operation.operation_id;
    } catch { return false; }
  }

  async function replay(operation: HivraLaunchOperation): Promise<HivraLaunchOperationReplay> {
    if (operation.phase === "failed") {
      if (operation.failure_status === null || operation.failure_code === null) throw new HivraLaunchOperationStoreError();
      return { state: "failed", requestId: operation.request_id, phase: "failed", responseStatus: null,
        failureStatus: operation.failure_status, failureCode: operation.failure_code, agent: null };
    }
    if (operation.phase === "accepted") {
      return acceptedReplay(operation, exactAgent(operation, await readAgent(operation.user_id, operation.agent_id!)));
    }
    const value = operationScope(operation);
    if (operation.phase === "bound") {
      const agent = exactAgent(operation, await readAgent(operation.user_id, operation.agent_id!));
      const accepted = await store.accept(value, operation.agent_id!, 202);
      if (!accepted) throw new HivraLaunchOperationStoreError();
      return acceptedReplay(accepted, agent);
    }

    const recovered = await readAgentByOperation(operation.user_id, operation.operation_id, operation.runtime_id);
    if (recovered) {
      const agent = exactAgent(operation, recovered);
      if (agent.computer_substrate === "provider-vm" ? !recoverableProvider(operation,agent) : agent.operation_id !== operation.operation_id) {
        throw new HivraLaunchOperationStoreError();
      }
      const agentId = String(agent.id);
      const bound = await store.bindAgent(value, agentId);
      if (!bound) throw new HivraLaunchOperationStoreError();
      const accepted = await store.accept(value, agentId, 202);
      if (!accepted) throw new HivraLaunchOperationStoreError();
      return acceptedReplay(accepted, agent);
    }
    return { state: "reconciling", requestId: operation.request_id, phase: operation.phase,
      responseStatus: null, agent: null };
  }

  function verifyAdmission(admission: HivraLaunchOperationAdmission) {
    validateOwnerRequest(admission.userId, admission.requestId);
    if (!Id.safeParse(admission.operationId).success
      || admission.requestDigest !== hivraLaunchRequestDigest(admission.userId, admission.requestId, admission.requestIntent)
      || admission.intentDigest !== hivraLaunchIntentDigest(admission.userId, admission.requestId, admission.intent)
      || admission.resourceKind !== admission.intent.resourceKind || admission.runtimeId !== admission.intent.runtimeId) {
      throw new HivraLaunchOperationRequestError("invalid_request");
    }
  }

  return {
    /** Owner-only receipt lookup used after the original HTTP response is slow
     * or interrupted. This never needs the mutable launch form again: the
     * durable operation already contains the exact owner/request binding. */
    async original(userId: string, requestId: unknown) {
      validateOwnerRequest(userId, requestId);
      const existing = await store.byRequest(userId, requestId);
      return existing ? replay(existing) : null;
    },
    async lookup(userId: string, requestId: unknown, rawRequestIntent: unknown) {
      validateOwnerRequest(userId, requestId);
      const parsed = HivraLaunchRequestIntentSchema.safeParse(rawRequestIntent);
      if (!parsed.success) throw new HivraLaunchOperationRequestError("invalid_request");
      const requestDigest = hivraLaunchRequestDigest(userId, requestId, parsed.data);
      const existing = await store.byRequest(userId, requestId);
      if (!existing) return { existing: null };
      if (existing.request_digest !== requestDigest) throw new HivraLaunchOperationRequestError("request_conflict");
      return { existing: await replay(existing) };
    },
    async prepare(userId: string, requestId: unknown, rawRequestIntent: unknown, rawIntent: unknown) {
      validateOwnerRequest(userId, requestId);
      const requestParsed = HivraLaunchRequestIntentSchema.safeParse(rawRequestIntent);
      const intentParsed = HivraLaunchIntentSchema.safeParse(rawIntent);
      if (!requestParsed.success || !intentParsed.success) throw new HivraLaunchOperationRequestError("invalid_request");
      const requestDigest = hivraLaunchRequestDigest(userId, requestId, requestParsed.data);
      const intentDigest = hivraLaunchIntentDigest(userId, requestId, intentParsed.data);
      const existing = await store.byRequest(userId, requestId);
      if (existing) {
        if (existing.request_digest !== requestDigest) throw new HivraLaunchOperationRequestError("request_conflict");
        return { admission: null, existing: await replay(existing) };
      }
      const operationId = Id.parse(newId());
      return { existing: null, admission: {
        userId, requestId, operationId, requestIntent: requestParsed.data, intent: intentParsed.data,
        requestDigest, intentDigest, resourceKind: intentParsed.data.resourceKind, runtimeId: intentParsed.data.runtimeId,
      } satisfies HivraLaunchOperationAdmission };
    },
    async reserve(admission: HivraLaunchOperationAdmission) {
      verifyAdmission(admission);
      const outcome = await store.reserve(admission);
      if ("conflict" in outcome) throw new HivraLaunchOperationRequestError("request_conflict");
      if (outcome.created) {
        if (!matchesScope(outcome.operation, admission)) throw new HivraLaunchOperationStoreError();
        return { created: true as const, operation: outcome.operation, existing: null };
      }
      if (outcome.operation.request_digest !== admission.requestDigest) {
        throw new HivraLaunchOperationRequestError("request_conflict");
      }
      return { created: false as const, operation: outcome.operation, existing: await replay(outcome.operation) };
    },
    async bindAgent(admission: HivraLaunchOperationAdmission, agentId: string) {
      verifyAdmission(admission);
      const operation = await store.bindAgent(admission, agentId);
      if (!operation || operation.agent_id !== agentId) throw new HivraLaunchOperationStoreError();
      return operation;
    },
    async accept(admission: HivraLaunchOperationAdmission, agentId: string, responseStatus: 201 | 202) {
      verifyAdmission(admission);
      const operation = await store.accept(admission, agentId, responseStatus);
      if (!operation) throw new HivraLaunchOperationStoreError();
      return replay(operation);
    },
    async markReconciling(admission: HivraLaunchOperationAdmission) {
      verifyAdmission(admission);
      const operation = await store.markReconciling(admission);
      if (!operation) throw new HivraLaunchOperationStoreError();
      return replay(operation);
    },
    async fail(admission: HivraLaunchOperationAdmission, failureStatus: number, failureCode: string) {
      verifyAdmission(admission);
      const operation = await store.fail(admission, failureStatus, failureCode);
      if (!operation) throw new HivraLaunchOperationStoreError();
      return replay(operation);
    },
  };
}
