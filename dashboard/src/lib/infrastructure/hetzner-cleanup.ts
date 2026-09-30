import "server-only";
import { randomUUID } from "node:crypto";
import { log } from "@/lib/logger";
import { createHetznerCloudCleanupClient, createHetznerCloudFirstBootClient, type HetznerCloudCleanupClient, type HetznerCloudFirstBootClient } from "@/lib/hetzner/client";
import { loadFirstBootOperationForOrder, type FirstBootOperation } from "./first-boot-operations";
import { retireUnusedPreparedProviderComputer } from "./provider-computer-preparation";
import {
  loadHetznerCloudCleanupOrder, listHetznerCloudCleanupOrders, loadHetznerCloudConnectionSecret,
  claimHetznerCleanup, verifyHetznerCleanupLease, recordHetznerCleanupObservation,
  type StoredHetznerCloudCapacityOrder,
} from "./hetzner-cloud-store";
import {
  HetznerCleanupError, assertHetznerCleanupSnapshot, hetznerCleanupAbsence, hetznerCleanupManifest,
  type HetznerCleanupSnapshot,
} from "./hetzner-cleanup-policy";
import { HETZNER_CLEANUP_CONFIRMATION, HETZNER_FIRST_BOOT_CLEANUP_CONFIRMATION, HetznerCleanupRequestSchema, type HetznerCleanupRequest, type HetznerCleanupAbsence } from "./hetzner-cleanup-contracts";

type Dependencies = {
  loadOrder: typeof loadHetznerCloudCleanupOrder;
  listOrders: typeof listHetznerCloudCleanupOrders;
  loadSecret: typeof loadHetznerCloudConnectionSecret;
  claim: typeof claimHetznerCleanup;
  verifyLease: typeof verifyHetznerCleanupLease;
  record: typeof recordHetznerCleanupObservation;
  client: (token: string) => HetznerCloudCleanupClient;
  firstBootClient: (token: string) => Pick<HetznerCloudFirstBootClient, "getFirewall" | "deleteFirewall">;
  loadFirstBoot: typeof loadFirstBootOperationForOrder;
  retireUnused: typeof retireUnusedPreparedProviderComputer;
  newId: () => string;
  monotonicNow: () => number;
};
const defaults: Dependencies = {
  loadOrder: loadHetznerCloudCleanupOrder, listOrders: listHetznerCloudCleanupOrders,
  loadSecret: loadHetznerCloudConnectionSecret, claim: claimHetznerCleanup,
  verifyLease: verifyHetznerCleanupLease, record: recordHetznerCleanupObservation,
  client: createHetznerCloudCleanupClient, newId: randomUUID,
  firstBootClient: createHetznerCloudFirstBootClient, loadFirstBoot: loadFirstBootOperationForOrder,
  retireUnused: retireUnusedPreparedProviderComputer,
  monotonicNow: () => performance.now(),
};
const NO_ABSENCE: HetznerCleanupAbsence = { server: false, ipv4: false, ipv6: false, sshKey: false };
// The database lease lasts 120s. Stop dispatching mutations within 45s of
// starting the claim, leaving room for the provider's bounded 15s request and
// observation/checkpoint work. Do not depend on a host enforcing maxDuration.
const MUTATION_WINDOW_MS = 45_000;

function view(order: StoredHetznerCloudCapacityOrder, firstBoot: FirstBootOperation | null) {
  let manifest: ReturnType<typeof hetznerCleanupManifest> | null = null;
  try { manifest = hetznerCleanupManifest(order, firstBoot); } catch { /* Legacy/ambiguous resources remain manual. */ }
  return {
    orderId: order.operation.id, connectionId: order.operation.connectionId,
    status: order.operation.status, serverName: order.operation.quote.serverName,
    eligible: manifest !== null, resources: manifest?.resources ?? null,
    fingerprint: manifest?.fingerprint ?? null, cleanup: order.cleanup ?? null,
  };
}

async function provider(deps: Dependencies, userId: string, connectionId: string, revision: number, hasFirewall: boolean): Promise<CleanupClient> {
  const current = await deps.loadSecret(userId, connectionId, { requireBoundToken: true });
  if (current.revision !== revision || current.connection.status !== "ready") {
    throw new HetznerCleanupError("connection_changed");
  }
  const resources = deps.client(current.apiToken);
  if (!hasFirewall) return resources;
  const firewall = deps.firstBootClient(current.apiToken);
  // Pick at runtime too: the boot client's getServer intentionally does not
  // treat 404 as cleanup evidence and must never replace the cleanup reader.
  return { ...resources, getFirewall: firewall.getFirewall, deleteFirewall: firewall.deleteFirewall };
}

type CleanupClient = HetznerCloudCleanupClient & Partial<Pick<HetznerCloudFirstBootClient, "getFirewall" | "deleteFirewall">>;
async function inspect(client: CleanupClient, order: StoredHetznerCloudCapacityOrder, firstBoot: FirstBootOperation | null) {
  const { resources } = hetznerCleanupManifest(order, firstBoot);
  const [server, ipv4, ipv6, sshKey, firewall] = await Promise.all([
    client.getServer(Number(resources.server)), client.getPrimaryIp(Number(resources.ipv4)),
    client.getPrimaryIp(Number(resources.ipv6)), client.getSshKey(Number(resources.sshKey)),
    resources.firewall ? client.getFirewall!(Number(resources.firewall)) : undefined,
  ]);
  const snapshot: HetznerCleanupSnapshot = { server, ipv4, ipv6, sshKey, ...(resources.firewall ? { firewall } : {}) };
  const absence = hetznerCleanupAbsence(snapshot);
  for (const kind of Object.keys(absence) as Array<keyof HetznerCleanupAbsence>) {
    if (order.cleanup?.absence[kind] && !absence[kind]) throw new HetznerCleanupError("resource_changed");
  }
  // A reappearing resource is a hard failure, including when a sibling's
  // attachment relationship would otherwise produce a pending observation.
  assertHetznerCleanupSnapshot(order, snapshot, firstBoot);
  return { snapshot, absence };
}

async function loadFirstBoot(deps: Dependencies, userId: string, order: StoredHetznerCloudCapacityOrder) {
  if (!order.operation.providerServerId) return null;
  return deps.loadFirstBoot({ binding: { userId, connectionId: order.operation.connectionId,
    connectionRevision: order.connectionRevision, orderId: order.operation.id,
    quoteFingerprint: order.quoteFingerprintSha256 },
  providerServerId: order.operation.providerServerId });
}

export async function listHetznerCleanup(userId: string, connectionId: string, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  const orders = await deps.listOrders(userId, connectionId);
  return { orders: await Promise.all(orders.map(async order => view(order, await loadFirstBoot(deps, userId, order)))) };
}

export async function previewHetznerCleanup(userId: string, connectionId: string, orderId: string, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  const order = await deps.loadOrder(userId, connectionId, orderId);
  const firstBoot = await loadFirstBoot(deps, userId, order);
  const manifest = hetznerCleanupManifest(order, firstBoot);
  if (order.operation.status === "deleted") return { ...view(order, firstBoot), observedAbsence: order.cleanup?.absence ?? null };
  const client = await provider(deps, userId, connectionId, order.connectionRevision, Boolean(manifest.resources.firewall));
  const { absence } = await inspect(client, order, firstBoot);
  return { ...view(order, firstBoot), observedAbsence: absence };
}

/** One bounded resource mutation per request, always under a database lease.
 * Replays observe the original IDs; they never recreate, unprotect, unassign,
 * or infer ownership from a name. The UI can advance the same confirmed intent.
 */
export async function advanceHetznerCleanup(
  userId: string, connectionId: string, rawRequest: HetznerCleanupRequest,
  dependencies: Partial<Dependencies> = {},
) {
  const deps = { ...defaults, ...dependencies };
  const request = HetznerCleanupRequestSchema.parse(rawRequest);
  const loaded = await deps.loadOrder(userId, connectionId, request.orderId);
  const firstBoot = await loadFirstBoot(deps, userId, loaded);
  const manifest = hetznerCleanupManifest(loaded, firstBoot);
  const confirmation = manifest.resources.firewall ? HETZNER_FIRST_BOOT_CLEANUP_CONFIRMATION : HETZNER_CLEANUP_CONFIRMATION;
  if (request.fingerprint !== manifest.fingerprint || request.serverName !== manifest.serverName || request.confirmation !== confirmation) {
    throw new HetznerCleanupError("confirmation_changed");
  }
  const binding = { userId, connectionId, expectedRevision: loaded.connectionRevision,
    orderId: request.orderId, leaseId: deps.newId() };
  const mutationDeadline = deps.monotonicNow() + MUTATION_WINDOW_MS;
  const assertMutationWindow = () => {
    if (deps.monotonicNow() >= mutationDeadline) throw new HetznerCleanupError("connection_changed");
  };
  if (firstBoot && loaded.operation.status !== "deleted") {
    if (!await deps.retireUnused({ userId, connectionId, expectedRevision: loaded.connectionRevision,
      orderId: loaded.operation.id, providerServerId: manifest.resources.server })) throw new HetznerCleanupError("target_in_use");
    assertMutationWindow();
  }
  const claim = await deps.claim({ ...binding, ...request, expectedFirewallReceipt: manifest.firewallReceipt });
  if (claim.outcome === "not_found") throw new HetznerCleanupError("not_eligible");
  if (claim.outcome === "not_eligible" || claim.outcome === "connection_changed" || claim.outcome === "confirmation_changed" || claim.outcome === "target_in_use") {
    throw new HetznerCleanupError(claim.outcome);
  }
  if (claim.outcome === "busy") return { ...view(claim.order, firstBoot), busy: true };
  if (claim.outcome === "complete") return { ...view(claim.order, firstBoot), busy: false };
  if (!("order" in claim)) throw new HetznerCleanupError("not_eligible");
  const order = claim.order;
  // Validate the freshly locked row, not just the earlier preview.
  if (hetznerCleanupManifest(order, firstBoot).fingerprint !== manifest.fingerprint) throw new HetznerCleanupError("confirmation_changed");
  let absence = order.cleanup?.absence ?? { ...NO_ABSENCE, ...(manifest.resources.firewall ? { firewall: false } : {}) };
  let error: "resource_changed" | "resource_busy" | "provider_unavailable" | "connection_changed" | null = null;
  try {
    assertMutationWindow();
    const client = await provider(deps, userId, connectionId, order.connectionRevision, Boolean(manifest.resources.firewall));
    if (!await deps.verifyLease(binding)) throw new HetznerCleanupError("connection_changed");
    assertMutationWindow();
    const before = await inspect(client, order, firstBoot);
    assertMutationWindow();
    absence = before.absence;
    // Refresh the exact mutation target after slower sibling GETs finish.
    // No unrelated DB await may separate this final guard from DELETE.
    // Hetzner does not offer an off-state compare-and-delete primitive:
    // a concurrent project administrator can still race any GET/DELETE pair.
    const fresh = before.snapshot;
    if (fresh.server) {
      [fresh.server, fresh.firewall] = await Promise.all([
        client.getServer(Number(manifest.resources.server)),
        manifest.resources.firewall ? client.getFirewall!(Number(manifest.resources.firewall)) : undefined,
      ]);
      assertHetznerCleanupSnapshot(order,fresh,firstBoot);
      // This fence must be synchronous and immediately before dispatch: an
      // awaited GET may outlive the lease and an explicit forget operation.
      assertMutationWindow();
      if (fresh.server) await client.deleteServer(Number(manifest.resources.server));
    } else if (manifest.resources.firewall && fresh.firewall !== null) {
      [fresh.server,fresh.firewall] = await Promise.all([
        client.getServer(Number(manifest.resources.server)),client.getFirewall!(Number(manifest.resources.firewall)),
      ]);
      if (fresh.server) throw new HetznerCleanupError("resource_changed");
      assertHetznerCleanupSnapshot(order,fresh,firstBoot);
      assertMutationWindow();
      if (fresh.firewall !== null) await client.deleteFirewall!(Number(manifest.resources.firewall));
    } else if (fresh.ipv4 || fresh.ipv6) {
      const kind = fresh.ipv4 ? "ipv4" : "ipv6";
      [fresh.server,fresh[kind]] = await Promise.all([
        client.getServer(Number(manifest.resources.server)),client.getPrimaryIp(Number(manifest.resources[kind])),
      ]);
      if (fresh.server) throw new HetznerCleanupError("resource_changed");
      assertHetznerCleanupSnapshot(order,fresh,firstBoot);
      assertMutationWindow();
      if (fresh[kind]) await client.deletePrimaryIp(Number(manifest.resources[kind]));
    } else if (fresh.sshKey) {
      const latest = await inspect(client,order,firstBoot);
      if (latest.snapshot.server || latest.snapshot.ipv4 || latest.snapshot.ipv6 || latest.snapshot.firewall) throw new HetznerCleanupError("resource_changed");
      assertMutationWindow();
      if (latest.snapshot.sshKey) await client.deleteSshKey(Number(manifest.resources.sshKey));
    }
    // Even an acknowledged DELETE does not release a claim. Fresh exact-ID
    // provider GETs must prove that all separately billable resources are gone.
    absence = (await inspect(client, order, firstBoot)).absence;
  } catch (failure) {
    error = failure instanceof HetznerCleanupError && (
      failure.code === "resource_changed" || failure.code === "resource_busy" || failure.code === "connection_changed"
    ) ? failure.code : "provider_unavailable";
    log.warn("Original provider cleanup paused after observation", {
      source: "hetzner-cleanup", requestId: order.operation.id,
      failureType: error,
      observation: failure instanceof HetznerCleanupError ? failure.observation ?? null : null,
    });
  }
  const saved = await deps.record({ ...binding, absence, error });
  return { ...view(saved, firstBoot), busy: false };
}
