import "server-only";

import { listInfrastructureDeploymentTargets, InfrastructureConnectionStoreError } from "./connection-store";
import { listHetznerCloudCleanupOrders, loadHetznerCloudCleanupOrder, loadHetznerCloudConnectionMetadata, type StoredHetznerCloudCapacityOrder } from "./hetzner-cloud-store";
import { FIRST_BOOT_RECIPE_VERSION } from "./first-boot-enrollment";
import { loadFirstBootEnrollmentForOrder } from "./first-boot-store";
import { loadFirstBootOperation } from "./first-boot-operations";
import { advanceFirstBoot } from "./first-boot-coordinator";
import { prepareEnrolledGuest } from "./enrolled-guest-verification";
import { ProviderComputerSetupRequestSchema, ProviderComputerSetupViewSchema, PROVIDER_SETUP_TERMINAL_STAGES,
  type ProviderComputerSetupRequest, type ProviderComputerSetupView } from "./provider-computer-setup-contracts";

type Dependencies = {
  connection: typeof loadHetznerCloudConnectionMetadata; orders: typeof listHetznerCloudCleanupOrders;
  order: typeof loadHetznerCloudCleanupOrder; enrollment: typeof loadFirstBootEnrollmentForOrder;
  boot: typeof loadFirstBootOperation; targets: typeof listInfrastructureDeploymentTargets;
  advance: typeof advanceFirstBoot; prepare: typeof prepareEnrolledGuest; now: () => Date;
};
const defaults: Dependencies = { connection: loadHetznerCloudConnectionMetadata, orders: listHetznerCloudCleanupOrders,
  order: loadHetznerCloudCleanupOrder, enrollment: loadFirstBootEnrollmentForOrder, boot: loadFirstBootOperation,
  targets: listInfrastructureDeploymentTargets, advance: advanceFirstBoot, prepare: prepareEnrolledGuest, now: () => new Date() };

export class ProviderComputerSetupError extends Error {
  constructor(readonly code: "connection_changed" | "setup_not_active" | "setup_failed") {
    super("Computer setup could not continue: " + code); this.name = "ProviderComputerSetupError";
  }
}

async function describe(userId: string, connectionId: string, order: StoredHetznerCloudCapacityOrder, deps: Dependencies) {
  const operation = order.operation;
  if (operation.connectionId !== connectionId) throw new ProviderComputerSetupError("connection_changed");
  const view: ProviderComputerSetupView = {
    orderId: operation.id, connectionId, connectionRevision: order.connectionRevision,
    serverName: operation.quote.serverName, providerServerId: operation.providerServerId,
    stage: "awaiting_setup", targetId: null, observedAt: null, launchReady: false, enrollmentExpiresAt: null,
  };
  const creationScope = { binding: { userId, connectionId, connectionRevision: order.connectionRevision, orderId: operation.id,
    quoteFingerprint: order.quoteFingerprintSha256, recipeVersion: FIRST_BOOT_RECIPE_VERSION }, capacityIdempotencyKey: operation.idempotencyKey };
  const enrollment = await deps.enrollment(creationScope);
  const scope = enrollment && operation.providerServerId
    ? { binding: enrollment.challenge.binding, providerServerId: operation.providerServerId } : null;
  // The key is only a deadline until the server connects back with it.
  if (enrollment && (enrollment.phase === "staged" || enrollment.phase === "awaiting_identity")) {
    view.enrollmentExpiresAt = enrollment.challenge.expiresAt;
  }
  if (["deleted", "cleaning"].includes(operation.status)) view.stage = "retired";
  else if (!enrollment) view.stage = "not_requested";
  else if (["revoked", "failed"].includes(enrollment.phase)) view.stage = "stopped";
  else if (enrollment.phase !== "enrolled" && deps.now().getTime() >= Date.parse(enrollment.challenge.expiresAt)) view.stage = "expired";
  else if (operation.status !== "created_off" || !scope) view.stage = "waiting_for_capacity";
  else {
    const boot = await deps.boot(scope);
    if (boot?.abandonedAt) view.stage = "stopped";
    else if (enrollment.phase === "enrolled") {
      view.stage = "identity_enrolled";
      const targets = await deps.targets(userId, { connectionId });
      const target = targets.find(candidate => "kind" in candidate.capabilities
        && candidate.capabilities.kind === "provider-vm"
        && candidate.capabilities.capacityOrderId === operation.id);
      if (target && "kind" in target.capabilities && target.capabilities.kind === "provider-vm") {
        if (target.externalId !== scope.providerServerId || target.evidenceConnectionRevision !== order.connectionRevision
          || target.capabilities.enrollmentAttemptId !== scope.binding.attemptId) throw new ProviderComputerSetupError("connection_changed");
        view.targetId = target.id; view.observedAt = target.lastPreflightAt;
        if (target.lastErrorCode === "PROVIDER_COMPUTER_RETIRING") view.stage = "retired";
        else if (target.capabilities.provisioner.ready) {
          view.stage = "environment_prepared";
          view.launchReady = target.status === "ready" && target.capabilities.launchReady;
        }
      }
    } else if (boot?.firewallPostAttemptedAt && !boot.firewallReceipt) view.stage = "firewall_outcome_unknown";
    else if (boot?.powerOnPostAttemptedAt && !boot.powerOnAction) view.stage = "power_outcome_unknown";
    else if (boot?.powerOnAction) view.stage = boot.powerOnAction.status === "success" ? "waiting_for_identity" : "waiting_for_power";
    else if (boot?.firewallReceipt) view.stage = "waiting_for_firewall";
  }
  return { view: ProviderComputerSetupViewSchema.parse(view), scope };
}

/** An inventory read never powers, installs, renews enrollment or resumes work. */
export async function listProviderComputerSetups(userId: string, connectionId: string, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  const orders = await deps.orders(userId, connectionId);
  const results = await Promise.all(orders.map(order => describe(userId, connectionId, order, deps)));
  return results.map(result => result.view);
}

/** Only an authenticated, same-origin POST may advance the already-confirmed
 * original recipe. The caller never supplies a server, SSH pin, key or command. */
export async function advanceProviderComputerSetup(userId: string, connectionId: string, input: ProviderComputerSetupRequest,
  dependencies: Partial<Dependencies> = {}): Promise<ProviderComputerSetupView> {
  const deps = { ...defaults, ...dependencies }, request = ProviderComputerSetupRequestSchema.parse(input);
  const connection = await deps.connection(userId, connectionId);
  if (connection.provider !== "hetzner-cloud") throw new InfrastructureConnectionStoreError("invalid_request");
  if (connection.status !== "ready" || connection.revision !== request.expectedConnectionRevision) {
    throw new ProviderComputerSetupError("connection_changed");
  }
  const order = await deps.order(userId, connectionId, request.orderId);
  if (order.connectionRevision !== request.expectedConnectionRevision) throw new ProviderComputerSetupError("connection_changed");
  const { view, scope } = await describe(userId, connectionId, order, deps);
  if (view.stage === "environment_prepared" && view.launchReady) return view;
  if (PROVIDER_SETUP_TERMINAL_STAGES.has(view.stage) || !scope) throw new ProviderComputerSetupError("setup_not_active");
  if (view.stage === "waiting_for_capacity") return view;
  try {
    if (view.stage === "identity_enrolled" || view.stage === "environment_prepared") {
      const result = await deps.prepare(scope);
      return ProviderComputerSetupViewSchema.parse(result.stage === "computer_prepared"
        ? { ...view, stage: "environment_prepared", targetId: result.target.id, observedAt: result.target.lastPreflightAt,
          launchReady: result.target.status === "ready" && result.target.capabilities.launchReady }
        : { ...view, stage: result.stage });
    }
    const result = await deps.advance(scope);
    return ProviderComputerSetupViewSchema.parse({ ...view, stage: result.stage });
  } catch { throw new ProviderComputerSetupError("setup_failed"); }
}
