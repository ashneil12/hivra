/** @jest-environment node */
import { advanceProviderDesktopReadiness } from "../provider-desktop-readiness";
import { desktopInstallFixture } from "./provider-desktop-install.fixtures";
import type { advanceProviderDesktopInstaller } from "../provider-desktop-installer";
import type { inspectProviderDesktopRuntime } from "@/lib/infrastructure/first-boot-ssh";
import type { FirstBootOperation } from "@/lib/infrastructure/first-boot-operations";
import { REMOTE_DESKTOP_BUNDLE_REVISION } from "@/lib/remote-computers/capability-inspection";

function setup(mode: "cloudflare-named" | "direct-https" = "cloudflare-named") {
  const f = desktopInstallFixture(mode);
  const context = { ...structuredClone(f.context), identity: structuredClone(f.identity), stoppedAt: "2026-09-05T21:00:00Z",
    outcome: "succeeded" as "succeeded" | "cancelled" | "failed" };
  let elapsed = 0;
  const deps = {
    load: jest.fn(async () => structuredClone(context)),
    installer: jest.fn<ReturnType<typeof advanceProviderDesktopInstaller>, [unknown]>(async () => ({
      stage: "worker_observed", state: "succeeded", stopped: true, desktopCleanup: "pending", cleanupRecorded: false, cancellationRequested: false,
    })),
    boot: jest.fn(async () => ({ ...f.scope } as FirstBootOperation)),
    verify: jest.fn(async () => ({ stage: "provider_verified" as const, scope: f.scope, address: "93.184.216.34",
      hostPublicKey: f.f.host.publicKey, hostFingerprintSha256: f.f.host.fingerprintSha256,
      capacityIdempotencyKey: f.f.stored.capacityIdempotencyKey, observedAt: "2026-09-05T21:01:00Z",
      powerOnAction: { id: 603, command: "start_server" as const, status: "success" as const, resources: [{ id: 42, type: "server" as const }] } })),
    bootstrap: jest.fn(async () => ({ publicKeyOpenSsh: "public-fixture", privateKeyOpenSsh: "private-fixture" }) as Awaited<ReturnType<typeof import("@/lib/infrastructure/hetzner-cloud-store").loadHetznerCloudCapacityBootstrap>>),
    inspect: jest.fn<ReturnType<typeof inspectProviderDesktopRuntime>, [unknown]>(async () => ({ hostVerified: true,
      administratorAuthenticated: true, hostFingerprintSha256: f.f.host.fingerprintSha256,
      receipt: { protocol: "hivra-remote-desktop-capability-v1", computerKind: "hivra-agent", computerId: f.op.agentId,
        capabilityGeneration: f.clock.bootId, observedRevision: REMOTE_DESKTOP_BUNDLE_REVISION, compositor: "x11",
        installedTransports: ["selkies-websocket"], privateNetworkReachable: false, supportsInputTakeover: true,
        brokerOrigin: `https://${context.hostname}`, observedAt: new Date().toISOString() } })),
    publicReady: jest.fn(async () => true), complete: jest.fn(async () => true), expireUnstarted: jest.fn(async () => false),
    monotonicNow: () => elapsed, now: () => new Date("2026-09-05T21:02:00Z"), controlOrigin: () => "https://canary.hermesos.cloud",
  };
  return { ...f, context, deps, advance: (ms: number) => { elapsed = ms; } };
}
it.each(["cloudflare-named", "direct-https"] as const)("converges %s through the original provider and private desktop CAS", async mode => {
  const h = setup(mode); expect(await advanceProviderDesktopReadiness(h.op, h.deps)).toBe("running");
  expect(h.deps.installer).toHaveBeenCalledWith({ ...h.op, action: "status" });
  expect(h.deps.inspect).toHaveBeenCalledWith(expect.objectContaining({ identity: h.identity,
    hostPublicKey: h.f.host.publicKey, administratorPrivateKey: "private-fixture", dispatchDeadlineMs: 30000 }), expect.any(Object));
  expect(h.deps.publicReady).toHaveBeenCalledWith({ access: { mode, hostname: h.context.hostname, tunnelId: h.context.tunnelId }, controlOrigin: h.deps.controlOrigin() });
  expect(h.deps.complete).toHaveBeenCalledWith({ ...h.op, chatUrl: `https://${h.context.hostname}`, ip: "93.184.216.34", provisionedAt: "2026-09-05T21:02:00.000Z" });
});
it.each(["initial", "installer", "final"])("retains cancellation at %s", async point => {
  const h = setup();
  if (point === "initial") h.context.desiredState = "deleted";
  if (point === "installer") h.deps.installer.mockResolvedValue({ stage: "worker_observed", state: "succeeded", stopped: true,
    desktopCleanup: "pending", cleanupRecorded: false, cancellationRequested: true });
  if (point === "final") h.deps.publicReady.mockImplementation(async () => { h.context.cancellationRequested = true; return true; });
  expect(await advanceProviderDesktopReadiness(h.op, h.deps)).toBe("cancellation_pending"); expect(h.deps.complete).not.toHaveBeenCalled();
});
it.each(["running", "unknown", "stopping"] as const)("retains a %s installer", async state => {
  const h = setup(); h.deps.installer.mockResolvedValue({ stage: "worker_observed", state, stopped: false,
    desktopCleanup: "pending", cleanupRecorded: false, cancellationRequested: false });
  expect(await advanceProviderDesktopReadiness(h.op, h.deps)).toBe("installer_pending"); expect(h.deps.inspect).not.toHaveBeenCalled();
});
it.each(["failed", "cancelled"] as const)("retains a stopped %s VM for removal", async state => {
  const h = setup(); h.context.outcome = state;
  h.deps.installer.mockResolvedValue({ stage: "worker_observed", state, stopped: true, desktopCleanup: "pending", cleanupRecorded: false, cancellationRequested: false });
  expect(await advanceProviderDesktopReadiness(h.op, h.deps)).toBe("failed"); expect(h.deps.complete).not.toHaveBeenCalled();
});
it("expires only database-confirmed unstarted operations", async () => {
  const h = setup(); h.deps.installer.mockResolvedValue({ stage: "not_dispatched" }); h.deps.expireUnstarted.mockResolvedValue(true);
  expect(await advanceProviderDesktopReadiness(h.op, h.deps)).toBe("failed"); expect(h.deps.inspect).not.toHaveBeenCalled();
});
it("retains the computer when public ingress is not ready", async () => {
  const h = setup(); h.deps.publicReady.mockResolvedValue(false);
  expect(await advanceProviderDesktopReadiness(h.op, h.deps)).toBe("public_access_pending"); expect(h.deps.complete).not.toHaveBeenCalled();
});
it.each(["scope", "identity", "pin", "receipt", "late-binding", "deadline", "CAS", "private-error"])("rejects %s without releasing authority", async fault => {
  const h = setup();
  if (fault === "scope") h.deps.verify.mockResolvedValue({ ...(await h.deps.verify()), scope: { ...h.scope, providerServerId: "43" } });
  if (fault === "identity") h.context.identity.operationId = h.op.agentId;
  if (fault === "pin") h.deps.inspect.mockResolvedValue({ ...(await h.deps.inspect({})), hostFingerprintSha256: "other" });
  if (fault === "receipt") { const observed = await h.deps.inspect({}); observed.receipt.computerId = h.op.operationId; h.deps.inspect.mockResolvedValue(observed); }
  if (fault === "late-binding") h.deps.publicReady.mockImplementation(async () => { h.context.targetId = h.op.agentId; return true; });
  if (fault === "deadline") h.deps.publicReady.mockImplementation(async () => { h.advance(30001); return true; });
  if (fault === "CAS") h.deps.complete.mockResolvedValue(false);
  if (fault === "private-error") h.deps.inspect.mockRejectedValue(new Error("PRIVATE fixture secret"));
  await expect(advanceProviderDesktopReadiness(h.op, h.deps)).rejects.toThrow("Provider desktop readiness could not be verified; the original operation is retained.");
  expect(h.deps.complete).toHaveBeenCalledTimes(fault === "CAS" ? 1 : 0);
});
