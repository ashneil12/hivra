import "server-only";

import { loadFirstBootOperation } from "@/lib/infrastructure/first-boot-operations";
import { loadHetznerCloudCapacityBootstrap } from "@/lib/infrastructure/hetzner-cloud-store";
import { verifyEnrolledProviderReceipt } from "@/lib/infrastructure/enrolled-provider-receipt";
import { inspectProviderDesktopRuntime } from "@/lib/infrastructure/first-boot-ssh";
import { parseProviderDesktopWorkerIdentity } from "@/lib/infrastructure/provider-desktop-worker";
import { parseProviderDesktopAccess } from "@/lib/infrastructure/provider-desktop-launch-contract";
import { parseProviderDesktopRuntimeReceipt } from "@/lib/infrastructure/provider-desktop-runtime";
import { expireUnstartedProviderAgent, type ProviderAgentInstallOperation } from "./provider-agent-install-store";
import { completeProviderDesktopRunning, loadProviderDesktopInstallOperation } from "./provider-desktop-install-store";
import { advanceProviderDesktopInstaller } from "./provider-desktop-installer";
import { verifyProviderDesktopPublicRuntime } from "./provider-desktop-public-readiness";
import { validateHivraChatOrigin } from "./agent-host-result";
import type { ProviderAgentReadinessStage } from "./provider-readiness-contract";

class ProviderDesktopReadinessError extends Error {
  constructor() {
    super("Provider desktop readiness could not be verified; the original operation is retained.");
    this.name = "ProviderDesktopReadinessError";
  }
}

type Dependencies = {
  load: typeof loadProviderDesktopInstallOperation; installer: typeof advanceProviderDesktopInstaller;
  boot: typeof loadFirstBootOperation; verify: typeof verifyEnrolledProviderReceipt;
  bootstrap: typeof loadHetznerCloudCapacityBootstrap; inspect: typeof inspectProviderDesktopRuntime;
  publicReady: typeof verifyProviderDesktopPublicRuntime; complete: typeof completeProviderDesktopRunning;
  expireUnstarted: typeof expireUnstartedProviderAgent; monotonicNow: () => number; now: () => Date; controlOrigin: () => string;
};
const defaults: Dependencies = {
  load: loadProviderDesktopInstallOperation, installer: advanceProviderDesktopInstaller, boot: loadFirstBootOperation,
  verify: verifyEnrolledProviderReceipt, bootstrap: loadHetznerCloudCapacityBootstrap, inspect: inspectProviderDesktopRuntime,
  publicReady: verifyProviderDesktopPublicRuntime, complete: completeProviderDesktopRunning, expireUnstarted: expireUnstartedProviderAgent,
  monotonicNow: () => performance.now(), now: () => new Date(),
  controlOrigin: () => { const key = "NEXT_PUBLIC_APP_URL"; return process.env[key] ?? ""; },
};
type Context = Awaited<ReturnType<typeof loadProviderDesktopInstallOperation>>;
function sameBinding(current: Context, original: Context) {
  return JSON.stringify(current.operation) === JSON.stringify(original.operation)
    && JSON.stringify(current.scope) === JSON.stringify(original.scope) && current.targetId === original.targetId
    && current.runtime === original.runtime && current.computerProfile === original.computerProfile
    && current.accessMode === original.accessMode && current.hostname === original.hostname && current.tunnelId === original.tunnelId
    && JSON.stringify(current.identity) === JSON.stringify(original.identity);
}

/** Initial provisioning only. Retains the original operation through installer,
 * provider, pinned runtime and public-ingress observations, then uses the
 * desktop-specific SQL CAS. No model/broker credentials or session grants are
 * created/stored here. Normal capability/session issuance follows running state;
 * its authenticated browser acceptance is a separate release requirement. */
export async function advanceProviderDesktopReadiness(raw: ProviderAgentInstallOperation,
  dependencies: Partial<Dependencies> = {}): Promise<ProviderAgentReadinessStage> {
  const input = structuredClone(raw), deps = { ...defaults, ...dependencies }, deadline = deps.monotonicNow() + 30_000;
  const fence = () => { if (!Number.isFinite(deadline) || deps.monotonicNow() >= deadline) throw new ProviderDesktopReadinessError(); };
  try {
    fence(); const initial = await deps.load(input); fence();
    if (initial.desiredState === "deleted" || initial.cancellationRequested) return "cancellation_pending";
    const installer = await deps.installer({ ...input, action: "status" }); fence();
    if (installer.stage === "not_dispatched") return await deps.expireUnstarted(input) ? "failed" : "installer_pending";
    if (installer.stage !== "worker_observed" || !installer.stopped) return "installer_pending";
    const context = await deps.load(input); fence();
    if (context.desiredState === "deleted" || context.cancellationRequested || installer.cancellationRequested) return "cancellation_pending";
    if (!sameBinding(context, initial) || context.runtime !== "linux-desktop" || context.computerProfile !== "ubuntu-desktop"
      || context.operation.userId !== input.userId || context.operation.agentId !== input.agentId || context.operation.operationId !== input.operationId
      || context.scope.binding.userId !== input.userId || context.outcome !== installer.state
      || !context.stoppedAt || !Number.isFinite(Date.parse(context.stoppedAt))) throw new ProviderDesktopReadinessError();
    if (installer.state !== "succeeded") return "failed";
    const identity = parseProviderDesktopWorkerIdentity(context.identity);
    if (identity.agentId !== input.agentId || identity.operationId !== input.operationId) throw new ProviderDesktopReadinessError();
    const access = parseProviderDesktopAccess({ mode: context.accessMode, hostname: context.hostname, tunnelId: context.tunnelId });
    const probe = { identity, access }, chatUrl = validateHivraChatOrigin(`https://${access.hostname}`, access.hostname);
    if (!chatUrl) throw new ProviderDesktopReadinessError();
    const boot = await deps.boot(context.scope); fence();
    if (!boot) throw new ProviderDesktopReadinessError();
    const verified = await deps.verify({ scope: context.scope, operation: boot, dispatchDeadlineMs: deadline,
      ...(access.mode === "direct-https" ? { requireDirectHttps: true } : {}) }, { monotonicNow: deps.monotonicNow }); fence();
    if (verified.stage === "waiting_for_provider") return "provider_pending";
    if (JSON.stringify(verified.scope) !== JSON.stringify(context.scope)) throw new ProviderDesktopReadinessError();
    const binding = context.scope.binding;
    const bootstrap = await deps.bootstrap({ userId: binding.userId, connectionId: binding.connectionId,
      expectedRevision: binding.connectionRevision, orderId: binding.orderId,
      idempotencyKey: verified.capacityIdempotencyKey, quoteFingerprintSha256: binding.quoteFingerprint }); fence();
    const observed = await deps.inspect({ ...probe, address: verified.address, hostPublicKey: verified.hostPublicKey,
      administratorPublicKey: bootstrap.publicKeyOpenSsh, administratorPrivateKey: bootstrap.privateKeyOpenSsh,
      dispatchDeadlineMs: deadline }, { monotonicNow: deps.monotonicNow }); fence();
    if (observed.hostVerified !== true || observed.administratorAuthenticated !== true
      || observed.hostFingerprintSha256 !== verified.hostFingerprintSha256) throw new ProviderDesktopReadinessError();
    parseProviderDesktopRuntimeReceipt(`HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(observed.receipt)}\n`, probe);
    if (!await deps.publicReady({ access, controlOrigin: deps.controlOrigin() })) return "public_access_pending";
    fence(); const current = await deps.load(input); fence();
    if (current.desiredState === "deleted" || current.cancellationRequested) return "cancellation_pending";
    if (JSON.stringify(current) !== JSON.stringify(context)) throw new ProviderDesktopReadinessError();
    if (!await deps.complete({ ...input, chatUrl, ip: verified.address, provisionedAt: deps.now().toISOString() })) throw new ProviderDesktopReadinessError();
    return "running";
  } catch { throw new ProviderDesktopReadinessError(); }
}
