import "server-only";

import { loadFirstBootOperation } from "@/lib/infrastructure/first-boot-operations";
import { loadHetznerCloudCapacityBootstrap } from "@/lib/infrastructure/hetzner-cloud-store";
import { verifyEnrolledProviderReceipt } from "@/lib/infrastructure/enrolled-provider-receipt";
import { inspectProviderNativeRuntime } from "@/lib/infrastructure/first-boot-ssh";
import { parseProviderNativeAccess, parseProviderNativeWorkerIdentity } from "@/lib/infrastructure/provider-native-worker";
import { parseProviderNativeRuntimeReceipt } from "@/lib/infrastructure/provider-native-runtime";
import type { ProviderAgentInstallOperation } from "./provider-agent-install-store";
import { expireUnstartedProviderAgent } from "./provider-agent-install-store";
import { completeProviderNativeRunning, loadProviderNativeInstallOperation } from "./provider-native-install-store";
import { advanceProviderNativeInstaller } from "./provider-native-installer";
import { verifyProviderNativePublicRuntime } from "./provider-native-public-readiness";
import { validateHivraChatOrigin } from "./agent-host-result";
import type { ProviderAgentReadinessStage } from "./provider-readiness-contract";

class ProviderNativeReadinessError extends Error {
  constructor() {
    super("Native provider computer readiness could not be verified; the original operation is retained.");
    this.name = "ProviderNativeReadinessError";
  }
}

export async function loadProviderNativeReadinessContext(input: ProviderAgentInstallOperation) {
  return loadProviderNativeInstallOperation(input);
}

type Dependencies = {
  load: typeof loadProviderNativeReadinessContext;
  installer: typeof advanceProviderNativeInstaller;
  boot: typeof loadFirstBootOperation;
  verify: typeof verifyEnrolledProviderReceipt;
  bootstrap: typeof loadHetznerCloudCapacityBootstrap;
  inspect: typeof inspectProviderNativeRuntime;
  publicReady: typeof verifyProviderNativePublicRuntime;
  complete: typeof completeProviderNativeRunning;
  expireUnstarted: typeof expireUnstartedProviderAgent;
  monotonicNow: () => number;
  now: () => Date;
};

const defaults: Dependencies = {
  load: loadProviderNativeReadinessContext,
  installer: advanceProviderNativeInstaller,
  boot: loadFirstBootOperation,
  verify: verifyEnrolledProviderReceipt,
  bootstrap: loadHetznerCloudCapacityBootstrap,
  inspect: inspectProviderNativeRuntime,
  publicReady: verifyProviderNativePublicRuntime,
  complete: completeProviderNativeRunning,
  expireUnstarted: expireUnstartedProviderAgent,
  monotonicNow: () => performance.now(),
  now: () => new Date(),
};

function sameDurableBinding(
  current: Awaited<ReturnType<typeof loadProviderNativeReadinessContext>>,
  original: Awaited<ReturnType<typeof loadProviderNativeReadinessContext>>,
) {
  return JSON.stringify(current.scope) === JSON.stringify(original.scope)
    && current.targetId === original.targetId
    && current.runtime === original.runtime
    && current.accessMode === original.accessMode
    && current.hostname === original.hostname
    && current.tunnelId === original.tunnelId
    && JSON.stringify(current.identity) === JSON.stringify(original.identity);
}

/** Private native convergence for the exact already-reserved provider VM.
 * It observes the retained installer, hashes the installed gateway/runtime over
 * pinned SSH, mints one opaque browser session locally, verifies the public
 * native and computer surfaces, then performs the shared terminal CAS. It does
 * not reinstall, replace, rotate, release, delete or expose management/model
 * credentials. Historical .31.3 operations remain cancellable but cannot pass
 * this readiness gate because that gateway forwarded Hivra authority.
 */
export async function advanceProviderNativeReadiness(
  raw: ProviderAgentInstallOperation,
  dependencies: Partial<Dependencies> = {},
): Promise<ProviderAgentReadinessStage> {
  const input = structuredClone(raw), deps = { ...defaults, ...dependencies };
  const deadline = deps.monotonicNow() + 30_000;
  const fence = () => {
    if (!Number.isFinite(deadline) || deps.monotonicNow() >= deadline) throw new ProviderNativeReadinessError();
  };
  try {
    fence();
    const initial = await deps.load(input);
    fence();
    if (initial.desiredState === "deleted" || initial.cancellationRequested) return "cancellation_pending";
    const installer = await deps.installer({ ...input, action: "status" });
    fence();
    if (installer.stage === "not_dispatched") {
      return await deps.expireUnstarted(input) ? "failed" : "installer_pending";
    }
    if (installer.stage !== "worker_observed" || !installer.stopped) return "installer_pending";
    const context = await deps.load(input);
    fence();
    if (context.desiredState === "deleted" || context.cancellationRequested || installer.cancellationRequested) return "cancellation_pending";
    if (!sameDurableBinding(context, initial)
      || context.outcome !== installer.state || !context.stoppedAt || !Number.isFinite(Date.parse(context.stoppedAt))) {
      throw new ProviderNativeReadinessError();
    }
    // A failed native install retains its VM and operation for explicit
    // inspection/removal. It is never released through the legacy error path.
    if (installer.state !== "succeeded") return "failed";
    if (!context.hostname || !context.accessMode || (context.accessMode === "cloudflare-named" && !context.tunnelId)) {
      throw new ProviderNativeReadinessError();
    }
    const identity = parseProviderNativeWorkerIdentity(context.identity);
    if (identity.agentId !== input.agentId || identity.operationId !== input.operationId) throw new ProviderNativeReadinessError();
    const access = parseProviderNativeAccess({ mode: context.accessMode, hostname: context.hostname, tunnelId: context.tunnelId });
    const probe = { identity, access };
    const chatUrl = validateHivraChatOrigin(`https://${context.hostname}`, context.hostname);
    if (!chatUrl) throw new ProviderNativeReadinessError();
    const boot = await deps.boot(context.scope);
    fence();
    if (!boot) throw new ProviderNativeReadinessError();
    const verified = await deps.verify({ scope: context.scope, operation: boot, dispatchDeadlineMs: deadline,
      ...(context.accessMode === "direct-https" ? { requireDirectHttps: true } : {}) }, { monotonicNow: deps.monotonicNow });
    fence();
    if (verified.stage === "waiting_for_provider") return "provider_pending";
    if (JSON.stringify(verified.scope) !== JSON.stringify(context.scope)) throw new ProviderNativeReadinessError();
    const binding = context.scope.binding;
    const bootstrap = await deps.bootstrap({ userId: binding.userId, connectionId: binding.connectionId,
      expectedRevision: binding.connectionRevision, orderId: binding.orderId,
      idempotencyKey: verified.capacityIdempotencyKey, quoteFingerprintSha256: binding.quoteFingerprint });
    fence();
    const observed = await deps.inspect({ ...probe, address: verified.address, hostPublicKey: verified.hostPublicKey,
      administratorPublicKey: bootstrap.publicKeyOpenSsh, administratorPrivateKey: bootstrap.privateKeyOpenSsh,
      dispatchDeadlineMs: deadline }, { monotonicNow: deps.monotonicNow });
    fence();
    if (observed.hostVerified !== true || observed.administratorAuthenticated !== true
      || observed.hostFingerprintSha256 !== verified.hostFingerprintSha256) throw new ProviderNativeReadinessError();
    const receipt = parseProviderNativeRuntimeReceipt(
      `HIVRA_PROVIDER_NATIVE_RUNTIME_V1 ${JSON.stringify(observed.receipt)}\n`, probe,
    );
    if (!receipt.ready) return "runtime_pending";
    if (!await deps.publicReady({ access, sessionCookie: receipt.sessionCookie })) return "public_access_pending";
    fence();
    const current = await deps.load(input);
    fence();
    if (current.desiredState === "deleted" || current.cancellationRequested) return "cancellation_pending";
    if (JSON.stringify(current) !== JSON.stringify(context)) throw new ProviderNativeReadinessError();
    if (!await deps.complete({ ...input, chatUrl, ip: verified.address,
      provisionedAt: deps.now().toISOString() })) throw new ProviderNativeReadinessError();
    return "running";
  } catch {
    throw new ProviderNativeReadinessError();
  }
}
