/** @jest-environment node */
jest.mock("server-only", () => ({}));

import { receiverFixture } from "@/lib/infrastructure/__tests__/first-boot-receiver.fixtures";
import type { HetznerCloudProjectClient, HetznerServer } from "@/lib/hetzner/client";
import type { StoredProviderResizeOperation } from "../provider-agent-resize-store";
import { inspectProviderResizeReadiness } from "../provider-resize-readiness";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPERATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = "2026-09-05T08:30:00.000Z";
const BOOT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function harness() {
  const fixture = receiverFixture(), b = fixture.binding;
  const input = { userId: "owner", agentId: AGENT, operationId: OPERATION, dispatchDeadlineMs: 30_000 };
  const target = { serverTypeId: 105, serverType: "cpx32", architecture: "x86", cores: 4, memoryGb: 8,
    advertisedDiskGb: 160, cpuType: "shared" };
  // Store authority/parsing has separate regressions. This adapter consumes its
  // trusted return shape, but every live server check below remains real.
  const operation = {
    input: { userId: "owner", agentId: AGENT, operationId: OPERATION }, stage: "provider_pending",
    providerPostAttemptedAt: NOW, shutdownAttemptedAt: null, sourceShapeFingerprint: "a".repeat(64),
    quote: { operationId: OPERATION, agentId: AGENT, providerServerId: "42", target, existingDiskGb: 80 },
    action: { id: 700, command: "change_server_type", status: "success", resources: [{ id: 42, type: "server" }] },
    authority: {
      agent: { id: AGENT, user_id: "owner", status: "provisioning", desired_state: "stopped",
        operation_id: OPERATION, operation_kind: "resize", infrastructure_connection_id: b.connectionId,
        infrastructure_connection_revision: 7, provider_capacity_order_id: b.orderId,
        provider_enrollment_attempt_id: b.attemptId, provider_server_id: "42", deployment_target_id: TARGET,
        allocation_operation_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      order: { ...fixture.evidence, server_name: fixture.server.name }, target: { id: TARGET },
    },
  } as unknown as StoredProviderResizeOperation;
  const enrollment = { ...fixture.stored, phase: "enrolled" as const,
    enrolledHostPublicKey: fixture.host.publicKey, hostFingerprintSha256: fixture.host.fingerprintSha256 };
  const server = { ...fixture.server, labels: fixture.evidence.provider_labels, locked: false, primary_disk_size: 80,
    server_type: { ...fixture.server.server_type, id: 105, name: "cpx32", architecture: "x86", cores: 4,
      memory: 8, disk: 160, cpu_type: "shared" },
  } as HetznerServer;
  let elapsed = 0;
  const provider = { getServer: jest.fn(async () => server) };
  const deps = {
    load: jest.fn(async () => structuredClone(operation)), enrollment: jest.fn(async () => enrollment),
    secret: jest.fn(async () => ({ connection: { id: b.connectionId, status: "ready" }, revision: 7, apiToken: "fixture-token" }) as never),
    bootstrap: jest.fn(async () => ({ publicKeyOpenSsh: "original-admin-public", privateKeyOpenSsh: "original-admin-private" }) as never),
    client: jest.fn(() => provider as unknown as HetznerCloudProjectClient),
    inspect: jest.fn(async () => ({ hostVerified: true as const, administratorAuthenticated: true as const,
      hostFingerprintSha256: fixture.host.fingerprintSha256,
      receipt: { version: 1 as const, ready: true as const, bootId: BOOT, powerHandlerPid: 649 } })),
    now: () => new Date(NOW), monotonicNow: () => elapsed,
  };
  return { input, operation, enrollment, server, provider, deps, fixture, advance: (ms: number) => { elapsed = ms; } };
}

describe("owner-bound resize readiness adapter", () => {
  it("checks the journal target, not the still-recorded source shape, through the original pin", async () => {
    const f = harness();
    await expect(inspectProviderResizeReadiness(f.input, f.deps)).resolves.toEqual({ observedAt: NOW,
      hostFingerprintSha256: f.fixture.host.fingerprintSha256,
      receipt: { version: 1, ready: true, bootId: BOOT, powerHandlerPid: 649 } });
    expect(f.deps.bootstrap).toHaveBeenCalledWith({ userId: "owner", connectionId: f.fixture.binding.connectionId,
      expectedRevision: 7, orderId: f.fixture.binding.orderId, idempotencyKey: f.enrollment.capacityIdempotencyKey,
      quoteFingerprintSha256: f.fixture.binding.quoteFingerprint });
    expect(f.deps.inspect).toHaveBeenCalledWith({ address: f.fixture.evidence.provider_creation_receipt.primaryIpv4.ip,
      hostPublicKey: f.fixture.host.publicKey, administratorPublicKey: "original-admin-public",
      administratorPrivateKey: "original-admin-private", dispatchDeadlineMs: 30_000 }, { monotonicNow: f.deps.monotonicNow });
    expect(f.deps.load).toHaveBeenCalledTimes(3);
  });

  it("returns an honest early-boot receipt without consuming a power grant", async () => {
    const f = harness();
    f.deps.inspect.mockResolvedValue({ hostVerified: true, administratorAuthenticated: true,
      hostFingerprintSha256: f.fixture.host.fingerprintSha256, receipt: { version: 1, ready: false } } as never);
    await expect(inspectProviderResizeReadiness(f.input, f.deps)).resolves.toMatchObject({ receipt: { ready: false } });
    expect(f.deps.inspect).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "lease", "stage", "delete", "shutdown", "action"])("rejects changed %s before credentials or SSH", async (change) => {
    const f = harness(), a = f.operation.authority.agent;
    if (change === "owner") a.user_id = "someone-else";
    if (change === "lease") a.operation_id = TARGET;
    if (change === "stage") f.operation.stage = "manual_attention";
    if (change === "delete") a.desired_state = "deleted";
    if (change === "shutdown") f.operation.shutdownAttemptedAt = NOW;
    if (change === "action") f.operation.action!.status = "running";
    await expect(inspectProviderResizeReadiness(f.input, f.deps)).rejects.toMatchObject({ code: "rejected" });
    expect(f.deps.secret).not.toHaveBeenCalled(); expect(f.deps.inspect).not.toHaveBeenCalled();
  });

  it.each(["owner", "connection", "revision", "order", "attempt", "quote", "pin", "revoked", "server"])("rejects enrollment %s mismatch", async (change) => {
    const f = harness(), b = f.enrollment.challenge.binding;
    if (change === "owner") b.userId = "another-owner";
    if (change === "connection") b.connectionId = TARGET;
    if (change === "revision") b.connectionRevision++;
    if (change === "order") b.orderId = TARGET;
    if (change === "attempt") b.attemptId = TARGET;
    if (change === "quote") b.quoteFingerprint = "b".repeat(64);
    if (change === "pin") f.enrollment.hostFingerprintSha256 = "SHA256:wrong";
    if (change === "revoked") f.deps.enrollment.mockResolvedValue({ ...f.enrollment, phase: "revoked" } as never);
    if (change === "server") f.enrollment.providerServerId = "43";
    await expect(inspectProviderResizeReadiness(f.input, f.deps)).rejects.toMatchObject({ code: "rejected" });
    expect(f.deps.bootstrap).not.toHaveBeenCalled(); expect(f.deps.inspect).not.toHaveBeenCalled();
  });

  it.each(["id", "name", "ipv4", "ipv6", "labels", "type", "disk", "image", "off", "locked"])("rejects changed live %s before SSH", async (change) => {
    const f = harness(), s = f.server;
    if (change === "id") s.id++;
    if (change === "name") s.name = "other-server";
    if (change === "ipv4") s.public_net.ipv4!.ip = "8.8.8.8";
    if (change === "ipv6") s.public_net.ipv6!.id = Number(s.public_net.ipv6!.id) + 1;
    if (change === "labels") s.labels = {};
    if (change === "type") s.server_type.cores = 2;
    if (change === "disk") s.primary_disk_size = 160;
    if (change === "image") s.image!.id++;
    if (change === "off") s.status = "off";
    if (change === "locked") s.locked = true;
    await expect(inspectProviderResizeReadiness(f.input, f.deps)).rejects.toMatchObject({ code: "rejected" });
    expect(f.deps.inspect).not.toHaveBeenCalled();
  });

  it("rechecks the retained lease before SSH and after the receipt", async () => {
    for (const read of [2, 3]) {
      const f = harness();
      let reads = 0;
      f.deps.load.mockImplementation(async () => {
        const op = structuredClone(f.operation);
        if (++reads === read) op.authority.agent.desired_state = "deleted";
        return op;
      });
      await expect(inspectProviderResizeReadiness(f.input, f.deps)).rejects.toMatchObject({ code: "rejected" });
      expect(f.deps.inspect).toHaveBeenCalledTimes(read === 2 ? 0 : 1);
    }
  });

  it("rejects elapsed deadlines, unauthenticated receipts and wrong pins", async () => {
    for (const change of ["deadline", "authentication", "pin"]) {
      const f = harness();
      f.deps.inspect.mockImplementation(async () => {
        if (change === "deadline") f.advance(30_000);
        return { hostVerified: true, administratorAuthenticated: change !== "authentication",
          hostFingerprintSha256: change === "pin" ? "SHA256:wrong" : f.fixture.host.fingerprintSha256,
          receipt: { version: 1, ready: true, bootId: BOOT, powerHandlerPid: 649 } } as never;
      });
      await expect(inspectProviderResizeReadiness(f.input, f.deps)).rejects.toMatchObject({
        code: change === "deadline" ? "deadline_expired" : "verification_failed" });
    }
  });
});
