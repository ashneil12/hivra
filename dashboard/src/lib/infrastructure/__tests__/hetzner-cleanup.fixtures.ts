import { generateHetznerBootstrapBundle } from "../hetzner-cloud";
import { createHetznerCreationReceipt } from "../hetzner-creation-receipt";
import type { StoredHetznerCloudCapacityOrder } from "../hetzner-cloud-store";
import type { HetznerCleanupSnapshot } from "../hetzner-cleanup-policy";
import type { HetznerCloudCapacityOperationDto } from "../contracts";
import type { HetznerServer } from "@/lib/hetzner/client";
import { firstBootFirewallRequest, type FirstBootFirewall } from "@/lib/hetzner/first-boot-firewall";
import { FIRST_BOOT_RECIPE_VERSION } from "../first-boot-enrollment";
import type { FirstBootOperation } from "../first-boot-operations";

export const cleanupConnection = "11111111-1111-4111-8111-111111111111";
export const cleanupOrder = "22222222-2222-4222-8222-222222222222";
export const cleanupKey = "33333333-3333-4333-8333-333333333333";
const bootstrap = generateHetznerBootstrapBundle({
  userId: "owner", connectionId: cleanupConnection, connectionRevision: 7,
  orderId: cleanupOrder, quoteFingerprintSha256: "a".repeat(64),
});

export function cleanupFixture() {
  const labels = { "hivra-operation": cleanupOrder, "hivra-quote": "a".repeat(32), "hivra-managed": "true" };
  const image = { id: 100, type: "system", status: "available", deleted: null, created_from: null, bound_to: null, name: "ubuntu-24.04" };
  const server = {
    id: 42, name: "hivra-22222222222242228222", status: "off",
    labels, created: "2026-08-27T15:00:00Z", backup_window: null,
    volumes: [], primary_disk_size: 80, rescue_enabled: false, iso: null, private_net: [],
    locked: false, protection: { delete: false, rebuild: false }, load_balancers: [], placement_group: null,
    server_type: { id: 104, name: "cpx22", disk: 80 },
    location: { id: 1, name: "fsn1" }, image,
    public_net: { ipv4: { id: 88, ip: "203.0.113.10" }, ipv6: { id: 89, ip: "2001:db8::/64" }, floating_ips: [] },
  } as unknown as HetznerServer;
  const operation = {
    id: cleanupOrder, connectionId: cleanupConnection, status: "created_off",
    providerServerId: "42", providerActionId: "500",
    quote: { serverName: server.name, serverType: { id: 104, name: "cpx22", diskGb: 80 },
      image, location: { id: 1, name: "fsn1" } },
  } as unknown as HetznerCloudCapacityOperationDto;
  const order: StoredHetznerCloudCapacityOrder = {
    operation, connectionRevision: 7, providerLabels: labels, quoteFingerprintSha256: "a".repeat(64),
    sshKeyPostAttemptedAt: "2026-08-27T15:00:00Z", providerSshKeyStatus: "accepted", providerSshKeyId: "77",
    serverPostAttemptedAt: "2026-08-27T15:00:00Z", providerServerStatus: "accepted",
    creationReceipt: createHetznerCreationReceipt(server, { id: 500, command: "create_server", status: "success", resources: [{ id: 42, type: "server" }] }, []),
    bootstrapPublicKey: bootstrap.publicKeyOpenSsh, bootstrapPublicKeyFingerprint: bootstrap.publicKeyFingerprint, cleanup: null,
  };
  const snapshot: HetznerCleanupSnapshot = {
    server,
    ipv4: { id: 88, ip: "203.0.113.10", type: "ipv4", assignee_id: 42, assignee_type: "server", protection: { delete: false }, blocked: false, auto_delete: false, labels: {} },
    ipv6: { id: 89, ip: "2001:db8::/64", type: "ipv6", assignee_id: 42, assignee_type: "server", protection: { delete: false }, blocked: false, auto_delete: false, labels: {} },
    sshKey: { id: 77, name: "hivra-key-22222222222242228222", labels, public_key: bootstrap.publicKeyOpenSsh, fingerprint: "provider-format-not-authority", created: "2026-08-27T15:00:00Z" },
  };
  return { order, snapshot };
}

export function firstBootCleanupFixture() {
  const fixture = cleanupFixture();
  const scope = { orderId: cleanupOrder, attemptId: "55555555-5555-4555-8555-555555555555",
    quoteFingerprint: fixture.order.quoteFingerprintSha256, serverId: 42 };
  const request = firstBootFirewallRequest(scope);
  const date = "2026-08-27T15:01:00.000Z";
  const firewall: FirstBootFirewall = { id: 91, name: request.name, labels: request.labels, created: date,
    rules: request.rules.map(rule => ({ ...rule, destination_ips: [] })),
    applied_to: [{ type: "server", server: { id: 42 } }] };
  const firstBoot: FirstBootOperation = {
    binding: { userId: "owner", connectionId: cleanupConnection, connectionRevision: 7, orderId: cleanupOrder,
      attemptId: scope.attemptId, quoteFingerprint: scope.quoteFingerprint, recipeVersion: FIRST_BOOT_RECIPE_VERSION },
    providerServerId: "42", leaseId: null, leaseExpiresAt: null, firewallPostAttemptedAt: date,
    firewallReceipt: { version: 1, scope, firewallId: 91, createdAt: date, setRulesActionId: 601, applyActionId: 602 },
    firewallVerifiedAt: date, powerOnPostAttemptedAt: date, powerOnAction: null, abandonedAt: null,
  };
  fixture.snapshot.server!.status = "running";
  fixture.snapshot.server!.public_net.firewalls = [{ id: 91, status: "applied" }];
  const snapshot = { ...fixture.snapshot, firewall: firewall as FirstBootFirewall | null };
  return { order: fixture.order, snapshot, firstBoot };
}
