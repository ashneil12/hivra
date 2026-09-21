import { advanceProviderAgentPower } from "../provider-agent-power";
import type { ProviderAgentPowerContext } from "../provider-agent-power-store";
import { HETZNER_POWER_ACTIONS, type HetznerPowerAction, type HetznerPowerKind } from "@/lib/hetzner/power-action";
import type { inspectProviderGuestRuntime } from "@/lib/infrastructure/first-boot-ssh";
import type { verifyEnrolledProviderPowerReceipt, VerifiedEnrolledProviderPowerReceipt } from "@/lib/infrastructure/enrolled-provider-receipt";
import type { loadHetznerCloudCapacityBootstrap, loadHetznerCloudConnectionSecret } from "@/lib/infrastructure/hetzner-cloud-store";
import type { FirstBootOperation } from "@/lib/infrastructure/first-boot-operations";
import { providerGuestBundleScopeSha256 } from "@/lib/infrastructure/provider-guest-bundle";
import { receiverFixture } from "@/lib/infrastructure/__tests__/first-boot-receiver.fixtures";
import { desktopInstallFixture } from "./provider-desktop-install.fixtures";
import { REMOTE_DESKTOP_BUNDLE_REVISION } from "@/lib/remote-computers/capability-inspection";

const beforeBootId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", afterBootId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
function setup(kind: HetznerPowerKind = "restart", dispatched = false) {
  const f = receiverFixture(), input = { userId: f.binding.userId, agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const scope = { binding: f.binding, providerServerId: "42" };
  const identity = { version: 1 as const, agentId: input.agentId, operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    bundle: { version: 1 as const, state: "bundle_installed" as const, scopeSha256: providerGuestBundleScopeSha256(scope),
      bundleSha256: "a".repeat(64), provisionerVersion: "2026.08.28.1" as const } };
  const created = "2026-08-28T02:00:00.000Z";
  const action: HetznerPowerAction = { id: 701, command: HETZNER_POWER_ACTIONS[kind].command, status: "running", resources: [{ id: 42, type: "server" }] };
  const context: ProviderAgentPowerContext = { operation: input, kind, scope, targetId: identity.operationId, runtime: "codex", identity,
    desiredState: kind === "stop" ? "stopped" : "running", accessMode: "cloudflare-named",
    hostname: "box-fixture.hermesos.cloud", tunnelId: identity.operationId,
    originalStatus: kind === "start" ? "stopped" : "running", createdAt: created, dispatchNotAfter: "2026-08-28T02:00:45.000Z",
    dispatchIntentAt: dispatched ? created : null, beforeBootId: dispatched && kind === "restart" ? beforeBootId : null,
    action: dispatched ? structuredClone(action) : null, verifiedAt: null, verifiedStatus: null, verifiedBootId: null, cancelledAt: null };
  const verified: VerifiedEnrolledProviderPowerReceipt = { stage: "provider_verified", scope, address: "203.0.113.10",
    hostPublicKey: f.host.publicKey, hostFingerprintSha256: f.host.fingerprintSha256, capacityIdempotencyKey: f.stored.capacityIdempotencyKey,
    observedAt: created, powerOnAction: { id: 603, command: "start_server", status: "success", resources: [{ id: 42, type: "server" }] },
    powerState: (dispatched ? kind === "stop" : kind === "start") ? "off" : "running" };
  let elapsed = 0, wall = Date.parse(created);
  const provider = { getServer: jest.fn(), dispatch: jest.fn(async () => structuredClone(action)),
    getAction: jest.fn(async () => ({ ...action, status: "success" as const })) };
  const deps = {
    load: jest.fn(async () => structuredClone(context)),
    begin: jest.fn(async (_op: unknown, bootId: string | null) => { context.dispatchIntentAt = created; context.beforeBootId = bootId; return "dispatch" as "dispatch" | "observe" | "rejected"; }),
    cancel: jest.fn(async () => true), record: jest.fn(async (_op: unknown, _expected: unknown, next: HetznerPowerAction) => { context.action = structuredClone(next); return true; }),
    verifyResult: jest.fn(async () => true), boot: jest.fn(async () => ({ ...scope } as FirstBootOperation)),
    verify: jest.fn<ReturnType<typeof verifyEnrolledProviderPowerReceipt>, Parameters<typeof verifyEnrolledProviderPowerReceipt>>(async () => structuredClone(verified)),
    secret: jest.fn(async () => ({ apiToken: "private-project-key", revision: 7, connection: { id: f.binding.connectionId, status: "ready" } }) as Awaited<ReturnType<typeof loadHetznerCloudConnectionSecret>>),
    client: jest.fn(() => provider),
    bootstrap: jest.fn(async () => ({ publicKeyOpenSsh: "public-key", privateKeyOpenSsh: "private-admin-key" }) as Awaited<ReturnType<typeof loadHetznerCloudCapacityBootstrap>>),
    inspect: jest.fn<ReturnType<typeof inspectProviderGuestRuntime>, Parameters<typeof inspectProviderGuestRuntime>>(async () => ({ hostVerified: true, administratorAuthenticated: true,
      hostFingerprintSha256: f.host.fingerprintSha256, receipt: { version: 1, ready: true, identity, runtime: "codex", apiToken: "b".repeat(64), bootId: dispatched ? afterBootId : beforeBootId } })),
    publicReady: jest.fn(async () => true), completeStopped: jest.fn(async () => true), completeRunning: jest.fn(async () => true), release: jest.fn(async () => true),
    now: () => new Date(wall), monotonicNow: () => elapsed,
  };
  return { f, input, scope, context, identity, verified, deps, provider, action,
    advance: (ms: number) => { elapsed = ms; }, wall: (ms: number) => { wall += ms; } };
}

function desktopSetup(kind:HetznerPowerKind="restart",dispatched=false) {
  const h=setup(kind,dispatched),d=desktopInstallFixture();
  const identity={...d.identity,agentId:h.input.agentId,operationId:h.identity.operationId,
    bundle:{...d.identity.bundle,scopeSha256:providerGuestBundleScopeSha256(h.scope)}};
  const desktopAccess={mode:"cloudflare-named" as const,hostname:h.context.hostname,tunnelId:h.context.tunnelId!};
  const context:ProviderAgentPowerContext={...h.context,runtime:"linux-desktop",identity,desktopAccess};
  const capability={protocol:"hivra-remote-desktop-capability-v1" as const,computerKind:"hivra-agent" as const,computerId:h.input.agentId,
    capabilityGeneration:d.clock.bootId,observedRevision:REMOTE_DESKTOP_BUNDLE_REVISION,compositor:"x11" as const,
    installedTransports:["selkies-websocket" as const],privateNetworkReachable:false,supportsInputTakeover:true,
    brokerOrigin:`https://${context.hostname}`,observedAt:new Date().toISOString()};
  const deps={...h.deps,load:jest.fn(async()=>structuredClone(context)),
    record:jest.fn(async(_op:unknown,_expected:unknown,next:HetznerPowerAction)=>{context.action=structuredClone(next);return true;}),
    clockInspect:jest.fn(async()=>({hostVerified:true as const,administratorAuthenticated:true as const,
      hostFingerprintSha256:h.f.host.fingerprintSha256,clock:{bootId:beforeBootId,boottimeMs:1000}})),
    desktopInspect:jest.fn(async()=>({hostVerified:true as const,administratorAuthenticated:true as const,
      hostFingerprintSha256:h.f.host.fingerprintSha256,receipt:{bootId:afterBootId,capability}})),
    desktopPublicReady:jest.fn(async()=>true),desktopComplete:jest.fn(async()=>true),controlOrigin:()=>"https://canary.hermesos.cloud"};
  return {...h,context,deps,capability};
}
it("dispatches desktop restart from original kernel boot even when desktop services cannot be inspected",async()=>{
  const h=desktopSetup();h.deps.desktopInspect.mockRejectedValue(new Error("desktop unavailable"));
  expect(await advanceProviderAgentPower(h.input,"dispatch",h.deps)).toBe("action_pending");
  expect(h.deps.begin).toHaveBeenCalledWith(h.input,beforeBootId);
  expect(h.deps.clockInspect).toHaveBeenCalledTimes(1);expect(h.deps.desktopInspect).not.toHaveBeenCalled();
  expect(h.deps.inspect).not.toHaveBeenCalled();
});
it.each(["start","restart","stop"] as const)("converges desktop %s only through its correct observation and finalizer",async kind=>{
  const h=desktopSetup(kind,true);
  expect(await advanceProviderAgentPower(h.input,"observe",h.deps)).toBe(kind==="stop"?"stopped":"running");
  expect(h.deps.desktopInspect).toHaveBeenCalledTimes(kind==="stop"?0:1);
  expect(h.deps.desktopPublicReady).toHaveBeenCalledTimes(kind==="stop"?0:1);
  expect(h.deps.desktopComplete).toHaveBeenCalledTimes(kind==="stop"?0:1);
  expect(h.deps.completeStopped).toHaveBeenCalledTimes(kind==="stop"?1:0);
  expect(h.deps.inspect).not.toHaveBeenCalled();expect(h.deps.publicReady).not.toHaveBeenCalled();expect(h.deps.completeRunning).not.toHaveBeenCalled();
  expect(h.provider.dispatch).not.toHaveBeenCalled();
});
it.each(["same-boot","public","wrong-computer","pin","deadline","finalizer"])("retains desktop power operation after %s",async fault=>{
  const h=desktopSetup("restart",true);
  if(fault==="same-boot") h.deps.desktopInspect.mockResolvedValue({hostVerified:true,administratorAuthenticated:true,
    hostFingerprintSha256:h.f.host.fingerprintSha256,receipt:{bootId:beforeBootId,capability:h.capability}});
  if(fault==="public")h.deps.desktopPublicReady.mockResolvedValue(false);
  if(fault==="wrong-computer")h.capability.computerId=h.input.operationId;
  if(fault==="pin")h.deps.desktopInspect.mockResolvedValue({hostVerified:true,administratorAuthenticated:true,
    hostFingerprintSha256:"wrong",receipt:{bootId:afterBootId,capability:h.capability}});
  if(fault==="deadline")h.deps.desktopPublicReady.mockImplementation(async()=>{h.advance(30000);return true;});
  if(fault==="finalizer")h.deps.desktopComplete.mockResolvedValue(false);
  const run=advanceProviderAgentPower(h.input,"observe",h.deps);
  if(fault==="same-boot"||fault==="public")await expect(run).resolves.toBe(fault==="same-boot"?"reboot_pending":"public_access_pending");
  else await expect(run).rejects.toThrow("Provider power could not be verified");
  if(fault!=="finalizer")expect(h.deps.desktopComplete).not.toHaveBeenCalled();
  expect(h.deps.release).not.toHaveBeenCalled();expect(h.provider.dispatch).not.toHaveBeenCalled();
});
it.each(["start", "stop", "restart"] as const)("dispatches one exact %s request after durable intent, never a hard reset or second launch", async kind => {
  const h = setup(kind);
  expect(await advanceProviderAgentPower(h.input, "dispatch", h.deps)).toBe("action_pending");
  expect(h.provider.dispatch).toHaveBeenCalledTimes(1);
  expect(h.provider.dispatch).toHaveBeenCalledWith({ serverId: 42, kind });
  expect(h.deps.begin).toHaveBeenCalledWith(h.input, kind === "restart" ? beforeBootId : null);
  expect(h.deps.record).toHaveBeenCalledWith(h.input, { serverId: 42, kind }, h.action);
  expect(h.deps.begin.mock.invocationCallOrder[0]).toBeLessThan(h.provider.dispatch.mock.invocationCallOrder[0]);
  expect(h.deps.bootstrap).toHaveBeenCalledTimes(kind === "restart" ? 1 : 0);
  expect(h.deps.completeRunning).not.toHaveBeenCalled(); expect(h.deps.completeStopped).not.toHaveBeenCalled();
});
it.each(["start", "stop", "restart"] as const)("GET/DELETE observation never dispatches an unstarted %s", async kind => {
  const h = setup(kind);
  expect(await advanceProviderAgentPower(h.input, "observe", h.deps)).toBe("dispatch_pending");
  for (const unused of [h.deps.begin, h.deps.verify, h.deps.secret, h.deps.inspect, h.provider.dispatch]) expect(unused).not.toHaveBeenCalled();
});
it.each(["deleted", "expired", "wrong_state"])("cancels %s before dispatch without mutating the provider", async cause => {
  const h = setup();
  if (cause === "deleted") h.context.desiredState = "deleted";
  if (cause === "expired") h.wall(45_000);
  if (cause === "wrong_state") h.verified.powerState = "off";
  expect(await advanceProviderAgentPower(h.input, "dispatch", h.deps)).toBe("cancelled");
  expect(h.deps.cancel).toHaveBeenCalledWith(h.input);
  expect(h.provider.dispatch).not.toHaveBeenCalled(); expect(h.deps.begin).not.toHaveBeenCalled();
});
it("can restart an unhealthy runtime when the exact old boot is proved", async () => {
  const h = setup(); h.deps.inspect.mockResolvedValue({ hostVerified: true, administratorAuthenticated: true, hostFingerprintSha256: h.f.host.fingerprintSha256,
    receipt: { version: 1, ready: false, identity: h.identity, runtime: "codex", bootId: beforeBootId, reason: "runtime_unavailable" } });
  expect(await advanceProviderAgentPower(h.input, "dispatch", h.deps)).toBe("action_pending");
  expect(h.deps.begin).toHaveBeenCalledWith(h.input, beforeBootId); expect(h.deps.publicReady).not.toHaveBeenCalled();
});
it("does not dispatch a reboot without its original boot identity", async () => {
  const h = setup(); h.deps.inspect.mockResolvedValue({ hostVerified: true, administratorAuthenticated: true, hostFingerprintSha256: h.f.host.fingerprintSha256,
    receipt: { version: 1, ready: false, identity: h.identity, runtime: "codex", reason: "boot_unverified" } });
  expect(await advanceProviderAgentPower(h.input, "dispatch", h.deps)).toBe("runtime_pending");
  expect(h.deps.begin).not.toHaveBeenCalled(); expect(h.provider.dispatch).not.toHaveBeenCalled();
});
it.each(["start", "stop", "restart"] as const)("requires actual provider and runtime evidence before completing %s", async kind => {
  const h = setup(kind, true);
  expect(await advanceProviderAgentPower(h.input, "observe", h.deps)).toBe(kind === "stop" ? "stopped" : "running");
  expect(h.provider.dispatch).not.toHaveBeenCalled(); expect(h.deps.begin).not.toHaveBeenCalled();
  expect(h.provider.getAction).toHaveBeenCalledWith({ serverId: 42, kind, actionId: 701 });
  expect(h.deps.verifyResult).toHaveBeenCalledWith(h.input, { observedAt: h.verified.observedAt,
    status: kind === "stop" ? "off" : "running", bootId: kind === "stop" ? null : afterBootId, runtimeReady: kind !== "stop", publicReady: kind !== "stop" });
  if (kind === "stop") {
    expect(h.deps.completeStopped).toHaveBeenCalledWith({ ...h.input, expectedDesiredState: "stopped", status: "stopped" });
    expect(h.deps.bootstrap).not.toHaveBeenCalled(); expect(h.deps.inspect).not.toHaveBeenCalled(); expect(h.deps.publicReady).not.toHaveBeenCalled();
  } else {
    expect(h.deps.completeRunning).toHaveBeenCalledWith({ ...h.input, operationKind: kind, chatUrl: "https://box-fixture.hermesos.cloud", ip: h.verified.address,
      apiToken: "b".repeat(64), provisionedAt: "2026-08-28T02:00:00.000Z" });
    expect(h.deps.inspect).toHaveBeenCalledWith(expect.objectContaining({ captureBootId: true, identity: h.identity, hostPublicKey: h.f.host.publicKey }), expect.any(Object));
    expect(h.deps.publicReady.mock.invocationCallOrder[0]).toBeLessThan(h.deps.verifyResult.mock.invocationCallOrder[0]);
  }
});
it.each(["provider", "boot", "runtime", "public"])("does not declare a reboot complete while %s is unverified", async cause => {
  const h = setup("restart", true);
  if (cause === "provider") h.verified.powerState = "off";
  if (cause === "boot") h.deps.inspect.mockResolvedValue({ ...(await h.deps.inspect({} as never)), receipt: { version: 1, ready: true,
    identity: h.identity, runtime: "codex", apiToken: "b".repeat(64), bootId: beforeBootId } });
  if (cause === "runtime") h.deps.inspect.mockResolvedValue({ ...(await h.deps.inspect({} as never)), receipt: { version: 1, ready: false,
    identity: h.identity, runtime: "codex", reason: "authentication_unverified", bootId: afterBootId } });
  if (cause === "public") h.deps.publicReady.mockResolvedValue(false);
  expect(await advanceProviderAgentPower(h.input, "observe", h.deps)).toBe({ provider: "provider_pending", boot: "reboot_pending", runtime: "runtime_pending", public: "public_access_pending" }[cause]);
  for (const unused of [h.deps.verifyResult, h.deps.completeRunning, h.deps.completeStopped, h.deps.release]) expect(unused).not.toHaveBeenCalled();
});
it("retains an acknowledged ACPI shutdown while the computer is still on", async () => {
  const h = setup("stop", true); h.verified.powerState = "running";
  expect(await advanceProviderAgentPower(h.input, "observe", h.deps)).toBe("provider_pending");
  expect(h.deps.completeStopped).not.toHaveBeenCalled(); expect(h.provider.dispatch).not.toHaveBeenCalled();
});
it.each(["running", "success", "error"] as const)("deletion observes %s and releases only a terminal action", async status => {
  const h = setup("restart", true); h.context.desiredState = "deleted"; h.context.action!.status = status;
  h.provider.getAction.mockResolvedValue({ ...h.action, status } as never);
  expect(await advanceProviderAgentPower(h.input, "observe", h.deps)).toBe("cancellation_pending");
  expect(h.deps.release).toHaveBeenCalledTimes(status === "running" ? 0 : 1);
  expect(h.deps.verify).not.toHaveBeenCalled(); expect(h.deps.completeRunning).not.toHaveBeenCalled(); expect(h.deps.cancel).not.toHaveBeenCalled();
});
it("retains failed provider resources and records failure without pretending they stopped", async () => {
  const h = setup("stop", true); h.provider.getAction.mockResolvedValue({ ...h.action, status: "error" } as never);
  expect(await advanceProviderAgentPower(h.input, "observe", h.deps)).toBe("failed");
  expect(h.deps.release).toHaveBeenCalledWith(expect.objectContaining({ ...h.input, markError: true }));
  expect(h.deps.verify).not.toHaveBeenCalled(); expect(h.deps.completeStopped).not.toHaveBeenCalled();
});
it("retains an uncertain POST without retry on later explicit actions or status polls", async () => {
  const h = setup(); h.provider.dispatch.mockRejectedValue(new Error("private-provider-key"));
  expect(await advanceProviderAgentPower(h.input, "dispatch", h.deps)).toBe("request_uncertain");
  expect(await advanceProviderAgentPower(h.input, "observe", h.deps)).toBe("request_uncertain");
  expect(await advanceProviderAgentPower(h.input, "dispatch", h.deps)).toBe("request_uncertain");
  expect(h.provider.dispatch).toHaveBeenCalledTimes(1); expect(h.deps.begin).toHaveBeenCalledTimes(1);
  expect(h.deps.cancel).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
it("does not turn an observe-only grant into a second provider dispatch", async () => {
  const h = setup(); h.deps.begin.mockResolvedValue("observe");
  expect(await advanceProviderAgentPower(h.input, "dispatch", h.deps)).toBe("request_uncertain");
  expect(h.provider.dispatch).not.toHaveBeenCalled(); expect(h.deps.cancel).not.toHaveBeenCalled();
});
it("reports cancellation only if an unstarted rejected grant is actually cancelled", async () => {
  const h = setup(); h.deps.begin.mockResolvedValue("rejected");
  expect(await advanceProviderAgentPower(h.input, "dispatch", h.deps)).toBe("cancelled");
  expect(h.deps.cancel).toHaveBeenCalledWith(h.input); expect(h.provider.dispatch).not.toHaveBeenCalled();
  h.deps.cancel.mockResolvedValue(false);
  await expect(advanceProviderAgentPower(h.input, "dispatch", h.deps)).rejects.toThrow("could not be verified");
  expect(h.provider.dispatch).not.toHaveBeenCalled();
});
it("preserves a late dispatch grant as uncertain without sending after the fence", async () => {
  const h = setup();
  h.deps.begin.mockImplementation(async () => { h.context.dispatchIntentAt = h.context.createdAt; h.advance(30_000); return "dispatch"; });
  await expect(advanceProviderAgentPower(h.input, "dispatch", h.deps)).rejects.toThrow("could not be verified");
  h.advance(0);
  expect(await advanceProviderAgentPower(h.input, "observe", h.deps)).toBe("request_uncertain");
  expect(h.provider.dispatch).not.toHaveBeenCalled(); expect(h.deps.cancel).not.toHaveBeenCalled();
});
it("records a known POST receipt even when the transport finishes after the dispatch deadline", async () => {
  const h = setup(); h.provider.dispatch.mockImplementation(async () => { h.advance(30_100); return h.action; });
  expect(await advanceProviderAgentPower(h.input, "dispatch", h.deps)).toBe("action_pending");
  expect(h.deps.record).toHaveBeenCalledWith(h.input, { serverId: 42, kind: "restart" }, h.action);
  expect(h.deps.completeRunning).not.toHaveBeenCalled();
});
it.each(["begin", "secret", "verify", "inspect", "load"] as const)("does not dispatch after %s outlives the original monotonic fence", async step => {
  const h = setup(); const original = h.deps[step].getMockImplementation()!;
  // Typed mocks deliberately model a delayed dependency without renewing time.
  h.deps[step].mockImplementation((async (...args: never[]) => { const result = await (original as (...a: never[]) => unknown)(...args); h.advance(30_000); return result; }) as never);
  await expect(advanceProviderAgentPower(h.input, "dispatch", h.deps)).rejects.toThrow("could not be verified");
  expect(h.provider.dispatch).not.toHaveBeenCalled();
});
it.each(["scope", "hostname", "runtime", "identity", "operation", "targetId"])("rejects changed %s before dispatch", async field => {
  const h = setup(); let n = 0;
  h.deps.load.mockImplementation(async () => {
    const next = structuredClone(h.context);
    if (++n === 2) {
      if (field === "scope") next.scope.providerServerId = "43";
      else if (field === "identity") next.identity.operationId = h.input.operationId;
      else if (field === "operation") next.operation.userId = "other";
      else Object.assign(next, { [field]: "changed" });
    }
    return next;
  });
  await expect(advanceProviderAgentPower(h.input, "dispatch", h.deps)).rejects.toThrow("could not be verified");
  expect(h.deps.begin).not.toHaveBeenCalled(); expect(h.provider.dispatch).not.toHaveBeenCalled();
});
it.each(["pin", "action", "record", "proof", "complete"])("rejects failed %s without publishing success", async field => {
  const h = setup("start", true);
  if (field === "pin") h.deps.inspect.mockResolvedValue({ ...(await h.deps.inspect({} as never)), hostFingerprintSha256: "different" });
  if (field === "action") h.provider.getAction.mockResolvedValue({ ...h.action, id: 999, status: "success" });
  if (field === "record") h.deps.record.mockResolvedValue(false);
  if (field === "proof") h.deps.verifyResult.mockResolvedValue(false);
  if (field === "complete") h.deps.completeRunning.mockResolvedValue(false);
  await expect(advanceProviderAgentPower(h.input, "observe", h.deps)).rejects.toThrow("could not be verified");
  expect(h.provider.dispatch).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
it("honors deletion arriving after public verification without overwriting it", async () => {
  const h = setup("restart", true); h.deps.publicReady.mockImplementation(async () => { h.context.desiredState = "deleted"; return true; });
  expect(await advanceProviderAgentPower(h.input, "observe", h.deps)).toBe("cancellation_pending");
  expect(h.deps.verifyResult).not.toHaveBeenCalled(); expect(h.deps.completeRunning).not.toHaveBeenCalled();
});
it("fails closed on invalid mode, owner, credential revision or secret failures", async () => {
  const h = setup();
  await expect(advanceProviderAgentPower(h.input, "poweroff" as never, h.deps)).rejects.toThrow("could not be verified");
  await expect(advanceProviderAgentPower({ ...h.input, userId: "" }, "dispatch", h.deps)).rejects.toThrow("could not be verified");
  expect(h.deps.load).not.toHaveBeenCalled();
  h.deps.secret.mockResolvedValue({ ...(await h.deps.secret()), revision: 8 });
  await expect(advanceProviderAgentPower(h.input, "dispatch", h.deps)).rejects.toThrow("could not be verified");
  h.deps.secret.mockRejectedValue(new Error("PRIVATE_TOKEN"));
  await expect(advanceProviderAgentPower(h.input, "dispatch", h.deps)).rejects.toThrow("Provider power could not be verified; the original computer and operation are retained.");
  expect(h.provider.dispatch).not.toHaveBeenCalled();
});
