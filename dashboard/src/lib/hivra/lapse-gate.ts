import { hasTokenTierInGrace, resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { paysForHostedCompute } from "@/lib/billing/hosted-compute";
import { isHivraLapseEnforceLive } from "@/lib/hivra/lapse-flags";
import { log } from "@/lib/logger";

/**
 * Whether a Hivra computer's owner has a paid plan, and the Start refusal that
 * follows. Both the unpaid-owner sweep (lib/recovery/hivra-lapse-enforce.ts) and
 * the Start action use ownerHasNoPaidPlan, so they cannot disagree; the answer
 * is read live from resolveEffectiveSubscription, so nothing is stored and it
 * clears by itself the moment payment resumes.
 */

/** Actions that bring a computer back up (resize stops it and starts it again). Stop, snapshot, export and delete are never gated. */
const POWER_ON_ACTIONS = ["start", "restart", "force_restart", "resize"];

interface ComputerRow {
  deployment_mode?: unknown;
  computer_substrate?: unknown;
  deployment_target_id?: unknown;
  infrastructure_connection_id?: unknown;
}

/** A computer Hivra runs and pays for: not the owner's own server and not a provider's VM. */
export function isHivraCloudComputer(row: ComputerRow): boolean {
  return row.deployment_mode === "hivra-managed"
    && row.computer_substrate === "proxmox-kvm"
    && row.deployment_target_id == null
    && row.infrastructure_connection_id == null;
}

/**
 * True only when the owner has no entitlement at all, only the Free account,
 * or only a trial (Hivra has no trials: see paysForHostedCompute), and no
 * token tier still inside its 24 hour grace. Any error is "don't know", which
 * is false: never act on doubt.
 */
export async function ownerHasNoPaidPlan(userId: string): Promise<boolean> {
  try {
    // throwOnQueryError: a failed read must mean "don't know", never "no plan".
    const entitlement = await resolveEffectiveSubscription(userId, { throwOnQueryError: true });
    if (paysForHostedCompute(entitlement)) return false;
    return !(await hasTokenTierInGrace(userId));
  } catch (error) {
    log.warn("could not check the owner's plan; treating the owner as paid", {
      source: "hivra-lapse-gate",
      failureType: "lapse_entitlement_check_failed",
      userId,
    }, error);
    return false;
  }
}

/** True when this action would start a Hivra Cloud computer whose owner has no paid plan, and enforcement is on. */
export async function isStartBlockedForLapse(
  agent: ComputerRow & { user_id?: unknown },
  action: string,
): Promise<boolean> {
  if (!isHivraLapseEnforceLive()) return false;
  if (!POWER_ON_ACTIONS.includes(action)) return false;
  if (!isHivraCloudComputer(agent) || typeof agent.user_id !== "string") return false;
  return ownerHasNoPaidPlan(agent.user_id);
}
