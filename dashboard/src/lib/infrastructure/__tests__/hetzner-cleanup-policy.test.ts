import { assertHetznerCleanupSnapshot, hetznerCleanupManifest, type HetznerCleanupSnapshot } from "../hetzner-cleanup-policy";
import { cleanupFixture, firstBootCleanupFixture } from "./hetzner-cleanup.fixtures";

describe("original-resource cleanup policy", () => {
  it("binds the exact resource set to order, credential revision and original quote", () => {
    const { order, snapshot } = cleanupFixture();
    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).not.toThrow();
    const manifest = hetznerCleanupManifest(order);
    expect(manifest.resources).toEqual({ server: "42", ipv4: "88", ipv6: "89", sshKey: "77" });
    expect(hetznerCleanupManifest({ ...order, connectionRevision: 8 }).fingerprint).not.toBe(manifest.fingerprint);
    expect(() => hetznerCleanupManifest({ ...order, creationReceipt: null })).toThrow("not_eligible");
  });
  it("accepts the exact terminal resize shape for Delete while retaining the original resource manifest", () => {
    const { order, snapshot } = cleanupFixture();
    const original = hetznerCleanupManifest(order);
    order.currentServerShape = {
      version: 1, provider: "hetzner-cloud", capacityOrderId: order.operation.id,
      connectionId: order.operation.connectionId, connectionRevision: order.connectionRevision,
      providerServerId: String(snapshot.server!.id),
      resizeOperationId: "66666666-6666-4666-8666-666666666666",
      resizeQuoteFingerprintSha256: "b".repeat(64),
      previousShapeFingerprintSha256: order.quoteFingerprintSha256,
      serverType: { id: 204, name: "cpx32", architecture: "x86", cores: 4, memoryGb: 8,
        advertisedDiskGb: 160, cpuType: "shared" },
      primaryDiskGb: 80, observedAt: "2026-09-04T14:00:00.000Z",
    };
    order.currentServerShapeFingerprintSha256 = "c".repeat(64);
    Object.assign(snapshot.server!.server_type, { id: 204, name: "cpx32", description: "CPX 32", architecture: "x86",
      cores: 4, memory: 8, disk: 160, cpu_type: "shared" });

    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).not.toThrow();
    const resized = hetznerCleanupManifest(order);
    expect(resized.resources).toEqual(original.resources);
    expect(resized.fingerprint).not.toBe(original.fingerprint);

    snapshot.server!.primary_disk_size = 160;
    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).toThrow("resource_changed");
  });
  it("uses the provider's public_net floating IP field, not a top-level decoy", () => {
    const { order, snapshot } = cleanupFixture();
    expect(snapshot.server).not.toHaveProperty("floating_ips");
    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).not.toThrow();
    Object.assign(snapshot.server!, { floating_ips: [] });
    snapshot.server!.public_net.floating_ips = [99];
    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).toThrow("resource_changed");
    delete snapshot.server!.public_net.floating_ips;
    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).toThrow("resource_changed");
  });
  const changes: Array<[string, (v: HetznerCleanupSnapshot) => void]> = [
    ["unrelated server", v => { v.server!.id = 43; }],
    ["user powered on", v => { v.server!.status = "running"; }],
    ["protection enabled", v => { v.server!.protection!.delete = true; }],
    ["extra volume", v => { v.server!.volumes = [99]; }],
    ["private network", v => { v.server!.private_net = [{}]; }],
    ["changed order labels", v => { v.server!.labels = {}; }],
    ["replaced IP", v => { v.server!.public_net.ipv4!.id = 99; }],
    ["protected IP", v => { v.ipv4!.protection.delete = true; }],
    ["reassigned IP", v => { v.ipv6!.assignee_id = 99; }],
    ["blocked IP", v => { v.ipv4!.blocked = true; }],
    ["customized IP labels", v => { v.ipv4!.labels = { purpose: "another-application" }; }],
    ["changed IP address", v => { v.ipv6!.ip = "2001:db8:1::/64"; }],
    ["unknown IP state", v => { v.ipv6!.assignee_id = undefined as unknown as null; }],
    ["missing IP while server exists", v => { v.ipv4 = null; }],
    ["changed SSH key", v => { v.sshKey!.public_key = "ssh-ed25519 changed"; }],
    ["renamed SSH key", v => { v.sshKey!.name = "keep-for-other-server"; }],
  ];
  it.each(changes)("refuses %s", (_label, change) => {
    const { order, snapshot } = cleanupFixture(); change(snapshot);
    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).toThrow("resource_changed");
  });
  it("allows an independently absent server only with unassigned original IPs", () => {
    const { order, snapshot } = cleanupFixture(); snapshot.server = null;
    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).toThrow("resource_changed");
    snapshot.ipv4!.assignee_id = null; snapshot.ipv6!.assignee_id = null;
    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).toThrow("resource_changed");
    snapshot.ipv4!.assignee_type = "unassigned"; snapshot.ipv6!.assignee_type = "unassigned";
    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).not.toThrow();
    snapshot.ipv4 = null; snapshot.ipv6 = null; snapshot.sshKey = null;
    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).not.toThrow();
  });
  it("waits for provider transitions without clearing locks or power state", () => {
    const { order, snapshot } = cleanupFixture(); snapshot.server!.status = "deleting";
    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).toThrow("resource_busy");
  });
  it.each(["server-gone", "ip-gone", "ip-unassigned"])("does not authorize deletion from a torn %s observation", state => {
    const { order, snapshot } = cleanupFixture();
    order.operation.status = "cleaning";
    if (state === "server-gone") snapshot.server = null;
    else if (state === "ip-gone") snapshot.ipv4 = null;
    else { snapshot.ipv4!.assignee_id = null; snapshot.ipv4!.assignee_type = "unassigned"; }
    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).toThrow("resource_busy");
  });
  it.each(["foreign-ip", "protected-ip", "changed-key", "malformed-assignment"])("keeps %s a hard failure despite an original-resource transition", state => {
    const { order, snapshot } = cleanupFixture();
    order.operation.status = "cleaning";
    snapshot.server = null;
    if (state === "foreign-ip") snapshot.ipv6!.assignee_id = 99;
    else if (state === "protected-ip") snapshot.ipv6!.protection.delete = true;
    else if (state === "changed-key") snapshot.sshKey!.public_key = "ssh-ed25519 changed";
    else snapshot.ipv6!.assignee_id = null; // server/null is not the current provider wire contract.
    expect(() => assertHetznerCleanupSnapshot(order, snapshot)).toThrow("resource_changed");
  });
});

describe("first-boot cleanup identity and attachment policy", () => {
  it("binds the fifth resource and its original attempt to a new confirmation fingerprint", () => {
    const { order, snapshot, firstBoot } = firstBootCleanupFixture();
    expect(() => assertHetznerCleanupSnapshot(order, snapshot, firstBoot)).not.toThrow();
    const original = hetznerCleanupManifest(order, firstBoot);
    expect(original.resources.firewall).toBe("91");
    expect(original.fingerprint).not.toBe(hetznerCleanupManifest(order).fingerprint);
    const other = structuredClone(firstBoot);
    other.firewallReceipt!.firewallId = 92;
    expect(hetznerCleanupManifest(order, other).fingerprint).not.toBe(original.fingerprint);
    order.cleanup = { idempotencyKey: "33333333-3333-4333-8333-333333333333", fingerprint: original.fingerprint,
      absence: { server: false, firewall: false, ipv4: false, ipv6: false, sshKey: false }, error: null,
      startedAt: "2026-08-27T16:00:00Z", observedAt: null, finishedAt: null };
    // JSONB returns keys in a different order from the provider POST.
    order.cleanupFirewallReceipt = Object.fromEntries(Object.entries(firstBoot.firewallReceipt!).reverse());
    expect(hetznerCleanupManifest(order, firstBoot).fingerprint).toBe(original.fingerprint);
    expect(() => hetznerCleanupManifest(order, other)).toThrow("not_eligible");
    expect(() => hetznerCleanupManifest(order)).toThrow("not_eligible");
  });
  it.each(["orderId", "connectionId", "connectionRevision", "quoteFingerprint"] as const)("rejects another %s", key => {
    const { order, firstBoot } = firstBootCleanupFixture();
    Object.assign(firstBoot.binding, { [key]: key === "connectionRevision" ? 8 : "foreign" });
    expect(() => hetznerCleanupManifest(order, firstBoot)).toThrow("not_eligible");
  });
  const changes: Array<[string, (fixture: ReturnType<typeof firstBootCleanupFixture>) => void]> = [
    ["unknown firewall", f => { delete (f.snapshot as HetznerCleanupSnapshot).firewall; }],
    ["different ID", f => { f.snapshot.firewall!.id = 92; }],
    ["recreated firewall", f => { f.snapshot.firewall!.created = "2026-08-27T16:00:00Z"; }],
    ["changed labels", f => { f.snapshot.firewall!.labels = {}; }],
    ["changed rules", f => { f.snapshot.firewall!.rules[0].source_ips = ["192.0.2.0/24", "::/0"]; }],
    ["extra rules", f => { f.snapshot.firewall!.rules.push(f.snapshot.firewall!.rules[0]); }],
    ["label selector", f => { Object.assign(f.snapshot.firewall!.applied_to[0], { type: "label_selector", label_selector: { selector: "all" } }); }],
    ["other server attached", f => { f.snapshot.firewall!.applied_to[0].server.id = 43; }],
    ["extra attachment", f => { f.snapshot.firewall!.applied_to.push({ type: "server", server: { id: 43 } }); }],
    ["server references another firewall", f => { f.snapshot.server!.public_net.firewalls = [{ id: 92, status: "applied" }]; }],
    ["server firewall field missing", f => { delete f.snapshot.server!.public_net.firewalls; }],
    ["absent firewall still attached to server", f => { f.snapshot.firewall = null; }],
    ["running without setup power marker", f => { f.firstBoot.powerOnPostAttemptedAt = null; }],
  ];
  it.each(changes)("stops cleanup for %s", (_name, change) => {
    const fixture = firstBootCleanupFixture(); change(fixture);
    expect(() => assertHetznerCleanupSnapshot(fixture.order, fixture.snapshot, fixture.firstBoot)).toThrow("resource_changed");
  });
  it.each(["pending", "one-sided"])("waits when the original attachment is %s", state => {
    const { order, snapshot, firstBoot } = firstBootCleanupFixture();
    if (state === "pending") snapshot.server!.public_net.firewalls = [{ id: 91, status: "pending" }];
    else snapshot.firewall!.applied_to = [];
    expect(() => assertHetznerCleanupSnapshot(order, snapshot, firstBoot)).toThrow("resource_busy");
  });
  it("does not hide a changed key behind a pending firewall attachment", () => {
    const { order, snapshot, firstBoot } = firstBootCleanupFixture();
    snapshot.firewall!.applied_to = [];
    snapshot.sshKey!.public_key = "ssh-ed25519 changed";
    expect(() => assertHetznerCleanupSnapshot(order, snapshot, firstBoot)).toThrow("resource_changed");
  });
  it("allows an original off server and receipted firewall that both report unattached after a failed apply", () => {
    const { order, snapshot, firstBoot } = firstBootCleanupFixture();
    snapshot.server!.status = "off";
    snapshot.server!.public_net.firewalls = [];
    snapshot.firewall!.applied_to = [];
    firstBoot.firewallVerifiedAt = null;
    firstBoot.powerOnPostAttemptedAt = null;
    expect(() => assertHetznerCleanupSnapshot(order, snapshot, firstBoot)).not.toThrow();
  });
  it("allows firewall absence only when the server agrees, and never detaches a residual attachment", () => {
    const { order, snapshot, firstBoot } = firstBootCleanupFixture();
    const firewall = snapshot.firewall!;
    snapshot.firewall = null;
    snapshot.server!.public_net.firewalls = [];
    expect(() => assertHetznerCleanupSnapshot(order, snapshot, firstBoot)).not.toThrow();
    snapshot.firewall = firewall;
    snapshot.server = null;
    for (const ip of [snapshot.ipv4!, snapshot.ipv6!]) { ip.assignee_id = null; ip.assignee_type = "unassigned"; }
    expect(() => assertHetznerCleanupSnapshot(order, snapshot, firstBoot)).toThrow("resource_busy");
    firewall.applied_to = [];
    expect(() => assertHetznerCleanupSnapshot(order, snapshot, firstBoot)).not.toThrow();
  });
});
