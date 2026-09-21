import "server-only";

import { z } from "zod";
import { createHetznerCloudPowerClient } from "@/lib/hetzner/client";
import { parseHetznerPowerAction } from "@/lib/hetzner/power-action";
import { loadFirstBootOperation } from "@/lib/infrastructure/first-boot-operations";
import { loadHetznerCloudCapacityBootstrap, loadHetznerCloudConnectionSecret } from "@/lib/infrastructure/hetzner-cloud-store";
import { verifyEnrolledProviderPowerReceipt, type VerifiedEnrolledProviderPowerReceipt } from "@/lib/infrastructure/enrolled-provider-receipt";
import { inspectProviderGuestRuntime, inspectProviderDesktopPower, inspectProviderGuestClock } from "@/lib/infrastructure/first-boot-ssh";
import { buildProviderDesktopPowerProbe, parseProviderDesktopPowerReceipt } from "@/lib/infrastructure/provider-desktop-runtime";
import { verifyProviderDesktopPublicRuntime } from "./provider-desktop-public-readiness";
import { buildProviderGuestRuntimeProbe, parseProviderGuestRuntimeReceipt } from "@/lib/infrastructure/provider-guest-runtime";
import { beginProviderAgentPowerDispatch, cancelProviderAgentPowerBeforeDispatch, loadProviderAgentPowerOperation,
  recordProviderAgentPowerAction, verifyProviderAgentPowerResult, completeProviderDesktopPower,
  type ProviderAgentPowerContext, type ProviderAgentPowerOperation } from "./provider-agent-power-store";
import { completeHivraAgentOperation, completeHivraAgentRunning, releaseHivraAgentOperation } from "./agent-operation-store";
import { validateHivraChatOrigin } from "./agent-host-result";
import { verifyProviderPublicRuntime } from "./provider-public-readiness";
import type { ProviderAgentPowerStage } from "./provider-power-contract";

const Input = z.object({ userId: z.string().min(1).max(256), agentId: z.string().uuid(), operationId: z.string().uuid() }).strict();
const Mode = z.enum(["dispatch", "observe"]);
class ProviderAgentPowerError extends Error {
  constructor() { super("Provider power could not be verified; the original computer and operation are retained."); this.name = "ProviderAgentPowerError"; }
}

type Dependencies = {
  load: typeof loadProviderAgentPowerOperation; begin: typeof beginProviderAgentPowerDispatch;
  cancel: typeof cancelProviderAgentPowerBeforeDispatch; record: typeof recordProviderAgentPowerAction;
  verifyResult: typeof verifyProviderAgentPowerResult; boot: typeof loadFirstBootOperation;
  verify: typeof verifyEnrolledProviderPowerReceipt; secret: typeof loadHetznerCloudConnectionSecret;
  client: typeof createHetznerCloudPowerClient; bootstrap: typeof loadHetznerCloudCapacityBootstrap;
  inspect: typeof inspectProviderGuestRuntime; publicReady: typeof verifyProviderPublicRuntime;
  desktopInspect: typeof inspectProviderDesktopPower; clockInspect: typeof inspectProviderGuestClock;
  desktopPublicReady: typeof verifyProviderDesktopPublicRuntime; desktopComplete: typeof completeProviderDesktopPower;
  controlOrigin: () => string;
  completeStopped: typeof completeHivraAgentOperation; completeRunning: typeof completeHivraAgentRunning;
  release: typeof releaseHivraAgentOperation; now: () => Date; monotonicNow: () => number;
};
const defaults: Dependencies = { load: loadProviderAgentPowerOperation, begin: beginProviderAgentPowerDispatch,
  cancel: cancelProviderAgentPowerBeforeDispatch, record: recordProviderAgentPowerAction, verifyResult: verifyProviderAgentPowerResult,
  boot: loadFirstBootOperation, verify: verifyEnrolledProviderPowerReceipt, secret: loadHetznerCloudConnectionSecret,
  client: createHetznerCloudPowerClient, bootstrap: loadHetznerCloudCapacityBootstrap, inspect: inspectProviderGuestRuntime,
  publicReady: verifyProviderPublicRuntime, completeStopped: completeHivraAgentOperation, completeRunning: completeHivraAgentRunning,
  desktopInspect: inspectProviderDesktopPower, clockInspect: inspectProviderGuestClock,
  desktopPublicReady: verifyProviderDesktopPublicRuntime, desktopComplete: completeProviderDesktopPower,
  controlOrigin: () => { const key = "NEXT_PUBLIC_APP_URL"; return process.env[key] ?? ""; },
  release: releaseHivraAgentOperation, now: () => new Date(), monotonicNow: () => performance.now() };

function originalIdentity(context: ProviderAgentPowerContext) {
  const { operation, kind, scope, targetId, runtime, identity, accessMode, hostname, tunnelId, originalStatus, createdAt, dispatchNotAfter } = context;
  return JSON.stringify({ operation, kind, scope, targetId, runtime, identity, accessMode, hostname, tunnelId, originalStatus, createdAt, dispatchNotAfter,
    ...(context.runtime === "linux-desktop" ? { desktopAccess: context.desktopAccess } : {}) });
}

/** Advances only an already claimed, original power operation. Only the
 * explicit action POST uses dispatch mode. Polling and deletion observe it;
 * neither can send the first request, retry an uncertain POST or force power.
 * A provider acknowledgement alone never publishes stopped/running/restarted.
 */
export async function advanceProviderAgentPower(raw: ProviderAgentPowerOperation, rawMode: "dispatch" | "observe" = "observe",
  dependencies: Partial<Dependencies> = {}): Promise<ProviderAgentPowerStage> {
  const deps = { ...defaults, ...dependencies }, deadline = deps.monotonicNow() + 30_000;
  const fence = () => { if (!Number.isFinite(deadline) || deps.monotonicNow() >= deadline) throw new ProviderAgentPowerError(); };
  try {
    const input = Input.parse(structuredClone(raw)), mode = Mode.parse(rawMode);
    fence();
    const initial = await deps.load(input);
    fence();
    if (JSON.stringify(initial.operation) !== JSON.stringify(input)) throw new ProviderAgentPowerError();
    const reload = async () => {
      const current = await deps.load(input);
      fence();
      if (originalIdentity(current) !== originalIdentity(initial)) throw new ProviderAgentPowerError();
      return current;
    };
    const expected = { serverId: Number(initial.scope.providerServerId), kind: initial.kind };
    const cancel = async () => {
      fence();
      if (!await deps.cancel(input)) throw new ProviderAgentPowerError();
      return "cancelled" as const;
    };
    const client = async () => {
      const b = initial.scope.binding;
      const connection = await deps.secret(input.userId, b.connectionId, { requireBoundToken: true });
      fence();
      if (connection.connection.id !== b.connectionId || connection.connection.status !== "ready"
        || connection.revision !== b.connectionRevision) throw new ProviderAgentPowerError();
      return deps.client(connection.apiToken);
    };
    const verify = async () => {
      const boot = await deps.boot(initial.scope);
      fence();
      if (!boot) throw new ProviderAgentPowerError();
      const receipt = await deps.verify({ scope: initial.scope, operation: boot, dispatchDeadlineMs: deadline,
        ...(initial.accessMode === "direct-https" ? { requireDirectHttps: true } : {}) }, { monotonicNow: deps.monotonicNow });
      fence();
      if (receipt.stage === "provider_verified" && JSON.stringify(receipt.scope) !== JSON.stringify(initial.scope)) throw new ProviderAgentPowerError();
      return receipt;
    };
    const inspect = async (verified: VerifiedEnrolledProviderPowerReceipt) => {
      const b = initial.scope.binding;
      if (initial.runtime === "linux-desktop") {
        const probe = { identity: initial.identity, access: initial.desktopAccess };
        buildProviderDesktopPowerProbe(probe);
        const bootstrap = await deps.bootstrap({ userId: b.userId, connectionId: b.connectionId, expectedRevision: b.connectionRevision,
          orderId: b.orderId, idempotencyKey: verified.capacityIdempotencyKey, quoteFingerprintSha256: b.quoteFingerprint });
        fence();
        const transport = { address: verified.address, hostPublicKey: verified.hostPublicKey,
          administratorPublicKey: bootstrap.publicKeyOpenSsh, administratorPrivateKey: bootstrap.privateKeyOpenSsh, dispatchDeadlineMs: deadline };
        if (!initial.dispatchIntentAt) {
          const observed = await deps.clockInspect(transport, { monotonicNow: deps.monotonicNow }); fence();
          if (observed.hostVerified !== true || observed.administratorAuthenticated !== true
            || observed.hostFingerprintSha256 !== verified.hostFingerprintSha256) throw new ProviderAgentPowerError();
          return { bootId: z.string().uuid().parse(observed.clock.bootId), ready: false as const, apiToken: null };
        }
        const observed = await deps.desktopInspect({ ...transport, ...probe }, { monotonicNow: deps.monotonicNow }); fence();
        if (observed.hostVerified !== true || observed.administratorAuthenticated !== true
          || observed.hostFingerprintSha256 !== verified.hostFingerprintSha256) throw new ProviderAgentPowerError();
        const receipt = parseProviderDesktopPowerReceipt(`HIVRA_PROVIDER_DESKTOP_POWER_V1 ${JSON.stringify({ bootId: observed.receipt.bootId,
          capabilityOutput: `HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(observed.receipt.capability)}\n` })}\n`, probe);
        return { bootId: receipt.bootId, ready: true as const, apiToken: null };
      }
      const probe = { scope: initial.scope, identity: initial.identity, runtime: initial.runtime,
        accessMode: initial.accessMode, captureBootId: true as const };
      buildProviderGuestRuntimeProbe(probe);
      const bootstrap = await deps.bootstrap({ userId: b.userId, connectionId: b.connectionId, expectedRevision: b.connectionRevision,
        orderId: b.orderId, idempotencyKey: verified.capacityIdempotencyKey, quoteFingerprintSha256: b.quoteFingerprint });
      fence();
      const observed = await deps.inspect({ ...probe, address: verified.address, hostPublicKey: verified.hostPublicKey,
        administratorPublicKey: bootstrap.publicKeyOpenSsh, administratorPrivateKey: bootstrap.privateKeyOpenSsh, dispatchDeadlineMs: deadline },
      { monotonicNow: deps.monotonicNow });
      fence();
      if (observed.hostVerified !== true || observed.administratorAuthenticated !== true
        || observed.hostFingerprintSha256 !== verified.hostFingerprintSha256) throw new ProviderAgentPowerError();
      return parseProviderGuestRuntimeReceipt(`HIVRA_PROVIDER_RUNTIME_V1 ${JSON.stringify(observed.receipt)}\n`, probe);
    };

    if (!initial.dispatchIntentAt) {
      if (initial.desiredState === "deleted" || deps.now().getTime() >= Date.parse(initial.dispatchNotAfter)) return await cancel();
      if (mode === "observe") return "dispatch_pending";
      const verified = await verify();
      if (verified.stage !== "provider_verified") return "provider_pending";
      if (verified.powerState !== (initial.kind === "start" ? "off" : "running")) return await cancel();
      let beforeBootId: string | null = null;
      if (initial.kind === "restart") {
        const receipt = await inspect(verified);
        if (!receipt.bootId) return "runtime_pending";
        beforeBootId = receipt.bootId;
      }
      const provider = await client();
      const current = await reload();
      if (current.dispatchIntentAt) return current.action ? "action_pending" : "request_uncertain";
      if (current.desiredState === "deleted") return await cancel();
      // The monotonic deadline began before every preceding read and this RPC.
      // A late/lost grant cannot acquire a new lifetime on the next request.
      const grant = await deps.begin(input, beforeBootId);
      fence();
      if (grant === "rejected") return await cancel();
      if (grant === "observe") return (await reload()).action ? "action_pending" : "request_uncertain";
      let action;
      try { action = parseHetznerPowerAction(await provider.dispatch(expected), expected); }
      catch { return "request_uncertain"; }
      // Persist a known POST receipt even if I/O finished after our deadline.
      // Discarding it would turn a known request into an unrecoverable unknown.
      if (!await deps.record(input, expected, action)) throw new ProviderAgentPowerError();
      return "action_pending";
    }

    if (!initial.action) return "request_uncertain";
    let action = parseHetznerPowerAction(initial.action, expected);
    if (action.status === "running") {
      const provider = await client();
      fence();
      action = parseHetznerPowerAction(await provider.getAction({ ...expected, actionId: action.id }), { ...expected, actionId: action.id });
      if (!await deps.record(input, { ...expected, actionId: initial.action.id }, action)) throw new ProviderAgentPowerError();
      fence();
    }
    const current = await reload();
    if (current.action?.id !== action.id || current.action.status !== action.status) throw new ProviderAgentPowerError();
    if (action.status === "running") return current.desiredState === "deleted" ? "cancellation_pending" : "action_pending";
    if (current.desiredState === "deleted") {
      if (!await deps.release(input)) throw new ProviderAgentPowerError();
      return "cancellation_pending";
    }
    if (action.status === "error") {
      if (!await deps.release({ ...input, markError: true,
        error: "Hetzner reported a failed power action. The original computer is retained for inspection; provider billing may continue." })) throw new ProviderAgentPowerError();
      return "failed";
    }
    const verified = await verify();
    if (verified.stage !== "provider_verified" || verified.powerState !== (initial.kind === "stop" ? "off" : "running")) return "provider_pending";
    let bootId: string | null = null, apiToken: string | null = null;
    const chatUrl = validateHivraChatOrigin(`https://${initial.hostname}`, initial.hostname);
    if (!chatUrl) throw new ProviderAgentPowerError();
    if (initial.kind !== "stop") {
      const receipt = await inspect(verified);
      if (!receipt.bootId) return "runtime_pending";
      if (initial.kind === "restart" && receipt.bootId === current.beforeBootId) return "reboot_pending";
      if (!receipt.ready) return "runtime_pending";
      const accessible = initial.runtime === "linux-desktop"
        ? await deps.desktopPublicReady({ access: initial.desktopAccess, controlOrigin: deps.controlOrigin() })
        : await deps.publicReady({ hostname: initial.hostname, runtime: initial.runtime, apiToken: receipt.apiToken! });
      if (!accessible) return "public_access_pending";
      fence();
      bootId = receipt.bootId; apiToken = receipt.apiToken;
    }
    const latest = await reload();
    if (latest.desiredState === "deleted") return "cancellation_pending";
    if (latest.action?.id !== action.id || latest.action.status !== "success"
      || latest.beforeBootId !== current.beforeBootId) throw new ProviderAgentPowerError();
    if (!await deps.verifyResult(input, { observedAt: verified.observedAt, status: verified.powerState, bootId,
      runtimeReady: initial.kind !== "stop", publicReady: initial.kind !== "stop" })) throw new ProviderAgentPowerError();
    fence();
    const completed = initial.kind === "stop"
      ? await deps.completeStopped({ ...input, expectedDesiredState: "stopped", status: "stopped" })
      : initial.runtime === "linux-desktop"
        ? await deps.desktopComplete({ ...input, operationKind: initial.kind, chatUrl, ip: verified.address })
        : await deps.completeRunning({ ...input, operationKind: initial.kind, chatUrl, ip: verified.address,
        apiToken, provisionedAt: deps.now().toISOString() });
    if (!completed) throw new ProviderAgentPowerError();
    return initial.kind === "stop" ? "stopped" : "running";
  } catch { throw new ProviderAgentPowerError(); }
}
