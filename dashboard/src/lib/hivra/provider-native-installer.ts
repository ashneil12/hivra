import "server-only";

import { loadPortableProvisionerBundle } from "@/lib/infrastructure/connection-preparation";
import { loadFirstBootOperation, parseFirstBootOperationScope } from "@/lib/infrastructure/first-boot-operations";
import { verifyEnrolledProviderReceipt } from "@/lib/infrastructure/enrolled-provider-receipt";
import { loadHetznerCloudCapacityBootstrap } from "@/lib/infrastructure/hetzner-cloud-store";
import { controlProviderNativeInstaller } from "@/lib/infrastructure/first-boot-ssh";
import { buildProviderNativeWorkerPlan, parseProviderNativeWorkerIdentity, parseProviderNativeWorkerReceipt, parseProviderNativeAccess,
  type ProviderNativeLaunch, type ProviderNativeWorkerIdentity, type ProviderNativeWorkerInput } from "@/lib/infrastructure/provider-native-worker";
import type { ProviderAgentInstallOperation } from "./provider-agent-install-store";
import { ProviderAgentInstallerError } from "./provider-agent-installer";
import { beginProviderNativeCleanup, beginProviderNativeInstall, loadProviderNativeInstallOperation,
  recordProviderNativeCleanup, recordProviderNativeInstallStopped, type ProviderNativeInstallContext } from "./provider-native-install-store";

type Dependencies = {
  load: typeof loadProviderNativeInstallOperation; begin: typeof beginProviderNativeInstall;
  stopped: typeof recordProviderNativeInstallStopped; cleanupBegin: typeof beginProviderNativeCleanup;
  cleanupRecord: typeof recordProviderNativeCleanup; bundle: typeof loadPortableProvisionerBundle;
  boot: typeof loadFirstBootOperation; verify: typeof verifyEnrolledProviderReceipt;
  bootstrap: typeof loadHetznerCloudCapacityBootstrap; control: typeof controlProviderNativeInstaller;
  monotonicNow: () => number;
};
const defaults: Dependencies = {
  load: loadProviderNativeInstallOperation, begin: beginProviderNativeInstall, stopped: recordProviderNativeInstallStopped,
  cleanupBegin: beginProviderNativeCleanup, cleanupRecord: recordProviderNativeCleanup, bundle: loadPortableProvisionerBundle,
  boot: loadFirstBootOperation, verify: verifyEnrolledProviderReceipt, bootstrap: loadHetznerCloudCapacityBootstrap,
  control: controlProviderNativeInstaller, monotonicNow: () => performance.now(),
};
type Input = ProviderAgentInstallOperation & ({ action: "start"; launch: ProviderNativeLaunch } | { action: "status" | "cancel" });
function sameIdentity(actual: unknown, expected: ProviderNativeWorkerIdentity) {
  try { return JSON.stringify(parseProviderNativeWorkerIdentity(actual)) === JSON.stringify(expected); }
  catch { return false; }
}
function validateContext(context: ProviderNativeInstallContext, op: ProviderAgentInstallOperation) {
  if (context.operation.userId !== op.userId || context.operation.agentId !== op.agentId || context.operation.operationId !== op.operationId
    || context.scope.binding.userId !== op.userId || context.runtime !== "deepseek-harness"
    || !["running", "deleted"].includes(context.desiredState) || typeof context.cancellationRequested !== "boolean") {
    throw new ProviderAgentInstallerError("rejected");
  }
  if (context.stoppedAt !== null || context.outcome !== null) {
    if (!context.stoppedAt || !Number.isFinite(Date.parse(context.stoppedAt))
      || !["succeeded", "cancelled", "failed"].includes(String(context.outcome)) || context.identity === null) {
      throw new ProviderAgentInstallerError("rejected");
    }
  }
  if (context.cancellationRequested && context.identity === null) throw new ProviderAgentInstallerError("rejected");
}
function unchangedBinding(current: ProviderNativeInstallContext, original: ProviderNativeInstallContext) {
  return JSON.stringify(parseFirstBootOperationScope(current.scope)) === JSON.stringify(parseFirstBootOperationScope(original.scope))
    && current.targetId === original.targetId && current.runtime === original.runtime
    && current.accessMode === original.accessMode && current.hostname === original.hostname && current.tunnelId === original.tunnelId;
}

/** Private native adapter for an already reserved, owner-bound provider VM.
 * Native provisioning is not publicly selectable. The existing delete route
 * may recover an already reserved native operation. Same provider receipt, original admin key and
 * one-use dispatch grant as v1; no ambient fleet/first-boot/replacement powers.
 *
 * Unlike v1, NO cached terminal outcome bypasses fresh native observation.
 * Explicit cancellation acquires its grant before the signed SSH clock read.
 * Status does not stop the native service and cannot persist cleanup authority. The
 * installer outcome stays immutable; only fresh grant-bound cleanup can later
 * permit SQL to release the original operation. This function never releases.
 */
export async function advanceProviderNativeInstaller(input: Input, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies }, deadline = deps.monotonicNow() + 30_000;
  let attempted = false;
  const fence = () => { if (!Number.isFinite(deadline) || deps.monotonicNow() >= deadline) throw new ProviderAgentInstallerError("deadline_expired"); };
  try {
    const request = structuredClone(input);
    if (!["start", "status", "cancel"].includes(request.action)) throw new ProviderAgentInstallerError("rejected");
    const op = { userId: request.userId, agentId: request.agentId, operationId: request.operationId };
    fence();
    const context = await deps.load(op);
    fence(); validateContext(context, op);
    // Only validates a script/identity, never a receipt or executed guest clock.
    const validationClock = { bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", boottimeMs: 0 };
    let worker: ProviderNativeWorkerInput, plan: ReturnType<typeof buildProviderNativeWorkerPlan>;
    if (context.identity !== null) {
      worker = { ...op, scope: context.scope, identity: context.identity as ProviderNativeWorkerIdentity,
        action: request.action === "start" ? "status" : request.action };
      try { plan = buildProviderNativeWorkerPlan(worker, validationClock); }
      catch { throw new ProviderAgentInstallerError("unsupported_bundle"); }
    } else {
      if (request.action !== "start" || context.desiredState === "deleted") return { stage: "not_dispatched" as const };
      if (!context.hostname) throw new ProviderAgentInstallerError("rejected");
      const assets = await deps.bundle();
      fence();
      worker = { ...op, scope: context.scope, assets, action: "start", launch: request.launch, journaledHostname: context.hostname };
      plan = buildProviderNativeWorkerPlan(worker, validationClock);
      let tunnelId: unknown = null;
      if (request.launch.tunnelToken !== null) {
        try { tunnelId = JSON.parse(Buffer.from(request.launch.tunnelToken, "base64").toString("utf8")).t; } catch { /* reject below */ }
      }
      const accessMatches = context.accessMode === "cloudflare-named"
        ? request.launch.accessHostname === null && Boolean(context.tunnelId) && tunnelId === context.tunnelId
        : context.accessMode === "direct-https" && request.launch.tunnelToken === null
          && context.tunnelId === null && request.launch.accessHostname === context.hostname;
      if (!accessMatches) throw new ProviderAgentInstallerError("rejected");
    }
    fence();
    const boot = await deps.boot(context.scope);
    fence();
    if (!boot) throw new ProviderAgentInstallerError("rejected");
    const verified = await deps.verify({ scope: context.scope, operation: boot, dispatchDeadlineMs: deadline,
      ...(context.accessMode === "direct-https" ? { requireDirectHttps: true } : {}) }, { monotonicNow: deps.monotonicNow });
    fence();
    if (verified.stage === "waiting_for_provider") return verified;
    if (JSON.stringify(parseFirstBootOperationScope(verified.scope)) !== JSON.stringify(parseFirstBootOperationScope(context.scope))) {
      throw new ProviderAgentInstallerError("verification_failed");
    }
    const current = await deps.load(op);
    fence(); validateContext(current, op);
    const hasIdentity = sameIdentity(current.identity, plan.identity);
    if (!unchangedBinding(current, context) || (!hasIdentity && !(context.identity === null && current.identity === null && request.action === "start"))
      || (context.cancellationRequested && !current.cancellationRequested)
      || (context.stoppedAt !== null && (current.stoppedAt !== context.stoppedAt || current.outcome !== context.outcome))) {
      throw new ProviderAgentInstallerError("rejected");
    }
    if (current.desiredState === "deleted" && !hasIdentity) return { stage: "not_dispatched" as const };
    const b = context.scope.binding;
    const bootstrap = await deps.bootstrap({ userId: b.userId, connectionId: b.connectionId, expectedRevision: b.connectionRevision,
      orderId: b.orderId, idempotencyKey: verified.capacityIdempotencyKey, quoteFingerprintSha256: b.quoteFingerprint });
    fence();
    let action: "start" | "status" | "cancel" = worker.action;
    if (worker.action === "start") {
      const grant = await deps.begin(op, plan.identity, parseProviderNativeAccess({
        mode: current.accessMode, hostname: current.hostname, tunnelId: current.tunnelId,
      }));
      fence();
      if (grant.outcome === "rejected") throw new ProviderAgentInstallerError("rejected");
      action = grant.outcome === "dispatch" ? "start" : "status";
    }
    if (request.action === "start" && (current.desiredState === "deleted" || current.cancellationRequested)) action = "cancel";
    // Acquire once before SSH; never refresh a grant or retrieve a newer token
    // after seeing a receipt. A timeout/response loss keeps the cancellation latch.
    const cleanupGrant = action === "cancel" ? await deps.cleanupBegin(op, plan.identity) : null;
    fence();
    if (action === "cancel" && !cleanupGrant) throw new ProviderAgentInstallerError("rejected");
    const control: ProviderNativeWorkerInput = action === "start" && worker.action === "start" ? worker
      : { ...op, scope: context.scope, identity: plan.identity, action: action as "status" | "cancel" };
    attempted = true;
    const result = await deps.control({ ...control, address: verified.address, hostPublicKey: verified.hostPublicKey,
      administratorPublicKey: bootstrap.publicKeyOpenSsh, administratorPrivateKey: bootstrap.privateKeyOpenSsh,
      dispatchDeadlineMs: deadline }, { monotonicNow: deps.monotonicNow });
    fence();
    if (result.hostVerified !== true || result.administratorAuthenticated !== true
      || result.hostFingerprintSha256 !== verified.hostFingerprintSha256) throw new ProviderAgentInstallerError("verification_failed");
    // Re-validate against the clock returned by THIS SSH invocation. Never
    // manufacture a matching clock from nativeCleanup.bootId or stored proof.
    const receipt = parseProviderNativeWorkerReceipt(`HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify(result.receipt)}\n`, plan.identity, result.clock);
    if (current.stoppedAt !== null && (!receipt.stopped || receipt.state !== current.outcome)) throw new ProviderAgentInstallerError("verification_failed");
    let cleanupRecorded = false;
    if (receipt.stopped) {
      if (!await deps.stopped(op, receipt, result.clock)) throw new ProviderAgentInstallerError("verification_failed");
      fence();
      if (cleanupGrant && receipt.nativeCleanup.state !== "pending") {
        // A competing observer/superseded grant must not be hidden behind a
        // cached stopped outcome. SQL false means keep authority, not success.
        if (!await deps.cleanupRecord(op, cleanupGrant, receipt, result.clock)) throw new ProviderAgentInstallerError("verification_failed");
        fence(); cleanupRecorded = true;
      }
    }
    return { stage: "worker_observed" as const, state: receipt.state, stopped: receipt.stopped,
      nativeCleanup: receipt.nativeCleanup.state, cleanupRecorded,
      cancellationRequested: current.cancellationRequested || cleanupGrant !== null };
  } catch (error) {
    if (attempted) throw new ProviderAgentInstallerError("outcome_unknown");
    if (error instanceof ProviderAgentInstallerError) throw error;
    throw new ProviderAgentInstallerError("verification_failed");
  }
}
