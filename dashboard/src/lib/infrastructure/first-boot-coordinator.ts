import "server-only";

import { z } from "zod";
import { createHetznerCloudFirstBootClient, type HetznerCloudFirstBootClient, type HetznerServer } from "@/lib/hetzner/client";
import { assessFirstBootFirewall, FirstBootFirewallError, firstBootPowerOnAction, parseFirstBootFirewallReceipt } from "@/lib/hetzner/first-boot-firewall";
import { assertServerIdentityMatchesQuote } from "./hetzner-cloud";
import { loadHetznerCloudConnectionSecret } from "./hetzner-cloud-store";
import { assertHetznerCreationReceiptMatchesObservation } from "./hetzner-creation-receipt";
import { assertFirstBootCapacityEvidence, FirstBootReceiverError, loadFirstBootCapacityEvidence, type FirstBootCapacityEvidence } from "./first-boot-receiver";
import { firstBootEnrollmentDeadline } from "./first-boot-enrollment";
import { armFirstBootEnrollment, loadFirstBootEnrollment, type StoredFirstBootEnrollment } from "./first-boot-store";
import {
  claimFirstBootOperation, markFirstBootFirewallDispatch, markFirstBootPowerDispatch,
  recordFirstBootFirewallVerified, releaseFirstBootOperation, saveFirstBootFirewallReceipt, saveFirstBootPowerAction,
  type FirstBootOperationScope,
} from "./first-boot-operations";

type Dependencies = {
  claim: typeof claimFirstBootOperation;
  evidence: typeof loadFirstBootCapacityEvidence;
  enrollment: typeof loadFirstBootEnrollment;
  secret: typeof loadHetznerCloudConnectionSecret;
  client: (token: string) => Omit<HetznerCloudFirstBootClient, "deleteFirewall">;
  markFirewall: typeof markFirstBootFirewallDispatch;
  saveFirewall: typeof saveFirstBootFirewallReceipt;
  verifyFirewall: typeof recordFirstBootFirewallVerified;
  arm: typeof armFirstBootEnrollment;
  markPower: typeof markFirstBootPowerDispatch;
  savePower: typeof saveFirstBootPowerAction;
  release: typeof releaseFirstBootOperation;
  now: () => Date;
  monotonicNow: () => number;
};
const defaults: Dependencies = {
  claim: claimFirstBootOperation, evidence: loadFirstBootCapacityEvidence, enrollment: loadFirstBootEnrollment,
  secret: loadHetznerCloudConnectionSecret, client: createHetznerCloudFirstBootClient,
  markFirewall: markFirstBootFirewallDispatch, saveFirewall: saveFirstBootFirewallReceipt,
  verifyFirewall: recordFirstBootFirewallVerified, arm: armFirstBootEnrollment,
  markPower: markFirstBootPowerDispatch, savePower: saveFirstBootPowerAction,
  release: releaseFirstBootOperation, now: () => new Date(), monotonicNow: () => performance.now(),
};
class FirstBootCoordinatorError extends Error {
  constructor(readonly code: "rejected" | "resource_changed" | "action_failed" | "deadline_expired" | "provider_unavailable" | "checkpoint_failed") {
    super("First-boot step stopped: " + code);
    this.name = "FirstBootCoordinatorError";
  }
}
export type FirstBootStep = { stage:
  | "busy" | "waiting_for_capacity" | "firewall_requested" | "waiting_for_firewall"
  | "firewall_outcome_unknown" | "power_requested" | "power_outcome_unknown"
  | "waiting_for_power" | "waiting_for_identity" | "identity_enrolled";
};
const changed = (): never => { throw new FirstBootCoordinatorError("resource_changed"); };

function enrollmentMatches(value: StoredFirstBootEnrollment | null, scope: FirstBootOperationScope) {
  if (!value || !["staged", "awaiting_identity", "enrolled"].includes(value.phase)
    || Object.entries(scope.binding).some(([key, expected]) => value.challenge.binding[key as keyof typeof scope.binding] !== expected)
    || (value.phase !== "staged" && value.providerServerId !== scope.providerServerId)) {
    throw new FirstBootCoordinatorError("rejected");
  }
  return value;
}
function assertServer(server: HetznerServer, evidence: FirstBootCapacityEvidence) {
  const receipt = evidence.provider_creation_receipt;
  if (String(server.id) !== receipt.serverId || typeof server.locked !== "boolean"
    || String(server.public_net?.ipv4?.id) !== receipt.primaryIpv4.id
    || server.public_net?.ipv4?.ip !== receipt.primaryIpv4.ip
    || String(server.public_net?.ipv6?.id) !== receipt.primaryIpv6.id
    || server.public_net?.ipv6?.ip !== receipt.primaryIpv6.ip) changed();
  try { assertServerIdentityMatchesQuote({ ...server, locked: false }, evidence.quote_snapshot, evidence.provider_labels); }
  catch { changed(); }
}

/** Advance one explicitly staged preparation, never a purchase or a new
 * enrollment. The claim rechecks the saved owner/quote/recipe intent. Every
 * provider POST is durably marked once before dispatch, and never replayed.
 * The explicit computer-setup caller advances this coordinator. It does not perform
 * SSH, publish targets, install agents or claim runtime readiness.
 */
export async function advanceFirstBoot(
  input: FirstBootOperationScope, dependencies: Partial<Dependencies> = {},
): Promise<FirstBootStep> {
  const deps = { ...defaults, ...dependencies };
  // Claim grants at least 60s of database lease lifetime. Anchor the 30s local
  // dispatch budget BEFORE awaiting it, leaving room for a bounded 15s POST.
  const deadline = deps.monotonicNow() + 30_000;
  const claim = await deps.claim(input); // The adapter snapshots/validates input.
  if (claim.outcome === "busy") return { stage: "busy" };
  if (claim.outcome !== "claimed") throw new FirstBootCoordinatorError("rejected");
  const { lease, operation } = claim;
  const b = lease.binding;
  let enrollment: StoredFirstBootEnrollment | null = null;
  // The legacy recipe's window runs from creation. The current recipe has no
  // enrollment deadline before Start setup; its one window opens in the same
  // database step that records this coordinator's power-on (markPower).
  let enrollmentDeadline: number | null = null;
  const fence = () => {
    if (deps.monotonicNow() >= deadline
      || (enrollmentDeadline !== null && deps.now().getTime() >= enrollmentDeadline)) {
      throw new FirstBootCoordinatorError("deadline_expired");
    }
  };
  const checkpoint = async (result: Promise<boolean>) => {
    if (!await result) throw new FirstBootCoordinatorError("checkpoint_failed");
  };
  try {
    fence();
    const evidence = assertFirstBootCapacityEvidence(await deps.evidence(b), b, lease.providerServerId);
    enrollment = enrollmentMatches(await deps.enrollment(b.orderId, b.attemptId), lease);
    try { enrollmentDeadline = firstBootEnrollmentDeadline(enrollment); }
    catch { throw new FirstBootCoordinatorError("rejected"); }
    fence();
    if (enrollment.phase === "enrolled") return { stage: "identity_enrolled" };
    // An absent original receipt is not permission to replay a POST or adopt
    // something found by its name. Cleanup retains the unresolved claim.
    if (operation.firewallPostAttemptedAt && !operation.firewallReceipt) return { stage: "firewall_outcome_unknown" };
    if (operation.powerOnPostAttemptedAt && !operation.powerOnAction) return { stage: "power_outcome_unknown" };
    const current = await deps.secret(b.userId, b.connectionId, { requireBoundToken: true });
    if (current.connection.id !== b.connectionId || current.revision !== b.connectionRevision
      || current.connection.status !== "ready") throw new FirstBootCoordinatorError("rejected");
    const client = deps.client(current.apiToken);
    const serverId = Number(lease.providerServerId);
    const firewallScope = { orderId: b.orderId, attemptId: b.attemptId, quoteFingerprint: b.quoteFingerprint, serverId };
    const receipt = operation.firewallReceipt
      ? parseFirstBootFirewallReceipt(operation.firewallReceipt, firewallScope) : null;

    async function capacity() {
      fence();
      const original = evidence.provider_creation_receipt;
      const [server, action, nextActions] = await Promise.all([
        client.getServer(serverId), client.getAction(Number(original.action.id)),
        Promise.all(original.nextActions.map(item => client.getAction(Number(item.id)))),
      ]);
      fence();
      assertServer(server, evidence);
      try { assertHetznerCreationReceiptMatchesObservation(original, server, action, nextActions); }
      catch { changed(); }
      if ([action, ...nextActions].some(item => item.status === "error")) throw new FirstBootCoordinatorError("action_failed");
      if (server.status !== "off") changed();
      return { server, settled: !server.locked && [action, ...nextActions].every(item => item.status === "success") };
    }
    async function protectedCapacity() {
      if (!receipt) return changed();
      // Start-time freshness: a slow GET does not become fresh at completion.
      const observedAt = deps.now();
      const [state, firewall, setRulesAction, applyAction] = await Promise.all([
        capacity(), client.getFirewall(receipt.firewallId),
        client.getAction(receipt.setRulesActionId), client.getAction(receipt.applyActionId),
      ]);
      fence();
      const assessed = assessFirstBootFirewall({ scope: firewallScope, receipt, firewall,
        setRulesAction, applyAction, server: state.server });
      return { verified: state.settled && assessed === "firewall_verified", observedAt };
    }
    if (operation.powerOnAction) {
      fence();
      const [server, raw] = await Promise.all([client.getServer(serverId), client.getAction(operation.powerOnAction.id)]);
      fence();
      assertServer(server, evidence);
      const action = firstBootPowerOnAction(serverId, raw);
      if (action.id !== operation.powerOnAction.id) changed();
      await checkpoint(deps.savePower(lease, action));
      if (action.status === "error") throw new FirstBootCoordinatorError("action_failed");
      if (!["off", "starting", "initializing", "running"].includes(server.status)) changed();
      // This describes power/identity observation, never agent readiness.
      return { stage: action.status === "success" && server.status === "running" && !server.locked
        ? "waiting_for_identity" : "waiting_for_power" };
    }
    if (!receipt) {
      const initial = await capacity();
      const attachments = z.array(z.unknown()).length(0);
      if (!attachments.safeParse(initial.server.public_net.firewalls).success) changed();
      if (!initial.settled) return { stage: "waiting_for_capacity" };
      await checkpoint(deps.markFirewall(lease));
      // The persisted dispatch marker is not provider evidence. Check again
      // after that awaited checkpoint, then fence immediately before POST.
      const latest = await capacity();
      if (!latest.settled || !attachments.safeParse(latest.server.public_net.firewalls).success) changed();
      fence();
      const created = await client.createFirewall(firewallScope);
      await checkpoint(deps.saveFirewall(lease, parseFirstBootFirewallReceipt(created, firewallScope)));
      return { stage: "firewall_requested" };
    }
    const protectedState = await protectedCapacity();
    if (!protectedState.verified) return { stage: "waiting_for_firewall" };
    await checkpoint(deps.arm({ binding: b, capacityIdempotencyKey: enrollment.capacityIdempotencyKey,
      creationReceipt: evidence.provider_creation_receipt }));
    await checkpoint(deps.verifyFirewall(lease, receipt, protectedState.observedAt));
    await checkpoint(deps.markPower(lease));
    const finalState = await protectedCapacity();
    if (!finalState.verified) changed();
    fence(); // No await may separate this fence from provider dispatch.
    const action = firstBootPowerOnAction(serverId, await client.powerOnServer(serverId));
    await checkpoint(deps.savePower(lease, action));
    if (action.status === "error") throw new FirstBootCoordinatorError("action_failed");
    return { stage: "power_requested" };
  } catch (error) {
    if (error instanceof FirstBootCoordinatorError) throw error;
    if (error instanceof FirstBootReceiverError) throw new FirstBootCoordinatorError("resource_changed");
    if (error instanceof FirstBootFirewallError) throw new FirstBootCoordinatorError(error.code === "action_failed" ? "action_failed" : "resource_changed");
    // Never forward raw provider/database responses, request data or secrets.
    throw new FirstBootCoordinatorError("provider_unavailable");
  } finally {
    try { await checkpoint(deps.release(lease)); }
    catch { throw new FirstBootCoordinatorError("checkpoint_failed"); }
  }
}
