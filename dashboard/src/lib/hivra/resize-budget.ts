import type { HivraAgent, PlanInfo } from "./agent-api";
import { isPoolExempt, MAX_CPU, MAX_RAM, resizeFloor } from "./agent-catalog";

/** A UI preview, never admission authority. The server checks fresh entitlement
 * and host headroom again before changing the existing computer. */
export function resizeBudget(agent: HivraAgent, plan?: PlanInfo | null) {
  const selfManaged = agent.deployment_mode === "self-managed";
  const exempt = isPoolExempt(agent.type);
  const fixedSize = !selfManaged && exempt;
  const floor = resizeFloor(agent.type, false);
  const contributes = !selfManaged && !exempt && ["running", "stopped", "provisioning"].includes(agent.status);
  const ownCpu = contributes ? agent.cpu : 0;
  const ownRam = contributes ? agent.ram : 0;
  const usage = plan?.usage;
  // Re-credit only compute that is actually in the account-wide snapshot. An
  // inconsistent or missing snapshot is not evidence of an empty shared pool.
  const known = Boolean(plan && usage &&
    [usage.usedCpu, usage.usedRam, plan.poolCpu, plan.poolRam, plan.maxCpuPerAgent, plan.maxRamPerAgent].every(n => Number.isFinite(n) && n >= 0) &&
    usage.usedCpu >= ownCpu && usage.usedRam >= ownRam);
  const otherCpu = known ? usage!.usedCpu - ownCpu : 0;
  const otherRam = known ? usage!.usedRam - ownRam : 0;
  const ready = selfManaged || known;
  return {
    selfManaged, ready, fixedSize,
    showPool: !selfManaged && known && !exempt,
    otherCpu, otherRam,
    cpu: !ready ? 0 : selfManaged ? MAX_CPU : fixedSize ? floor.cpu : Math.min(MAX_CPU, plan!.maxCpuPerAgent, Math.max(0, plan!.poolCpu - otherCpu)),
    ram: !ready ? 0 : selfManaged ? MAX_RAM : fixedSize ? floor.ram : Math.min(MAX_RAM, plan!.maxRamPerAgent, Math.max(0, plan!.poolRam - otherRam)),
  };
}
