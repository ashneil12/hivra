import "server-only";

import { getPlan } from "@/lib/subscription";
import { loadLadderEntitlement } from "@/lib/billing/plan-ladder-entitlement";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import {
  HOSTED_COMPUTE_REQUIRES_PLAN_CODE,
  HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE,
  paysForHostedCompute,
} from "@/lib/billing/hosted-compute";
import {
  getInfrastructureConnectionAuthority,
  getInfrastructureDeploymentTarget,
} from "@/lib/infrastructure/connection-store";
import { isGvisorDeploymentTarget } from "@/lib/infrastructure/contracts";
import { HIVRA_GVISOR_ADAPTER_VERSION, isGvisorPreflightFresh } from "@/lib/hivra/gvisor-computer-contract";
import {
  managedGvisorAuthorityConfig,
  managedGvisorGeneralLaunchEnabled,
  managedGvisorLaunchAdmittedForUser,
  managedGvisorQaEnrollmentEnabled,
  type ManagedGvisorAuthorityConfig,
} from "@/lib/hivra/managed-gvisor-launch-config";

export type ManagedGvisorLaunchGateCode =
  | "managed_gvisor_disabled"
  | typeof HOSTED_COMPUTE_REQUIRES_PLAN_CODE
  | "managed_gvisor_billing_unavailable"
  | "managed_gvisor_not_configured"
  | "managed_gvisor_owner_fence"
  | "managed_gvisor_authority_unavailable"
  | "managed_gvisor_target_mismatch";

export type ManagedGvisorLaunchGateFailure = {
  ok: false;
  code: ManagedGvisorLaunchGateCode;
  status: number;
  message: string;
};

export type ManagedGvisorAuthority = ManagedGvisorAuthorityConfig & {
  agentLimit: number;
  cpuBudget: number;
  ramBudgetMb: number;
  maxCpu: number;
  maxRamMb: number;
  adapterSha: string;
  runtimeSha: string;
};

function failure(
  code: ManagedGvisorLaunchGateCode,
  status: number,
  message: string,
): ManagedGvisorLaunchGateFailure {
  return { ok: false, code, status, message };
}

export async function checkManagedGvisorLaunchAuthority(userId: string, env: NodeJS.ProcessEnv = process.env): Promise<ManagedGvisorLaunchGateFailure | { ok: true; authority: ManagedGvisorAuthority }> {
  const admitted = managedGvisorLaunchAdmittedForUser(userId, env);
  if (managedGvisorQaEnrollmentEnabled(env)) {
    if (!admitted) {
      return failure("managed_gvisor_disabled", 404, "Managed Linux terminal sandboxes are not available.");
    }
  } else if (!managedGvisorGeneralLaunchEnabled(env)) {
    return failure("managed_gvisor_disabled", 404, "Managed Linux terminal sandboxes are not available.");
  }
  let subscription;
  try {
    subscription = await resolveEffectiveSubscription(userId, { throwOnQueryError: true });
  } catch {
    return failure("managed_gvisor_billing_unavailable", 503, "The hosted compute plan could not be verified. Nothing was created.");
  }
  if (!subscription || !paysForHostedCompute(subscription)) {
    return failure(HOSTED_COMPUTE_REQUIRES_PLAN_CODE, 403, HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE);
  }
  const agentLimit = subscription?.instance_limit;
  if (typeof agentLimit !== "number" || !Number.isInteger(agentLimit) || agentLimit < 0) {
    return failure("managed_gvisor_billing_unavailable", 503, "The hosted compute plan could not be verified. Nothing was created.");
  }
  const config = managedGvisorAuthorityConfig(env);
  if (!config) {
    return failure("managed_gvisor_not_configured", 503, "Managed Linux terminal sandboxes are not configured safely in this environment.");
  }
  if (config.authorityUserId === userId) {
    return failure("managed_gvisor_owner_fence", 503, "Managed Linux terminal authority is not independent of the computer owner.");
  }
  const plan = getPlan(subscription.plan);
  const cpuBudget = Number(subscription.total_cpu_budget) || plan.totalCpu;
  const ramBudgetMb = Number(subscription.total_ram_budget) || plan.totalRam;
  if (!Number.isFinite(cpuBudget) || cpuBudget < 0 || !Number.isSafeInteger(ramBudgetMb) || ramBudgetMb < 0) {
    return failure("managed_gvisor_billing_unavailable", 503, "The hosted compute plan could not be verified. Nothing was created.");
  }
  let ladder;
  try {
    ladder = await loadLadderEntitlement(userId);
  } catch {
    return failure("managed_gvisor_billing_unavailable", 503, "The hosted compute plan could not be verified. Nothing was created.");
  }
  try {
    const [connection, target] = await Promise.all([
      getInfrastructureConnectionAuthority(config.authorityUserId, config.connectionId),
      getInfrastructureDeploymentTarget(config.authorityUserId, config.targetId),
    ]);
    if (connection.id !== config.connectionId
      || connection.provider !== "host"
      || connection.status !== "ready"
      || connection.revision !== config.connectionRevision) {
      return failure("managed_gvisor_authority_unavailable", 503, "Managed Linux terminal authority could not be verified. Nothing was created.");
    }
    if (!isGvisorDeploymentTarget(target)
      || target.id !== config.targetId
      || target.connectionId !== config.connectionId
      || target.evidenceConnectionRevision !== config.connectionRevision
      || target.status !== "ready"
      || target.capabilities.adapter.version !== HIVRA_GVISOR_ADAPTER_VERSION
      || !isGvisorPreflightFresh(target.lastPreflightAt)) {
      return failure("managed_gvisor_target_mismatch", 503, "The configured managed Linux terminal target is not exact ready gVisor evidence. Nothing was created.");
    }
    return { ok: true, authority: { ...config, agentLimit, cpuBudget, ramBudgetMb,
      maxCpu: ladder?.maxCpuPerAgent ?? plan.maxCpuPerAgent, maxRamMb: ladder?.maxRamPerAgentMb ?? plan.maxRamPerAgent,
      adapterSha: target.capabilities.adapter.sha256, runtimeSha: target.capabilities.runtime.sha256 } };
  } catch {
    return failure("managed_gvisor_authority_unavailable", 503, "Managed Linux terminal authority could not be verified. Nothing was created.");
  }
}
