/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";
import { advanceProviderAgentInstaller } from "../provider-agent-installer";
import type { ProviderAgentInstallContext } from "../provider-agent-install-store";
import { receiverFixture } from "@/lib/infrastructure/__tests__/first-boot-receiver.fixtures";
import { PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES, PORTABLE_HIVRA_PROVISIONER_VERSION } from "@/lib/infrastructure/portable-provisioner-contract";
import { buildProviderGuestWorkerPlan, type ProviderGuestWorkerReceipt } from "@/lib/infrastructure/provider-guest-worker";
import type { FirstBootOperation } from "@/lib/infrastructure/first-boot-operations";

function setup(accessMode: "cloudflare-named" | "direct-https" = "cloudflare-named") {
  const f = receiverFixture(), op = { userId: f.binding.userId,
    agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const scope = { binding: f.binding, providerServerId: "42" };
  const assets = PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath => ({ relativePath,
    content: relativePath === "hivra-provider-worker.py" ? readFileSync(path.join(process.cwd(), "provisioner", relativePath))
      : Buffer.from(relativePath === "VERSION" ? PORTABLE_HIVRA_PROVISIONER_VERSION : "fixture:" + relativePath) }));
  const context: ProviderAgentInstallContext = { operation: op, scope, targetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    runtime: "codex", desiredState: "running", accessMode,
    hostname: accessMode === "direct-https" ? "203-0-113-10.sslip.io" : "fixture.hivra.test",
    tunnelId: accessMode === "direct-https" ? null : "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    identity: null, stoppedAt: null, outcome: null };
  const request = { ...op, action: "start" as const, launch: { version: 1 as const, computerSubstrate: "provider-vm" as const,
    agentKind: "codex" as const, wantBrowser: false, modelKey: "private-fixture-model-key", modelBaseUrl: "", model: "",
    tunnelToken: accessMode === "direct-https" ? null
      : Buffer.from(JSON.stringify({ a: "a".repeat(32), t: context.tunnelId, s: "private-fixture-tunnel" })).toString("base64"),
    accessHostname: accessMode === "direct-https" ? context.hostname : null } };
  const identity = buildProviderGuestWorkerPlan({ ...request, scope, assets },
    { bootId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", boottimeMs: 0 }).identity;
  let elapsed = 0, state: ProviderGuestWorkerReceipt["state"] = "running";
  const deps = {
    load: jest.fn(async () => structuredClone(context)),
    begin: jest.fn(async () => { context.identity = structuredClone(identity); return { outcome: "dispatch" as const, dispatchBudgetMs: 30000 as const }; }),
    stopped: jest.fn(async () => true), bundle: jest.fn(async () => assets),
    boot: jest.fn(async () => ({ ...scope } as FirstBootOperation)),
    verify: jest.fn(async () => ({ stage: "provider_verified" as const, scope, address: "203.0.113.10",
      hostPublicKey: f.host.publicKey, hostFingerprintSha256: f.host.fingerprintSha256,
      capacityIdempotencyKey: f.stored.capacityIdempotencyKey, observedAt: "2026-08-28T00:00:00.000Z",
      powerOnAction: { id: 603, command: "start_server" as const, status: "success" as const, resources: [{ id: 42, type: "server" as const }] } })),
    bootstrap: jest.fn(async () => ({ publicKeyOpenSsh: "public-fixture-admin-key", privateKeyOpenSsh: "private-fixture-admin-key" }) as Awaited<ReturnType<typeof import("@/lib/infrastructure/hetzner-cloud-store").loadHetznerCloudCapacityBootstrap>>),
    control: jest.fn(async () => ({ hostVerified: true as const, administratorAuthenticated: true as const,
      hostFingerprintSha256: f.host.fingerprintSha256, receipt: { version: 1 as const, identity,
        state, stopped: ["cancelled", "failed", "succeeded"].includes(state) } })),
    monotonicNow: () => elapsed,
  };
  return { f, op, context, identity, assets, request, deps,
    advance: (ms: number) => { elapsed = ms; }, state: (value: typeof state) => { state = value; } };
}

describe("existing provider agent installer adapter", () => {
  it("uses the reserved owner/operation, exact provider receipt and original pinned administrator key", async () => {
    const h = setup();
    await expect(advanceProviderAgentInstaller(h.request, h.deps)).resolves.toEqual({ stage: "worker_observed", state: "running", stopped: false });
    expect(h.deps.begin).toHaveBeenCalledWith(h.op, h.identity);
    expect(h.deps.verify).toHaveBeenCalledWith(expect.objectContaining({ scope: h.context.scope, dispatchDeadlineMs: 30000 }), expect.any(Object));
    expect(h.deps.bootstrap).toHaveBeenCalledWith({ userId: h.op.userId, connectionId: h.f.binding.connectionId,
      expectedRevision: 7, orderId: h.f.binding.orderId, idempotencyKey: h.f.stored.capacityIdempotencyKey,
      quoteFingerprintSha256: h.f.binding.quoteFingerprint });
    expect(h.deps.control).toHaveBeenCalledWith(expect.objectContaining({ ...h.op, scope: h.context.scope,
      action: "start", launch: h.request.launch, address: "203.0.113.10", hostPublicKey: h.f.host.publicKey,
      administratorPrivateKey: "private-fixture-admin-key", dispatchDeadlineMs: 30000 }), expect.any(Object));
    expect(h.deps.load).toHaveBeenCalledTimes(2);
    expect(h.deps.stopped).not.toHaveBeenCalled();
  });

  it("accepts the exact journaled standalone hostname without decoding or requiring a tunnel secret", async () => {
    const h = setup("direct-https");
    await expect(advanceProviderAgentInstaller(h.request, h.deps)).resolves.toEqual({
      stage: "worker_observed", state: "running", stopped: false,
    });
    expect(h.request.launch).toMatchObject({ tunnelToken: null, accessHostname: "203-0-113-10.sslip.io" });
    expect(h.deps.control).toHaveBeenCalledWith(expect.objectContaining({ launch: h.request.launch }), expect.any(Object));
  });

  it("observes a repeated start without redispatch or a refreshed deadline", async () => {
    const h = setup(); h.context.identity = h.identity;
    h.deps.begin.mockResolvedValue({ outcome: "observe" } as never);
    await advanceProviderAgentInstaller(h.request, h.deps);
    expect(h.deps.control).toHaveBeenCalledWith(expect.objectContaining({ action: "status", dispatchDeadlineMs: 30000 }), expect.any(Object));
    expect(h.deps.control).toHaveBeenCalledWith(expect.not.objectContaining({ launch: expect.anything() }), expect.any(Object));
  });

  it.each(["start", "status", "cancel"] as const)("recovers %s from the original journal without loading the current release", async action => {
    const h = setup(); h.context.identity = h.identity;
    h.deps.bundle.mockRejectedValue(new Error("current release assets unavailable"));
    await expect(advanceProviderAgentInstaller({ ...h.request, action }, h.deps)).resolves.toEqual({
      stage: "worker_observed", state: "running", stopped: false,
    });
    expect(h.deps.bundle).not.toHaveBeenCalled(); expect(h.deps.begin).not.toHaveBeenCalled();
    expect(h.deps.control).toHaveBeenCalledWith(expect.objectContaining({
      action: action === "start" ? "status" : action, identity: h.identity,
    }), expect.any(Object));
    for (const privateField of ["assets", "launch"]) expect(h.deps.control).toHaveBeenCalledWith(
      expect.not.objectContaining({ [privateField]: expect.anything() }), expect.any(Object));
  });

  it.each(["start", "status", "cancel"] as const)("returns durable terminal proof for %s even when current assets cannot load", async action => {
    const h = setup(); h.context.identity = h.identity;
    h.context.outcome = "succeeded"; h.context.stoppedAt = "2026-08-28T00:01:00Z";
    h.deps.bundle.mockRejectedValue(new Error("current assets unavailable"));
    await expect(advanceProviderAgentInstaller({ ...h.request, action }, h.deps)).resolves.toEqual({
      stage: "worker_observed", state: "succeeded", stopped: true, source: "recorded",
    });
    for (const unused of [h.deps.bundle, h.deps.begin, h.deps.boot, h.deps.verify, h.deps.bootstrap, h.deps.control, h.deps.stopped]) {
      expect(unused).not.toHaveBeenCalled();
    }
  });

  it.each(["agent", "operation", "scope"])("rejects a foreign %s journal before any provider or administrator credential is opened", async field => {
    const h = setup(), identity = structuredClone(h.identity);
    if (field === "agent") identity.agentId = h.op.operationId;
    if (field === "operation") identity.operationId = h.op.agentId;
    if (field === "scope") identity.bundle.scopeSha256 = "f".repeat(64);
    h.context.identity = identity;
    await expect(advanceProviderAgentInstaller({ ...h.op, action: "cancel" }, h.deps)).rejects.toThrow();
    for (const unused of [h.deps.bundle, h.deps.begin, h.deps.boot, h.deps.verify, h.deps.bootstrap, h.deps.control, h.deps.stopped]) {
      expect(unused).not.toHaveBeenCalled();
    }
  });

  it.each(["status", "cancel"] as const)("does not fabricate a stop proof for %s before dispatch", async action => {
    const h = setup(); h.context.accessMode = null; h.context.hostname = null; h.context.tunnelId = null;
    await expect(advanceProviderAgentInstaller({ ...h.op, action }, h.deps)).resolves.toEqual({ stage: "not_dispatched" });
    for (const unused of [h.deps.begin, h.deps.bootstrap, h.deps.control, h.deps.stopped]) expect(unused).not.toHaveBeenCalled();
  });

  it("refuses a new installer dispatch when the access binding was never journaled", async () => {
    const h = setup("direct-https"); h.context.accessMode = null;
    await expect(advanceProviderAgentInstaller(h.request, h.deps)).rejects.toMatchObject({ code: "rejected" });
    for (const unused of [h.deps.begin, h.deps.boot, h.deps.verify, h.deps.bootstrap, h.deps.control]) expect(unused).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "failed", "succeeded"] as const)("journals exact %s proof without completing or releasing the agent", async state => {
    const h = setup(); h.context.identity = h.identity; h.state(state);
    const result = await advanceProviderAgentInstaller({ ...h.op, action: "status" }, h.deps);
    expect(result).toEqual({ stage: "worker_observed", state, stopped: true });
    expect(h.deps.stopped).toHaveBeenCalledWith(h.op, { version: 1, identity: h.identity, state, stopped: true });
    expect(JSON.stringify(result)).not.toMatch(/private-fixture|ready|operationId|scopeSha256/);
  });

  it.each(["failed", "succeeded", "cancelled"] as const)("preserves durable %s evidence across later cancel and status without changing the guest", async state => {
    const h = setup(); h.context.identity = h.identity; h.state(state);
    h.deps.stopped.mockImplementation(async () => { h.context.stoppedAt = "2026-08-28T00:01:00Z"; h.context.outcome = state; return true; });
    await advanceProviderAgentInstaller({ ...h.op, action: "status" }, h.deps);
    h.state("cancelled"); // A new cancel would change the guest's effective outcome.
    for (const action of ["cancel", "status"] as const) {
      await expect(advanceProviderAgentInstaller({ ...h.op, action }, h.deps)).resolves.toEqual({
        stage: "worker_observed", state, stopped: true, source: "recorded",
      });
    }
    expect(h.deps.control).toHaveBeenCalledTimes(1); expect(h.deps.stopped).toHaveBeenCalledTimes(1);
    expect(h.deps.begin).not.toHaveBeenCalled();
  });

  it("keeps canonical stopped evidence when a concurrent observer settles after the last read but before cancellation", async () => {
    const h = setup(); h.context.identity = h.identity; h.state("cancelled");
    const original = h.deps.control.getMockImplementation()!;
    h.deps.control.mockImplementation(async () => {
      h.context.stoppedAt = "2026-08-28T00:01:00Z"; h.context.outcome = "succeeded";
      return original();
    });
    h.deps.stopped.mockResolvedValue(false);
    await expect(advanceProviderAgentInstaller({ ...h.op, action: "cancel" }, h.deps)).resolves.toEqual({
      stage: "worker_observed", state: "succeeded", stopped: true, source: "recorded",
    });
    expect(h.deps.control).toHaveBeenCalledTimes(1);
    expect(h.deps.load).toHaveBeenCalledTimes(3);
  });

  it("cancels instead of starting when a delete request wins the last owner check", async () => {
    const h = setup(); h.context.identity = h.identity;
    const original = h.deps.verify.getMockImplementation()!;
    h.deps.verify.mockImplementation(async () => { h.context.desiredState = "deleted"; return original(); });
    await advanceProviderAgentInstaller(h.request, h.deps);
    expect(h.deps.control).toHaveBeenCalledWith(expect.objectContaining({ action: "cancel" }), expect.any(Object));
    expect(h.deps.control).toHaveBeenCalledWith(expect.not.objectContaining({ launch: expect.anything() }), expect.any(Object));
  });

  it("does not consume its one-use grant while the provider is waiting, and can proceed on a subsequent observation", async () => {
    const h = setup();
    h.deps.verify.mockResolvedValueOnce({ stage: "waiting_for_provider" } as never);
    await expect(advanceProviderAgentInstaller(h.request, h.deps)).resolves.toEqual({ stage: "waiting_for_provider" });
    expect(h.deps.begin).not.toHaveBeenCalled(); expect(h.deps.bootstrap).not.toHaveBeenCalled();
    expect(h.deps.control).not.toHaveBeenCalled(); expect(h.context.identity).toBeNull();
    await expect(advanceProviderAgentInstaller(h.request, h.deps)).resolves.toEqual({ stage: "worker_observed", state: "running", stopped: false });
    expect(h.deps.begin).toHaveBeenCalledTimes(1);
    expect(h.deps.control).toHaveBeenCalledWith(expect.objectContaining({ action: "start" }), expect.any(Object));
  });

  it.each(["runtime", "tunnel"])("rejects a different %s before recording a dispatch grant", async field => {
    const h = setup();
    if (field === "runtime") h.context.runtime = "claude";
    else h.context.tunnelId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await expect(advanceProviderAgentInstaller(h.request, h.deps)).rejects.toMatchObject({ code: "rejected" });
    expect(h.deps.begin).not.toHaveBeenCalled(); expect(h.deps.bootstrap).not.toHaveBeenCalled();
  });

  it("retains an older or changed original bundle without executing current bytes", async () => {
    const h = setup(); h.context.identity = { ...h.identity, bundle: { ...h.identity.bundle, provisionerVersion: "2026.08.27.4" } };
    await expect(advanceProviderAgentInstaller({ ...h.op, action: "cancel" }, h.deps)).rejects.toMatchObject({ code: "unsupported_bundle" });
    expect(h.deps.control).not.toHaveBeenCalled(); expect(h.deps.stopped).not.toHaveBeenCalled();
  });

  it.each(["load", "begin", "boot", "verify", "bootstrap"] as const)("never refreshes a deadline consumed by %s", async step => {
    const h = setup(); const original = h.deps[step].getMockImplementation()!;
    h.deps[step].mockImplementation((async () => { const result = await original(); h.advance(30000); return result; }) as never);
    await expect(advanceProviderAgentInstaller(h.request, h.deps)).rejects.toMatchObject({ code: "deadline_expired" });
    expect(h.deps.control).not.toHaveBeenCalled(); expect(h.deps.stopped).not.toHaveBeenCalled();
  });

  it.each(["scope", "identity", "target", "tunnel"])("does not open the administrator key after %s changes during provider verification", async field => {
    const h = setup(); const original = h.deps.verify.getMockImplementation()!;
    if (field === "identity") h.context.identity = h.identity;
    h.deps.verify.mockImplementation(async () => { const result = await original();
      if (field === "scope") h.context.scope = { ...h.context.scope, providerServerId: "43" };
      if (field === "identity") h.context.identity = null;
      if (field === "target") h.context.targetId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      if (field === "tunnel") h.context.tunnelId = null;
      return result;
    });
    await expect(advanceProviderAgentInstaller(h.request, h.deps)).rejects.toMatchObject({ code: "rejected" });
    expect(h.deps.bootstrap).not.toHaveBeenCalled(); expect(h.deps.control).not.toHaveBeenCalled();
  });

  it("snapshots caller-owned launch choices before reading the operation", async () => {
    const h = setup(), key = h.request.launch.modelKey, original = h.deps.load.getMockImplementation()!;
    h.deps.load.mockImplementation(async () => { h.request.launch.modelKey = "changed-later"; h.request.agentId = "ffffffff-ffff-4fff-8fff-ffffffffffff"; return original(); });
    await advanceProviderAgentInstaller(h.request, h.deps);
    expect(h.deps.control).toHaveBeenCalledWith(expect.objectContaining({ agentId: h.op.agentId, launch: expect.objectContaining({ modelKey: key }) }), expect.any(Object));
  });

  it.each(["disconnect", "host", "identity", "stop-write", "late-receipt"])("retains ambiguous %s outcome without a terminal result or raw secret error", async failure => {
    const h = setup(); h.state("succeeded");
    if (failure === "disconnect") h.deps.control.mockRejectedValue(new Error("private-fixture-admin-key"));
    if (failure === "stop-write") h.deps.stopped.mockResolvedValue(false);
    const original = h.deps.control.getMockImplementation()!;
    if (["host", "identity", "late-receipt"].includes(failure)) h.deps.control.mockImplementation(async () => {
      const result = await original();
      if (failure === "host") result.hostFingerprintSha256 = "other";
      if (failure === "identity") result.receipt.identity = { ...h.identity, operationId: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
      if (failure === "late-receipt") h.advance(30000);
      return result;
    });
    await expect(advanceProviderAgentInstaller(h.request, h.deps)).rejects.toThrow("Provider agent installer failed: outcome_unknown");
    if (failure !== "stop-write") expect(h.deps.stopped).not.toHaveBeenCalled();
  });
});
