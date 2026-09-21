import "server-only";

import { createHetznerCloudFirstBootClient, type HetznerCloudFirstBootClient } from "@/lib/hetzner/client";
import { assessEnrolledGuestFirewall, assessFirstBootFirewall, firstBootPowerOnAction } from "@/lib/hetzner/first-boot-firewall";
import { canonicalFirstBootHostKey } from "./first-boot-enrollment";
import { parseFirstBootOperationScope, type FirstBootOperation, type FirstBootOperationScope } from "./first-boot-operations";
import { assertFirstBootCapacityEvidence, loadFirstBootCapacityEvidence } from "./first-boot-receiver";
import { loadFirstBootEnrollment } from "./first-boot-store";
import { assertServerIdentityMatchesCurrentShape } from "./hetzner-cloud";
import { loadHetznerCloudConnectionSecret } from "./hetzner-cloud-store";
import { assertHetznerCreationReceiptMatchesObservation } from "./hetzner-creation-receipt";

export type EnrolledProviderReceiptDependencies = {
  evidence: typeof loadFirstBootCapacityEvidence;
  enrollment: typeof loadFirstBootEnrollment;
  secret: typeof loadHetznerCloudConnectionSecret;
  client: (token: string) => Pick<HetznerCloudFirstBootClient, "getServer" | "getAction" | "getFirewall">;
  now: () => Date;
  monotonicNow: () => number;
};

const defaults: EnrolledProviderReceiptDependencies = {
  evidence: loadFirstBootCapacityEvidence,
  enrollment: loadFirstBootEnrollment,
  secret: loadHetznerCloudConnectionSecret,
  client: createHetznerCloudFirstBootClient,
  now: () => new Date(),
  monotonicNow: () => performance.now(),
};

export class EnrolledProviderReceiptError extends Error {
  constructor(readonly code: "rejected" | "resource_changed" | "action_failed" | "deadline_expired" | "verification_failed") {
    super("Enrolled provider receipt failed: " + code);
    this.name = "EnrolledProviderReceiptError";
  }
}

export type VerifiedEnrolledProviderReceipt = {
  stage: "provider_verified";
  scope: FirstBootOperationScope;
  address: string;
  hostPublicKey: string;
  hostFingerprintSha256: string;
  capacityIdempotencyKey: string;
  observedAt: string;
  powerOnAction: ReturnType<typeof firstBootPowerOnAction>;
};
type EnrolledProviderReceiptInput = { scope: FirstBootOperationScope; operation: FirstBootOperation; dispatchDeadlineMs: number;
  requireDirectHttps?: boolean };
export type VerifiedEnrolledProviderPowerReceipt = VerifiedEnrolledProviderReceipt & { powerState: "running" | "off" };

/** Shared read-only provider identity check for an already enrolled computer.
 * The caller owns and retains its lifecycle lease; this function does not
 * claim, renew or release one. Its input operation must come from that exact
 * owner-bound journal. A verified receipt is not permission to dispatch later:
 * callers must retain their original deadline and check operation authority.
 *
 * Only the project token is opened here. No administrator/model key, enrollment
 * capability, SSH connection, guest command or ready target is returned/created.
 */
export async function verifyEnrolledProviderReceipt(input: EnrolledProviderReceiptInput,
  dependencies: Partial<EnrolledProviderReceiptDependencies> = {}): Promise<
  { stage: "waiting_for_provider" } | VerifiedEnrolledProviderReceipt
> {
  const result = await verifyEnrolledProviderComputer(input, false, dependencies);
  if (result.stage === "waiting_for_provider") return result;
  // Preserve the original preparation/readiness response and running-only gate.
  const { powerState, ...receipt } = result;
  void powerState;
  return receipt;
}

/** Power observes the same original receipt, pin, image and firewall while the
 * computer is either on or off. It neither invents a running observation for
 * an off server nor authorizes a mutation. The power coordinator owns the
 * original operation, dispatch fence and desired/observed-state comparison. */
export function verifyEnrolledProviderPowerReceipt(input: EnrolledProviderReceiptInput,
  dependencies: Partial<EnrolledProviderReceiptDependencies> = {}) {
  return verifyEnrolledProviderComputer(input, true, dependencies);
}

async function verifyEnrolledProviderComputer(input: EnrolledProviderReceiptInput, allowStopped: boolean,
  dependencies: Partial<EnrolledProviderReceiptDependencies>): Promise<
  { stage: "waiting_for_provider" } | VerifiedEnrolledProviderPowerReceipt
> {
  const deps = { ...defaults, ...dependencies };
  const deadline = input.dispatchDeadlineMs;
  const remaining = deadline - deps.monotonicNow();
  const fence = () => {
    if (deps.monotonicNow() >= deadline) throw new EnrolledProviderReceiptError("deadline_expired");
  };
  const changed = (): never => { throw new EnrolledProviderReceiptError("resource_changed"); };
  try {
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 30_000) {
      throw new EnrolledProviderReceiptError("deadline_expired");
    }
    // Both objects may be retained by the caller. Freeze our meaning of their
    // scope and original receipts before the first asynchronous read.
    const current = parseFirstBootOperationScope(input.scope);
    if (input.requireDirectHttps !== undefined && typeof input.requireDirectHttps !== "boolean") {
      throw new EnrolledProviderReceiptError("rejected");
    }
    const requireHttps = input.requireDirectHttps === true;
    const operation = structuredClone(input.operation);
    const operationScope = parseFirstBootOperationScope({
      binding: operation.binding, providerServerId: operation.providerServerId,
    });
    if (JSON.stringify(operationScope) !== JSON.stringify(current)) {
      throw new EnrolledProviderReceiptError("rejected");
    }
    const b = current.binding;
    const receipt = operation.firewallReceipt, power = operation.powerOnAction;
    if (!receipt || !power || !operation.firewallPostAttemptedAt || !operation.firewallVerifiedAt
      || !operation.powerOnPostAttemptedAt || operation.abandonedAt) {
      throw new EnrolledProviderReceiptError("resource_changed");
    }

    fence();
    const evidence = assertFirstBootCapacityEvidence(await deps.evidence(b), b, current.providerServerId);
    fence();
    const enrolled = await deps.enrollment(b.orderId, b.attemptId);
    fence();
    if (!enrolled || enrolled.phase !== "enrolled" || enrolled.providerServerId !== current.providerServerId
      || !enrolled.enrolledHostPublicKey || !enrolled.hostFingerprintSha256
      || Object.entries(b).some(([key, value]) => enrolled.challenge.binding[key as keyof typeof b] !== value)) {
      throw new EnrolledProviderReceiptError("rejected");
    }
    const pin = canonicalFirstBootHostKey(enrolled.enrolledHostPublicKey);
    if (pin.fingerprintSha256 !== enrolled.hostFingerprintSha256) changed();
    const connection = await deps.secret(b.userId, b.connectionId, { requireBoundToken: true });
    fence();
    if (connection.connection.id !== b.connectionId || connection.connection.status !== "ready"
      || connection.revision !== b.connectionRevision) throw new EnrolledProviderReceiptError("rejected");

    const client = deps.client(connection.apiToken), original = evidence.provider_creation_receipt;
    const serverId = Number(current.providerServerId);
    const observedAt = deps.now().toISOString(); // Freshness starts before provider I/O.
    fence();
    const [server, creation, nextActions, firewall, setRulesAction, applyAction, powerAction] = await Promise.all([
      client.getServer(serverId), client.getAction(Number(original.action.id)),
      Promise.all(original.nextActions.map(action => client.getAction(Number(action.id)))),
      client.getFirewall(receipt.firewallId), client.getAction(receipt.setRulesActionId),
      client.getAction(receipt.applyActionId), client.getAction(power.id),
    ]);
    fence();
    try {
      assertServerIdentityMatchesCurrentShape(
        { ...server, locked: false },
        evidence.quote_snapshot,
        evidence.provider_labels,
        evidence.current_server_shape,
      );
      assertHetznerCreationReceiptMatchesObservation(original, server, creation, nextActions);
    } catch { changed(); }
    const boot = firstBootPowerOnAction(serverId, powerAction);
    if (boot.id !== power.id || typeof server.locked !== "boolean") changed();
    if ([creation, ...nextActions, boot].some(action => action.status === "error")) {
      throw new EnrolledProviderReceiptError("action_failed");
    }
    const allowedStates = allowStopped ? ["running", "off", "starting", "stopping", "initializing", "migrating"]
      : ["running", "starting", "initializing"];
    if (!allowedStates.includes(server.status)) changed();
    if (server.locked || (server.status !== "running" && !(allowStopped && server.status === "off"))
      || [creation, ...nextActions, boot].some(action => action.status !== "success")) {
      return { stage: "waiting_for_provider" };
    }
    const assessFirewall = server.status === "off" ? assessFirstBootFirewall : assessEnrolledGuestFirewall;
    if (assessFirewall({
      scope: { orderId: b.orderId, attemptId: b.attemptId, quoteFingerprint: b.quoteFingerprint, serverId },
      receipt, firewall, setRulesAction, applyAction, server, requireHttps,
    }) !== "firewall_verified") return { stage: "waiting_for_provider" };
    fence();
    return {
      stage: "provider_verified", scope: current, address: original.primaryIpv4.ip,
      hostPublicKey: pin.publicKey, hostFingerprintSha256: pin.fingerprintSha256,
      capacityIdempotencyKey: enrolled.capacityIdempotencyKey, observedAt, powerOnAction: boot,
      powerState: server.status === "off" ? "off" : "running",
    };
  } catch (error) {
    if (error instanceof EnrolledProviderReceiptError) throw error;
    throw new EnrolledProviderReceiptError("verification_failed");
  }
}
