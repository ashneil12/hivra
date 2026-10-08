import type { SupabaseClient } from "@supabase/supabase-js";

import { log } from "@/lib/logger";

import { isAgentPublicKey, verifyAgentKeyProof } from "./agent-key";
import type { AuthzStore } from "./authorize";
import type { CardKeyRecord } from "./card-signing";
import type { PrincipalState } from "./types";

// Service-role access to the agent-network tables. Every write goes through a
// database function (the tables grant the service role SELECT only, apart from the
// card key registry), so the integrity rules live in one place: the database.

const SOURCE = "agent-network";

export class AgentNetworkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Database error code behind it, when there was one (HN403, HN409, 23505, ...). */
    readonly code?: string
  ) {
    super(message);
  }
}

interface RpcError {
  code?: string;
  message?: string;
}

/** HN403 forbidden, HN404 not found, HN409 conflict or stale, HN422 invalid. */
function statusFor(code: string | undefined): number {
  switch (code) {
    case "HN403":
      return 403;
    case "HN404":
      return 404;
    case "HN409":
    case "23505":
      return 409;
    case "HN422":
    case "23514":
    case "23502":
    case "23503":
      return 422;
    default:
      return 500;
  }
}

function fail(operation: string, error: RpcError): never {
  const status = statusFor(error.code);
  // Integration boundary: keep the database's own words for diagnosis, but a 5xx
  // never leaks them to the caller.
  log.warn(`${operation} failed`, { source: SOURCE, failureType: error.code, dbMessage: error.message });
  throw new AgentNetworkError(
    status >= 500 ? `${operation} failed` : (error.message ?? `${operation} was refused`).replace(/^hivra_net:\s*/, ""),
    status,
    error.code
  );
}

async function rpc<T>(db: SupabaseClient, name: string, args: Record<string, unknown>, operation: string): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) fail(operation, error as RpcError);
  return data as T;
}

/** An account's organization of one, created on first use. Idempotent. */
export async function ensurePersonalOrg(db: SupabaseClient, userId: string): Promise<string> {
  return rpc<string>(db, "hivra_net_ensure_personal_org", { p_user_id: userId }, "ensure personal organization");
}

export async function createTeamOrg(db: SupabaseClient, input: { ownerUserId: string; name: string }): Promise<string> {
  return rpc<string>(
    db,
    "hivra_net_create_org",
    { p_kind: "team", p_owner_user_id: input.ownerUserId, p_name: input.name },
    "create organization"
  );
}

export async function addOrgMember(
  db: SupabaseClient,
  input: { orgId: string; userId: string; role: "admin" | "member" | "owner"; actorUserId: string }
): Promise<void> {
  await rpc<null>(
    db,
    "hivra_net_add_member",
    { p_org_id: input.orgId, p_user_id: input.userId, p_role: input.role, p_actor_user_id: input.actorUserId },
    "add member"
  );
}

/** Returns how many of the member's agents were suspended or dropped. */
export async function removeOrgMember(
  db: SupabaseClient,
  input: { orgId: string; userId: string; actorUserId: string }
): Promise<number> {
  return rpc<number>(
    db,
    "hivra_net_remove_member",
    { p_org_id: input.orgId, p_user_id: input.userId, p_actor_user_id: input.actorUserId },
    "remove member"
  );
}

/** Starts the explicit join of an agent. Launching an agent never calls this. */
export async function beginJoin(
  db: SupabaseClient,
  input: { orgId: string; agentIdentityId: string; ownerUserId: string; actorUserId: string }
): Promise<string> {
  return rpc<string>(
    db,
    "hivra_net_begin_join",
    {
      p_org_id: input.orgId,
      p_agent_identity_id: input.agentIdentityId,
      p_owner_user_id: input.ownerUserId,
      p_actor_user_id: input.actorUserId,
    },
    "begin join"
  );
}

/**
 * Registers the agent's public key. The proof of possession is checked here, before
 * the database is called, so a key is never stored for a caller that cannot sign
 * with its private half. Only a public key is accepted.
 */
export async function registerPrincipalKey(
  db: SupabaseClient,
  input: {
    orgId: string;
    principalId: string;
    publicKey: string;
    nonce: string;
    signature: string;
    actorUserId: string;
  }
): Promise<number> {
  if (!isAgentPublicKey(input.publicKey)) {
    throw new AgentNetworkError("The key must be a raw Ed25519 public key", 422);
  }
  const proof = verifyAgentKeyProof(input);
  if (!proof.ok) {
    throw new AgentNetworkError(`Key proof of possession failed (${proof.reason})`, 422);
  }
  return rpc<number>(
    db,
    "hivra_net_set_principal_key",
    {
      p_org_id: input.orgId,
      p_principal_id: input.principalId,
      p_public_key: input.publicKey,
      p_actor_user_id: input.actorUserId,
    },
    "register key"
  );
}

export async function transitionPrincipal(
  db: SupabaseClient,
  input: {
    orgId: string;
    principalId: string;
    to: Exclude<PrincipalState, "pending">;
    actorUserId: string;
    reason?: string;
  }
): Promise<void> {
  await rpc<null>(
    db,
    "hivra_net_transition_principal",
    {
      p_org_id: input.orgId,
      p_principal_id: input.principalId,
      p_to_state: input.to,
      p_actor_user_id: input.actorUserId,
      p_reason: input.reason ?? null,
    },
    "change agent state"
  );
}

/**
 * Publishes the complete desired policy as the next revision. Returns the new
 * revision, or the current one when nothing changed. A stale expectedRevision
 * (409), a role that may not make this change (403) or a narrowing that exceeds the
 * ceiling (422) is refused with nothing written.
 */
export async function publishPolicyRevision(
  db: SupabaseClient,
  input: {
    orgId: string;
    expectedRevision: number;
    authorUserId: string;
    reason?: string;
    document: Record<string, unknown>;
  }
): Promise<number> {
  const revision = await rpc<number | string>(
    db,
    "hivra_net_publish_policy_revision",
    {
      p_org_id: input.orgId,
      p_expected_revision: input.expectedRevision,
      p_author_user_id: input.authorUserId,
      p_reason: input.reason ?? null,
      p_document: input.document,
    },
    "publish policy"
  );
  return Number(revision);
}

export async function appendAudit(
  db: SupabaseClient,
  entry: {
    orgId: string;
    action: string;
    actorUserId?: string;
    actorPrincipalId?: string;
    subjectPrincipalId?: string;
    resource?: string;
    decision?: "allow" | "deny" | "approve" | "n/a";
    rule?: string;
    reason?: string;
    policyRevision?: number | null;
    /** sha256 hex of the message or request; never the content. */
    digest?: string;
    sizeBytes?: number;
    detail?: Record<string, unknown>;
  }
): Promise<number> {
  const seq = await rpc<number | string>(
    db,
    "hivra_net_append_audit",
    {
      p_org_id: entry.orgId,
      p_action: entry.action,
      p_actor_user_id: entry.actorUserId ?? null,
      p_actor_principal_id: entry.actorPrincipalId ?? null,
      p_subject_principal_id: entry.subjectPrincipalId ?? null,
      p_resource: entry.resource ?? null,
      p_decision: entry.decision ?? "n/a",
      p_rule: entry.rule ?? null,
      p_reason: entry.reason ?? null,
      p_policy_revision: entry.policyRevision ?? null,
      p_digest: entry.digest ?? null,
      p_size_bytes: entry.sizeBytes ?? null,
      p_detail: entry.detail ?? {},
    },
    "append audit"
  );
  return Number(seq);
}

export async function verifyAuditChain(
  db: SupabaseClient,
  orgId: string
): Promise<{ ok: boolean; entries: number; firstBadSeq: number | null; problem: string | null }> {
  const rows = await rpc<Array<{ ok: boolean; entries: number | string; first_bad_seq: number | string | null; problem: string | null }>>(
    db,
    "hivra_net_verify_audit_chain",
    { p_org_id: orgId },
    "verify audit chain"
  );
  const row = rows?.[0];
  if (!row) return { ok: false, entries: 0, firstBadSeq: null, problem: "no result" };
  return {
    ok: row.ok,
    entries: Number(row.entries),
    firstBadSeq: row.first_bad_seq === null ? null : Number(row.first_bad_seq),
    problem: row.problem,
  };
}

/** Erases an account's organization of one, with its audit log. Returns rows removed (0 if none). */
export async function erasePersonalOrg(db: SupabaseClient, userId: string): Promise<number> {
  return rpc<number>(db, "hivra_net_erase_personal_org", { p_user_id: userId }, "erase personal organization");
}

/** The authorization store used by gateways and brokers: one live read per decision. */
export function createSupabaseAuthzStore(db: SupabaseClient): AuthzStore {
  return {
    async getContext(input) {
      const { data, error } = await db.rpc("hivra_net_authz_context", {
        p_org_id: input.orgId,
        p_principal_id: input.principalId,
        p_peer_principal_id: input.peerPrincipalId ?? null,
        p_revision: input.revision ?? null,
      });
      if (error) {
        log.warn("authorization context read failed", { source: SOURCE, failureType: (error as RpcError).code });
        throw new Error("authorization context unavailable");
      }
      return data;
    },
  };
}

interface CardKeyRow {
  kid: string;
  public_key: string;
  status: "active" | "retired" | "revoked";
  retired_at: string | null;
  revoked_at: string | null;
}

/** The public keys and the revocation list, as verifyCard() reads them. */
export async function loadCardKeyRegistry(db: SupabaseClient): Promise<CardKeyRecord[]> {
  const { data, error } = await db
    .from("hivra_card_signing_keys")
    .select("kid, public_key, status, retired_at, revoked_at");
  if (error) fail("load card keys", error as RpcError);
  return ((data ?? []) as CardKeyRow[]).map((row) => ({
    kid: row.kid,
    publicKey: row.public_key,
    status: row.status,
    retiredAt: row.retired_at ? new Date(row.retired_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  }));
}

export async function registerCardKey(db: SupabaseClient, key: { kid: string; publicKey: string }): Promise<void> {
  const { error } = await db.from("hivra_card_signing_keys").insert({ kid: key.kid, public_key: key.publicKey });
  if (error) fail("register card key", error as RpcError);
}

/** Stops a key signing. Cards it signed before now stay valid until they expire. */
export async function retireCardKey(db: SupabaseClient, kid: string, now: Date = new Date()): Promise<void> {
  const { error } = await db
    .from("hivra_card_signing_keys")
    .update({ status: "retired", retired_at: now.toISOString() })
    .eq("kid", kid)
    .eq("status", "active");
  if (error) fail("retire card key", error as RpcError);
}

/** The revocation list: every card this key signed fails verification at once. */
export async function revokeCardKey(db: SupabaseClient, kid: string, reason: string, now: Date = new Date()): Promise<void> {
  const { error } = await db
    .from("hivra_card_signing_keys")
    .update({ status: "revoked", revoked_at: now.toISOString(), revoked_reason: reason.slice(0, 500) })
    .eq("kid", kid)
    .neq("status", "revoked");
  if (error) fail("revoke card key", error as RpcError);
}
