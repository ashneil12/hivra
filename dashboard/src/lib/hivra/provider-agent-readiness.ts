import "server-only";

import { loadFirstBootOperation } from "@/lib/infrastructure/first-boot-operations";
import { loadHetznerCloudCapacityBootstrap } from "@/lib/infrastructure/hetzner-cloud-store";
import { verifyEnrolledProviderReceipt } from "@/lib/infrastructure/enrolled-provider-receipt";
import { inspectProviderGuestRuntime } from "@/lib/infrastructure/first-boot-ssh";
import { buildProviderGuestRuntimeProbe, parseProviderGuestRuntimeReceipt } from "@/lib/infrastructure/provider-guest-runtime";
import type { ProviderGuestWorkerIdentity } from "@/lib/infrastructure/provider-guest-worker";
import { loadProviderAgentInstallOperation, expireUnstartedProviderAgent, type ProviderAgentInstallOperation } from "./provider-agent-install-store";
import { advanceProviderAgentInstaller } from "./provider-agent-installer";
import { completeHivraAgentRunning, releaseHivraAgentOperation } from "./agent-operation-store";
import { verifyProviderPublicRuntime } from "./provider-public-readiness";
import { validateHivraChatOrigin } from "./agent-host-result";
import type { ProviderAgentReadinessStage } from "./provider-readiness-contract";

class ProviderAgentReadinessError extends Error {
  constructor() { super("Provider computer readiness could not be verified; the original operation is retained."); this.name = "ProviderAgentReadinessError"; }
}

export async function loadProviderAgentReadinessContext(input: ProviderAgentInstallOperation) {
  return loadProviderAgentInstallOperation(input);
}

type Dependencies = {
  load: typeof loadProviderAgentReadinessContext; installer: typeof advanceProviderAgentInstaller;
  boot: typeof loadFirstBootOperation; verify: typeof verifyEnrolledProviderReceipt;
  bootstrap: typeof loadHetznerCloudCapacityBootstrap; inspect: typeof inspectProviderGuestRuntime;
  publicReady: typeof verifyProviderPublicRuntime; complete: typeof completeHivraAgentRunning;
  release: typeof releaseHivraAgentOperation; monotonicNow: () => number; now: () => Date;
  expireUnstarted: typeof expireUnstartedProviderAgent;
};
const defaults: Dependencies = { load: loadProviderAgentReadinessContext, installer: advanceProviderAgentInstaller,
  boot: loadFirstBootOperation, verify: verifyEnrolledProviderReceipt, bootstrap: loadHetznerCloudCapacityBootstrap,
  inspect: inspectProviderGuestRuntime, publicReady: verifyProviderPublicRuntime,
  complete: completeHivraAgentRunning, release: releaseHivraAgentOperation,
  expireUnstarted: expireUnstartedProviderAgent,
  monotonicNow: () => performance.now(), now: () => new Date() };

/** Advance only the existing provision operation. Reads the original worker,
 * independently checks current services/auth/native endpoints and the public
 * named tunnel, then uses the shared SQL convergence CAS. No first-boot lease,
 * replacement, reinstall, tunnel/key creation or target admission occurs here.
 */
export async function advanceProviderAgentReadiness(raw: ProviderAgentInstallOperation, dependencies: Partial<Dependencies> = {}): Promise<ProviderAgentReadinessStage> {
  const input = structuredClone(raw), deps = { ...defaults, ...dependencies };
  const deadline = deps.monotonicNow() + 30_000;
  const fence = () => { if (!Number.isFinite(deadline) || deps.monotonicNow() >= deadline) throw new ProviderAgentReadinessError(); };
  try {
    fence();
    const initial = await deps.load(input);
    fence();
    if (initial.desiredState === "deleted") return "cancellation_pending";
    const installer = await deps.installer({ ...input, action: "status" });
    fence();
    if (installer.stage === "not_dispatched") {
      return await deps.expireUnstarted(input) ? "failed" : "installer_pending";
    }
    if (installer.stage !== "worker_observed" || !installer.stopped) return "installer_pending";
    const context = await deps.load(input);
    fence();
    if (context.desiredState === "deleted") return "cancellation_pending";
    if (JSON.stringify(context.scope) !== JSON.stringify(initial.scope) || context.targetId !== initial.targetId
      || context.runtime !== initial.runtime || context.tunnelId !== initial.tunnelId || context.hostname !== initial.hostname
      || context.accessMode !== initial.accessMode
      || JSON.stringify(context.identity) !== JSON.stringify(initial.identity)
      || context.outcome !== installer.state || !context.stoppedAt || !Number.isFinite(Date.parse(context.stoppedAt))) throw new ProviderAgentReadinessError();
    if (installer.state === "succeeded" && !context.accessMode) throw new ProviderAgentReadinessError();
    const probe = { scope: context.scope, identity: context.identity as ProviderGuestWorkerIdentity,
      runtime: context.runtime, accessMode: context.accessMode ?? undefined };
    const plan = buildProviderGuestRuntimeProbe(probe);
    if (plan.identity.agentId !== input.agentId || plan.identity.operationId !== input.operationId) throw new ProviderAgentReadinessError();
    if (installer.state !== "succeeded") {
      fence();
      if (!await deps.release({ ...input, markError: true, error: "The original agent installer stopped without success. This cloud computer is retained; inspect it or explicitly remove it. Provider billing may continue." })) throw new ProviderAgentReadinessError();
      return "failed";
    }
    if (!context.hostname || (context.accessMode === "cloudflare-named" && !context.tunnelId)) throw new ProviderAgentReadinessError();
    const chatUrl = validateHivraChatOrigin(`https://${context.hostname}`, context.hostname);
    if (!chatUrl) throw new ProviderAgentReadinessError();
    const boot = await deps.boot(context.scope);
    fence();
    if (!boot) throw new ProviderAgentReadinessError();
    const verified = await deps.verify({ scope: context.scope, operation: boot, dispatchDeadlineMs: deadline,
      ...(context.accessMode === "direct-https" ? { requireDirectHttps: true } : {}) }, { monotonicNow: deps.monotonicNow });
    fence();
    if (verified.stage === "waiting_for_provider") return "provider_pending";
    if (JSON.stringify(verified.scope) !== JSON.stringify(context.scope)) throw new ProviderAgentReadinessError();
    const b = context.scope.binding;
    const bootstrap = await deps.bootstrap({ userId: b.userId, connectionId: b.connectionId, expectedRevision: b.connectionRevision,
      orderId: b.orderId, idempotencyKey: verified.capacityIdempotencyKey, quoteFingerprintSha256: b.quoteFingerprint });
    fence();
    const observed = await deps.inspect({ ...probe, address: verified.address, hostPublicKey: verified.hostPublicKey,
      administratorPublicKey: bootstrap.publicKeyOpenSsh, administratorPrivateKey: bootstrap.privateKeyOpenSsh, dispatchDeadlineMs: deadline },
    { monotonicNow: deps.monotonicNow });
    fence();
    if (observed.hostVerified !== true || observed.administratorAuthenticated !== true
      || observed.hostFingerprintSha256 !== verified.hostFingerprintSha256) throw new ProviderAgentReadinessError();
    const receipt = parseProviderGuestRuntimeReceipt(`HIVRA_PROVIDER_RUNTIME_V1 ${JSON.stringify(observed.receipt)}\n`, probe);
    if (!receipt.ready) return "runtime_pending";
    if (!await deps.publicReady({ hostname: context.hostname, runtime: context.runtime, apiToken: receipt.apiToken })) return "public_access_pending";
    fence();
    // A newer deletion, changed binding or another convergence winner cannot
    // be overwritten by an earlier guest/public observation.
    const current = await deps.load(input);
    fence();
    if (current.desiredState === "deleted") return "cancellation_pending";
    if (JSON.stringify(current) !== JSON.stringify(context)) throw new ProviderAgentReadinessError();
    if (!await deps.complete({ ...input, operationKind: "provision", chatUrl, ip: verified.address,
      apiToken: receipt.apiToken, provisionedAt: deps.now().toISOString() })) throw new ProviderAgentReadinessError();
    return "running";
  } catch { throw new ProviderAgentReadinessError(); }
}
