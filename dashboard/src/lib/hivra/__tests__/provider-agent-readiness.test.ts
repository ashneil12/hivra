import { advanceProviderAgentReadiness, type loadProviderAgentReadinessContext } from "../provider-agent-readiness";
import { receiverFixture } from "@/lib/infrastructure/__tests__/first-boot-receiver.fixtures";
import { providerGuestBundleScopeSha256 } from "@/lib/infrastructure/provider-guest-bundle";
import type { advanceProviderAgentInstaller } from "../provider-agent-installer";
import type { inspectProviderGuestRuntime } from "@/lib/infrastructure/first-boot-ssh";
import type { FirstBootOperation } from "@/lib/infrastructure/first-boot-operations";

function setup() {
  const f = receiverFixture(), input = { userId: f.binding.userId, agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const scope = { binding: f.binding, providerServerId: "42" };
  const identity = { version: 1 as const, agentId: input.agentId, operationId: input.operationId,
    bundle: { version: 1 as const, state: "bundle_installed" as const, scopeSha256: providerGuestBundleScopeSha256(scope),
      bundleSha256: "a".repeat(64), provisionerVersion: "2026.08.28.1" as const } };
  const context: Awaited<ReturnType<typeof loadProviderAgentReadinessContext>> = { operation: input, scope,
    targetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", runtime: "codex", desiredState: "running",
    accessMode: "cloudflare-named", tunnelId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    hostname: "box-fixture.hermesos.cloud", identity,
    stoppedAt: "2026-08-28T00:01:00Z", outcome: "succeeded" };
  let elapsed = 0;
  const deps = {
    load: jest.fn(async () => structuredClone(context)),
    installer: jest.fn<ReturnType<typeof advanceProviderAgentInstaller>, [unknown]>(async () => ({ stage: "worker_observed", state: "succeeded", stopped: true })),
    boot: jest.fn(async () => ({ ...scope } as FirstBootOperation)),
    verify: jest.fn(async () => ({ stage: "provider_verified" as const, scope, address: "203.0.113.10",
      hostPublicKey: f.host.publicKey, hostFingerprintSha256: f.host.fingerprintSha256,
      capacityIdempotencyKey: f.stored.capacityIdempotencyKey, observedAt: "2026-08-28T00:02:00Z",
      powerOnAction: { id: 603, command: "start_server" as const, status: "success" as const, resources: [{ id: 42, type: "server" as const }] } })),
    bootstrap: jest.fn(async () => ({ publicKeyOpenSsh: "public-fixture", privateKeyOpenSsh: "private-fixture" }) as Awaited<ReturnType<typeof import("@/lib/infrastructure/hetzner-cloud-store").loadHetznerCloudCapacityBootstrap>>),
    inspect: jest.fn<ReturnType<typeof inspectProviderGuestRuntime>, [unknown]>(async () => ({ hostVerified: true, administratorAuthenticated: true,
      hostFingerprintSha256: f.host.fingerprintSha256, receipt: { version: 1, ready: true, identity, runtime: "codex", apiToken: "b".repeat(64) } })),
    publicReady: jest.fn(async () => true), complete: jest.fn(async () => true), release: jest.fn(async () => true),
    expireUnstarted: jest.fn(async () => false),
    monotonicNow: () => elapsed, now: () => new Date("2026-08-28T00:03:00Z"),
  };
  return { f, input, scope, context, identity, deps, advance: (ms: number) => { elapsed = ms; } };
}

it("uses the exact existing operation, pinned guest and public gate before shared terminal convergence", async () => {
  const h = setup();
  expect(await advanceProviderAgentReadiness(h.input, h.deps)).toBe("running");
  expect(h.deps.installer).toHaveBeenCalledWith({ ...h.input, action: "status" });
  expect(h.deps.bootstrap).toHaveBeenCalledWith({ userId: h.input.userId, connectionId: h.f.binding.connectionId,
    expectedRevision: 7, orderId: h.f.binding.orderId, idempotencyKey: h.f.stored.capacityIdempotencyKey,
    quoteFingerprintSha256: h.f.binding.quoteFingerprint });
  expect(h.deps.inspect).toHaveBeenCalledWith(expect.objectContaining({ identity: h.identity, scope: h.scope,
    administratorPrivateKey: "private-fixture", hostPublicKey: h.f.host.publicKey }), expect.any(Object));
  expect(h.deps.complete).toHaveBeenCalledWith({ ...h.input, operationKind: "provision", chatUrl: "https://box-fixture.hermesos.cloud",
    ip: "203.0.113.10", apiToken: "b".repeat(64), provisionedAt: "2026-08-28T00:03:00.000Z" });
  expect(h.deps.publicReady.mock.invocationCallOrder[0]).toBeLessThan(h.deps.complete.mock.invocationCallOrder[0]);
  expect(h.deps.release).not.toHaveBeenCalled();
});
it("marks an unstarted launch failed only when the database closes the original dispatch window", async () => {
  const h = setup(); h.deps.installer.mockResolvedValue({ stage: "not_dispatched" }); h.deps.expireUnstarted.mockResolvedValue(true);
  expect(await advanceProviderAgentReadiness(h.input, h.deps)).toBe("failed");
  expect(h.deps.expireUnstarted).toHaveBeenCalledWith(h.input);
  expect(h.deps.release).not.toHaveBeenCalled(); expect(h.deps.complete).not.toHaveBeenCalled();
});
it.each(["not_dispatched", "running", "stopping", "unknown"] as const)("never treats installer %s as runtime readiness", async state => {
  const h = setup(); h.deps.installer.mockResolvedValue(state === "not_dispatched" ? { stage: state }
    : { stage: "worker_observed", state, stopped: false });
  expect(await advanceProviderAgentReadiness(h.input, h.deps)).toBe("installer_pending");
  for (const unused of [h.deps.bootstrap, h.deps.inspect, h.deps.publicReady, h.deps.complete, h.deps.release]) expect(unused).not.toHaveBeenCalled();
});
it.each(["failed", "cancelled"] as const)("marks an exactly stopped %s installer as failed without deleting its computer or access", async state => {
  const h = setup(); h.context.outcome = state; h.deps.installer.mockResolvedValue({ stage: "worker_observed", state, stopped: true });
  expect(await advanceProviderAgentReadiness(h.input, h.deps)).toBe("failed");
  expect(h.deps.release).toHaveBeenCalledWith(expect.objectContaining({ ...h.input, markError: true }));
  expect(h.deps.inspect).not.toHaveBeenCalled(); expect(h.deps.complete).not.toHaveBeenCalled();
});
it("does not release a failed installer whose terminal journal does not match", async () => {
  const h = setup(); h.deps.installer.mockResolvedValue({ stage: "worker_observed", state: "failed", stopped: true });
  await expect(advanceProviderAgentReadiness(h.input, h.deps)).rejects.toThrow("could not be verified");
  expect(h.deps.release).not.toHaveBeenCalled();
});
it.each([1, 2, 3])("honors deletion intent on read %s without completing or relaunching", async at => {
  const h = setup(); let call = 0;
  h.deps.load.mockImplementation(async () => ({ ...structuredClone(h.context), desiredState: ++call >= at ? "deleted" : "running" }));
  expect(await advanceProviderAgentReadiness(h.input, h.deps)).toBe("cancellation_pending");
  expect(h.deps.complete).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
it.each(["hostname", "tunnelId", "targetId", "identity", "scope"])("rejects changed %s before publishing readiness", async field => {
  const h = setup(); let call = 0;
  h.deps.load.mockImplementation(async () => {
    const next = structuredClone(h.context);
    if (++call === 3) {
      if (field === "identity") next.identity = { ...h.identity, bundle: { ...h.identity.bundle, bundleSha256: "e".repeat(64) } };
      else if (field === "scope") next.scope.providerServerId = "43";
      else Object.assign(next, { [field]: "changed" });
    }
    return next;
  });
  await expect(advanceProviderAgentReadiness(h.input, h.deps)).rejects.toThrow("could not be verified");
  expect(h.deps.complete).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
it("retains the operation if local services or authentication are not ready", async () => {
  const h = setup(); h.deps.inspect.mockResolvedValue({ hostVerified: true, administratorAuthenticated: true,
    hostFingerprintSha256: h.f.host.fingerprintSha256, receipt: { version: 1, ready: false, identity: h.identity, runtime: "codex", reason: "authentication_unverified" } });
  expect(await advanceProviderAgentReadiness(h.input, h.deps)).toBe("runtime_pending");
  expect(h.deps.publicReady).not.toHaveBeenCalled(); expect(h.deps.complete).not.toHaveBeenCalled();
});
it("retains an installed computer when the public route is unavailable", async () => {
  const h = setup(); h.deps.publicReady.mockResolvedValue(false);
  expect(await advanceProviderAgentReadiness(h.input, h.deps)).toBe("public_access_pending");
  expect(h.deps.complete).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
it.each(["pin", "guest_identity", "terminal_cas", "deadline"])("rejects %s without falsely declaring running", async changed => {
  const h = setup();
  if (changed === "pin") h.deps.inspect.mockResolvedValue({ ...(await h.deps.inspect({})), hostFingerprintSha256: "different" });
  if (changed === "guest_identity") h.identity.operationId = h.input.agentId;
  if (changed === "terminal_cas") h.deps.complete.mockResolvedValue(false);
  if (changed === "deadline") h.deps.publicReady.mockImplementation(async () => { h.advance(30_001); return true; });
  await expect(advanceProviderAgentReadiness(h.input, h.deps)).rejects.toThrow("could not be verified");
  expect(h.deps.release).not.toHaveBeenCalled();
});
it("does not return raw SSH or provider failures containing credentials", async () => {
  const h = setup(); h.deps.inspect.mockRejectedValue(new Error("PRIVATE_SSH_TOKEN"));
  await expect(advanceProviderAgentReadiness(h.input, h.deps)).rejects.toThrow("Provider computer readiness could not be verified; the original operation is retained.");
  expect(h.deps.complete).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
