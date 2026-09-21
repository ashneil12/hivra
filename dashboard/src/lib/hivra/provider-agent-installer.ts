import "server-only";

import { loadPortableProvisionerBundle } from "@/lib/infrastructure/connection-preparation";
import { loadFirstBootOperation, parseFirstBootOperationScope, type FirstBootOperationScope } from "@/lib/infrastructure/first-boot-operations";
import { verifyEnrolledProviderReceipt } from "@/lib/infrastructure/enrolled-provider-receipt";
import { loadHetznerCloudCapacityBootstrap } from "@/lib/infrastructure/hetzner-cloud-store";
import { controlProviderGuestInstaller } from "@/lib/infrastructure/first-boot-ssh";
import { buildProviderGuestWorkerPlan, parseProviderGuestWorkerReceipt, type ProviderGuestLaunch,
  type ProviderGuestWorkerIdentity, type ProviderGuestWorkerInput } from "@/lib/infrastructure/provider-guest-worker";
import { beginProviderAgentInstall, loadProviderAgentInstallOperation, recordProviderAgentInstallStopped,
  type ProviderAgentInstallOperation, type ProviderAgentInstallContext } from "./provider-agent-install-store";

type Dependencies = {
  load: typeof loadProviderAgentInstallOperation; begin: typeof beginProviderAgentInstall;
  stopped: typeof recordProviderAgentInstallStopped; bundle: typeof loadPortableProvisionerBundle;
  boot: typeof loadFirstBootOperation; verify: typeof verifyEnrolledProviderReceipt;
  bootstrap: typeof loadHetznerCloudCapacityBootstrap; control: typeof controlProviderGuestInstaller;
  monotonicNow: () => number;
};
const defaults: Dependencies = {
  load: loadProviderAgentInstallOperation, begin: beginProviderAgentInstall, stopped: recordProviderAgentInstallStopped,
  bundle: loadPortableProvisionerBundle, boot: loadFirstBootOperation, verify: verifyEnrolledProviderReceipt,
  bootstrap: loadHetznerCloudCapacityBootstrap, control: controlProviderGuestInstaller, monotonicNow: () => performance.now(),
};
type Input = ProviderAgentInstallOperation & ({ action: "start"; launch: ProviderGuestLaunch } | { action: "status" | "cancel" });
export class ProviderAgentInstallerError extends Error {
  constructor(readonly code: "rejected" | "deadline_expired" | "unsupported_bundle" | "verification_failed" | "outcome_unknown") {
    super("Provider agent installer failed: " + code); this.name = "ProviderAgentInstallerError";
  }
}
function sameScope(actual: FirstBootOperationScope, expected: FirstBootOperationScope) {
  return JSON.stringify(parseFirstBootOperationScope(actual)) === JSON.stringify(parseFirstBootOperationScope(expected));
}
function sameIdentity(actual: unknown, expected: ProviderGuestWorkerIdentity) {
  try {
    parseProviderGuestWorkerReceipt(`HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify({ version: 1, identity: actual, state: "unknown", stopped: false })}\n`, expected);
    return true;
  } catch { return false; }
}
function recordedTerminal(context: ProviderAgentInstallContext, identity: ProviderGuestWorkerIdentity) {
  if (context.stoppedAt === null && context.outcome === null) return null;
  if (!context.stoppedAt || !Number.isFinite(Date.parse(context.stoppedAt)) || !sameIdentity(context.identity, identity)) {
    throw new ProviderAgentInstallerError("rejected");
  }
  const receipt = parseProviderGuestWorkerReceipt(`HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify({
    version: 1, identity: context.identity, state: context.outcome, stopped: true,
  })}\n`, identity);
  return { stage: "worker_observed" as const, state: receipt.state, stopped: true, source: "recorded" as const };
}

/** Private adapter for an already reserved provider agent. The authenticated
 * route must supply its user ID and the existing operation, and resolve model
 * credentials from the owner's launch choice. No caller can choose a host/key,
 * bundle, arbitrary command or new lease. This does not enable public launch.
 *
 * Every ambiguous result retains the existing provision operation. A stopped
 * worker is journaled, never translated into ready, release, rollback or delete.
 */
export async function advanceProviderAgentInstaller(input: Input, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies }, deadline = deps.monotonicNow() + 30_000;
  let attempted = false;
  const fence = () => { if (!Number.isFinite(deadline) || deps.monotonicNow() >= deadline) throw new ProviderAgentInstallerError("deadline_expired"); };
  try {
    const request = structuredClone(input); // Snapshot before any asynchronous read.
    if (!["start", "status", "cancel"].includes(request.action)) throw new ProviderAgentInstallerError("rejected");
    const op = { userId: request.userId, agentId: request.agentId, operationId: request.operationId };
    fence();
    const context = await deps.load(op);
    fence();
    const clock = { bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", boottimeMs: 0 }; // Validation only, never executed.
    let worker: ProviderGuestWorkerInput, plan: ReturnType<typeof buildProviderGuestWorkerPlan>;
    if (context.identity !== null) {
      // Recovery never reads the current bundle or relays launch credentials.
      // The original journal selects a retained, reviewed control protocol.
      worker = { ...op, scope: context.scope, identity: context.identity as ProviderGuestWorkerIdentity,
        action: request.action === "start" ? "status" : request.action };
      try { plan = buildProviderGuestWorkerPlan(worker, clock); }
      catch { throw new ProviderAgentInstallerError("unsupported_bundle"); }
    } else {
      if (request.action !== "start") return { stage: "not_dispatched" as const }; // Not stop/release permission.
      const assets = await deps.bundle();
      fence();
      worker = { ...op, scope: context.scope, assets, action: "start", launch: request.launch };
      plan = buildProviderGuestWorkerPlan(worker, clock);
      // The launch document must match the access binding journaled before any
      // guest mutation. Hosted installs bind a named-tunnel claim; standalone
      // installs bind their exact public sslip hostname and carry no platform secret.
      let tunnelId: unknown = null;
      if (request.launch.tunnelToken !== null) {
        try { tunnelId = JSON.parse(Buffer.from(request.launch.tunnelToken, "base64").toString("utf8")).t; } catch { /* reject below */ }
      }
      const accessMatches = context.accessMode === "cloudflare-named"
        ? request.launch.accessHostname === null && Boolean(context.tunnelId) && tunnelId === context.tunnelId
        : context.accessMode === "direct-https" && request.launch.tunnelToken === null
          && context.tunnelId === null && request.launch.accessHostname === context.hostname;
      if (request.launch.agentKind !== context.runtime || !accessMatches) {
        throw new ProviderAgentInstallerError("rejected");
      }
    }
    const terminal = recordedTerminal(context, plan.identity);
    if (terminal) return terminal; // No new cancel marker may rewrite a durable outcome.
    let action: "start" | "status" | "cancel" = worker.action;
    fence();
    const boot = await deps.boot(context.scope);
    fence();
    if (!boot) throw new ProviderAgentInstallerError("rejected");
    const verified = await deps.verify({ scope: context.scope, operation: boot, dispatchDeadlineMs: deadline,
      ...(context.accessMode === "direct-https" ? { requireDirectHttps: true } : {}) },
      { monotonicNow: deps.monotonicNow });
    fence();
    if (verified.stage === "waiting_for_provider") return verified;
    if (!sameScope(verified.scope, context.scope)) throw new ProviderAgentInstallerError("verification_failed");
    const current = await deps.load(op);
    fence();
    const hasIdentity = sameIdentity(current.identity, plan.identity);
    if (!sameScope(current.scope, context.scope) || (!hasIdentity && !(request.action === "start" && current.identity === null && context.identity === null))
      || current.targetId !== context.targetId || current.runtime !== context.runtime || current.tunnelId !== context.tunnelId
      || current.accessMode !== context.accessMode || current.hostname !== context.hostname) {
      throw new ProviderAgentInstallerError("rejected");
    }
    const completed = recordedTerminal(current, plan.identity);
    if (completed) return completed;
    if (request.action === "start" && current.desiredState === "deleted" && !hasIdentity) return { stage: "not_dispatched" as const };
    const b = context.scope.binding;
    const bootstrap = await deps.bootstrap({ userId: b.userId, connectionId: b.connectionId, expectedRevision: b.connectionRevision,
      orderId: b.orderId, idempotencyKey: verified.capacityIdempotencyKey, quoteFingerprintSha256: b.quoteFingerprint });
    fence();
    // Do not consume the one-use grant while the provider is still converging
    // or before the original administrator credential can be loaded. A lost
    // grant acknowledgement remains unknown; it must never be redispatched.
    if (worker.action === "start") {
      const grant = await deps.begin(op, plan.identity);
      fence();
      if (grant.outcome === "rejected") throw new ProviderAgentInstallerError("rejected");
      action = current.desiredState === "deleted" ? "cancel" : grant.outcome === "dispatch" ? "start" : "status";
    } else if (request.action === "start" && current.desiredState === "deleted") {
      action = "cancel";
    }
    const control: ProviderGuestWorkerInput = action === "start" && worker.action === "start" ? worker
      : { ...op, scope: context.scope, identity: plan.identity, action: action as "status" | "cancel" };
    attempted = true;
    const result = await deps.control({ ...control,
      address: verified.address, hostPublicKey: verified.hostPublicKey,
      administratorPublicKey: bootstrap.publicKeyOpenSsh, administratorPrivateKey: bootstrap.privateKeyOpenSsh,
      dispatchDeadlineMs: deadline,
    }, { monotonicNow: deps.monotonicNow });
    fence();
    if (result.hostVerified !== true || result.administratorAuthenticated !== true
      || result.hostFingerprintSha256 !== verified.hostFingerprintSha256) throw new ProviderAgentInstallerError("verification_failed");
    const receipt = parseProviderGuestWorkerReceipt(`HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify(result.receipt)}\n`, plan.identity);
    if (receipt.stopped) {
      fence();
      if (!await deps.stopped(op, receipt)) {
        // Another observer may have durably recorded a stopped outcome after
        // our last read but before this cancel reached the guest. Keep that
        // canonical proof; never overwrite it with a later cancel marker.
        fence();
        const settled = await deps.load(op);
        fence();
        if (sameScope(settled.scope, context.scope) && settled.targetId === context.targetId
          && settled.runtime === context.runtime && settled.tunnelId === context.tunnelId
          && settled.accessMode === context.accessMode && settled.hostname === context.hostname) {
          const canonical = recordedTerminal(settled, plan.identity);
          if (canonical) return canonical;
        }
        throw new ProviderAgentInstallerError("verification_failed");
      }
      fence();
    }
    return { stage: "worker_observed" as const, state: receipt.state, stopped: receipt.stopped };
  } catch (error) {
    if (attempted) throw new ProviderAgentInstallerError("outcome_unknown");
    if (error instanceof ProviderAgentInstallerError) throw error;
    throw new ProviderAgentInstallerError("verification_failed");
  }
}
