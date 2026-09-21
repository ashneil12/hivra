import "server-only";

import { loadPortableProvisionerBundle } from "@/lib/infrastructure/connection-preparation";
import { loadFirstBootOperation, parseFirstBootOperationScope } from "@/lib/infrastructure/first-boot-operations";
import { verifyEnrolledProviderReceipt } from "@/lib/infrastructure/enrolled-provider-receipt";
import { loadHetznerCloudCapacityBootstrap } from "@/lib/infrastructure/hetzner-cloud-store";
import { controlProviderDesktopInstaller } from "@/lib/infrastructure/first-boot-ssh";
import { buildProviderDesktopWorkerPlan, parseProviderDesktopWorkerIdentity, parseProviderDesktopWorkerReceipt,
  type ProviderDesktopWorkerIdentity, type ProviderDesktopWorkerInput } from "@/lib/infrastructure/provider-desktop-worker";
import { parseProviderDesktopAccess, type ProviderDesktopLaunch } from "@/lib/infrastructure/provider-desktop-launch-contract";
import type { ProviderAgentInstallOperation } from "./provider-agent-install-store";
import { ProviderAgentInstallerError } from "./provider-agent-installer";
import { beginProviderDesktopCleanup, beginProviderDesktopInstall, loadProviderDesktopInstallOperation,
  recordProviderDesktopCleanup, recordProviderDesktopInstallStopped, type ProviderDesktopInstallContext } from "./provider-desktop-install-store";

type Dependencies = {
  load: typeof loadProviderDesktopInstallOperation; begin: typeof beginProviderDesktopInstall;
  stopped: typeof recordProviderDesktopInstallStopped; cleanupBegin: typeof beginProviderDesktopCleanup;
  cleanupRecord: typeof recordProviderDesktopCleanup; bundle: typeof loadPortableProvisionerBundle;
  boot: typeof loadFirstBootOperation; verify: typeof verifyEnrolledProviderReceipt;
  bootstrap: typeof loadHetznerCloudCapacityBootstrap; control: typeof controlProviderDesktopInstaller;
  monotonicNow: () => number; controlOrigin: () => string;
};
const defaults: Dependencies = {
  load: loadProviderDesktopInstallOperation, begin: beginProviderDesktopInstall, stopped: recordProviderDesktopInstallStopped,
  cleanupBegin: beginProviderDesktopCleanup, cleanupRecord: recordProviderDesktopCleanup, bundle: loadPortableProvisionerBundle,
  boot: loadFirstBootOperation, verify: verifyEnrolledProviderReceipt, bootstrap: loadHetznerCloudCapacityBootstrap,
  control: controlProviderDesktopInstaller,
  // Runtime server configuration, not a browser-selected URL or build-time
  // fallback to production. Missing/non-canonical configuration fails closed.
  controlOrigin: () => { const key = "NEXT_PUBLIC_APP_URL"; return process.env[key] ?? ""; },
  monotonicNow: () => performance.now(),
};
type Input = ProviderAgentInstallOperation & ({ action: "start"; launch: ProviderDesktopLaunch } | { action: "status" | "cancel" });
function sameIdentity(actual: unknown, expected: ProviderDesktopWorkerIdentity) {
  try { return JSON.stringify(parseProviderDesktopWorkerIdentity(actual)) === JSON.stringify(expected); }
  catch { return false; }
}
function validateContext(context: ProviderDesktopInstallContext, op: ProviderAgentInstallOperation) {
  if (context.operation.userId !== op.userId || context.operation.agentId !== op.agentId || context.operation.operationId !== op.operationId
    || context.scope.binding.userId !== op.userId || context.runtime !== "linux-desktop" || context.computerProfile !== "ubuntu-desktop"
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
function unchangedBinding(current: ProviderDesktopInstallContext, original: ProviderDesktopInstallContext) {
  return JSON.stringify(parseFirstBootOperationScope(current.scope)) === JSON.stringify(parseFirstBootOperationScope(original.scope))
    && current.targetId === original.targetId && current.runtime === original.runtime && current.computerProfile === original.computerProfile
    && current.accessMode === original.accessMode && current.hostname === original.hostname && current.tunnelId === original.tunnelId;
}

/** Private desktop adapter for an already reserved, owner-bound provider VM.
 * Desktop provisioning is not publicly selectable. The existing delete route
 * must recover an already reserved desktop operation once integrated. Same provider receipt, original admin key and
 * one-use dispatch grant as v1; no ambient fleet/first-boot/replacement powers.
 *
 * Unlike v1, NO cached terminal outcome bypasses fresh desktop observation.
 * Explicit cancellation acquires its grant before the signed SSH clock read.
 * Status does not stop the desktop service and cannot persist cleanup authority. The
 * installer outcome stays immutable; only fresh grant-bound cleanup can later
 * permit SQL to release the original operation. This function never releases.
 */
export async function advanceProviderDesktopInstaller(input: Input, dependencies: Partial<Dependencies> = {}) {
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
    let worker: ProviderDesktopWorkerInput, plan: ReturnType<typeof buildProviderDesktopWorkerPlan>;
    if (context.identity !== null) {
      worker = { ...op, scope: context.scope, identity: context.identity as ProviderDesktopWorkerIdentity,
        action: request.action === "start" ? "status" : request.action };
      try { plan = buildProviderDesktopWorkerPlan(worker, validationClock); }
      catch { throw new ProviderAgentInstallerError("unsupported_bundle"); }
    } else {
      if (request.action !== "start" || context.desiredState === "deleted") return { stage: "not_dispatched" as const };
      if (!context.hostname) throw new ProviderAgentInstallerError("rejected");
      const assets = await deps.bundle();
      fence();
      worker = { ...op, scope: context.scope, assets, action: "start", launch: request.launch,
        authority: { computerId: op.agentId, controlOrigin: deps.controlOrigin(),
          access: parseProviderDesktopAccess({ mode: context.accessMode, hostname: context.hostname, tunnelId: context.tunnelId }) } };
      plan = buildProviderDesktopWorkerPlan(worker, validationClock);
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
      const grant = await deps.begin(op, plan.identity, parseProviderDesktopAccess({
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
    const control: ProviderDesktopWorkerInput = action === "start" && worker.action === "start" ? worker
      : { ...op, scope: context.scope, identity: plan.identity, action: action as "status" | "cancel" };
    attempted = true;
    const result = await deps.control({ ...control, address: verified.address, hostPublicKey: verified.hostPublicKey,
      administratorPublicKey: bootstrap.publicKeyOpenSsh, administratorPrivateKey: bootstrap.privateKeyOpenSsh,
      dispatchDeadlineMs: deadline }, { monotonicNow: deps.monotonicNow });
    fence();
    if (result.hostVerified !== true || result.administratorAuthenticated !== true
      || result.hostFingerprintSha256 !== verified.hostFingerprintSha256) throw new ProviderAgentInstallerError("verification_failed");
    // Re-validate against the clock returned by THIS SSH invocation. Never
    // manufacture a matching clock from desktopCleanup.bootId or stored proof.
    const receipt = parseProviderDesktopWorkerReceipt(`HIVRA_PROVIDER_WORKER_V1 ${JSON.stringify(result.receipt)}\n`, plan.identity, result.clock);
    if (current.stoppedAt !== null && (!receipt.stopped || receipt.state !== current.outcome)) throw new ProviderAgentInstallerError("verification_failed");
    let cleanupRecorded = false;
    if (receipt.stopped) {
      if (!await deps.stopped(op, receipt, result.clock)) throw new ProviderAgentInstallerError("verification_failed");
      fence();
      if (cleanupGrant && receipt.desktopCleanup.state !== "pending") {
        // A competing observer/superseded grant must not be hidden behind a
        // cached stopped outcome. SQL false means keep authority, not success.
        if (!await deps.cleanupRecord(op, cleanupGrant, receipt, result.clock)) throw new ProviderAgentInstallerError("verification_failed");
        fence(); cleanupRecorded = true;
      }
    }
    return { stage: "worker_observed" as const, state: receipt.state, stopped: receipt.stopped,
      desktopCleanup: receipt.desktopCleanup.state, cleanupRecorded,
      cancellationRequested: current.cancellationRequested || cleanupGrant !== null };
  } catch (error) {
    if (attempted) throw new ProviderAgentInstallerError("outcome_unknown");
    if (error instanceof ProviderAgentInstallerError) throw error;
    throw new ProviderAgentInstallerError("verification_failed");
  }
}
