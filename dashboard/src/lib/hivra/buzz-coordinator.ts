import "server-only";

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { decryptSecret, encryptSecret, getSecretPrimaryKey } from "@/lib/crypto";
import {
  BuzzRelayError,
  claimBuzzInvite,
  generateBuzzIdentity,
  inspectBuzzRelay,
  leaveBuzzRelay,
  verifyBuzzMembership,
  type BuzzRelayDescriptor,
} from "./buzz-relay";
import { createBuzzStore, type BuzzBindingRow, type BuzzConnectionRow, type BuzzStore } from "./buzz-store";
import {
  BuzzRuntimeControlError,
  installBuzzRuntime,
  observeBuzzRuntime,
  removeBuzzRuntime,
} from "./buzz-runtime-service";
import { resolveBuzzVaultCredential } from "./buzz-runtime-credentials";

const Id = z.string().uuid();
const ClaimRosterReceipt = z.object({
  rosterEventId: z.string().regex(/^[a-f0-9]{64}$/),
  rosterCreatedAt: z.number().int().nonnegative(),
  rosterMember: z.literal(true),
}).passthrough();
const DefinitiveClaimErrors = new Set(["invalid_invite", "invite_expired", "invite_exhausted", "join_policy_required"]);

export type BuzzCoordinatorProblem = "invalid_request" | "not_found" | "already_bound" | "operation_conflict"
  | "storage_unavailable" | "configuration_unavailable" | "relay_unavailable" | "relay_incompatible"
  | "unsafe_relay" | "invalid_relay" | "invalid_invite" | "invite_expired" | "invite_exhausted"
  | "join_policy_required" | "membership_unconfirmed" | "leave_unconfirmed"
  | "runtime_unsupported" | "runtime_unavailable" | "runtime_credential_unavailable";

const MESSAGES: Record<BuzzCoordinatorProblem, string> = {
  invalid_request: "Check the Buzz connection details and try again.",
  not_found: "Buzz connection or agent not found.",
  already_bound: "That agent already has a live identity on this Buzz relay.",
  operation_conflict: "That request belongs to a different Buzz connection change.",
  storage_unavailable: "Buzz connection storage is temporarily unavailable.",
  configuration_unavailable: "Buzz secret custody is not configured.",
  relay_unavailable: "The Buzz relay is temporarily unavailable.",
  relay_incompatible: "That server is not a compatible signed Buzz relay.",
  unsafe_relay: "That relay cannot be reached safely from this Hivra controller.",
  invalid_relay: "Enter the public URL of a Buzz relay.",
  invalid_invite: "That Buzz invite is invalid.",
  invite_expired: "That Buzz invite has expired.",
  invite_exhausted: "That Buzz invite has no remaining uses.",
  join_policy_required: "Accept this relay's joining policy in Buzz, then create a new invite.",
  membership_unconfirmed: "The relay did not confirm this agent identity.",
  leave_unconfirmed: "The relay did not confirm that this identity left.",
  runtime_unsupported: "This computer cannot run the Buzz ACP sidecar yet.",
  runtime_unavailable: "The Buzz runtime could not be confirmed on this computer.",
  runtime_credential_unavailable: "Save a Venice API key in Vault before activating this Buzz runtime.",
};

export class BuzzCoordinatorError extends Error {
  constructor(readonly code: BuzzCoordinatorProblem) {
    super(MESSAGES[code]);
    this.name = "BuzzCoordinatorError";
  }
}

export type BuzzMutationOutcome = {
  bindingId: string;
  status: "joined" | "pending" | "revoked";
  reason?: string;
};

type Dependencies = {
  store?: BuzzStore;
  inspectRelay?: typeof inspectBuzzRelay;
  claimInvite?: typeof claimBuzzInvite;
  verifyMembership?: typeof verifyBuzzMembership;
  leaveRelay?: typeof leaveBuzzRelay;
  encrypt?: typeof encryptSecret;
  decrypt?: typeof decryptSecret;
  generateIdentity?: typeof generateBuzzIdentity;
  requestDigestKey?: () => Buffer;
  installRuntime?: typeof installBuzzRuntime;
  observeRuntime?: typeof observeBuzzRuntime;
  removeRuntime?: typeof removeBuzzRuntime;
  resolveVaultCredential?: typeof resolveBuzzVaultCredential;
};

function requireId(value: string) {
  if (!Id.safeParse(value).success) throw new BuzzCoordinatorError("invalid_request");
}

function relayDescriptor(connection: BuzzConnectionRow): BuzzRelayDescriptor {
  if (connection.status !== "ready") throw new BuzzCoordinatorError("not_found");
  return {
    relayUrl: connection.relay_url,
    httpOrigin: connection.http_origin,
    relayPublicKey: connection.relay_public_key,
    displayName: connection.display_name,
    software: connection.software,
    version: connection.relay_version,
    requiresMembership: connection.requires_membership,
  };
}

function publicSummary(input: Awaited<ReturnType<BuzzStore["list"]>>) {
  const agents = new Map(input.agents.map((agent) => [agent.id, agent]));
  return {
    connections: input.connections.map((connection) => ({
      id: connection.id,
      relayUrl: connection.relay_url,
      openUrl: connection.http_origin,
      relayPublicKey: connection.relay_public_key,
      displayName: connection.display_name,
      software: connection.software,
      version: connection.relay_version,
      requiresMembership: connection.requires_membership,
      revision: connection.revision,
      status: connection.status,
      observedAt: connection.observed_at,
    })),
    bindings: input.bindings.map((binding) => ({
      id: binding.id,
      connectionId: binding.connection_id,
      agentId: binding.agent_id,
      agentName: agents.get(binding.agent_id)?.name ?? "Agent",
      agentType: agents.get(binding.agent_id)?.type ?? "unknown",
      publicKey: binding.public_key,
      status: binding.status,
      lastHealthAt: binding.last_health_at,
      joinedAt: binding.joined_at,
      revokedAt: binding.revoked_at,
      lastErrorCode: binding.last_error_code,
      runtimeAdapter: binding.runtime_status,
      runtimeProvider: binding.runtime_provider,
      runtimeModel: binding.runtime_model,
      runtimeLastObservedAt: binding.runtime_last_observed_at,
      runtimeLastErrorCode: binding.runtime_last_error_code,
    })),
    agents: input.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      type: agent.type,
      status: agent.status,
      desiredState: agent.desired_state,
    })),
  };
}

function translate(error: unknown): never {
  if (error instanceof BuzzCoordinatorError) throw error;
  if (error instanceof BuzzRelayError) {
    // A malformed or missing saved key is a local custody failure, not a
    // remotely actionable relay error. Keep that distinction stable at the
    // public API boundary and never expose key material in diagnostics.
    if (error.code === "invalid_identity") throw new BuzzCoordinatorError("configuration_unavailable");
    throw new BuzzCoordinatorError(error.code);
  }
  throw new BuzzCoordinatorError("storage_unavailable");
}

export function createBuzzCoordinator(deps: Dependencies = {}) {
  const store = deps.store ?? createBuzzStore();
  const inspectRelay = deps.inspectRelay ?? inspectBuzzRelay;
  const claimInvite = deps.claimInvite ?? claimBuzzInvite;
  const verifyMembership = deps.verifyMembership ?? verifyBuzzMembership;
  const leaveRelay = deps.leaveRelay ?? leaveBuzzRelay;
  const encrypt = deps.encrypt ?? encryptSecret;
  const decrypt = deps.decrypt ?? decryptSecret;
  const generateIdentity = deps.generateIdentity ?? generateBuzzIdentity;
  const requestDigestKey = deps.requestDigestKey ?? (() => getSecretPrimaryKey().key);
  const installRuntime = deps.installRuntime ?? installBuzzRuntime;
  const observeRuntime = deps.observeRuntime ?? observeBuzzRuntime;
  const removeRuntime = deps.removeRuntime ?? removeBuzzRuntime;
  const resolveVaultCredential = deps.resolveVaultCredential ?? resolveBuzzVaultCredential;

  function buildRequestDigest(input: {
    operationId: string;
    connectionId: string;
    connectionRevision: number;
    relayPublicKey: string;
    agentId: string;
    publicKey: string;
    inviteCode: string;
  }) {
    const inviteDigest = createHash("sha256").update(input.inviteCode).digest("hex");
    return createHmac("sha256", requestDigestKey()).update(JSON.stringify({
      protocol: "hivra-buzz-bind-v1",
      operationId: input.operationId,
      connectionId: input.connectionId,
      connectionRevision: input.connectionRevision,
      relayPublicKey: input.relayPublicKey,
      agentId: input.agentId,
      publicKey: input.publicKey,
      inviteDigest,
    })).digest("hex");
  }

  function sameDigest(left: string, right: string) {
    const a = Buffer.from(left, "hex");
    const b = Buffer.from(right, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function buildRuntimeDigest(input: {
    bindingId: string; operationId: string; publicKey: string; provider: "openai" | "anthropic" | "venice";
    model: string; ownerPublicKey: string; apiKey: string;
  }) {
    return createHmac("sha256", requestDigestKey()).update(JSON.stringify({
      protocol: "hivra-buzz-runtime-install-v1",
      bindingId: input.bindingId,
      operationId: input.operationId,
      publicKey: input.publicKey,
      provider: input.provider,
      model: input.model,
      ownerPublicKey: input.ownerPublicKey,
      apiKeyDigest: createHash("sha256").update(input.apiKey).digest("hex"),
    })).digest("hex");
  }

  async function connection(userId: string, id: string) {
    requireId(id);
    const row = await store.connection(userId, id);
    if (!row) throw new BuzzCoordinatorError("not_found");
    return row;
  }

  async function binding(userId: string, id: string) {
    requireId(id);
    const row = await store.binding(userId, id);
    if (!row) throw new BuzzCoordinatorError("not_found");
    return row;
  }

  function privateKey(row: BuzzBindingRow) {
    if (!row.encrypted_private_key) throw new BuzzCoordinatorError("configuration_unavailable");
    try {
      const value = decrypt(row.encrypted_private_key);
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("identity");
      return value;
    } catch {
      throw new BuzzCoordinatorError("configuration_unavailable");
    }
  }

  async function resume(userId: string, bindingId: string): Promise<BuzzMutationOutcome> {
    const current = await binding(userId, bindingId);
    if (current.status === "joined") return { bindingId, status: "joined" };
    if (current.status === "revoked") return { bindingId, status: "revoked" };
    if (current.status !== "claim_pending") return { bindingId, status: "pending", reason: "leave_in_progress" };
    const lease = await store.claimMembership(userId, bindingId);
    if (!lease) return { bindingId, status: "pending", reason: "claim_in_progress" };
    let inviteCode: string;
    try {
      inviteCode = decrypt(lease.encrypted_invite_code ?? "");
    } catch {
      throw new BuzzCoordinatorError("configuration_unavailable");
    }
    const connected = await connection(userId, lease.connection_id);
    try {
      const outcome = await claimInvite({
        relay: relayDescriptor(connected), privateKeyHex: privateKey(lease), inviteCode,
      });
      const roster = await verifyMembership({
        relay: relayDescriptor(connected),
        privateKeyHex: privateKey(lease),
        targetPublicKeyHex: lease.public_key,
      });
      if (!roster?.member || roster.relayPublicKey !== connected.relay_public_key) {
        return { bindingId, status: "pending", reason: "membership_unconfirmed" };
      }
      const receipt = {
        protocol: "hivra-buzz-claim-v1",
        connectionId: connected.id,
        connectionRevision: connected.revision,
        relayPublicKey: connected.relay_public_key,
        relayUrl: connected.relay_url,
        publicKey: lease.public_key,
        status: outcome.status,
        communityId: outcome.communityId,
        host: outcome.host,
        role: outcome.role,
        rosterEventId: roster.rosterEventId,
        rosterCreatedAt: roster.rosterCreatedAt,
        rosterMember: true,
      };
      const settled = await store.settleMembership(userId, bindingId, lease.lease_id!, receipt);
      return settled ? { bindingId, status: "joined" } : { bindingId, status: "pending", reason: "settlement_unconfirmed" };
    } catch (error) {
      if (error instanceof BuzzRelayError && DefinitiveClaimErrors.has(error.code)) {
        await store.abandonMembership(userId, bindingId, lease.lease_id!, error.code).catch(() => false);
        throw new BuzzCoordinatorError(error.code as BuzzCoordinatorProblem);
      }
      if (error instanceof BuzzRelayError) {
        if (error.code === "invalid_identity") {
          throw new BuzzCoordinatorError("configuration_unavailable");
        }
        return { bindingId, status: "pending", reason: error.code };
      }
      throw error;
    }
  }

  async function runtimeAgent(userId: string, current: BuzzBindingRow) {
    const agent = await store.runtimeAgent(userId, current.agent_id);
    if (!agent || agent.status !== "running" || agent.desired_state !== "running" || !agent.ip) {
      throw new BuzzCoordinatorError("runtime_unsupported");
    }
    return agent;
  }

  function runtimeIdentity(current: BuzzBindingRow, agentIp: string) {
    return { bindingId: current.id, agentId: current.agent_id, agentIp, publicKey: current.public_key };
  }

  async function resumeRuntime(userId: string, bindingId: string) {
    const current = await binding(userId, bindingId);
    if (current.status !== "joined") throw new BuzzCoordinatorError("not_found");
    if (current.runtime_status === "active") return { bindingId, status: "active" as const };
    if (current.runtime_status !== "install_pending") {
      return { bindingId, status: current.runtime_status as "not_installed" | "remove_pending" | "removed" };
    }
    const lease = await store.claimRuntimeInstall(userId, bindingId);
    if (!lease) return { bindingId, status: "install_pending" as const, reason: "install_in_progress" };
    if (!lease.runtime_lease_id || !lease.runtime_operation_id || !lease.runtime_request_digest
      || !lease.runtime_provider || !lease.runtime_model
      || !lease.runtime_owner_public_key || !lease.encrypted_runtime_api_key) {
      throw new BuzzCoordinatorError("configuration_unavailable");
    }
    const connected = await connection(userId, lease.connection_id);
    const agent = await runtimeAgent(userId, lease);
    let apiKey: string;
    try { apiKey = decrypt(lease.encrypted_runtime_api_key); }
    catch { throw new BuzzCoordinatorError("configuration_unavailable"); }
    try {
      const receipt = await installRuntime(userId, agent, {
        ...runtimeIdentity(lease, agent.ip!),
        agentType: agent.type,
        privateKey: privateKey(lease),
        relayUrl: connected.relay_url,
        provider: lease.runtime_provider,
        model: lease.runtime_model,
        apiKey,
        ownerPublicKey: lease.runtime_owner_public_key,
        operationId: lease.runtime_operation_id!,
        requestDigest: lease.runtime_request_digest!,
        leaseId: lease.runtime_lease_id,
      });
      const settled = await store.settleRuntimeInstall(userId, bindingId, lease.runtime_lease_id, receipt);
      return settled ? { bindingId, status: "active" as const }
        : { bindingId, status: "install_pending" as const, reason: "settlement_unconfirmed" };
    } catch (error) {
      if (error instanceof BuzzRuntimeControlError) {
        if (error.code === "target_unsupported") throw new BuzzCoordinatorError("runtime_unsupported");
        return { bindingId, status: "install_pending" as const, reason: error.code };
      }
      throw error;
    }
  }

  async function removeRuntimeBinding(userId: string, bindingId: string) {
    const current = await binding(userId, bindingId);
    if (current.runtime_status === "not_installed" || current.runtime_status === "removed") {
      return { bindingId, status: "removed" as const };
    }
    const lease = await store.claimRuntimeRemove(userId, bindingId);
    if (!lease) return { bindingId, status: "remove_pending" as const, reason: "remove_in_progress" };
    if (!lease.runtime_lease_id || !lease.runtime_operation_id || !lease.runtime_request_digest) {
      throw new BuzzCoordinatorError("configuration_unavailable");
    }
    const agent = await runtimeAgent(userId, lease);
    try {
      const receipt = await removeRuntime(userId, agent, {
        ...runtimeIdentity(lease, agent.ip!),
        operationId: lease.runtime_operation_id,
        requestDigest: lease.runtime_request_digest,
        leaseId: lease.runtime_lease_id,
      });
      const settled = await store.settleRuntimeRemove(userId, bindingId, lease.runtime_lease_id, receipt);
      return settled ? { bindingId, status: "removed" as const }
        : { bindingId, status: "remove_pending" as const, reason: "settlement_unconfirmed" };
    } catch (error) {
      if (error instanceof BuzzRuntimeControlError) {
        if (error.code === "target_unsupported") throw new BuzzCoordinatorError("runtime_unsupported");
        return { bindingId, status: "remove_pending" as const, reason: error.code };
      }
      throw error;
    }
  }

  return {
    async summary(userId: string) {
      try { return publicSummary(await store.list(userId)); } catch (error) { return translate(error); }
    },
    async connect(userId: string, relayUrl: string) {
      try {
        if (!userId.trim() || userId.length > 256 || typeof relayUrl !== "string") {
          throw new BuzzCoordinatorError("invalid_request");
        }
        const inspected = await inspectRelay(relayUrl);
        const id = await store.upsertConnection(userId, randomUUID(), inspected);
        const saved = await store.connection(userId, id);
        if (!saved) throw new BuzzCoordinatorError("storage_unavailable");
        return publicSummary({ connections: [saved], bindings: [], agents: [] }).connections[0];
      } catch (error) { return translate(error); }
    },
    async bind(userId: string, input: { connectionId: string; agentId: string; operationId: string; inviteCode: string }) {
      try {
        requireId(input.connectionId); requireId(input.agentId); requireId(input.operationId);
        if (typeof input.inviteCode !== "string" || !input.inviteCode.trim()) {
          throw new BuzzCoordinatorError("invalid_request");
        }
        const normalizedInvite = input.inviteCode.trim();
        const existing = await store.operation(userId, input.operationId);
        if (existing) {
          let replayDigest: string;
          try {
            replayDigest = buildRequestDigest({
              operationId: input.operationId,
              connectionId: input.connectionId,
              connectionRevision: existing.connection_revision,
              relayPublicKey: existing.relay_public_key,
              agentId: input.agentId,
              publicKey: existing.public_key,
              inviteCode: normalizedInvite,
            });
          } catch {
            throw new BuzzCoordinatorError("configuration_unavailable");
          }
          if (existing.connection_id !== input.connectionId || existing.agent_id !== input.agentId
            || !sameDigest(existing.request_digest, replayDigest)) {
            throw new BuzzCoordinatorError("operation_conflict");
          }
          return resume(userId, existing.id);
        }
        const connected = await connection(userId, input.connectionId);
        const identity = generateIdentity();
        const bindingId = randomUUID();
        let encryptedPrivateKey: string;
        let encryptedInviteCode: string;
        let requestDigest: string;
        try {
          encryptedPrivateKey = encrypt(identity.privateKeyHex);
          encryptedInviteCode = encrypt(normalizedInvite);
          requestDigest = buildRequestDigest({
            operationId: input.operationId,
            connectionId: connected.id,
            connectionRevision: connected.revision,
            relayPublicKey: connected.relay_public_key,
            agentId: input.agentId,
            publicKey: identity.publicKeyHex,
            inviteCode: normalizedInvite,
          });
        } catch {
          throw new BuzzCoordinatorError("configuration_unavailable");
        }
        const admitted = await store.admit(userId, {
          bindingId, connectionId: connected.id, agentId: input.agentId, operationId: input.operationId,
          requestDigest, publicKey: identity.publicKeyHex, encryptedPrivateKey, encryptedInviteCode,
        });
        if (admitted.status === "already_bound") throw new BuzzCoordinatorError("already_bound");
        if (admitted.status === "not_found" || admitted.status === "agent_not_found") throw new BuzzCoordinatorError("not_found");
        if (admitted.status === "invalid_request") throw new BuzzCoordinatorError("invalid_request");
        if (admitted.status === "operation_conflict") throw new BuzzCoordinatorError("operation_conflict");
        if (!admitted.bindingId) throw new BuzzCoordinatorError("storage_unavailable");
        return resume(userId, admitted.bindingId);
      } catch (error) { return translate(error); }
    },
    resume: async (userId: string, bindingId: string) => {
      try { return await resume(userId, bindingId); } catch (error) { return translate(error); }
    },
    async activateRuntime(userId: string, bindingId: string, input: {
      operationId: string; provider: "openai" | "anthropic" | "venice"; model: string; apiKey?: string;
      ownerPublicKey: string;
    }) {
      try {
        requireId(bindingId); requireId(input.operationId);
        const current = await binding(userId, bindingId);
        if (current.status !== "joined") throw new BuzzCoordinatorError("not_found");
        const apiKey = input.provider === "venice"
          ? await resolveVaultCredential(userId, "venice")
          : input.apiKey;
        if (input.provider === "venice" && !apiKey) {
          throw new BuzzCoordinatorError("runtime_credential_unavailable");
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,159}$/.test(input.model)
          || !/^[a-f0-9]{64}$/.test(input.ownerPublicKey)
          || !apiKey || !/^[\x21-\x7e]{1,8192}$/.test(apiKey)
          || !["openai", "anthropic", "venice"].includes(input.provider)) {
          throw new BuzzCoordinatorError("invalid_request");
        }
        const normalized = { ...input, apiKey };
        const digest = buildRuntimeDigest({ bindingId, publicKey: current.public_key, ...normalized });
        let encryptedApiKey: string;
        try { encryptedApiKey = encrypt(apiKey); }
        catch { throw new BuzzCoordinatorError("configuration_unavailable"); }
        const admitted = await store.beginRuntimeInstall(userId, {
          bindingId, operationId: input.operationId, requestDigest: digest, provider: input.provider,
          model: input.model, ownerPublicKey: input.ownerPublicKey, encryptedApiKey,
        });
        if (admitted.status === "invalid_request") throw new BuzzCoordinatorError("invalid_request");
        if (admitted.status === "not_found") throw new BuzzCoordinatorError("not_found");
        if (admitted.status === "agent_not_ready") throw new BuzzCoordinatorError("runtime_unsupported");
        if (admitted.status === "operation_conflict") throw new BuzzCoordinatorError("operation_conflict");
        if (admitted.status === "active") return { bindingId, status: "active" as const };
        return await resumeRuntime(userId, bindingId);
      } catch (error) { return translate(error); }
    },
    resumeRuntime: async (userId: string, bindingId: string) => {
      try { return await resumeRuntime(userId, bindingId); } catch (error) { return translate(error); }
    },
    async runtimeHealth(userId: string, bindingId: string) {
      try {
        const current = await binding(userId, bindingId);
        if (current.runtime_status !== "active") return { bindingId, healthy: false, status: current.runtime_status };
        const agent = await runtimeAgent(userId, current);
        const receipt = await observeRuntime(userId, agent, runtimeIdentity(current, agent.ip!));
        const healthy = await store.confirmRuntimeHealth(userId, bindingId, receipt);
        return { bindingId, healthy, status: healthy ? "active" as const : "install_pending" as const };
      } catch (error) {
        if (error instanceof BuzzRuntimeControlError) {
          return { bindingId, healthy: false, status: "active" as const, reason: error.code };
        }
        return translate(error);
      }
    },
    removeRuntime: async (userId: string, bindingId: string) => {
      try { return await removeRuntimeBinding(userId, bindingId); } catch (error) { return translate(error); }
    },
    async health(userId: string, bindingId: string) {
      try {
        const current = await binding(userId, bindingId);
        if (current.status !== "joined") return { bindingId, healthy: false, status: current.status };
        const connected = await connection(userId, current.connection_id);
        const evidence = await verifyMembership({
          relay: relayDescriptor(connected),
          privateKeyHex: privateKey(current),
          targetPublicKeyHex: current.public_key,
        });
        const healthy = evidence?.member === true && evidence.relayPublicKey === current.relay_public_key;
        if (healthy) await store.confirmHealth(userId, bindingId, {
          protocol: "hivra-buzz-health-v1",
          connectionId: connected.id,
          connectionRevision: connected.revision,
          relayPublicKey: connected.relay_public_key,
          relayUrl: connected.relay_url,
          publicKey: current.public_key,
          status: "member",
          rosterEventId: evidence.rosterEventId,
          rosterCreatedAt: evidence.rosterCreatedAt,
          rosterMember: true,
        });
        return { bindingId, healthy, status: current.status };
      } catch (error) { return translate(error); }
    },
    async disconnect(userId: string, bindingId: string): Promise<BuzzMutationOutcome> {
      try {
        let current = await binding(userId, bindingId);
        if (current.status === "revoked") return { bindingId, status: "revoked" };
        if (current.runtime_status !== "not_installed" && current.runtime_status !== "removed") {
          const removed = await removeRuntimeBinding(userId, bindingId);
          if (removed.status !== "removed") {
            return { bindingId, status: "pending", reason: "runtime_remove_pending" };
          }
          current = await binding(userId, bindingId);
        }
        if (current.status === "claim_pending") {
          const claim = await resume(userId, bindingId);
          if (claim.status !== "joined") return claim;
          current = await binding(userId, bindingId);
        }
        const lease = await store.claimLeave(userId, bindingId);
        if (!lease) return { bindingId, status: "pending", reason: "leave_in_progress" };
        const connected = await connection(userId, lease.connection_id);
        try {
          const outcome = await leaveRelay({ relay: relayDescriptor(connected), privateKeyHex: privateKey(lease) });
          const claimEvidence = ClaimRosterReceipt.safeParse(lease.claim_receipt);
          if (!claimEvidence.success) {
            return { bindingId, status: "pending", reason: "settlement_unconfirmed" };
          }
          const state = await store.list(userId);
          const observer = state.bindings.find((candidate) => candidate.connection_id === lease.connection_id
            && candidate.id !== lease.id && candidate.status === "joined" && candidate.encrypted_private_key);
          if (!observer) {
            return { bindingId, status: "pending", reason: "absence_proof_unavailable" };
          }
          const roster = await verifyMembership({
            relay: relayDescriptor(connected),
            privateKeyHex: privateKey(observer),
            targetPublicKeyHex: lease.public_key,
          });
          if (!roster || roster.member || roster.relayPublicKey !== connected.relay_public_key
            || roster.rosterCreatedAt < claimEvidence.data.rosterCreatedAt
            || roster.rosterEventId === claimEvidence.data.rosterEventId) {
            return { bindingId, status: "pending", reason: "leave_unconfirmed" };
          }
          const receipt = {
            protocol: "hivra-buzz-leave-v1",
            connectionId: connected.id,
            connectionRevision: connected.revision,
            relayPublicKey: connected.relay_public_key,
            relayUrl: connected.relay_url,
            publicKey: lease.public_key,
            status: outcome.status,
            eventId: outcome.eventId,
            rosterEventId: roster.rosterEventId,
            rosterCreatedAt: roster.rosterCreatedAt,
            rosterMember: false,
            observerPublicKey: observer.public_key,
          };
          const settled = await store.settleLeave(userId, bindingId, lease.lease_id!, receipt);
          return settled ? { bindingId, status: "revoked" } : { bindingId, status: "pending", reason: "settlement_unconfirmed" };
        } catch (error) {
          if (error instanceof BuzzRelayError) {
            if (error.code === "invalid_identity") {
              throw new BuzzCoordinatorError("configuration_unavailable");
            }
            return { bindingId, status: "pending", reason: error.code };
          }
          throw error;
        }
      } catch (error) { return translate(error); }
    },
  };
}
