import { generateKeyPairSync, sign } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { agentKeyProofMessage } from "../agent-key";
import {
  AgentNetworkError,
  appendAudit,
  beginJoin,
  createSupabaseAuthzStore,
  ensurePersonalOrg,
  erasePersonalOrg,
  loadCardKeyRegistry,
  publishPolicyRevision,
  registerCardKey,
  registerPrincipalKey,
  removeOrgMember,
  retireCardKey,
  revokeCardKey,
  transitionPrincipal,
  verifyAuditChain,
} from "../store";
import { ALICE, BOB, ORG } from "./fixtures";

jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

function rpcDb(result: { data?: unknown; error?: { code?: string; message?: string } | null }) {
  const rpc = jest.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}

function tableDb(result: { data?: unknown; error?: { code?: string; message?: string } | null }) {
  const calls: Array<[string, unknown?]> = [];
  const chain: Record<string, unknown> = {};
  const final = { data: result.data ?? null, error: result.error ?? null };
  for (const method of ["select", "insert", "update", "eq", "neq"]) {
    chain[method] = (arg?: unknown) => {
      calls.push([method, arg]);
      return chain;
    };
  }
  (chain as { then: unknown }).then = (resolve: (value: unknown) => void) => resolve(final);
  return { db: { from: jest.fn(() => chain) } as unknown as SupabaseClient, calls };
}

describe("the store speaks to the database only through its functions", () => {
  it("maps arguments for each function", async () => {
    const { db, rpc } = rpcDb({ data: "ok" });
    await ensurePersonalOrg(db, "user_1");
    await beginJoin(db, { orgId: ORG, agentIdentityId: ALICE, ownerUserId: "user_1", actorUserId: "user_1" });
    await removeOrgMember(db, { orgId: ORG, userId: "user_2", actorUserId: "user_1" });
    await transitionPrincipal(db, { orgId: ORG, principalId: ALICE, to: "suspended", actorUserId: "user_1" });
    await erasePersonalOrg(db, "user_1");
    expect(rpc.mock.calls).toEqual([
      ["hivra_net_ensure_personal_org", { p_user_id: "user_1" }],
      ["hivra_net_begin_join", { p_org_id: ORG, p_agent_identity_id: ALICE, p_owner_user_id: "user_1", p_actor_user_id: "user_1" }],
      ["hivra_net_remove_member", { p_org_id: ORG, p_user_id: "user_2", p_actor_user_id: "user_1" }],
      ["hivra_net_transition_principal", { p_org_id: ORG, p_principal_id: ALICE, p_to_state: "suspended", p_actor_user_id: "user_1", p_reason: null }],
      ["hivra_net_erase_personal_org", { p_user_id: "user_1" }],
    ]);
  });

  it("publishes a policy and returns the revision as a number", async () => {
    const { db, rpc } = rpcDb({ data: "12" });
    const document = { settings: {}, groups: [], group_members: [], grants: [], edges: [] };
    expect(await publishPolicyRevision(db, { orgId: ORG, expectedRevision: 11, authorUserId: "u", reason: "why", document })).toBe(12);
    expect(rpc).toHaveBeenCalledWith("hivra_net_publish_policy_revision", {
      p_org_id: ORG, p_expected_revision: 11, p_author_user_id: "u", p_reason: "why", p_document: document,
    });
  });

  it.each([
    ["HN403", 403],
    ["HN404", 404],
    ["HN409", 409],
    ["23505", 409],
    ["HN422", 422],
    ["23514", 422],
    ["23503", 422],
    ["XX000", 500],
    [undefined, 500],
  ])("maps database error %s to HTTP %s", async (code, status) => {
    const { db } = rpcDb({ error: { code, message: "hivra_net: the policy changed (expected revision 1, current 2)" } });
    const error = await ensurePersonalOrg(db, "u").catch((e) => e);
    expect(error).toBeInstanceOf(AgentNetworkError);
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    // A server error never carries the database's words to the caller.
    if (status === 500) expect(error.message).not.toMatch(/policy changed/);
    else expect(error.message).toBe("the policy changed (expected revision 1, current 2)");
  });

  it("appends audit entries content-free, by digest and size", async () => {
    const { db, rpc } = rpcDb({ data: 4 });
    expect(await appendAudit(db, { orgId: ORG, action: "gateway.decision", actorPrincipalId: ALICE, decision: "deny", rule: "grant:x", policyRevision: 3, digest: "a".repeat(64), sizeBytes: 12 })).toBe(4);
    expect(rpc).toHaveBeenCalledWith("hivra_net_append_audit", expect.objectContaining({
      p_org_id: ORG, p_action: "gateway.decision", p_decision: "deny", p_digest: "a".repeat(64), p_size_bytes: 12, p_detail: {},
    }));
  });

  it("reads the chain verification row", async () => {
    const { db } = rpcDb({ data: [{ ok: false, entries: "9", first_bad_seq: "4", problem: "gap in sequence numbers" }] });
    expect(await verifyAuditChain(db, ORG)).toEqual({ ok: false, entries: 9, firstBadSeq: 4, problem: "gap in sequence numbers" });
    expect(await verifyAuditChain(rpcDb({ data: [] }).db, ORG)).toMatchObject({ ok: false });
  });

  it("the authorization store makes one live read per decision and throws on error, which denies", async () => {
    const context = { orgFound: true };
    const ok = rpcDb({ data: context });
    expect(await createSupabaseAuthzStore(ok.db).getContext({ orgId: ORG, principalId: ALICE, peerPrincipalId: BOB, revision: 3 })).toBe(context);
    expect(ok.rpc).toHaveBeenCalledTimes(1);
    expect(ok.rpc).toHaveBeenCalledWith("hivra_net_authz_context", { p_org_id: ORG, p_principal_id: ALICE, p_peer_principal_id: BOB, p_revision: 3 });
    const bad = rpcDb({ error: { code: "XX000", message: "boom" } });
    await expect(createSupabaseAuthzStore(bad.db).getContext({ orgId: ORG, principalId: ALICE })).rejects.toThrow(/unavailable/);
  });
});

describe("registering an agent key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64url");
  const input = { orgId: ORG, principalId: ALICE, publicKey: raw, nonce: "nonce-0123456789abcdef", actorUserId: "user_1" };
  const signed = () => ({ ...input, signature: sign(null, agentKeyProofMessage(input), privateKey).toString("base64url") });

  it("stores the public key after the proof of possession verifies", async () => {
    const { db, rpc } = rpcDb({ data: 1 });
    expect(await registerPrincipalKey(db, signed())).toBe(1);
    expect(rpc).toHaveBeenCalledWith("hivra_net_set_principal_key", {
      p_org_id: ORG, p_principal_id: ALICE, p_public_key: raw, p_actor_user_id: "user_1",
    });
  });

  it("never calls the database without a valid proof", async () => {
    const { db, rpc } = rpcDb({ data: 1 });
    const other = generateKeyPairSync("ed25519").privateKey;
    const forged = { ...input, signature: sign(null, agentKeyProofMessage(input), other).toString("base64url") };
    await expect(registerPrincipalKey(db, forged)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/proof of possession/) });
    await expect(registerPrincipalKey(db, { ...signed(), signature: "" })).rejects.toMatchObject({ status: 422 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses private key material in the key field", async () => {
    const { db, rpc } = rpcDb({ data: 1 });
    const pkcs8 = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64url");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    for (const publicKeyField of [pkcs8, pem]) {
      await expect(registerPrincipalKey(db, { ...signed(), publicKey: publicKeyField })).rejects.toMatchObject({
        status: 422,
        message: "The key must be a raw Ed25519 public key",
      });
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("the card key registry", () => {
  it("reads public keys and the revocation list", async () => {
    const { db } = tableDb({ data: [
      { kid: "card-key-0001", public_key: "A".repeat(43), status: "revoked", retired_at: "2026-10-08T10:00:00Z", revoked_at: "2026-10-08T11:00:00Z" },
      { kid: "card-key-0002", public_key: "B".repeat(43), status: "active", retired_at: null, revoked_at: null },
    ] });
    const registry = await loadCardKeyRegistry(db);
    expect(registry).toEqual([
      { kid: "card-key-0001", publicKey: "A".repeat(43), status: "revoked", retiredAt: new Date("2026-10-08T10:00:00Z"), revokedAt: new Date("2026-10-08T11:00:00Z") },
      { kid: "card-key-0002", publicKey: "B".repeat(43), status: "active", retiredAt: null, revokedAt: null },
    ]);
  });

  it("registers, retires and revokes through status-guarded writes", async () => {
    const { db, calls } = tableDb({});
    await registerCardKey(db, { kid: "card-key-0001", publicKey: "A".repeat(43) });
    await retireCardKey(db, "card-key-0001", new Date("2026-10-08T10:00:00Z"));
    await revokeCardKey(db, "card-key-0001", "compromised", new Date("2026-10-08T11:00:00Z"));
    expect(calls).toEqual(expect.arrayContaining([
      ["insert", { kid: "card-key-0001", public_key: "A".repeat(43) }],
      ["update", { status: "retired", retired_at: "2026-10-08T10:00:00.000Z" }],
      ["eq", "kid"],
      ["update", { status: "revoked", revoked_at: "2026-10-08T11:00:00.000Z", revoked_reason: "compromised" }],
    ]));
  });

  it("reports a registry read failure", async () => {
    const { db } = tableDb({ error: { code: "42501", message: "permission denied" } });
    await expect(loadCardKeyRegistry(db)).rejects.toMatchObject({ status: 500 });
  });
});
