/** @jest-environment node */
import { advanceProviderNativeReadiness, type loadProviderNativeReadinessContext } from "../provider-native-readiness";
import { nativeInstallFixture } from "./provider-native-install.fixtures";
import type { advanceProviderNativeInstaller } from "../provider-native-installer";
import type { inspectProviderNativeRuntime } from "@/lib/infrastructure/first-boot-ssh";
import type { FirstBootOperation } from "@/lib/infrastructure/first-boot-operations";

function setup(accessMode: "cloudflare-named" | "direct-https" = "cloudflare-named") {
  const f = nativeInstallFixture(accessMode), input = f.op;
  const context: Awaited<ReturnType<typeof loadProviderNativeReadinessContext>> = {
    ...structuredClone(f.context), identity: structuredClone(f.identity), stoppedAt: "2026-08-31T21:00:00Z",
    outcome: "succeeded", cancellationRequested: false,
  };
  const access = { mode: accessMode, hostname: context.hostname!, tunnelId: context.tunnelId } as const;
  const sessionCookie = `__Host-hivra_auth=${"c".repeat(64)}`, invocationId = "d".repeat(32);
  let elapsed = 0;
  const deps = {
    load: jest.fn(async () => structuredClone(context)),
    installer: jest.fn<ReturnType<typeof advanceProviderNativeInstaller>, [unknown]>(async () => ({
      stage: "worker_observed", state: "succeeded", stopped: true, nativeCleanup: "pending",
      cleanupRecorded: false, cancellationRequested: false,
    })),
    boot: jest.fn(async () => ({ ...f.scope } as FirstBootOperation)),
    verify: jest.fn(async () => ({ stage: "provider_verified" as const, scope: f.scope, address: "93.184.216.34",
      hostPublicKey: f.f.host.publicKey, hostFingerprintSha256: f.f.host.fingerprintSha256,
      capacityIdempotencyKey: f.f.stored.capacityIdempotencyKey, observedAt: "2026-08-31T21:01:00Z",
      powerOnAction: { id: 603, command: "start_server" as const, status: "success" as const, resources: [{ id: 42, type: "server" as const }] } })),
    bootstrap: jest.fn(async () => ({ publicKeyOpenSsh: "public-fixture", privateKeyOpenSsh: "private-fixture" }) as Awaited<ReturnType<typeof import("@/lib/infrastructure/hetzner-cloud-store").loadHetznerCloudCapacityBootstrap>>),
    inspect: jest.fn<ReturnType<typeof inspectProviderNativeRuntime>, [unknown]>(async () => ({ hostVerified: true,
      administratorAuthenticated: true, hostFingerprintSha256: f.f.host.fingerprintSha256,
      receipt: { version: 1, ready: true, identity: f.identity, access, sessionCookie, invocationId } })),
    publicReady: jest.fn(async () => true), complete: jest.fn(async () => true), expireUnstarted: jest.fn(async () => false),
    monotonicNow: () => elapsed, now: () => new Date("2026-08-31T21:02:00Z"),
  };
  return { ...f, input, context, access, sessionCookie, invocationId, deps, advance: (ms: number) => { elapsed = ms; } };
}

it.each(["cloudflare-named", "direct-https"] as const)("converges an exact %s native computer without storing management authority", async mode => {
  const h = setup(mode);
  expect(await advanceProviderNativeReadiness(h.input, h.deps)).toBe("running");
  expect(h.deps.installer).toHaveBeenCalledWith({ ...h.input, action: "status" });
  expect(h.deps.inspect).toHaveBeenCalledWith(expect.objectContaining({ identity: h.identity, access: h.access,
    administratorPrivateKey: "private-fixture", hostPublicKey: h.f.host.publicKey }), expect.any(Object));
  expect(h.deps.publicReady).toHaveBeenCalledWith({ access: h.access, sessionCookie: h.sessionCookie });
  expect(h.deps.complete).toHaveBeenCalledWith({ ...h.input, chatUrl: `https://${h.context.hostname}`,
    ip: "93.184.216.34", provisionedAt: "2026-08-31T21:02:00.000Z" });
  expect(JSON.stringify(h.deps.complete.mock.calls)).not.toContain(h.sessionCookie);
});

it.each(["initial", "installer", "reload"] as const)("honors cancellation at %s without probing or completing", async point => {
  const h = setup();
  if (point === "initial") h.context.desiredState = "deleted";
  if (point === "installer") h.deps.installer.mockResolvedValue({ stage: "worker_observed", state: "succeeded", stopped: true,
    nativeCleanup: "pending", cleanupRecorded: false, cancellationRequested: true });
  if (point === "reload") {
    let call = 0; h.deps.load.mockImplementation(async () => ({ ...structuredClone(h.context), cancellationRequested: ++call >= 2 }));
  }
  expect(await advanceProviderNativeReadiness(h.input, h.deps)).toBe("cancellation_pending");
  expect(h.deps.inspect).not.toHaveBeenCalled(); expect(h.deps.complete).not.toHaveBeenCalled();
});

it.each(["running", "stopping", "unknown"] as const)("does not mistake %s installer state for readiness", async state => {
  const h = setup(); h.deps.installer.mockResolvedValue({ stage: "worker_observed", state, stopped: false,
    nativeCleanup: "pending", cleanupRecorded: false, cancellationRequested: false });
  expect(await advanceProviderNativeReadiness(h.input, h.deps)).toBe("installer_pending");
  expect(h.deps.inspect).not.toHaveBeenCalled(); expect(h.deps.complete).not.toHaveBeenCalled();
});

it.each(["failed", "cancelled"] as const)("retains a stopped %s computer for explicit inspection/removal", async state => {
  const h = setup(); h.context.outcome = state;
  h.deps.installer.mockResolvedValue({ stage: "worker_observed", state, stopped: true,
    nativeCleanup: "pending", cleanupRecorded: false, cancellationRequested: false });
  expect(await advanceProviderNativeReadiness(h.input, h.deps)).toBe("failed");
  expect(h.deps.inspect).not.toHaveBeenCalled(); expect(h.deps.complete).not.toHaveBeenCalled();
});

it("expires only a database-confirmed unstarted operation", async () => {
  const h = setup(); h.deps.installer.mockResolvedValue({ stage: "not_dispatched" }); h.deps.expireUnstarted.mockResolvedValue(true);
  expect(await advanceProviderNativeReadiness(h.input, h.deps)).toBe("failed");
  expect(h.deps.expireUnstarted).toHaveBeenCalledWith(h.input); expect(h.deps.inspect).not.toHaveBeenCalled();
});

it.each(["runtime", "public"] as const)("retains the original computer when %s readiness is pending", async stage => {
  const h = setup();
  if (stage === "runtime") h.deps.inspect.mockResolvedValue({ hostVerified: true, administratorAuthenticated: true,
    hostFingerprintSha256: h.f.host.fingerprintSha256,
    receipt: { version: 1, ready: false, identity: h.identity, access: h.access, reason: "service_unverified" } });
  else h.deps.publicReady.mockResolvedValue(false);
  expect(await advanceProviderNativeReadiness(h.input, h.deps)).toBe(stage === "runtime" ? "runtime_pending" : "public_access_pending");
  expect(h.deps.complete).not.toHaveBeenCalled();
});

it.each(["identity", "binding", "pin", "terminal", "deadline"] as const)("fails closed on %s drift without publishing running", async fault => {
  const h = setup();
  if (fault === "identity") h.context.identity = { ...h.identity, operationId: h.input.agentId };
  if (fault === "binding") {
    let call = 0; h.deps.load.mockImplementation(async () => ({ ...structuredClone(h.context), targetId: ++call >= 2 ? h.input.agentId : h.context.targetId }));
  }
  if (fault === "pin") h.deps.inspect.mockResolvedValue({ ...(await h.deps.inspect({})), hostFingerprintSha256: "different" });
  if (fault === "terminal") h.deps.complete.mockResolvedValue(false);
  if (fault === "deadline") h.deps.publicReady.mockImplementation(async () => { h.advance(30_001); return true; });
  await expect(advanceProviderNativeReadiness(h.input, h.deps)).rejects.toThrow("original operation is retained");
  expect(h.deps.complete).toHaveBeenCalledTimes(fault === "terminal" ? 1 : 0);
});

it("does not expose private SSH, provider or session details in errors", async () => {
  const h = setup(); h.deps.inspect.mockRejectedValue(new Error(`PRIVATE ${h.sessionCookie}`));
  await expect(advanceProviderNativeReadiness(h.input, h.deps)).rejects.toThrow(
    "Native provider computer readiness could not be verified; the original operation is retained.",
  );
  expect(h.deps.complete).not.toHaveBeenCalled();
});
