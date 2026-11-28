import { advancePortableKvmIdleHandoff, requestPortableKvmOwnerWake, type PortableKvmHandoff, type PortableKvmWakeDriver } from "../handoff";

jest.mock("server-only", () => ({}));

const owner = "user_fixture";
const id = "11111111-1111-4111-8111-111111111111";
const operation = "22222222-2222-4222-8222-222222222222";
const hostA = { hostId: "qa-host-a", vmid: 9344, ip: "192.0.2.44" };
const hostB = { hostId: "qa-host-b", vmid: 9388, ip: "192.0.2.88" };
const tag = { bindingTag: "hivra-bind-" + "a".repeat(32) };
const source = { ...hostA, ...tag };
const destination = { ...hostB, ...tag };
const configuration = { sha256: "a".repeat(64), snapshotId: "b".repeat(64) };
const disk = { key: "scsi0" as const, sha256: "c".repeat(64), snapshotId: "d".repeat(64), bytes: 4096 };
const checkpointSha256 = "e".repeat(64);
const originalEnv = process.env;
const pilot = () => ({ ownerId: owner, agentId: id, placements: [source, destination] as [typeof source, typeof destination],
  profile: {}, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

beforeEach(() => {
  process.env = {
    ...originalEnv, VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
    VERCEL_GIT_COMMIT_REF: "canary", VERCEL_GIT_REPO_OWNER: "ashneil12", VERCEL_GIT_REPO_SLUG: "hivra",
  };
});

afterEach(() => { process.env = originalEnv; });

function agent(claimed = false, committed = false) {
  const placement = committed ? hostB : hostA;
  return {
    id, user_id: owner, proxmox_host: placement.hostId, vmid: placement.vmid, ip: placement.ip,
    infrastructure_binding_token_enforced: true, infrastructure_binding_token_hash: "a".repeat(64),
    deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", seat_funding: "paid", type: "codex",
    status: "running", desired_state: "running", sleep_policy: "full", always_on: false,
    sleep_state: claimed ? "waking" : "hibernated", sleep_generation: claimed ? 3 : 2,
    sleep_tier_changed_at: "2026-11-27T18:00:00.000Z", sleep_memory_dropped_at: "2026-11-27T18:01:00.000Z",
    operation_id: claimed ? operation : null, operation_kind: claimed ? "wake" : null,
    operation_payload: claimed ? { portable_kvm: true } : null,
  };
}

function lease(phase: PortableKvmHandoff["phase"], requested = phase !== "checkpointing") {
  return { owner_id: owner, agent_id: id, operation_id: operation, generation: 3, source, destination,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(), phase,
    wake_requested_at: requested ? new Date().toISOString() : null,
    checkpoint_sha256: phase === "checkpointing" ? null : checkpointSha256,
    storage_evidence: phase === "checkpointing" ? null : { configuration, disk },
    destination_evidence: { bootId: operation, reservationSha256: checkpointSha256 },
    connector_evidence: phase === "connector_verified" ? { bootId: operation, connectorId: id } : null,
  };
}

function driver(phase: PortableKvmHandoff["phase"] = "checkpointing", next = phase) {
  return {
    rpc: jest.fn().mockImplementation(async name => lease(name.startsWith("read_") ? phase : next)),
    preflight: jest.fn().mockResolvedValue(true),
    checkpoint: jest.fn().mockResolvedValue({ configuration, disk, checkpointSha256 }),
    verifyFencedSource: jest.fn().mockResolvedValue(true),
    restoreAndColdBoot: jest.fn().mockResolvedValue({ bootId: operation, reservationSha256: checkpointSha256 }),
    verifyQuarantinedDestination: jest.fn().mockResolvedValue(true),
    enableDestinationConnector: jest.fn().mockResolvedValue({ bootId: operation, connectorId: id }),
    releaseDestinationLock: jest.fn().mockResolvedValue(true),
  } satisfies PortableKvmWakeDriver;
}

it("never admits a wrong owner, no opt-in, or a non-Canary deployment", async () => {
  const d = driver();
  await expect(advancePortableKvmIdleHandoff("other", agent(), pilot(), d)).resolves.toBeNull();
  await expect(advancePortableKvmIdleHandoff(owner, { ...agent(), sleep_policy: "off" }, pilot(), d)).resolves.toBeNull();
  process.env.VERCEL_PROJECT_PRODUCTION_URL = "hivra.cloud";
  await expect(advancePortableKvmIdleHandoff(owner, agent(), pilot(), d)).resolves.toBeNull();
  expect(d.rpc).not.toHaveBeenCalled();
  expect(d.preflight).not.toHaveBeenCalled();
});

it("refuses before a claim when source or destination preflight cannot prove compatibility", async () => {
  const d = driver();
  d.preflight.mockResolvedValue(false);
  await expect(advancePortableKvmIdleHandoff(owner, agent(), pilot(), d)).resolves.toEqual({
    state: "failed", reason: "portable_kvm_preflight_refused",
  });
  expect(d.rpc).not.toHaveBeenCalled();
});

it("claims the exact two pinned placements after preflight and supports the inverse placement", async () => {
  const d = driver();
  await expect(advancePortableKvmIdleHandoff(owner, agent(false, true), pilot(), d)).resolves.toMatchObject({ state: "waking" });
  expect(d.rpc).toHaveBeenCalledWith("begin_hivra_kvm_portable_handoff", expect.objectContaining({
    p_owner_id: owner, p_agent_id: id, p_source: destination, p_destination: source, p_expected_generation: 2,
  }));
  expect(d.enableDestinationConnector).not.toHaveBeenCalled();
});

it("does not fall through when a claimed operation loses its runtime pilot or lease expires", async () => {
  const d = driver();
  await expect(advancePortableKvmIdleHandoff(owner, agent(true), null, d)).resolves.toMatchObject({ state: "failed" });
  expect(d.rpc).not.toHaveBeenCalled();
  d.rpc.mockResolvedValue({ ...lease("checkpointing"), expires_at: "2024-01-01T00:00:00Z" });
  await expect(advancePortableKvmIdleHandoff(owner, agent(true), pilot(), d)).resolves.toMatchObject({ state: "failed" });
  expect(d.checkpoint).not.toHaveBeenCalled();
});

it("persists the exact immutable artifact only while the source is fenced", async () => {
  const d = driver("checkpointing", "storage_verified");
  await expect(advancePortableKvmIdleHandoff(owner, agent(true), pilot(), d)).resolves.toMatchObject({ state: "waking" });
  expect(d.rpc).toHaveBeenLastCalledWith("advance_hivra_kvm_portable_handoff", expect.objectContaining({
    p_operation_id: operation, p_generation: 3, p_action: "verify_storage",
    p_evidence: { source, sourceStopped: true, sourceFenced: true, sourceConnectorOff: true,
      storageReadbackVerified: true, configuration, disk, checkpointSha256 },
  }));
});

it("checks source fencing and destination quarantine before CAS, without enabling networking", async () => {
  const d = driver("destination_verified", "placement_committed");
  await expect(advancePortableKvmIdleHandoff(owner, agent(true), pilot(), d)).resolves.toMatchObject({ state: "waking" });
  expect(d.verifyFencedSource).toHaveBeenCalledTimes(1);
  expect(d.verifyQuarantinedDestination).toHaveBeenCalledTimes(1);
  expect(d.enableDestinationConnector).not.toHaveBeenCalled();
  expect(d.rpc).toHaveBeenLastCalledWith("advance_hivra_kvm_portable_handoff", expect.objectContaining({ p_action: "commit_placement" }));
});

it("never unlocks destination traffic for stale source placement or an unproven destination connector", async () => {
  const d = driver("placement_committed", "connector_verified");
  await expect(advancePortableKvmIdleHandoff(owner, agent(true), pilot(), d)).resolves.toMatchObject({ state: "failed" });
  expect(d.enableDestinationConnector).not.toHaveBeenCalled();
  d.enableDestinationConnector.mockResolvedValue(null);
  await expect(advancePortableKvmIdleHandoff(owner, agent(true, true), pilot(), d)).resolves.toMatchObject({ state: "waking" });
  expect(d.rpc).toHaveBeenLastCalledWith("read_hivra_kvm_portable_handoff", { p_owner_id: owner, p_agent_id: id });
  d.enableDestinationConnector.mockResolvedValue({ bootId: operation, connectorId: id });
  await expect(advancePortableKvmIdleHandoff(owner, agent(true, true), pilot(), d)).resolves.toMatchObject({ state: "waking" });
  expect(d.releaseDestinationLock).not.toHaveBeenCalled();
  const ready = driver("connector_verified", "finished");
  await expect(advancePortableKvmIdleHandoff(owner, agent(true, true), pilot(), ready)).resolves.toMatchObject({ state: "awake" });
  expect(ready.enableDestinationConnector).not.toHaveBeenCalled();
  expect(ready.releaseDestinationLock).toHaveBeenCalledTimes(1);
});

it("pre-stages but never claims a restore without a signed-in request", async () => {
  const d = driver("storage_verified");
  d.rpc.mockResolvedValue(lease("storage_verified", false));
  await expect(advancePortableKvmIdleHandoff(owner, agent(true), pilot(), d)).resolves.toMatchObject({ state: "waking" });
  expect(d.rpc).toHaveBeenCalledTimes(1);
  expect(d.restoreAndColdBoot).not.toHaveBeenCalled();
});

it("the signed-in wake only records authority and never starts a checkpoint", async () => {
  const d = driver("checkpointing");
  await expect(requestPortableKvmOwnerWake(owner, agent(), pilot(), d.rpc)).resolves.toBeNull();
  expect(d.rpc).not.toHaveBeenCalled();
  d.rpc.mockImplementation(async name => lease("checkpointing", name.startsWith("request_")));
  await expect(requestPortableKvmOwnerWake(owner, { ...agent(true), sleep_state: "hibernated" }, pilot(), d.rpc))
    .resolves.toMatchObject({ state: "waking" });
  expect(d.rpc).toHaveBeenLastCalledWith("request_hivra_kvm_portable_wake", {
    p_owner_id: owner, p_agent_id: id, p_operation_id: operation, p_generation: 3,
  });
  expect(d.checkpoint).not.toHaveBeenCalled();
  expect(d.restoreAndColdBoot).not.toHaveBeenCalled();
});
