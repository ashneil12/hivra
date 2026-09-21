/** @jest-environment node */
import { advanceProviderNativeInstaller } from "../provider-native-installer";
import type { ProviderNativeWorkerReceipt } from "@/lib/infrastructure/provider-native-worker";
import type { FirstBootOperation } from "@/lib/infrastructure/first-boot-operations";
import { nativeInstallFixture } from "./provider-native-install.fixtures";

function setup(accessMode: "cloudflare-named" | "direct-https" = "cloudflare-named") {
  const h = nativeInstallFixture(accessMode), { context, identity, scope, f, clock } = h;
  let elapsed = 0, state: ProviderNativeWorkerReceipt["state"] = "running";
  let cleanup: ProviderNativeWorkerReceipt["nativeCleanup"] = { state: "pending" };
  const deps = {
    load: jest.fn(async () => structuredClone(context)),
    begin: jest.fn(async () => { context.identity = structuredClone(identity); return { outcome: "dispatch" as const, dispatchBudgetMs: 30000 as const }; }),
    stopped: jest.fn(async (_op: typeof h.op, receipt: ProviderNativeWorkerReceipt) => {
      if (context.outcome !== null && context.outcome !== receipt.state) return false;
      context.stoppedAt ??= "2026-08-31T20:00:00Z"; context.outcome = receipt.state as typeof context.outcome; return true;
    }),
    cleanupBegin: jest.fn(async () => { context.cancellationRequested = true; return structuredClone(h.grant); }),
    cleanupRecord: jest.fn(async () => true), bundle: jest.fn(async () => h.assets),
    boot: jest.fn(async () => ({ ...scope } as FirstBootOperation)),
    verify: jest.fn(async () => ({ stage: "provider_verified" as const, scope, address: "203.0.113.10",
      hostPublicKey: f.host.publicKey, hostFingerprintSha256: f.host.fingerprintSha256,
      capacityIdempotencyKey: f.stored.capacityIdempotencyKey, observedAt: "2026-08-31T20:00:00.000Z",
      powerOnAction: { id: 603, command: "start_server" as const, status: "success" as const, resources: [{ id: 42, type: "server" as const }] } })),
    bootstrap: jest.fn(async () => ({ publicKeyOpenSsh: "public-fixture-admin-key", privateKeyOpenSsh: "private-fixture-admin-key" }) as Awaited<ReturnType<typeof import("@/lib/infrastructure/hetzner-cloud-store").loadHetznerCloudCapacityBootstrap>>),
    control: jest.fn(async (_input?: unknown) => { void _input; return { hostVerified: true as const, administratorAuthenticated: true as const,
      hostFingerprintSha256: f.host.fingerprintSha256, clock,
      receipt: { version: 2 as const, identity, state, stopped: ["cancelled", "failed", "succeeded"].includes(state), nativeCleanup: cleanup } }; }),
    monotonicNow: () => elapsed,
  };
  return { ...h, deps, advance: (ms: number) => { elapsed = ms; },
    result: (outcome: typeof state, native: typeof cleanup = { state: "pending" }) => { state = outcome; cleanup = native; } };
}
const call = (h: ReturnType<typeof setup>, action: "status" | "cancel") => advanceProviderNativeInstaller({ ...h.op, action }, h.deps);

describe("private native installer operation adapter", () => {
  it.each(["cloudflare-named", "direct-https"] as const)("dispatches one exact v2 install through original %s authority", async mode => {
    const h = setup(mode);
    await expect(advanceProviderNativeInstaller(h.request, h.deps)).resolves.toEqual({ stage: "worker_observed", state: "running", stopped: false,
      nativeCleanup: "pending", cleanupRecorded: false, cancellationRequested: false });
    expect(h.deps.begin).toHaveBeenCalledWith(h.op, h.identity, { mode, hostname: h.context.hostname, tunnelId: h.context.tunnelId });
    expect(h.deps.control).toHaveBeenCalledWith(expect.objectContaining({ action: "start", launch: h.request.launch,
      journaledHostname: h.context.hostname, scope: h.scope, hostPublicKey: h.f.host.publicKey,
      administratorPrivateKey: "private-fixture-admin-key", dispatchDeadlineMs: 30000 }), expect.any(Object));
    expect(h.deps.bootstrap).toHaveBeenCalledWith(expect.objectContaining({ userId: h.op.userId, connectionId: h.f.binding.connectionId,
      expectedRevision: h.f.binding.connectionRevision, orderId: h.f.binding.orderId, quoteFingerprintSha256: h.f.binding.quoteFingerprint }));
    expect(h.deps.cleanupBegin).not.toHaveBeenCalled(); expect(h.deps.stopped).not.toHaveBeenCalled();
  });
  it.each(["failed", "succeeded", "cancelled"] as const)("cancels cached %s with fresh SSH, preserving outcome and recording separate cleanup", async outcome => {
    const h = setup(); h.context.identity = h.identity; h.context.stoppedAt = "2026-08-31T20:00:00Z"; h.context.outcome = outcome;
    h.result(outcome, { state: "verified_stopped", bootId: h.clock.bootId });
    h.deps.bundle.mockRejectedValue(new Error("current release unavailable"));
    await expect(call(h, "cancel")).resolves.toEqual({ stage: "worker_observed", state: outcome, stopped: true,
      nativeCleanup: "verified_stopped", cleanupRecorded: true, cancellationRequested: true });
    expect(h.deps.cleanupBegin).toHaveBeenCalledWith(h.op, h.identity);
    expect(h.deps.cleanupBegin.mock.invocationCallOrder[0]).toBeLessThan(h.deps.control.mock.invocationCallOrder[0]);
    expect(h.deps.stopped.mock.invocationCallOrder[0]).toBeLessThan(h.deps.cleanupRecord.mock.invocationCallOrder[0]);
    expect(h.deps.control).toHaveBeenCalledWith(expect.objectContaining({ action: "cancel", identity: h.identity }), expect.any(Object));
    expect(h.deps.control).toHaveBeenCalledWith(expect.not.objectContaining({ launch: expect.anything(), assets: expect.anything() }), expect.any(Object));
    expect(h.deps.cleanupRecord).toHaveBeenCalledWith(h.op, h.grant, expect.objectContaining({ state: outcome }), h.clock);
    expect(h.deps.bundle).not.toHaveBeenCalled(); expect(h.deps.begin).not.toHaveBeenCalled();
  });
  it("does not let cached success observed on reload bypass cancellation", async () => {
    const h = setup(); h.context.identity = h.identity;
    h.deps.verify.mockImplementation(async () => {
      h.context.stoppedAt = "2026-08-31T20:00:00Z"; h.context.outcome = "succeeded";
      return { stage: "provider_verified", scope: h.scope, address: "203.0.113.10", hostPublicKey: h.f.host.publicKey,
        hostFingerprintSha256: h.f.host.fingerprintSha256, capacityIdempotencyKey: h.f.stored.capacityIdempotencyKey } as never;
    });
    h.result("succeeded", { state: "verified_stopped", bootId: h.clock.bootId });
    await expect(call(h, "cancel")).resolves.toMatchObject({ cleanupRecorded: true, state: "succeeded" });
    expect(h.deps.control).toHaveBeenCalledTimes(1);
  });
  it("retains immutable failure without confusing pending native cleanup with release", async () => {
    const h = setup(); h.context.identity = h.identity; h.result("failed");
    await expect(call(h, "cancel")).resolves.toMatchObject({ state: "failed", stopped: true, nativeCleanup: "pending", cleanupRecorded: false });
    expect(h.deps.stopped).toHaveBeenCalledTimes(1); expect(h.deps.cleanupRecord).not.toHaveBeenCalled();
  });
  it("status freshly observes but never acquires or records cleanup authority, including after cancellation", async () => {
    const h = setup(); h.context.identity = h.identity; h.context.cancellationRequested = true;
    h.context.stoppedAt = "2026-08-31T20:00:00Z"; h.context.outcome = "succeeded";
    h.result("succeeded", { state: "verified_stopped", bootId: h.clock.bootId });
    await expect(call(h, "status")).resolves.toMatchObject({ stopped: true, nativeCleanup: "verified_stopped", cleanupRecorded: false, cancellationRequested: true });
    expect(h.deps.control).toHaveBeenCalledWith(expect.objectContaining({ action: "status" }), expect.any(Object));
    expect(h.deps.cleanupBegin).not.toHaveBeenCalled(); expect(h.deps.cleanupRecord).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "failed", "succeeded"] as const)("never replaces durable %s with a different receipt outcome", async original => {
    const h = setup(); h.context.identity = h.identity; h.context.stoppedAt = "2026-08-31T20:00:00Z"; h.context.outcome = original;
    h.result(original === "cancelled" ? "succeeded" : "cancelled", { state: "verified_stopped", bootId: h.clock.bootId });
    await expect(call(h, "cancel")).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(h.deps.stopped).not.toHaveBeenCalled(); expect(h.deps.cleanupRecord).not.toHaveBeenCalled();
  });
  it("does not return a concurrent canonical outcome as cleanup success after a failed stopped CAS", async () => {
    const h = setup(); h.context.identity = h.identity; h.result("cancelled", { state: "verified_stopped", bootId: h.clock.bootId });
    h.deps.stopped.mockImplementation(async () => { h.context.stoppedAt = "2026-08-31T20:00:00Z"; h.context.outcome = "succeeded"; return false; });
    await expect(call(h, "cancel")).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(h.deps.cleanupRecord).not.toHaveBeenCalled(); expect(h.deps.load).toHaveBeenCalledTimes(2);
  });
  it("keeps the captured grant when another observation supersedes it during SSH", async () => {
    const h = setup(); h.context.identity = h.identity; h.result("failed", { state: "verified_stopped", bootId: h.clock.bootId });
    const original = h.deps.control.getMockImplementation()!, captured = { ...h.grant };
    h.deps.control.mockImplementation(async () => { h.grant.observationId = h.op.agentId; return original(); });
    h.deps.cleanupRecord.mockResolvedValue(false);
    await expect(call(h, "cancel")).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(h.deps.cleanupRecord).toHaveBeenCalledWith(h.op, captured, expect.anything(), h.clock);
    expect(h.deps.cleanupBegin).toHaveBeenCalledTimes(1);
  });
  it.each(["null", "lost_ack"])("does not open SSH without an acknowledged grant: %s", async fault => {
    const h = setup(); h.context.identity = h.identity;
    if (fault === "null") h.deps.cleanupBegin.mockResolvedValue(null as never);
    else h.deps.cleanupBegin.mockRejectedValue(new Error("private database detail"));
    await expect(call(h, "cancel")).rejects.toThrow("Provider agent installer failed:");
    expect(h.deps.control).not.toHaveBeenCalled(); expect(h.deps.cleanupRecord).not.toHaveBeenCalled();
  });
  it.each(["start", "status", "cancel"] as const)("recovers %s without current assets or relaying launch/model credentials", async action => {
    const h = setup(); h.context.identity = h.identity;
    h.deps.bundle.mockRejectedValue(new Error("current unavailable"));
    await advanceProviderNativeInstaller({ ...h.request, action }, h.deps);
    expect(h.deps.bundle).not.toHaveBeenCalled(); expect(h.deps.begin).not.toHaveBeenCalled();
    const control = h.deps.control.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(control).toMatchObject({ action: action === "start" ? "status" : action, identity: h.identity });
    expect(control).not.toHaveProperty("launch"); expect(control).not.toHaveProperty("assets");
  });
  it.each(["desiredState", "cancellationRequested"])("a repeated start resumes cancellation when %s is set", async field => {
    const h = setup(); h.context.identity = h.identity;
    if (field === "desiredState") h.context.desiredState = "deleted"; else h.context.cancellationRequested = true;
    await advanceProviderNativeInstaller(h.request, h.deps);
    expect(h.deps.control).toHaveBeenCalledWith(expect.objectContaining({ action: "cancel" }), expect.any(Object));
    expect(h.deps.cleanupBegin).toHaveBeenCalledTimes(1); expect(h.deps.begin).not.toHaveBeenCalled();
  });
  it.each(["status", "cancel", "deleted-start"])("keeps an unstarted reservation non-authoritative for %s", async mode => {
    const h = setup(); if (mode === "deleted-start") h.context.desiredState = "deleted";
    await expect(mode === "deleted-start" ? advanceProviderNativeInstaller(h.request, h.deps) : call(h, mode as "status" | "cancel"))
      .resolves.toEqual({ stage: "not_dispatched" });
    for (const mock of [h.deps.bundle, h.deps.begin, h.deps.boot, h.deps.control, h.deps.cleanupBegin]) expect(mock).not.toHaveBeenCalled();
  });
  it.each(["tunnel", "origin", "runtime", "modelKey", "no-access"])("rejects %s before provider access or consuming a dispatch grant", async field => {
    const h = setup();
    if (field === "tunnel") h.context.tunnelId = h.op.agentId;
    if (field === "origin") h.request.launch.publicOrigin = "https://foreign.example.test";
    if (field === "runtime") Object.assign(h.context, { runtime: "codex" });
    if (field === "modelKey") Object.assign(h.request.launch, { modelKey: "private-model-credential" });
    if (field === "no-access") h.context.accessMode = null;
    await expect(advanceProviderNativeInstaller(h.request, h.deps)).rejects.toThrow();
    for (const mock of [h.deps.begin, h.deps.boot, h.deps.bootstrap, h.deps.control]) expect(mock).not.toHaveBeenCalled();
  });
  it.each(["scope", "identity", "target", "hostname", "tunnel", "owner", "unlatch", "lost-outcome"])("rejects %s drift before opening the admin key", async field => {
    const h = setup(); h.context.identity = h.identity;
    if (field === "unlatch") h.context.cancellationRequested = true;
    if (field === "lost-outcome") { h.context.outcome = "succeeded"; h.context.stoppedAt = "2026-08-31T20:00:00Z"; }
    const verify = h.deps.verify.getMockImplementation()!;
    h.deps.verify.mockImplementation(async () => { const result = await verify();
      if (field === "scope") h.context.scope = { ...h.scope, providerServerId: "43" };
      if (field === "identity") h.context.identity = null;
      if (field === "target") h.context.targetId = h.op.agentId;
      if (field === "hostname") h.context.hostname = "foreign.example.test";
      if (field === "tunnel") h.context.tunnelId = h.op.agentId;
      if (field === "owner") h.context.operation = { ...h.op, userId: "foreign" };
      if (field === "unlatch") h.context.cancellationRequested = false;
      if (field === "lost-outcome") { h.context.outcome = null; h.context.stoppedAt = null; }
      return result;
    });
    await expect(call(h, "cancel")).rejects.toMatchObject({ code: "rejected" });
    expect(h.deps.bootstrap).not.toHaveBeenCalled(); expect(h.deps.control).not.toHaveBeenCalled();
  });
  it.each(["load", "begin", "boot", "verify", "bootstrap", "cleanupBegin"] as const)("does not refresh the original deadline after %s", async step => {
    const h = setup(); if (step === "cleanupBegin") h.context.identity = h.identity;
    const original = h.deps[step].getMockImplementation()!;
    h.deps[step].mockImplementation((async () => { const result = await original(); h.advance(30000); return result; }) as never);
    await expect(step === "cleanupBegin" ? call(h, "cancel") : advanceProviderNativeInstaller(h.request, h.deps))
      .rejects.toMatchObject({ code: "deadline_expired" });
    expect(h.deps.control).not.toHaveBeenCalled();
  });
  it.each(["control", "stopped", "cleanupRecord"] as const)("late %s acknowledgement remains unknown", async step => {
    const h = setup(); h.context.identity = h.identity; h.result("failed", { state: "verified_stopped", bootId: h.clock.bootId });
    const original = h.deps[step].getMockImplementation()!;
    h.deps[step].mockImplementation((async (...args: never[]) => { const result = await (original as (...args: never[]) => unknown)(...args); h.advance(30000); return result; }) as never);
    await expect(call(h, "cancel")).rejects.toMatchObject({ code: "outcome_unknown" });
    if (step !== "cleanupRecord") expect(h.deps.cleanupRecord).not.toHaveBeenCalled();
  });
  it.each(["disconnect", "host", "auth", "identity", "stale-boot", "missing-clock"])("retains ambiguous %s without false cleanup or secret errors", async fault => {
    const h = setup(); h.context.identity = h.identity; h.result("failed", { state: "verified_stopped", bootId: h.clock.bootId });
    const original = h.deps.control.getMockImplementation()!;
    h.deps.control.mockImplementation(async () => {
      if (fault === "disconnect") throw new Error("private-fixture-admin-key");
      const result = await original();
      if (fault === "host") result.hostFingerprintSha256 = "foreign";
      if (fault === "auth") Object.assign(result, { administratorAuthenticated: false });
      if (fault === "identity") result.receipt.identity = { ...h.identity, operationId: h.op.agentId };
      if (fault === "stale-boot") result.clock = { ...h.clock, bootId: h.op.agentId };
      if (fault === "missing-clock") Object.assign(result, { clock: undefined });
      return result;
    });
    await expect(call(h, "cancel")).rejects.toThrow("Provider agent installer failed: outcome_unknown");
    expect(h.deps.stopped).not.toHaveBeenCalled(); expect(h.deps.cleanupRecord).not.toHaveBeenCalled();
  });
  it("does not acquire grants or keys while the original provider is still converging", async () => {
    const h = setup(); h.deps.verify.mockResolvedValue({ stage: "waiting_for_provider" } as never);
    await expect(advanceProviderNativeInstaller(h.request, h.deps)).resolves.toEqual({ stage: "waiting_for_provider" });
    for (const mock of [h.deps.begin, h.deps.bootstrap, h.deps.control, h.deps.cleanupBegin]) expect(mock).not.toHaveBeenCalled();
  });
  it("snapshots launch origin/token and operation before async reads", async () => {
    const h = setup(), original = h.deps.load.getMockImplementation()!, launch = { ...h.request.launch };
    h.deps.load.mockImplementation(async () => {
      h.request.launch.publicOrigin = "https://foreign.example.test"; h.request.launch.tunnelToken = "changed";
      h.request.agentId = h.op.operationId; return original();
    });
    await advanceProviderNativeInstaller(h.request, h.deps);
    expect(h.deps.control).toHaveBeenCalledWith(expect.objectContaining({ agentId: h.op.agentId, launch }), expect.any(Object));
  });
});
