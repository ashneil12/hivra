import "server-only";

import {
  describeHivraAgentExecutionContextError,
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
} from "./agent-execution-context";
import {
  BuzzRuntimeInstallInputSchema,
  BuzzRuntimeIdentitySchema,
  BuzzRuntimeRemoveInputSchema,
  buildBuzzRuntimeHostScript,
  buildBuzzRuntimeInstallGuestScript,
  buildBuzzRuntimeObserveGuestScript,
  buildBuzzRuntimeRemoveGuestScript,
  parseBuzzRuntimeReceipt,
  type BuzzRuntimeInstallInput,
  type BuzzRuntimeIdentity,
  type BuzzRuntimeRemoveInput,
  type BuzzRuntimeReceipt,
} from "./buzz-runtime";
import type { BuzzRuntimeAgentRow } from "./buzz-store";
import { log } from "@/lib/logger";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";

export type BuzzRuntimeControlProblem = "target_unavailable" | "target_unsupported" | "outcome_unknown" | "receipt_invalid";

export class BuzzRuntimeControlError extends Error {
  constructor(readonly code: BuzzRuntimeControlProblem) {
    super("Buzz runtime control failed.");
    this.name = "BuzzRuntimeControlError";
  }
}

type Dependencies = {
  resolveContext: typeof resolveHivraAgentExecutionContext;
  runHostScript: typeof runProxmoxHostScript;
};

const defaults: Dependencies = {
  resolveContext: resolveHivraAgentExecutionContext,
  runHostScript: runProxmoxHostScript,
};

const LOG_SOURCE = "hivra/buzz-runtime";

function hostFailureType(error: string | undefined): string {
  if (!error) return "buzz_runtime_host_failed";
  if (/timed out/i.test(error)) return "buzz_runtime_host_timeout";
  if (/output exceeded/i.test(error)) return "buzz_runtime_host_output_limit";
  if (/not configured|missing target-specific|host fingerprint/i.test(error)) {
    return "buzz_runtime_host_authority_unavailable";
  }
  if (/exited with code/i.test(error)) return "buzz_runtime_host_exit";
  return "buzz_runtime_host_failed";
}

const SAFE_GUEST_FAILURE = /(?:^|\n)HIVRA_BUZZ_RUNTIME_FAILURE stage=([a-z_]+) code=([1-9][0-9]{0,2})(?:\n|$)/;

function hostFailureContext(
  error: string | undefined,
  stderr: string | undefined,
): { hostExitCode?: number; guestStage?: string; guestExitCode?: number } {
  const hostCodeMatch = error?.match(/Remote bash exited with code ([1-9][0-9]{0,2})/);
  const hostExitCode = hostCodeMatch ? Number(hostCodeMatch[1]) : undefined;
  const match = stderr?.match(SAFE_GUEST_FAILURE);
  if (!match) return hostExitCode && hostExitCode <= 255 ? { hostExitCode } : {};
  const guestExitCode = Number(match[2]);
  if (!Number.isInteger(guestExitCode) || guestExitCode > 255) {
    return hostExitCode && hostExitCode <= 255 ? { hostExitCode } : {};
  }
  return {
    ...(hostExitCode && hostExitCode <= 255 ? { hostExitCode } : {}),
    guestStage: match[1],
    guestExitCode,
  };
}

function sameReceiptIdentity(receipt: BuzzRuntimeReceipt, identity: BuzzRuntimeIdentity) {
  return receipt.bindingId === identity.bindingId && receipt.agentId === identity.agentId
    && receipt.publicKey === identity.publicKey;
}

function sameOperationReceipt(
  receipt: BuzzRuntimeReceipt,
  input: { operationId: string; requestDigest: string; leaseId: string },
) {
  return (receipt.action === "installed" || receipt.action === "removed")
    && receipt.operationId === input.operationId
    && receipt.requestDigest === input.requestDigest
    && receipt.leaseId === input.leaseId;
}

async function contextFor(userId: string, agent: BuzzRuntimeAgentRow, deps: Dependencies): Promise<HivraAgentExecutionContext> {
  if (agent.status !== "running" || agent.desired_state !== "running" || !agent.ip
    || !Number.isSafeInteger(agent.vmid) || Number(agent.vmid) < 100
    || agent.operation_id !== null || agent.operation_kind !== null
    || agent.infrastructure_binding_token_enforced !== true
    || (agent.computer_substrate !== null && agent.computer_substrate !== "proxmox-kvm")) {
    throw new BuzzRuntimeControlError("target_unsupported");
  }
  try {
    const context = await deps.resolveContext(userId, agent);
    if (!context.infrastructureBindingTagEnforced || !context.paths.vmSshKeyPath) {
      throw new BuzzRuntimeControlError("target_unsupported");
    }
    return context;
  } catch (error) {
    const safe = describeHivraAgentExecutionContextError(error);
    throw new BuzzRuntimeControlError(safe?.status === 503 ? "target_unavailable" : "target_unsupported");
  }
}

async function execute(
  userId: string,
  agent: BuzzRuntimeAgentRow,
  identity: BuzzRuntimeIdentity,
  guestScript: string,
  expectedAction: BuzzRuntimeReceipt["action"],
  dependencies: Partial<Dependencies>,
): Promise<BuzzRuntimeReceipt> {
  const deps = { ...defaults, ...dependencies };
  const context = await contextFor(userId, agent, deps);
  let result: Awaited<ReturnType<typeof runProxmoxHostScript>>;
  try {
    result = await deps.runHostScript(
      buildBuzzRuntimeHostScript({
        agentIp: identity.agentIp,
        vmid: Number(agent.vmid),
        vmSshKeyPath: context.paths.vmSshKeyPath!,
        infrastructureBindingTag: context.infrastructureBindingTag,
      }, guestScript),
      context.env,
      { timeoutMs: expectedAction === "installed" ? 180_000 : 60_000 },
    );
  } catch (error) {
    log.warn("Buzz runtime host dispatch threw before a receipt was returned", {
      source: LOG_SOURCE,
      failureType: "buzz_runtime_host_dispatch_throw",
      instanceId: agent.id,
      bindingId: identity.bindingId,
      host: context.host,
      vmid: agent.vmid,
      action: expectedAction,
      reportOpsEvent: false,
    }, error);
    throw new BuzzRuntimeControlError("outcome_unknown");
  }
  if (!result.ok) {
    log.warn("Buzz runtime host dispatch returned no usable receipt", {
      source: LOG_SOURCE,
      failureType: hostFailureType(result.error),
      instanceId: agent.id,
      bindingId: identity.bindingId,
      host: context.host,
      vmid: agent.vmid,
      action: expectedAction,
      ...hostFailureContext(result.error, result.stderr),
      reportOpsEvent: false,
    });
    throw new BuzzRuntimeControlError("outcome_unknown");
  }
  let receipt: BuzzRuntimeReceipt;
  try { receipt = parseBuzzRuntimeReceipt(result.stdout || ""); }
  catch { throw new BuzzRuntimeControlError("receipt_invalid"); }
  if (receipt.action !== expectedAction || !sameReceiptIdentity(receipt, identity)) {
    throw new BuzzRuntimeControlError("receipt_invalid");
  }
  return receipt;
}

export async function installBuzzRuntime(
  userId: string,
  agent: BuzzRuntimeAgentRow,
  raw: BuzzRuntimeInstallInput,
  dependencies: Partial<Dependencies> = {},
): Promise<Extract<BuzzRuntimeReceipt, { action: "installed" }>> {
  const input = BuzzRuntimeInstallInputSchema.parse(raw);
  if (input.agentId !== agent.id || input.agentIp !== agent.ip) throw new BuzzRuntimeControlError("target_unsupported");
  const receipt = await execute(userId, agent, input, buildBuzzRuntimeInstallGuestScript(input), "installed", dependencies);
  if (!sameOperationReceipt(receipt, input)) throw new BuzzRuntimeControlError("receipt_invalid");
  return receipt as Extract<BuzzRuntimeReceipt, { action: "installed" }>;
}

export async function observeBuzzRuntime(
  userId: string,
  agent: BuzzRuntimeAgentRow,
  raw: BuzzRuntimeIdentity,
  dependencies: Partial<Dependencies> = {},
): Promise<Extract<BuzzRuntimeReceipt, { action: "observed" }>> {
  const identity = BuzzRuntimeIdentitySchema.parse(raw);
  if (identity.agentId !== agent.id || identity.agentIp !== agent.ip) throw new BuzzRuntimeControlError("target_unsupported");
  const receipt = await execute(userId, agent, identity, buildBuzzRuntimeObserveGuestScript(identity), "observed", dependencies);
  return receipt as Extract<BuzzRuntimeReceipt, { action: "observed" }>;
}

export async function removeBuzzRuntime(
  userId: string,
  agent: BuzzRuntimeAgentRow,
  raw: BuzzRuntimeRemoveInput,
  dependencies: Partial<Dependencies> = {},
): Promise<Extract<BuzzRuntimeReceipt, { action: "removed" }>> {
  const identity = BuzzRuntimeRemoveInputSchema.parse(raw);
  if (identity.agentId !== agent.id || identity.agentIp !== agent.ip) throw new BuzzRuntimeControlError("target_unsupported");
  const receipt = await execute(userId, agent, identity, buildBuzzRuntimeRemoveGuestScript(identity), "removed", dependencies);
  if (!sameOperationReceipt(receipt, identity)) throw new BuzzRuntimeControlError("receipt_invalid");
  return receipt as Extract<BuzzRuntimeReceipt, { action: "removed" }>;
}
