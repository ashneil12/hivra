import { advanceHetznerCleanup, previewHetznerCleanup } from "../hetzner-cleanup";
import { hetznerCleanupManifest } from "../hetzner-cleanup-policy";
import { HETZNER_CLEANUP_CONFIRMATION, HETZNER_FIRST_BOOT_CLEANUP_CONFIRMATION } from "../hetzner-cleanup-contracts";
import { cleanupFixture, firstBootCleanupFixture, cleanupConnection, cleanupOrder, cleanupKey } from "./hetzner-cleanup.fixtures";
import type { HetznerCloudConnectionDto } from "../contracts";
import type { FirstBootFirewall } from "@/lib/hetzner/first-boot-firewall";
import { log } from "@/lib/logger";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

function harness(withFirstBoot = false) {
  const fixture = withFirstBoot ? firstBootCleanupFixture() : { ...cleanupFixture(), firstBoot: null };
  const { order, firstBoot } = fixture;
  const snapshot = fixture.snapshot as typeof fixture.snapshot & { firewall?: FirstBootFirewall | null };
  const manifest = hetznerCleanupManifest(order, firstBoot);
  const request = { orderId: cleanupOrder, idempotencyKey: cleanupKey, fingerprint: manifest.fingerprint,
    serverName: manifest.serverName, confirmation: withFirstBoot ? HETZNER_FIRST_BOOT_CLEANUP_CONFIRMATION : HETZNER_CLEANUP_CONFIRMATION };
  const client = {
    getServer: jest.fn(async () => structuredClone(snapshot.server)),
    getPrimaryIp: jest.fn(async id => structuredClone(id === 88 ? snapshot.ipv4 : snapshot.ipv6)),
    getSshKey: jest.fn(async () => structuredClone(snapshot.sshKey)),
    deleteServer: jest.fn(async () => {
      snapshot.server = null; snapshot.ipv4!.assignee_id = null; snapshot.ipv6!.assignee_id = null;
      snapshot.ipv4!.assignee_type = "unassigned"; snapshot.ipv6!.assignee_type = "unassigned";
      if (snapshot.firewall) snapshot.firewall.applied_to = [];
      return { id: 501, command: "delete_server", status: "success" as const, resources: [{ id: 42, type: "server" }] };
    }),
    deletePrimaryIp: jest.fn(async id => { if (id === 88) snapshot.ipv4 = null; else snapshot.ipv6 = null; }),
    deleteSshKey: jest.fn(async () => { snapshot.sshKey = null; }),
  };
  const firewallClient = {
    getFirewall: jest.fn(async () => structuredClone(snapshot.firewall ?? null)),
    deleteFirewall: jest.fn(async () => { snapshot.firewall = null; }),
    // Real boot clients have a different 404 contract and extra mutation methods.
    // Neither must leak into the cleanup client's resource reader.
    getServer: jest.fn(async () => { throw new Error("must use cleanup reader"); }),
    powerOnServer: jest.fn(), createFirewall: jest.fn(),
  };
  const deps = {
    loadFirstBoot: jest.fn(async () => structuredClone(firstBoot)),
    retireUnused: jest.fn(async () => true),
    firstBootClient: jest.fn(() => firewallClient),
    monotonicNow: jest.fn(() => 0),
    loadOrder: jest.fn(async () => structuredClone(order)),
    loadSecret: jest.fn(async () => ({ connection: { status: "ready" } as HetznerCloudConnectionDto, revision: 7, apiToken: "owner-project-only" })),
    client: jest.fn(() => client),
    newId: () => "44444444-4444-4444-8444-444444444444",
    claim: jest.fn(async () => {
      order.operation.status = "cleaning";
      order.cleanupFirewallReceipt = firstBoot?.firewallReceipt ?? null;
      order.cleanup ??= { idempotencyKey: cleanupKey, fingerprint: manifest.fingerprint,
        absence: { server: false, ipv4: false, ipv6: false, sshKey: false, ...(withFirstBoot ? { firewall: false } : {}) }, error: null,
        startedAt: "2026-08-27T16:00:00Z", observedAt: null, finishedAt: null };
      return { outcome: "claimed" as const, order: structuredClone(order) };
    }),
    verifyLease: jest.fn(async () => true),
    record: jest.fn(async input => {
      order.cleanup!.absence = input.absence; order.cleanup!.error = input.error;
      order.cleanup!.observedAt = "2026-08-27T16:01:00Z";
      if (!input.error && Object.values(input.absence).every(Boolean)) {
        order.operation.status = "deleted"; order.cleanup!.finishedAt = "2026-08-27T16:01:00Z";
      }
      return structuredClone(order);
    }),
  };
  return { order, snapshot, request, client, firewallClient, firstBoot, deps };
}

describe("durable scoped cleanup orchestration", () => {
  it("retires only a confirmed original unused provider target before cleanup admission", async () => {
    const h = harness(true);
    await previewHetznerCleanup("owner", cleanupConnection, cleanupOrder, h.deps);
    expect(h.deps.retireUnused).not.toHaveBeenCalled();
    await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(h.deps.retireUnused).toHaveBeenCalledWith({ userId: "owner", connectionId: cleanupConnection,
      expectedRevision: 7, orderId: cleanupOrder, providerServerId: "42" });
    expect(h.deps.retireUnused.mock.invocationCallOrder[0]).toBeLessThan(h.deps.claim.mock.invocationCallOrder[0]);
  });
  it("cannot clean a computer retained by an agent or setup lease", async () => {
    const h = harness(true); h.deps.retireUnused.mockResolvedValue(false);
    await expect(advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps)).rejects.toMatchObject({ code: "target_in_use" });
    expect(h.deps.claim).not.toHaveBeenCalled(); expect(h.client.deleteServer).not.toHaveBeenCalled();
  });
  it("cannot retire before the full original-resource confirmation matches", async () => {
    const h = harness(true);
    await expect(advanceHetznerCleanup("owner", cleanupConnection, { ...h.request, serverName: "hivra-" + "f".repeat(20) }, h.deps)).rejects.toMatchObject({ code: "confirmation_changed" });
    expect(h.deps.retireUnused).not.toHaveBeenCalled();
  });
  it("previews without a claim, a mutation or bootstrap-private-key load", async () => {
    const h = harness();
    const result = await previewHetznerCleanup("owner",cleanupConnection,cleanupOrder,h.deps);
    expect(result.eligible).toBe(true);
    expect(h.deps.claim).not.toHaveBeenCalled();
    expect(h.client.deleteServer).not.toHaveBeenCalled();
    expect(h.deps.client).toHaveBeenCalledWith("owner-project-only");
  });
  it("removes one exact resource per pass and completes only after four fresh absence reads", async () => {
    const h = harness();
    for (const expected of ["cleaning","cleaning","cleaning","deleted"]) {
      expect((await advanceHetznerCleanup("owner",cleanupConnection,h.request,h.deps)).status).toBe(expected);
    }
    expect(h.client.deleteServer).toHaveBeenCalledTimes(1);
    expect(h.client.deletePrimaryIp.mock.calls.map(([id])=>id)).toEqual([88,89]);
    expect(h.client.deleteSshKey).toHaveBeenCalledTimes(1);
    expect(h.client.getServer).toHaveBeenCalledTimes(12);
    expect(h.order.cleanup!.absence).toEqual({server:true,ipv4:true,ipv6:true,sshKey:true});
  });
  it("reconciles a lost delete response without replaying the server deletion", async () => {
    const h = harness();
    h.client.deleteServer.mockImplementationOnce(async () => {
      h.snapshot.server=null; h.snapshot.ipv4!.assignee_id=null; h.snapshot.ipv6!.assignee_id=null;
      h.snapshot.ipv4!.assignee_type="unassigned"; h.snapshot.ipv6!.assignee_type="unassigned";
      throw new Error("lost response containing no recoverable outcome");
    });
    const lost = await advanceHetznerCleanup("owner",cleanupConnection,h.request,h.deps);
    expect(lost.status).toBe("cleaning");
    expect(lost.cleanup?.error).toBe("provider_unavailable");
    await advanceHetznerCleanup("owner",cleanupConnection,h.request,h.deps);
    expect(h.client.deleteServer).toHaveBeenCalledTimes(1);
    expect(h.client.deletePrimaryIp).toHaveBeenCalledWith(88);
  });
  it("waits for asynchronous server removal and firewall detach without replaying deletes", async () => {
    const h = harness(true);
    h.client.deleteServer.mockImplementationOnce(async () => {
      h.snapshot.server!.status = "deleting";
      return { id: 501, command: "delete_server", status: "success", resources: [{ id: 42, type: "server" }] };
    });
    for (let pass = 0; pass < 2; pass++) {
      const result = await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
      expect(result.status).toBe("cleaning"); expect(result.cleanup?.error).toBe("resource_busy");
    }
    expect(h.client.deleteServer).toHaveBeenCalledTimes(1);
    expect(h.client.deletePrimaryIp).not.toHaveBeenCalled();
    h.snapshot.server = null; h.snapshot.ipv4 = null; h.snapshot.ipv6 = null;
    expect((await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps)).cleanup?.error).toBe("resource_busy");
    expect(h.firewallClient.deleteFirewall).not.toHaveBeenCalled(); expect(h.client.deleteSshKey).not.toHaveBeenCalled();
    h.snapshot.firewall!.applied_to = [];
    for (let pass = 0; pass < 2; pass++) await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(h.order.operation.status).toBe("deleted");
    expect(h.order.cleanup!.absence).toEqual({ server: true, ipv4: true, ipv6: true, sshKey: true, firewall: true });
    expect(h.client.deleteServer).toHaveBeenCalledTimes(1);
    expect(h.firewallClient.deleteFirewall).toHaveBeenCalledTimes(1); expect(h.client.deleteSshKey).toHaveBeenCalledTimes(1);
  });
  it("does not use an expired lease or a rotated credential", async () => {
    for (const kind of ["lease","credential"]) {
      const h = harness();
      if (kind === "lease") h.deps.verifyLease.mockResolvedValue(false);
      else h.deps.loadSecret.mockResolvedValue({connection:{status:"ready"} as HetznerCloudConnectionDto,revision:8,apiToken:"rotated"});
      const result = await advanceHetznerCleanup("owner",cleanupConnection,h.request,h.deps);
      expect(result.cleanup?.error).toBe("connection_changed");
      expect(h.client.deleteServer).not.toHaveBeenCalled();
    }
  });
  it("waits for original IP relationships to settle after asynchronous server deletion", async () => {
    const h = harness(true);
    h.client.deleteServer.mockImplementationOnce(async () => {
      h.snapshot.server = null;
      h.snapshot.firewall!.applied_to = [];
      // Independent provider GETs can still return the original assigned IPs.
      return { id: 501, command: "delete_server", status: "success", resources: [{ id: 42, type: "server" }] };
    });
    for (let pass = 0; pass < 2; pass++) {
      const result = await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
      expect(result.cleanup?.error).toBe("resource_busy");
      expect(result.cleanup?.absence).toEqual({ server: false, ipv4: false, ipv6: false, sshKey: false, firewall: false });
    }
    expect(h.client.deleteServer).toHaveBeenCalledTimes(1);
    expect(h.firewallClient.deleteFirewall).not.toHaveBeenCalled();
    expect(h.client.deletePrimaryIp).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("Original provider cleanup paused after observation", {
      source: "hetzner-cleanup", requestId: cleanupOrder,
      failureType: "resource_busy", observation: "server_ip_relationship",
    });
    h.snapshot.ipv4 = null; h.snapshot.ipv6 = null;
    for (let pass = 0; pass < 2; pass++) await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(h.order.operation.status).toBe("deleted");
    expect(h.firewallClient.deleteFirewall).toHaveBeenCalledTimes(1);
    expect(h.client.deleteSshKey).toHaveBeenCalledTimes(1);
    expect(h.client.deleteServer).toHaveBeenCalledTimes(1);
  });
  it("does not mutate when the final server refresh disagrees with earlier IP reads", async () => {
    const h = harness(true);
    h.client.getServer.mockResolvedValueOnce(structuredClone(h.snapshot.server)).mockResolvedValue(null);
    h.firewallClient.getFirewall.mockResolvedValueOnce(structuredClone(h.snapshot.firewall!))
      .mockResolvedValue({ ...h.snapshot.firewall!, applied_to: [] });
    const result = await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(result.cleanup?.error).toBe("resource_busy");
    expect(h.client.deleteServer).not.toHaveBeenCalled();
    expect(h.firewallClient.deleteFirewall).not.toHaveBeenCalled();
    expect(h.client.deletePrimaryIp).not.toHaveBeenCalled();
    expect(h.client.deleteSshKey).not.toHaveBeenCalled();
  });
  it("rejects reappearance before treating an original relationship as pending", async () => {
    const h = harness(true);
    await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(h.order.cleanup!.absence.server).toBe(true);
    h.snapshot.server = firstBootCleanupFixture().snapshot.server;
    h.snapshot.ipv4 = null;
    const result = await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(result.cleanup?.error).toBe("resource_changed");
    expect(h.client.deleteServer).toHaveBeenCalledTimes(1);
    expect(h.firewallClient.deleteFirewall).not.toHaveBeenCalled();
  });
  it("rechecks provider state after lease verification, not before it", async () => {
    const h=harness();
    h.deps.verifyLease.mockImplementation(async()=>{h.snapshot.server!.status="running";return true;});
    const result=await advanceHetznerCleanup("owner",cleanupConnection,h.request,h.deps);
    expect(result.cleanup?.error).toBe("resource_changed");
    expect(h.client.deleteServer).not.toHaveBeenCalled();
  });
  it("rechecks the target after waiting for sibling resource reads", async () => {
    const h=harness();
    h.client.getSshKey.mockImplementation(async()=>{h.snapshot.server!.status="running";return structuredClone(h.snapshot.sshKey);});
    const result=await advanceHetznerCleanup("owner",cleanupConnection,h.request,h.deps);
    expect(result.cleanup?.error).toBe("resource_changed");
    expect(h.client.deleteServer).not.toHaveBeenCalled();
  });
  it("rejects a changed confirmation before claiming or decrypting credentials", async () => {
    const h = harness();
    await expect(advanceHetznerCleanup("owner",cleanupConnection,{...h.request,fingerprint:"b".repeat(64)},h.deps)).rejects.toThrow("confirmation_changed");
    expect(h.deps.claim).not.toHaveBeenCalled(); expect(h.deps.loadSecret).not.toHaveBeenCalled();
  });
  it("anchors the mutation deadline before a slow database claim", async () => {
    const h = harness();
    const claim = h.deps.claim.getMockImplementation()!;
    h.deps.claim.mockImplementation(async () => {
      const result = await claim();
      h.deps.monotonicNow.mockReturnValue(45_000);
      return result;
    });
    const result = await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(result.cleanup?.error).toBe("connection_changed");
    expect(h.deps.loadSecret).not.toHaveBeenCalled();
    expect(h.client.deleteServer).not.toHaveBeenCalled();
  });
  it.each(["server", "ipv4", "ipv6", "sshKey"] as const)(
    "never deletes %s when the final awaited guard outlives the mutation window",
    async kind => {
      const h = harness();
      if (kind !== "server") {
        h.snapshot.server = null;
        for (const ip of [h.snapshot.ipv4!, h.snapshot.ipv6!]) {
          ip.assignee_id = null;
          ip.assignee_type = "unassigned";
        }
      }
      if (kind === "ipv6" || kind === "sshKey") h.snapshot.ipv4 = null;
      if (kind === "sshKey") h.snapshot.ipv6 = null;
      let reads = 0;
      h.client.getServer.mockImplementation(async () => {
        reads += 1;
        // The initial inspection succeeds; the final target/dependency GET
        // resumes after another request could abandon the expired DB lease.
        if (reads === 2) h.deps.monotonicNow.mockReturnValue(120_001);
        return structuredClone(h.snapshot.server);
      });
      const result = await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
      expect(result.cleanup?.error).toBe("connection_changed");
      expect(h.client.deleteServer).not.toHaveBeenCalled();
      expect(h.client.deletePrimaryIp).not.toHaveBeenCalled();
      expect(h.client.deleteSshKey).not.toHaveBeenCalled();
    },
  );
  it("stops after a slow initial inspection without another provider round", async () => {
    const h = harness();
    h.client.getSshKey.mockImplementation(async () => {
      h.deps.monotonicNow.mockReturnValue(45_000);
      return structuredClone(h.snapshot.sshKey);
    });
    const result = await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(result.cleanup?.error).toBe("connection_changed");
    expect(h.client.getServer).toHaveBeenCalledTimes(1);
    expect(h.client.deleteServer).not.toHaveBeenCalled();
  });
  it("cannot delete a retained IP after another server takes it", async () => {
    const h = harness();
    await advanceHetznerCleanup("owner",cleanupConnection,h.request,h.deps);
    h.snapshot.ipv4!.assignee_id=99;
    const result = await advanceHetznerCleanup("owner",cleanupConnection,h.request,h.deps);
    expect(result.cleanup?.error).toBe("resource_changed");
    expect(h.client.deletePrimaryIp).not.toHaveBeenCalled();
    expect(h.client.deleteSshKey).not.toHaveBeenCalled();
  });
  it("never turns a failed inspection into provider absence", async () => {
    const h = harness();
    h.client.getPrimaryIp.mockRejectedValue(new Error("forbidden"));
    const result = await advanceHetznerCleanup("owner",cleanupConnection,h.request,h.deps);
    expect(result.cleanup?.absence).toEqual({server:false,ipv4:false,ipv6:false,sshKey:false});
    expect(h.client.deleteServer).not.toHaveBeenCalled();
  });
  it("keeps the provider claim unresolved if the final database write fails", async () => {
    const h = harness(); h.deps.record.mockRejectedValue(new Error("database unavailable"));
    await expect(advanceHetznerCleanup("owner",cleanupConnection,h.request,h.deps)).rejects.toThrow("database unavailable");
    expect(h.order.operation.status).toBe("cleaning");
  });
});

describe("five-resource first-boot cleanup orchestration", () => {
  it("previews the exact fifth resource without dispatch or private-key retrieval", async () => {
    const h = harness(true);
    const preview = await previewHetznerCleanup("owner", cleanupConnection, cleanupOrder, h.deps);
    expect(preview.resources).toEqual({ server: "42", firewall: "91", ipv4: "88", ipv6: "89", sshKey: "77" });
    expect(preview.observedAbsence).toEqual({ server: false, firewall: false, ipv4: false, ipv6: false, sshKey: false });
    expect(h.deps.loadFirstBoot).toHaveBeenCalledWith({ binding: {
      userId: "owner", connectionId: cleanupConnection, connectionRevision: 7, orderId: cleanupOrder,
      // Order-only: the attempt and its recipe come from the original records.
      quoteFingerprint: "a".repeat(64),
    }, providerServerId: "42" });
    expect(h.deps.claim).not.toHaveBeenCalled();
    expect(h.client.deleteServer).not.toHaveBeenCalled();
    expect(h.firewallClient.getServer).not.toHaveBeenCalled();
  });
  it("deletes the started server, firewall, IPs and key one at a time, then proves all five absent", async () => {
    const h = harness(true);
    const dispatches: string[] = [];
    for (const [name, method] of [["server", h.client.deleteServer], ["firewall", h.firewallClient.deleteFirewall],
      ["ip", h.client.deletePrimaryIp], ["key", h.client.deleteSshKey]] as const) {
      const original = method.getMockImplementation()!;
      method.mockImplementation((async (...args: never[]) => {
        dispatches.push(name); return (original as (...params: never[]) => unknown)(...args);
      }) as never);
    }
    for (const expected of ["cleaning", "cleaning", "cleaning", "cleaning", "deleted"]) {
      expect((await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps)).status).toBe(expected);
    }
    expect(dispatches).toEqual(["server", "firewall", "ip", "ip", "key"]);
    expect(h.deps.claim).toHaveBeenCalledWith(expect.objectContaining({ expectedFirewallReceipt: h.firstBoot!.firewallReceipt }));
    expect(h.firewallClient.deleteFirewall).toHaveBeenCalledWith(91);
    expect(h.client.deletePrimaryIp.mock.calls.map(([id]) => id)).toEqual([88, 89]);
    expect(h.order.cleanup!.absence).toEqual({ server: true, firewall: true, ipv4: true, ipv6: true, sshKey: true });
    expect(h.firewallClient.getServer).not.toHaveBeenCalled();
    expect(h.firewallClient.powerOnServer).not.toHaveBeenCalled();
    expect(h.firewallClient.createFirewall).not.toHaveBeenCalled();
  });
  it("rejects the old off-server confirmation before claiming or loading a provider credential", async () => {
    const h = harness(true);
    await expect(advanceHetznerCleanup("owner", cleanupConnection,
      { ...h.request, confirmation: HETZNER_CLEANUP_CONFIRMATION }, h.deps)).rejects.toThrow("confirmation_changed");
    expect(h.deps.claim).not.toHaveBeenCalled();
    expect(h.deps.loadSecret).not.toHaveBeenCalled();
  });
  it("cleans up a receipted firewall whose apply failed before attachment without any detach or power call", async () => {
    const h = harness(true);
    h.snapshot.server!.status = "off";
    h.snapshot.server!.public_net.firewalls = [];
    h.snapshot.firewall!.applied_to = [];
    h.firstBoot!.firewallVerifiedAt = null;
    h.firstBoot!.powerOnPostAttemptedAt = null;
    expect((await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps)).cleanup?.error).toBeNull();
    expect(h.client.deleteServer).toHaveBeenCalledTimes(1);
    await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(h.firewallClient.deleteFirewall).toHaveBeenCalledWith(91);
    expect(h.firewallClient.powerOnServer).not.toHaveBeenCalled();
  });
  it("does not adopt a firewall after an ambiguous POST", async () => {
    const h = harness(true);
    h.firstBoot!.firewallReceipt = null;
    await expect(previewHetznerCleanup("owner", cleanupConnection, cleanupOrder, h.deps)).rejects.toThrow("not_eligible");
    expect(h.deps.loadSecret).not.toHaveBeenCalled();
  });
  it("reconciles a lost firewall DELETE response using exact-ID absence without repeating it", async () => {
    const h = harness(true);
    await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    h.firewallClient.deleteFirewall.mockImplementationOnce(async () => {
      h.snapshot.firewall = null; throw new Error("lost deletion response");
    });
    const lost = await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(lost.cleanup?.error).toBe("provider_unavailable");
    expect(lost.cleanup?.absence.firewall).toBe(false);
    await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(h.firewallClient.deleteFirewall).toHaveBeenCalledTimes(1);
    expect(h.client.deletePrimaryIp).toHaveBeenCalledWith(88);
  });
  it.each(["server", "firewall"])("fences %s deletion when the final firewall GET outlives the lease", async target => {
    const h = harness(true);
    if (target === "firewall") await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    h.client.deleteServer.mockClear();
    let reads = 0;
    h.firewallClient.getFirewall.mockImplementation(async () => {
      if (++reads === 2) h.deps.monotonicNow.mockReturnValue(120_001);
      return structuredClone(h.snapshot.firewall!);
    });
    const result = await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(result.cleanup?.error).toBe("connection_changed");
    expect(h.client.deleteServer).not.toHaveBeenCalled();
    expect(h.firewallClient.deleteFirewall).not.toHaveBeenCalled();
  });
  it("does not delete any resource if the firewall identity or attachments change during inspection", async () => {
    const h = harness(true);
    h.client.getSshKey.mockImplementation(async () => {
      h.snapshot.firewall!.applied_to[0].server.id = 99;
      return structuredClone(h.snapshot.sshKey);
    });
    const result = await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(result.cleanup?.error).toBe("resource_changed");
    expect(h.client.deleteServer).not.toHaveBeenCalled();
    expect(h.firewallClient.deleteFirewall).not.toHaveBeenCalled();
  });
  it("treats firewall GET failure as unknown, not absence", async () => {
    const h = harness(true);
    h.firewallClient.getFirewall.mockRejectedValue(new Error("unauthorized provider detail"));
    const result = await advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps);
    expect(result.cleanup?.error).toBe("provider_unavailable");
    expect(result.cleanup?.absence).toEqual({ server: false, firewall: false, ipv4: false, ipv6: false, sshKey: false });
    expect(JSON.stringify(result)).not.toContain("unauthorized provider detail");
    expect(h.client.deleteServer).not.toHaveBeenCalled();
  });
  it("does not contact the provider when the locked database claim finds a published target", async () => {
    const h = harness(true);
    h.deps.claim.mockResolvedValueOnce({ outcome: "target_in_use" } as never);
    await expect(advanceHetznerCleanup("owner", cleanupConnection, h.request, h.deps)).rejects.toThrow("target_in_use");
    expect(h.deps.loadSecret).not.toHaveBeenCalled();
    expect(h.deps.client).not.toHaveBeenCalled();
  });
});
