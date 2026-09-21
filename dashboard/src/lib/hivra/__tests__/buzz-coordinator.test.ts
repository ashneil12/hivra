/** @jest-environment node */

jest.mock("server-only", () => ({}));

import { createBuzzCoordinator } from "../buzz-coordinator";
import { BuzzRelayError, type BuzzRelayDescriptor } from "../buzz-relay";
import { BuzzRuntimeControlError } from "../buzz-runtime-service";
import { BUZZ_SPRIG_RELEASE } from "../buzz-runtime";
import type { BuzzBindingRow, BuzzConnectionRow, BuzzStore } from "../buzz-store";

const USER = "user_a";
const CONNECTION = "00000000-0000-4000-8000-000000001003";
const AGENT_A = "00000000-0000-4000-8000-000000001008";
const AGENT_B = "00000000-0000-4000-8000-000000001009";
const BINDING_A = "00000000-0000-4000-8000-000000001014";
const BINDING_B = "00000000-0000-4000-8000-000000001015";
const OP_A = "00000000-0000-4000-8000-000000001017";
const OP_B = "00000000-0000-4000-8000-000000001018";
const RUNTIME_OP = "00000000-0000-4000-8000-000000001019";
const LEASE = "00000000-0000-4000-8000-000000001023";
const RUNTIME_LEASE = "00000000-0000-4000-8000-000000001024";
const RELAY_KEY = "a".repeat(64);
const PRIVATE_A = "1".repeat(64);
const PRIVATE_B = "2".repeat(64);
const PUBLIC_A = "b".repeat(64);
const PUBLIC_B = "c".repeat(64);

const relay: BuzzRelayDescriptor = {
  relayUrl: "wss://buzz.example",
  httpOrigin: "https://buzz.example",
  relayPublicKey: RELAY_KEY,
  displayName: "Example Buzz",
  software: "https://github.com/block/buzz",
  version: "0.5.20",
  requiresMembership: true,
};

function connectionRow(): BuzzConnectionRow {
  return {
    id: CONNECTION,
    user_id: USER,
    relay_url: relay.relayUrl,
    http_origin: relay.httpOrigin,
    relay_public_key: relay.relayPublicKey,
    display_name: relay.displayName,
    software: relay.software,
    relay_version: relay.version,
    requires_membership: relay.requiresMembership,
    revision: 1,
    status: "ready",
    observed_at: "2026-09-01T00:00:00.000Z",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  };
}

function createFakeStore() {
  const connections = new Map<string, BuzzConnectionRow>([[CONNECTION, connectionRow()]]);
  const bindings = new Map<string, BuzzBindingRow>();
  const agents = [
    { id: AGENT_A, name: "Research", type: "codex", status: "running", desired_state: "running" },
    { id: AGENT_B, name: "Review", type: "hermes", status: "running", desired_state: "running" },
  ];
  const bindingIds = [BINDING_A, BINDING_B];
  const store = {
    list: jest.fn(async (userId: string) => ({
      connections: [...connections.values()].filter((row) => row.user_id === userId),
      bindings: [...bindings.values()].filter((row) => row.user_id === userId),
      agents,
    })),
    connection: jest.fn(async (userId: string, id: string) => {
      const row = connections.get(id);
      return row?.user_id === userId ? row : null;
    }),
    binding: jest.fn(async (userId: string, id: string) => {
      const row = bindings.get(id);
      return row?.user_id === userId ? row : null;
    }),
    operation: jest.fn(async (userId: string, operationId: string) =>
      [...bindings.values()].find((row) => row.user_id === userId && row.operation_id === operationId) ?? null),
    upsertConnection: jest.fn(async (userId: string, id: string, input: BuzzRelayDescriptor) => {
      connections.set(id, { ...connectionRow(), id, user_id: userId, ...{
        relay_url: input.relayUrl,
        http_origin: input.httpOrigin,
        relay_public_key: input.relayPublicKey,
        display_name: input.displayName,
        software: input.software,
        relay_version: input.version,
        requires_membership: input.requiresMembership,
      } });
      return id;
    }),
    admit: jest.fn(async (userId: string, input: {
      connectionId: string; agentId: string; operationId: string; requestDigest: string;
      publicKey: string; encryptedPrivateKey: string; encryptedInviteCode: string;
    }) => {
      const existing = [...bindings.values()].find((row) => row.operation_id === input.operationId);
      if (existing) return { status: existing.status, bindingId: existing.id } as const;
      const id = bindingIds.shift();
      if (!id) throw new Error("fixture exhausted");
      bindings.set(id, {
        id,
        user_id: userId,
        connection_id: input.connectionId,
        connection_revision: 1,
        relay_public_key: RELAY_KEY,
        agent_id: input.agentId,
        operation_id: input.operationId,
        request_digest: input.requestDigest,
        public_key: input.publicKey,
        encrypted_private_key: input.encryptedPrivateKey,
        encrypted_invite_code: input.encryptedInviteCode,
        status: "claim_pending",
        claim_receipt: null,
        leave_receipt: null,
        health_receipt: null,
        last_health_at: null,
        last_error_code: null,
        lease_id: null,
        lease_expires_at: null,
        joined_at: null,
        revoked_at: null,
        runtime_status: "not_installed",
        runtime_operation_id: null,
        runtime_request_digest: null,
        runtime_provider: null,
        runtime_model: null,
        runtime_owner_public_key: null,
        encrypted_runtime_api_key: null,
        runtime_install_receipt: null,
        runtime_remove_receipt: null,
        runtime_last_observed_at: null,
        runtime_last_error_code: null,
        runtime_lease_id: null,
        runtime_lease_expires_at: null,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
      });
      return { status: "claim_pending", bindingId: id } as const;
    }),
    claimMembership: jest.fn(async (userId: string, id: string) => {
      const row = bindings.get(id);
      if (!row || row.user_id !== userId || row.status !== "claim_pending") return null;
      const leased = { ...row, lease_id: LEASE, lease_expires_at: "2026-09-01T00:01:00.000Z" };
      bindings.set(id, leased);
      return leased;
    }),
    settleMembership: jest.fn(async (userId: string, id: string, leaseId: string, receipt: unknown) => {
      const row = bindings.get(id);
      if (!row || row.user_id !== userId || leaseId !== LEASE) return false;
      bindings.set(id, { ...row, status: "joined", claim_receipt: receipt,
        encrypted_invite_code: null, lease_id: null, lease_expires_at: null,
        joined_at: "2026-09-01T00:00:02.000Z" });
      return true;
    }),
    abandonMembership: jest.fn(async (userId: string, id: string, leaseId: string, errorCode: string) => {
      const row = bindings.get(id);
      if (!row || row.user_id !== userId || leaseId !== LEASE) return false;
      bindings.set(id, { ...row, status: "revoked", encrypted_private_key: null,
        encrypted_invite_code: null, last_error_code: errorCode, lease_id: null,
        lease_expires_at: null, revoked_at: "2026-09-01T00:00:02.000Z" });
      return true;
    }),
    claimLeave: jest.fn(async (userId: string, id: string) => {
      const row = bindings.get(id);
      if (!row || row.user_id !== userId || row.status !== "joined") return null;
      const leased = { ...row, status: "leave_pending" as const, lease_id: LEASE,
        lease_expires_at: "2026-09-01T00:01:00.000Z" };
      bindings.set(id, leased);
      return leased;
    }),
    settleLeave: jest.fn(async (userId: string, id: string, leaseId: string, receipt: unknown) => {
      const row = bindings.get(id);
      if (!row || row.user_id !== userId || leaseId !== LEASE) return false;
      bindings.set(id, { ...row, status: "revoked", encrypted_private_key: null,
        encrypted_invite_code: null, lease_id: null, lease_expires_at: null,
        leave_receipt: receipt, revoked_at: "2026-09-01T00:00:03.000Z" });
      return true;
    }),
    confirmHealth: jest.fn(async () => true),
    runtimeAgent: jest.fn(async (userId: string, id: string) => {
      const row = agents.find((candidate) => candidate.id === id);
      if (!row || userId !== USER) return null;
      return {
        ...row, user_id: userId, ip: "10.241.30.40", vmid: 1112, operation_id: null, operation_kind: null,
        computer_substrate: "proxmox-kvm",
        provider_capacity_order_id: null, provider_enrollment_attempt_id: null, provider_server_id: null,
        deployment_mode: "hivra-managed", proxmox_host: "fixturenode1", infrastructure_connection_id: null,
        deployment_target_id: null, infrastructure_connection_revision: null,
        infrastructure_binding_token_hash: "9".repeat(64), infrastructure_binding_token_enforced: true,
      };
    }),
    beginRuntimeInstall: jest.fn(async (userId: string, input: {
      bindingId: string; operationId: string; requestDigest: string; provider: "openai" | "anthropic";
      model: string; ownerPublicKey: string; encryptedApiKey: string;
    }) => {
      const row = bindings.get(input.bindingId);
      if (!row || row.user_id !== userId || row.status !== "joined") return { status: "not_found" as const };
      if (row.runtime_status === "active") return { status: "active" as const, bindingId: row.id };
      if (row.runtime_status === "install_pending") {
        return row.runtime_operation_id === input.operationId && row.runtime_request_digest === input.requestDigest
          ? { status: "install_pending" as const, bindingId: row.id }
          : { status: "operation_conflict" as const, bindingId: row.id };
      }
      bindings.set(row.id, { ...row, runtime_status: "install_pending", runtime_operation_id: input.operationId,
        runtime_request_digest: input.requestDigest, runtime_provider: input.provider, runtime_model: input.model,
        runtime_owner_public_key: input.ownerPublicKey, encrypted_runtime_api_key: input.encryptedApiKey,
        runtime_install_receipt: null, runtime_remove_receipt: null });
      return { status: "install_pending" as const, bindingId: row.id };
    }),
    claimRuntimeInstall: jest.fn(async (userId: string, id: string) => {
      const row = bindings.get(id);
      if (!row || row.user_id !== userId || row.runtime_status !== "install_pending") return null;
      const leased = { ...row, runtime_lease_id: RUNTIME_LEASE,
        runtime_lease_expires_at: "2026-09-01T00:04:00.000Z" };
      bindings.set(id, leased);
      return leased;
    }),
    settleRuntimeInstall: jest.fn(async (userId: string, id: string, leaseId: string, receipt: unknown) => {
      const row = bindings.get(id);
      if (!row || row.user_id !== userId || leaseId !== RUNTIME_LEASE) return false;
      bindings.set(id, { ...row, runtime_status: "active", encrypted_runtime_api_key: null,
        runtime_install_receipt: receipt, runtime_lease_id: null, runtime_lease_expires_at: null,
        runtime_last_observed_at: "2026-09-01T00:00:04.000Z" });
      return true;
    }),
    claimRuntimeRemove: jest.fn(async (userId: string, id: string) => {
      const row = bindings.get(id);
      if (!row || row.user_id !== userId || ["not_installed", "removed"].includes(row.runtime_status)) return null;
      const leased = { ...row, runtime_status: "remove_pending" as const, runtime_lease_id: RUNTIME_LEASE,
        runtime_lease_expires_at: "2026-09-01T00:02:00.000Z" };
      bindings.set(id, leased);
      return leased;
    }),
    settleRuntimeRemove: jest.fn(async (userId: string, id: string, leaseId: string, receipt: unknown) => {
      const row = bindings.get(id);
      if (!row || row.user_id !== userId || leaseId !== RUNTIME_LEASE) return false;
      bindings.set(id, { ...row, runtime_status: "removed", encrypted_runtime_api_key: null,
        runtime_remove_receipt: receipt, runtime_lease_id: null, runtime_lease_expires_at: null,
        runtime_last_observed_at: "2026-09-01T00:00:05.000Z" });
      return true;
    }),
    confirmRuntimeHealth: jest.fn(async () => true),
  };
  return { store: store as unknown as BuzzStore, bindings };
}

function coordinatorFixture(overrides: Parameters<typeof createBuzzCoordinator>[0] = {}) {
  const fake = createFakeStore();
  const identities = [
    { privateKeyHex: PRIVATE_A, publicKeyHex: PUBLIC_A },
    { privateKeyHex: PRIVATE_B, publicKeyHex: PUBLIC_B },
  ];
  const claimInvite = jest.fn(async () => ({
    status: "joined" as const, communityId: "00000000-0000-4000-8000-000000001029",
    host: "buzz.example", role: "member" as const, publicKeyHex: PUBLIC_A,
  }));
  const leaveRelay = jest.fn(async () => ({ status: "left" as const, eventId: "d".repeat(64) }));
  const verifyMembership = jest.fn(async () => ({
    member: true,
    rosterEventId: "e".repeat(64),
    rosterCreatedAt: 100,
    relayPublicKey: RELAY_KEY,
  }));
  const installRuntime = jest.fn(async (_userId, _agent, input) => ({
    protocol: "hivra-buzz-runtime-v1" as const, action: "installed" as const, state: "active" as const,
    bindingId: input.bindingId, agentId: input.agentId, publicKey: input.publicKey,
    serviceName: `hivra-buzz-${input.bindingId}.service`, sourceGitSha: BUZZ_SPRIG_RELEASE.sourceGitSha,
    observedAt: "2026-09-01T00:00:04Z", architecture: "x86_64" as const,
    archiveSha256: BUZZ_SPRIG_RELEASE.targets.x86_64.archiveSha256,
    binarySha256: BUZZ_SPRIG_RELEASE.targets.x86_64.binarySha256,
    provider: input.provider, model: input.model, ownerPublicKey: input.ownerPublicKey,
    operationId: input.operationId, requestDigest: input.requestDigest, leaseId: input.leaseId, mainPid: 42,
  }));
  const observeRuntime = jest.fn(async (_userId, _agent, input) => ({
    protocol: "hivra-buzz-runtime-v1" as const, action: "observed" as const, state: "active" as const,
    bindingId: input.bindingId, agentId: input.agentId, publicKey: input.publicKey,
    serviceName: `hivra-buzz-${input.bindingId}.service`, sourceGitSha: BUZZ_SPRIG_RELEASE.sourceGitSha,
    observedAt: "2026-09-01T00:00:05Z", architecture: "x86_64" as const,
    binarySha256: BUZZ_SPRIG_RELEASE.targets.x86_64.binarySha256, mainPid: 42,
  }));
  const removeRuntime = jest.fn(async (_userId, _agent, input) => ({
    protocol: "hivra-buzz-runtime-v1" as const, action: "removed" as const, state: "absent" as const,
    bindingId: input.bindingId, agentId: input.agentId, publicKey: input.publicKey,
    serviceName: `hivra-buzz-${input.bindingId}.service`, sourceGitSha: BUZZ_SPRIG_RELEASE.sourceGitSha,
    observedAt: "2026-09-01T00:00:06Z", operationId: input.operationId,
    requestDigest: input.requestDigest, leaseId: input.leaseId,
  }));
  const coordinator = createBuzzCoordinator({
    store: fake.store,
    inspectRelay: jest.fn(async () => relay),
    claimInvite,
    verifyMembership,
    leaveRelay,
    encrypt: (value) => `sealed:${value}`,
    decrypt: (value) => value.replace(/^sealed:/, ""),
    generateIdentity: jest.fn(() => identities.shift()!),
    requestDigestKey: () => Buffer.alloc(32, 7),
    installRuntime: installRuntime as never,
    observeRuntime: observeRuntime as never,
    removeRuntime: removeRuntime as never,
    ...overrides,
  });
  return { ...fake, coordinator, claimInvite, leaveRelay, verifyMembership, installRuntime, observeRuntime, removeRuntime };
}

describe("Buzz connection coordinator", () => {
  it("pins an inspected relay identity before saving the connection", async () => {
    const { coordinator, store } = coordinatorFixture();
    const saved = await coordinator.connect(USER, "https://buzz.example");

    expect(saved.relayPublicKey).toBe(RELAY_KEY);
    expect(store.upsertConnection).toHaveBeenCalledWith(USER, expect.any(String), relay);
  });

  it("reuses one durable operation and identity after an uncertain relay failure", async () => {
    const claimInvite = jest.fn()
      .mockRejectedValueOnce(new BuzzRelayError("relay_unavailable"))
      .mockResolvedValueOnce({ status: "joined", communityId: "00000000-0000-4000-8000-000000001029",
        host: "buzz.example", role: "member", publicKeyHex: PUBLIC_A });
    const { coordinator, store, bindings } = coordinatorFixture({ claimInvite });

    await expect(coordinator.bind(USER, {
      connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "buzz-v2-secret",
    })).resolves.toEqual({ bindingId: BINDING_A, status: "pending", reason: "relay_unavailable" });
    await expect(coordinator.bind(USER, {
      connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "buzz-v2-secret",
    })).resolves.toEqual({ bindingId: BINDING_A, status: "joined" });

    expect(store.admit).toHaveBeenCalledTimes(1);
    expect(claimInvite).toHaveBeenCalledTimes(2);
    expect(claimInvite.mock.calls[0]?.[0]).toMatchObject({ privateKeyHex: PRIVATE_A, inviteCode: "buzz-v2-secret" });
    expect(claimInvite.mock.calls[1]?.[0]).toMatchObject({ privateKeyHex: PRIVATE_A, inviteCode: "buzz-v2-secret" });
    expect(bindings.get(BINDING_A)?.public_key).toBe(PUBLIC_A);
    expect(bindings.get(BINDING_A)?.encrypted_invite_code).toBeNull();
  });

  it("rejects reuse of an operation id for different request content", async () => {
    const claimInvite = jest.fn()
      .mockRejectedValueOnce(new BuzzRelayError("relay_unavailable"));
    const { coordinator, store } = coordinatorFixture({ claimInvite });
    await coordinator.bind(USER, {
      connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "original",
    });

    await expect(coordinator.bind(USER, {
      connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "changed",
    })).rejects.toEqual(expect.objectContaining({ code: "operation_conflict" }));
    expect(store.admit).toHaveBeenCalledTimes(1);
    expect(claimInvite).toHaveBeenCalledTimes(1);
  });

  it("creates a distinct signing identity for every bound agent", async () => {
    const { coordinator, bindings } = coordinatorFixture();
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "one" });
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_B, operationId: OP_B, inviteCode: "two" });

    expect(bindings.get(BINDING_A)?.public_key).toBe(PUBLIC_A);
    expect(bindings.get(BINDING_B)?.public_key).toBe(PUBLIC_B);
    expect(bindings.get(BINDING_A)?.public_key).not.toBe(bindings.get(BINDING_B)?.public_key);
  });

  it("revokes local custody after a definitive invite rejection", async () => {
    const { coordinator, store, bindings } = coordinatorFixture({
      claimInvite: jest.fn(async () => { throw new BuzzRelayError("invalid_invite"); }),
    });
    await expect(coordinator.bind(USER, {
      connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "bad",
    })).rejects.toMatchObject({ code: "invalid_invite" });

    expect(store.abandonMembership).toHaveBeenCalledWith(USER, BINDING_A, LEASE, "invalid_invite");
    expect(bindings.get(BINDING_A)?.encrypted_private_key).toBeNull();
    expect(bindings.get(BINDING_A)?.status).toBe("revoked");
  });

  it("uses a second admitted identity to verify signed absence before clearing private custody", async () => {
    const verifyMembership = jest.fn()
      .mockResolvedValueOnce({ member: true, rosterEventId: "e".repeat(64), rosterCreatedAt: 100, relayPublicKey: RELAY_KEY })
      .mockResolvedValueOnce({ member: true, rosterEventId: "f".repeat(64), rosterCreatedAt: 100, relayPublicKey: RELAY_KEY })
      .mockResolvedValueOnce({ member: false, rosterEventId: "9".repeat(64), rosterCreatedAt: 100, relayPublicKey: RELAY_KEY });
    const { coordinator, leaveRelay, bindings } = coordinatorFixture({ verifyMembership });
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "one" });
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_B, operationId: OP_B, inviteCode: "two" });
    await expect(coordinator.disconnect(USER, BINDING_A)).resolves.toEqual({ bindingId: BINDING_A, status: "revoked" });

    expect(leaveRelay).toHaveBeenCalledWith(expect.objectContaining({ privateKeyHex: PRIVATE_A }));
    expect(verifyMembership).toHaveBeenLastCalledWith(expect.objectContaining({
      privateKeyHex: PRIVATE_B,
      targetPublicKeyHex: PUBLIC_A,
    }));
    expect(bindings.get(BINDING_A)?.encrypted_private_key).toBeNull();
  });

  it("retains local custody when absence proof replays the claim roster event", async () => {
    const verifyMembership = jest.fn()
      .mockResolvedValueOnce({ member: true, rosterEventId: "e".repeat(64), rosterCreatedAt: 100, relayPublicKey: RELAY_KEY })
      .mockResolvedValueOnce({ member: true, rosterEventId: "f".repeat(64), rosterCreatedAt: 100, relayPublicKey: RELAY_KEY })
      .mockResolvedValueOnce({ member: false, rosterEventId: "e".repeat(64), rosterCreatedAt: 100, relayPublicKey: RELAY_KEY });
    const { coordinator, bindings } = coordinatorFixture({ verifyMembership });
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "one" });
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_B, operationId: OP_B, inviteCode: "two" });

    await expect(coordinator.disconnect(USER, BINDING_A)).resolves.toEqual({
      bindingId: BINDING_A,
      status: "pending",
      reason: "leave_unconfirmed",
    });
    expect(bindings.get(BINDING_A)?.status).toBe("leave_pending");
    expect(bindings.get(BINDING_A)?.encrypted_private_key).toBe("sealed:" + PRIVATE_A);
  });

  it("retains local custody when no second identity can verify the signed absence roster", async () => {
    const { coordinator, bindings } = coordinatorFixture();
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "one" });

    await expect(coordinator.disconnect(USER, BINDING_A)).resolves.toEqual({
      bindingId: BINDING_A,
      status: "pending",
      reason: "absence_proof_unavailable",
    });
    expect(bindings.get(BINDING_A)?.status).toBe("leave_pending");
    expect(bindings.get(BINDING_A)?.encrypted_private_key).toBe("sealed:" + PRIVATE_A);
  });

  it("does not settle a claim from evidence signed by a different relay identity", async () => {
    const { coordinator, bindings } = coordinatorFixture({
      verifyMembership: jest.fn(async () => ({
        member: true,
        rosterEventId: "e".repeat(64),
        rosterCreatedAt: 100,
        relayPublicKey: "9".repeat(64),
      })),
    });
    await expect(coordinator.bind(USER, {
      connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "one",
    })).resolves.toEqual({ bindingId: BINDING_A, status: "pending", reason: "membership_unconfirmed" });
    expect(bindings.get(BINDING_A)?.encrypted_invite_code).toBe("sealed:one");
  });

  it("never exposes private key or invite ciphertext in the public summary", async () => {
    const { coordinator } = coordinatorFixture();
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "top-secret" });
    const summary = await coordinator.summary(USER);
    const serialized = JSON.stringify(summary);

    expect(summary.bindings[0]).toMatchObject({ publicKey: PUBLIC_A, runtimeAdapter: "not_installed" });
    expect(serialized).not.toContain(PRIVATE_A);
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("sealed:");
  });

  it("activates the pinned Buzz sidecar and clears provider-key custody after settlement", async () => {
    const { coordinator, store, bindings, installRuntime } = coordinatorFixture();
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "one" });

    await expect(coordinator.activateRuntime(USER, BINDING_A, {
      operationId: RUNTIME_OP, provider: "openai", model: "gpt-5", apiKey: "sk-buzz-test",
      ownerPublicKey: "d".repeat(64),
    })).resolves.toEqual({ bindingId: BINDING_A, status: "active" });

    expect(installRuntime).toHaveBeenCalledWith(USER, expect.objectContaining({ id: AGENT_A }),
      expect.objectContaining({ apiKey: "sk-buzz-test", privateKey: PRIVATE_A, ownerPublicKey: "d".repeat(64) }));
    expect(store.settleRuntimeInstall).toHaveBeenCalled();
    expect(bindings.get(BINDING_A)).toMatchObject({ runtime_status: "active", encrypted_runtime_api_key: null });
    expect(JSON.stringify(await coordinator.summary(USER))).not.toContain("sk-buzz-test");
  });

  it("resolves a saved Venice key server-side without requiring browser custody", async () => {
    const resolveVaultCredential = jest.fn(async () => "venice-vault-secret");
    const { coordinator, installRuntime } = coordinatorFixture({ resolveVaultCredential });
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "one" });

    await expect(coordinator.activateRuntime(USER, BINDING_A, {
      operationId: RUNTIME_OP, provider: "venice", model: "qwen3-4b",
      ownerPublicKey: "d".repeat(64),
    })).resolves.toEqual({ bindingId: BINDING_A, status: "active" });

    expect(resolveVaultCredential).toHaveBeenCalledWith(USER, "venice");
    expect(installRuntime).toHaveBeenCalledWith(USER, expect.anything(), expect.objectContaining({
      provider: "venice", apiKey: "venice-vault-secret", model: "qwen3-4b",
    }));
    expect(JSON.stringify(await coordinator.summary(USER))).not.toContain("venice-vault-secret");
  });

  it("fails closed when the account has no usable Venice key", async () => {
    const { coordinator } = coordinatorFixture({ resolveVaultCredential: jest.fn(async () => null) });
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "one" });
    await expect(coordinator.activateRuntime(USER, BINDING_A, {
      operationId: RUNTIME_OP, provider: "venice", model: "qwen3-4b",
      ownerPublicKey: "d".repeat(64),
    })).rejects.toEqual(expect.objectContaining({ code: "runtime_credential_unavailable" }));
  });

  it("keeps a write-only provider key only while an ambiguous install can be resumed", async () => {
    const installRuntime = jest.fn(async () => { throw new BuzzRuntimeControlError("outcome_unknown"); });
    const { coordinator, bindings } = coordinatorFixture({ installRuntime: installRuntime as never });
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "one" });

    await expect(coordinator.activateRuntime(USER, BINDING_A, {
      operationId: RUNTIME_OP, provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "sk-ant-test",
      ownerPublicKey: "d".repeat(64),
    })).resolves.toEqual({ bindingId: BINDING_A, status: "install_pending", reason: "outcome_unknown" });

    expect(bindings.get(BINDING_A)).toMatchObject({
      runtime_status: "install_pending", encrypted_runtime_api_key: "sealed:sk-ant-test",
    });
  });

  it("removes the in-guest runtime before leaving the relay and clearing identity custody", async () => {
    const order: string[] = [];
    const removeRuntime = jest.fn(async (_userId, _agent, input) => {
      order.push("runtime");
      return {
        protocol: "hivra-buzz-runtime-v1" as const, action: "removed" as const, state: "absent" as const,
        bindingId: input.bindingId, agentId: input.agentId, publicKey: input.publicKey,
        serviceName: `hivra-buzz-${input.bindingId}.service`, sourceGitSha: BUZZ_SPRIG_RELEASE.sourceGitSha,
        observedAt: "2026-09-01T00:00:06Z", operationId: input.operationId,
        requestDigest: input.requestDigest, leaseId: input.leaseId,
      };
    });
    const leaveRelay = jest.fn(async () => {
      order.push("relay");
      return { status: "left" as const, eventId: "d".repeat(64) };
    });
    const verifyMembership = jest.fn()
      .mockResolvedValueOnce({ member: true, rosterEventId: "e".repeat(64), rosterCreatedAt: 100, relayPublicKey: RELAY_KEY })
      .mockResolvedValueOnce({ member: true, rosterEventId: "f".repeat(64), rosterCreatedAt: 100, relayPublicKey: RELAY_KEY })
      .mockResolvedValueOnce({ member: false, rosterEventId: "9".repeat(64), rosterCreatedAt: 101, relayPublicKey: RELAY_KEY });
    const { coordinator } = coordinatorFixture({ removeRuntime: removeRuntime as never, leaveRelay, verifyMembership });
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "one" });
    await coordinator.bind(USER, { connectionId: CONNECTION, agentId: AGENT_B, operationId: OP_B, inviteCode: "two" });
    await coordinator.activateRuntime(USER, BINDING_A, {
      operationId: RUNTIME_OP, provider: "openai", model: "gpt-5", apiKey: "sk-buzz-test",
      ownerPublicKey: "d".repeat(64),
    });

    await expect(coordinator.disconnect(USER, BINDING_A)).resolves.toEqual({ bindingId: BINDING_A, status: "revoked" });
    expect(order).toEqual(["runtime", "relay"]);
  });

  it("maps a corrupt saved identity to configuration unavailable", async () => {
    const { coordinator } = coordinatorFixture({
      claimInvite: jest.fn(async () => { throw new BuzzRelayError("invalid_identity"); }),
    });
    await expect(coordinator.bind(USER, {
      connectionId: CONNECTION, agentId: AGENT_A, operationId: OP_A, inviteCode: "one",
    })).rejects.toEqual(expect.objectContaining({ code: "configuration_unavailable" }));
  });
});
