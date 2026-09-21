import { advanceFirstBoot } from "../first-boot-coordinator";
import { receiverFixture, firstBootNow } from "./first-boot-receiver.fixtures";
import { firstBootFirewallRequest, type FirstBootFirewall } from "@/lib/hetzner/first-boot-firewall";
import type { FirstBootOperation } from "../first-boot-operations";
import type { HetznerAction } from "@/lib/hetzner/client";

function setup() {
  const f = receiverFixture();
  const scope = { binding: f.binding, providerServerId: "42" };
  const lease = { ...scope, leaseId: "55555555-5555-4555-8555-555555555555" };
  const operation: FirstBootOperation = { ...scope, leaseId: lease.leaseId,
    leaseExpiresAt: new Date(firstBootNow.getTime() + 120_000).toISOString(),
    firewallPostAttemptedAt: null, firewallReceipt: null, firewallVerifiedAt: null,
    powerOnPostAttemptedAt: null, powerOnAction: null, abandonedAt: null };
  const firewallScope = { orderId: f.binding.orderId, attemptId: f.binding.attemptId,
    quoteFingerprint: f.binding.quoteFingerprint, serverId: 42 };
  const recipe = firstBootFirewallRequest(firewallScope);
  const firewall: FirstBootFirewall = { id: 91, name: recipe.name, labels: recipe.labels,
    created: firstBootNow.toISOString(),
    rules: recipe.rules.map(rule => ({ ...rule, destination_ips: [] })),
    applied_to: [{ type: "server", server: { id: 42 } }] };
  const receipt = { version: 1 as const, scope: firewallScope, firewallId: 91,
    createdAt: firewall.created, setRulesActionId: 601, applyActionId: 602 };
  const actions: Record<number, HetznerAction> = {
    500: f.action,
    601: { id: 601, command: "set_firewall_rules", status: "success", resources: [{ id: 91, type: "firewall" }] },
    602: { id: 602, command: "apply_firewall", status: "success", resources: [{ id: 91, type: "firewall" }, { id: 42, type: "server" }] },
    603: { id: 603, command: "start_server", status: "running", resources: [{ id: 42, type: "server" }] },
  };
  f.server.status = "off"; f.server.public_net.firewalls = [];
  f.stored.phase = "staged"; f.stored.providerServerId = null;
  const dispatches: string[] = [];
  const client = {
    getServer: jest.fn(async () => structuredClone(f.server)),
    getAction: jest.fn(async (id: number) => structuredClone(actions[id])),
    getFirewall: jest.fn(async () => structuredClone(firewall) as unknown | null),
    createFirewall: jest.fn(async () => {
      dispatches.push("POST firewall");
      f.server.public_net.firewalls = [{ id: 91, status: "applied" }];
      return structuredClone(receipt);
    }),
    powerOnServer: jest.fn(async () => { dispatches.push("POST power"); f.server.status = "starting"; return structuredClone(actions[603]); }),
  };
  const deps = {
    claim: jest.fn(async () => ({ outcome: "claimed" as const, lease: structuredClone(lease), operation: structuredClone(operation) })),
    evidence: jest.fn(async () => structuredClone(f.evidence)),
    enrollment: jest.fn(async () => structuredClone(f.stored)),
    secret: jest.fn(async () => ({ connection: { id: f.binding.connectionId, status: "ready" }, revision: 7, apiToken: "owner-project-only" }) as Awaited<ReturnType<typeof import("../hetzner-cloud-store").loadHetznerCloudConnectionSecret>>),
    client: jest.fn(() => client),
    markFirewall: jest.fn(async () => { dispatches.push("mark firewall"); operation.firewallPostAttemptedAt = firstBootNow.toISOString(); return true; }),
    saveFirewall: jest.fn(async (_lease, value) => { dispatches.push("save firewall"); operation.firewallReceipt = structuredClone(value); return true; }),
    verifyFirewall: jest.fn(async (_lease, _receipt, observedAt) => { operation.firewallVerifiedAt = observedAt.toISOString(); return true; }),
    arm: jest.fn(async () => { f.stored.phase = "awaiting_identity"; f.stored.providerServerId = "42"; return true; }),
    markPower: jest.fn(async () => { dispatches.push("mark power"); operation.powerOnPostAttemptedAt = firstBootNow.toISOString(); return true; }),
    savePower: jest.fn(async (_lease, value) => { dispatches.push("save power"); operation.powerOnAction = structuredClone(value); return true; }),
    release: jest.fn(async () => true), now: jest.fn(() => firstBootNow), monotonicNow: jest.fn(() => 0),
  };
  return { ...f, scope, lease, operation, firewall, receipt, actions, client, deps, dispatches };
}

it.each([false, true])("advances staged setup without claiming ready (source image: %s)", async includeImage => {
  const h = setup();
  if (includeImage) h.actions[500].resources.push({ id: h.server.image!.id, type: "image" });
  expect(await advanceFirstBoot(h.scope, h.deps)).toEqual({ stage: "firewall_requested" });
  expect(h.dispatches).toEqual(["mark firewall", "POST firewall", "save firewall"]);
  expect(await advanceFirstBoot(h.scope, h.deps)).toEqual({ stage: "power_requested" });
  expect(h.dispatches).toEqual(["mark firewall", "POST firewall", "save firewall", "mark power", "POST power", "save power"]);
  expect(await advanceFirstBoot(h.scope, h.deps)).toEqual({ stage: "waiting_for_power" });
  h.actions[603].status = "success"; h.server.status = "running";
  expect(await advanceFirstBoot(h.scope, h.deps)).toEqual({ stage: "waiting_for_identity" });
  h.stored.phase = "enrolled"; h.stored.enrolledHostPublicKey = h.host.publicKey; h.stored.hostFingerprintSha256 = h.host.fingerprintSha256;
  h.deps.secret.mockClear();
  expect(await advanceFirstBoot(h.scope, h.deps)).toEqual({ stage: "identity_enrolled" });
  expect(h.client.createFirewall).toHaveBeenCalledTimes(1);
  expect(h.client.powerOnServer).toHaveBeenCalledTimes(1);
  expect(h.deps.secret).not.toHaveBeenCalled();
  expect(h.deps.release).toHaveBeenCalledTimes(5);
  expect(h.deps.arm).toHaveBeenCalledWith({ binding: h.binding,
    capacityIdempotencyKey: h.stored.capacityIdempotencyKey, creationReceipt: h.evidence.provider_creation_receipt });
  expect(h.deps.client).toHaveBeenCalledWith("owner-project-only");
});
it.each(["busy", "rejected"])("does no I/O without an owned claim: %s", async outcome => {
  const h = setup(); h.deps.claim.mockResolvedValue({ outcome } as never);
  if (outcome === "busy") expect(await advanceFirstBoot(h.scope, h.deps)).toEqual({ stage: "busy" });
  else await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toMatchObject({ code: "rejected" });
  expect(h.deps.evidence).not.toHaveBeenCalled(); expect(h.deps.secret).not.toHaveBeenCalled(); expect(h.deps.release).not.toHaveBeenCalled();
});
it.each(["owner", "revision", "receipt", "phase", "enrollment", "credential"])("rejects changed %s before provider dispatch", async change => {
  const h = setup();
  if (change === "owner") h.evidence.user_id = "other";
  if (change === "revision") h.evidence.connection_revision = 8;
  if (change === "receipt") h.evidence.provider_creation_receipt.serverId = "43";
  if (change === "phase") h.stored.phase = "revoked";
  if (change === "enrollment") h.stored.challenge.binding = { ...h.binding, quoteFingerprint: "b".repeat(64) };
  if (change === "credential") h.deps.secret.mockResolvedValue({ connection: { id: h.binding.connectionId, status: "ready" }, revision: 8, apiToken: "rotated" } as never);
  await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toThrow("First-boot step stopped");
  expect(h.deps.client).not.toHaveBeenCalled(); expect(h.deps.release).toHaveBeenCalledWith(h.lease);
});
it("reports invalid capacity binding as changed evidence, not a provider outage", async () => {
  const h = setup(); h.evidence.active_connection_id = "66666666-6666-4666-8666-666666666666";
  await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toMatchObject({ code: "resource_changed" });
  expect(h.deps.secret).not.toHaveBeenCalled();
});
it.each(["claim", "credential", "initial_read", "marker", "final_read"])("never dispatches after a slow %s exhausts the local deadline", async delayed => {
  const h = setup();
  if (delayed === "claim") h.deps.monotonicNow.mockReturnValueOnce(0).mockReturnValue(30_000);
  if (delayed === "credential") {
    const original = h.deps.secret.getMockImplementation()!;
    h.deps.secret.mockImplementation(async () => { h.deps.monotonicNow.mockReturnValue(30_000); return original(); });
  }
  if (delayed === "marker") h.deps.markFirewall.mockImplementation(async () => { h.deps.monotonicNow.mockReturnValue(30_000); return true; });
  if (delayed.endsWith("read")) {
    let reads = 0;
    h.client.getServer.mockImplementation(async () => {
      if (++reads === (delayed === "initial_read" ? 1 : 2)) h.deps.monotonicNow.mockReturnValue(120_001);
      return structuredClone(h.server);
    });
  }
  await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toMatchObject({ code: "deadline_expired" });
  expect(h.client.createFirewall).not.toHaveBeenCalled(); expect(h.client.powerOnServer).not.toHaveBeenCalled();
  expect(h.deps.release).toHaveBeenCalledTimes(1);
});
it("requires the persisted dispatch marker and an intact final server observation before firewall POST", async () => {
  for (const kind of ["marker", "changed_after_marker"]) {
    const h = setup();
    h.deps.markFirewall.mockImplementation(async () => {
      if (kind === "changed_after_marker") h.server.public_net.firewalls = [{ id: 92, status: "applied" }];
      return kind !== "marker";
    });
    await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toThrow("First-boot step stopped");
    expect(h.client.createFirewall).not.toHaveBeenCalled();
  }
});
it("retains unknown firewall outcome after a lost POST response and never retries or adopts it", async () => {
  const h = setup(); h.client.createFirewall.mockRejectedValue(new Error("private provider request detail"));
  await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toThrow("First-boot step stopped: provider_unavailable");
  expect(h.operation.firewallPostAttemptedAt).not.toBeNull();
  expect(await advanceFirstBoot(h.scope, h.deps)).toEqual({ stage: "firewall_outcome_unknown" });
  expect(h.client.createFirewall).toHaveBeenCalledTimes(1); expect(h.deps.saveFirewall).not.toHaveBeenCalled();
});
it("waits only for intact provider transitions and keeps failures dominant over pending state", async () => {
  const h = setup(); h.server.locked = true;
  expect(await advanceFirstBoot(h.scope, h.deps)).toEqual({ stage: "waiting_for_capacity" });
  h.server.volumes = [99];
  await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toMatchObject({ code: "resource_changed" });
  expect(h.deps.markFirewall).not.toHaveBeenCalled();
});
it("waits for the exact firewall apply without starting the server", async () => {
  const h = setup(); await advanceFirstBoot(h.scope, h.deps);
  h.actions[602].status = "running";
  expect(await advanceFirstBoot(h.scope, h.deps)).toEqual({ stage: "waiting_for_firewall" });
  expect(h.deps.arm).not.toHaveBeenCalled(); expect(h.client.powerOnServer).not.toHaveBeenCalled();
  h.actions[602].status = "error";
  await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toMatchObject({ code: "action_failed" });
});
it.each(["arm", "verifyFirewall", "markPower"] as const)("does not power on when %s refuses authority", async method => {
  const h = setup(); await advanceFirstBoot(h.scope, h.deps);
  h.deps[method].mockResolvedValue(false);
  await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toMatchObject({ code: "checkpoint_failed" });
  expect(h.client.powerOnServer).not.toHaveBeenCalled();
});
it.each(["firewall_changed", "server_changed", "slow_get", "enrollment_expired"])("rechecks %s after power checkpoint and before POST", async change => {
  const h = setup(); await advanceFirstBoot(h.scope, h.deps);
  h.deps.markPower.mockImplementation(async () => {
    if (change === "firewall_changed") h.firewall.rules[0].source_ips = ["192.0.2.0/24", "::/0"];
    if (change === "server_changed") h.server.image!.id = 200;
    if (change === "enrollment_expired") h.deps.now.mockReturnValue(new Date(firstBootNow.getTime() + 900_000));
    if (change === "slow_get") h.client.getFirewall.mockImplementation(async () => { h.deps.monotonicNow.mockReturnValue(120_001); return structuredClone(h.firewall); });
    return true;
  });
  await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toThrow("First-boot step stopped");
  expect(h.client.powerOnServer).not.toHaveBeenCalled();
});
it("retains unknown power outcome without replay after a lost response", async () => {
  const h = setup(); await advanceFirstBoot(h.scope, h.deps);
  h.client.powerOnServer.mockRejectedValue(new Error("lost response"));
  await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toMatchObject({ code: "provider_unavailable" });
  expect(await advanceFirstBoot(h.scope, h.deps)).toEqual({ stage: "power_outcome_unknown" });
  expect(h.client.powerOnServer).toHaveBeenCalledTimes(1);
});
it("persists an originally failed power action and reports the failure on the same request", async () => {
  const h = setup(); await advanceFirstBoot(h.scope, h.deps);
  h.actions[603].status = "error";
  await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toMatchObject({ code: "action_failed" });
  expect(h.operation.powerOnAction?.status).toBe("error");
  expect(h.client.powerOnServer).toHaveBeenCalledTimes(1);
  await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toMatchObject({ code: "action_failed" });
  expect(h.client.powerOnServer).toHaveBeenCalledTimes(1);
});
it("does not report a completed step if receipt persistence or lease release fails", async () => {
  for (const method of ["saveFirewall", "release"] as const) {
    const h = setup(); h.deps[method].mockRejectedValue(new Error("private database detail"));
    await expect(advanceFirstBoot(h.scope, h.deps)).rejects.toThrow("First-boot step stopped");
    expect(h.client.createFirewall).toHaveBeenCalledTimes(1);
    expect(h.deps.release).toHaveBeenCalledTimes(1);
  }
});
