import "server-only";

import { createHash } from "node:crypto";
import type { HetznerPrimaryIp, HetznerServer, HetznerSshKey } from "@/lib/hetzner/client";
import { assertServerIdentityMatchesCurrentShape, exactSshKey } from "./hetzner-cloud";
import type { StoredHetznerCloudCapacityOrder } from "./hetzner-cloud-store";
import { HetznerCreationReceiptSchema } from "./hetzner-creation-receipt";
import { assertFirstBootFirewallCleanup, FirstBootFirewallError, parseFirstBootFirewallReceipt } from "@/lib/hetzner/first-boot-firewall";
import type { FirstBootOperation } from "./first-boot-operations";
import { parseHetznerCurrentServerShapeEvidence } from "./hetzner-current-server-shape";

export class HetznerCleanupError extends Error {
  constructor(readonly code: "not_eligible" | "resource_changed" | "resource_busy" | "connection_changed" | "cleanup_busy" | "confirmation_changed" | "provider_unavailable" | "target_in_use",
    readonly observation?: "server_transition" | "server_ip_relationship" | "firewall_attachment") {
    super(`Hetzner cleanup could not proceed: ${code}`);
    this.name = "HetznerCleanupError";
  }
}

export type HetznerCleanupSnapshot = {
  server: HetznerServer | null;
  ipv4: HetznerPrimaryIp | null;
  ipv6: HetznerPrimaryIp | null;
  sshKey: HetznerSshKey | null;
  firewall?: unknown | null;
};

export function hetznerCleanupManifest(order: StoredHetznerCloudCapacityOrder, firstBoot: FirstBootOperation | null = null) {
  const receipt = HetznerCreationReceiptSchema.safeParse(order.creationReceipt);
  const sshKeyId = order.providerSshKeyId;
  if (!receipt.success || !sshKeyId || !/^[1-9][0-9]*$/.test(sshKeyId)
    || !Number.isSafeInteger(Number(sshKeyId)) || String(Number(sshKeyId)) !== sshKeyId
    || !["created_off", "cleaning", "deleted"].includes(order.operation.status)
    || receipt.data.serverId !== order.operation.providerServerId
    || receipt.data.action.id !== order.operation.providerActionId
    || order.providerSshKeyStatus !== "accepted") {
    throw new HetznerCleanupError("not_eligible");
  }
  let firewallReceipt = null;
  if (firstBoot) {
    if (firstBoot.binding.orderId !== order.operation.id || firstBoot.binding.connectionId !== order.operation.connectionId
      || firstBoot.binding.connectionRevision !== order.connectionRevision || firstBoot.providerServerId !== receipt.data.serverId
      || firstBoot.binding.quoteFingerprint !== order.quoteFingerprintSha256) throw new HetznerCleanupError("not_eligible");
    if (firstBoot.firewallPostAttemptedAt) {
      try { firewallReceipt = parseFirstBootFirewallReceipt(firstBoot.firewallReceipt, {
        orderId: order.operation.id, attemptId: firstBoot.binding.attemptId,
        quoteFingerprint: order.quoteFingerprintSha256, serverId: Number(receipt.data.serverId),
      }); } catch { throw new HetznerCleanupError("not_eligible"); }
    }
  }
  if (order.cleanup && JSON.stringify(order.cleanupFirewallReceipt ?? null) !== JSON.stringify(firewallReceipt)) {
    // PostgreSQL JSONB key order is not the original wire order.
    try {
      if (!firewallReceipt || JSON.stringify(parseFirstBootFirewallReceipt(order.cleanupFirewallReceipt, firewallReceipt.scope)) !== JSON.stringify(firewallReceipt)) {
        throw new Error("mismatch");
      }
    } catch { throw new HetznerCleanupError("not_eligible"); }
  }
  let currentShape;
  try {
    currentShape = parseHetznerCurrentServerShapeEvidence({
      shape: order.currentServerShape,
      fingerprintSha256: order.currentServerShapeFingerprintSha256,
      capacityOrderId: order.operation.id,
      connectionId: order.operation.connectionId,
      connectionRevision: order.connectionRevision,
      providerServerId: receipt.data.serverId,
    });
  } catch { throw new HetznerCleanupError("not_eligible"); }
  const resources: { server: string; ipv4: string; ipv6: string; sshKey: string; firewall?: string } = {
    server: receipt.data.serverId,
    ipv4: receipt.data.primaryIpv4.id,
    ipv6: receipt.data.primaryIpv6.id,
    sshKey: sshKeyId,
    ...(firewallReceipt ? { firewall: String(firewallReceipt.firewallId) } : {}),
  };
  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: currentShape ? (firewallReceipt ? 4 : 3) : (firewallReceipt ? 2 : 1),
    orderId: order.operation.id, connectionId: order.operation.connectionId,
    revision: order.connectionRevision, quote: order.quoteFingerprintSha256,
    ...(currentShape ? { currentShape: currentShape.fingerprintSha256 } : {}),
    resources, ipv4: receipt.data.primaryIpv4.ip, ipv6: receipt.data.primaryIpv6.ip,
    sshKeyFingerprint: order.bootstrapPublicKeyFingerprint,
    ...(firewallReceipt ? { firewallReceipt } : {}),
  })).digest("hex");
  return { resources, fingerprint, serverName: order.operation.quote.serverName, firewallReceipt };
}

/** Capacity-only cleanup requires an off server. Explicitly confirmed first-
 * boot cleanup may remove its original off/running server and owned firewall.
 * Published targets are excluded under the database's shared connection lock.
 * Changes made outside Hivra require manual review, not unprotect/reassign.
 * Null means a provider-confirmed 404, never a failed inventory request.
 */
export function assertHetznerCleanupSnapshot(
  order: StoredHetznerCloudCapacityOrder,
  snapshot: HetznerCleanupSnapshot,
  firstBoot: FirstBootOperation | null = null,
): void {
  const { resources, firewallReceipt } = hetznerCleanupManifest(order, firstBoot);
  const receipt = HetznerCreationReceiptSchema.parse(order.creationReceipt);
  const changed = () => { throw new HetznerCleanupError("resource_changed"); };
  let pending = false;
  let relationshipMismatch = false;
  const relationshipPending = () => {
    // Separate exact-ID GETs can straddle an original server/IP deletion.
    // This is a hold, never permission to mutate an inconsistent snapshot.
    if (order.operation.status !== "cleaning") changed();
    pending = true;
    relationshipMismatch = true;
  };
  if (snapshot.server) {
    const server = snapshot.server;
    if (server.id !== Number(resources.server)) changed();
    if (server.status === "deleting" || server.locked === true) throw new HetznerCleanupError("resource_busy", "server_transition");
    if (server.status !== "off" && !(firewallReceipt && firstBoot?.powerOnPostAttemptedAt && server.status === "running")) changed();
    try {
      assertServerIdentityMatchesCurrentShape(
        server,
        order.operation.quote,
        order.providerLabels,
        order.currentServerShape,
      );
    }
    catch { changed(); }
    if (String(server.public_net?.ipv4?.id) !== resources.ipv4
      || server.public_net?.ipv4?.ip !== receipt.primaryIpv4.ip
      || String(server.public_net?.ipv6?.id) !== resources.ipv6
      || server.public_net?.ipv6?.ip !== receipt.primaryIpv6.ip) changed();
  }
  if (firewallReceipt) {
    if (snapshot.firewall === undefined) changed();
    try { assertFirstBootFirewallCleanup({ scope: firewallReceipt.scope, receipt: firewallReceipt,
      firewall: snapshot.firewall, server: snapshot.server }); }
    catch (error) {
      if (error instanceof FirstBootFirewallError && error.code === "still_attached") pending = true;
      else changed();
    }
  } else if (snapshot.firewall !== undefined) changed();
  for (const kind of ["ipv4", "ipv6"] as const) {
    const ip = snapshot[kind];
    const original = kind === "ipv4" ? receipt.primaryIpv4 : receipt.primaryIpv6;
    if (!ip) {
      if (snapshot.server) relationshipPending();
      continue;
    }
    if (ip.id !== Number(resources[kind]) || ip.ip !== original.ip || ip.type !== kind
      || ip.protection?.delete !== false
      || ip.blocked !== false || typeof ip.auto_delete !== "boolean"
      || !ip.labels || typeof ip.labels !== "object" || Array.isArray(ip.labels)
      || Object.keys(ip.labels).length !== 0) changed();
    const assignedHere = ip.assignee_type === "server" && ip.assignee_id === Number(resources.server);
    const unassigned = ip.assignee_type === "unassigned" && ip.assignee_id === null;
    // Foreign assignment and malformed wire states are hard failures even
    // when another original resource is currently transitioning.
    if (!assignedHere && !unassigned) changed();
    if (snapshot.server ? !assignedHere : !unassigned) relationshipPending();
  }
  if (snapshot.sshKey) {
    const key = snapshot.sshKey;
    if (key.id !== Number(resources.sshKey) || typeof key.public_key !== "string"
      || !exactSshKey({
        sshKey: key, expectedName: `hivra-key-${order.operation.id.replace(/-/g, "").slice(0, 20)}`,
        expectedPublicKey: order.bootstrapPublicKey,
        expectedFingerprint: order.bootstrapPublicKeyFingerprint,
        expectedLabels: order.providerLabels,
      })) changed();
  }
  if (pending) throw new HetznerCleanupError("resource_busy", relationshipMismatch ? "server_ip_relationship" : "firewall_attachment");
}

export function hetznerCleanupAbsence(snapshot: HetznerCleanupSnapshot) {
  return { server: snapshot.server === null, ipv4: snapshot.ipv4 === null,
    ipv6: snapshot.ipv6 === null, sshKey: snapshot.sshKey === null,
    ...(snapshot.firewall !== undefined ? { firewall: snapshot.firewall === null } : {}) };
}
