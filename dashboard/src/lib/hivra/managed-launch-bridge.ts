import "server-only";

import { resolveEffectiveSubscription, type EffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { paysForHostedCompute } from "@/lib/billing/hosted-compute";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export type ManagedLaunchBridgeEpoch = "legacy" | "funding" | "placement";
export type ManagedLaunchBridge = (
  | { epoch: "legacy" }
  | { epoch: "funding" | "placement"; seatFunding: "paid" }
) & { cpuOvercommitRatio: number; skipSleep: boolean };

export const BRIDGE_UNAVAILABLE_MESSAGE = "Managed computer launches are temporarily unavailable. Try again later.";

export class ManagedLaunchBridgeError extends Error {
  constructor(readonly code: "bridge_unavailable" | "bridge_phase_changed" | "bridge_holder_unavailable" | "placement_unavailable") {
    super(code === "bridge_holder_unavailable"
      ? "Token-holder computer launches are temporarily unavailable."
      : code === "placement_unavailable"
        ? "The selected host can no longer fit this computer. Try again later."
        : BRIDGE_UNAVAILABLE_MESSAGE);
  }
}

export async function readManagedLaunchBridgeEpoch(): Promise<ManagedLaunchBridgeEpoch | null> {
  if (process.env.HIVRA_MANAGED_LAUNCH_BRIDGE !== "1") return null;
  let epoch: unknown;
  try {
    const result = await supabaseAdmin?.rpc("managed_launch_bridge_epoch");
    epoch = result?.error ? null : result?.data;
  } catch {
    epoch = null;
  }
  if (epoch === "legacy" || epoch === "funding" || epoch === "placement") return epoch;
  log.warn("managed launch bridge epoch could not be verified", {
    source: "hivra/managed-launch-bridge", failureType: "managed_launch_bridge_epoch_unavailable",
  });
  throw new ManagedLaunchBridgeError("bridge_unavailable");
}

export function managedPlacementBridgeEnabled(): boolean {
  return process.env.HIVRA_MANAGED_PLACEMENT_BRIDGE === "1";
}

export function classicHolderBridgeEnabled(): boolean {
  return process.env.HIVRA_CLASSIC_HOLDER_BRIDGE === "1";
}

export async function requireUnreservedFundingEpoch(): Promise<void> {
  try {
    const result = await supabaseAdmin?.from("holder_admissions").select("user_id").eq("state", "admitted").limit(1);
    if (!result?.error && Array.isArray(result?.data) && result.data.length === 0) return;
  } catch {
    log.warn("managed launch bridge could not verify the holder reservation ledger", {
      source: "hivra/managed-launch-bridge", failureType: "managed_launch_bridge_reservations_unavailable",
    });
  }
  throw new ManagedLaunchBridgeError("bridge_unavailable");
}

export async function resolveManagedBridgePaidEntitlement(userId: string, previous?: EffectiveSubscription): Promise<EffectiveSubscription> {
  let subscription: EffectiveSubscription | null;
  try {
    subscription = await resolveEffectiveSubscription(userId, { throwOnQueryError: true });
  } catch {
    log.warn("managed launch bridge entitlement could not be verified", {
      source: "hivra/managed-launch-bridge", failureType: "managed_launch_bridge_entitlement_unavailable", userId,
    });
    throw new ManagedLaunchBridgeError("bridge_unavailable");
  }
  if (subscription?.source === "token_holding") throw new ManagedLaunchBridgeError("bridge_holder_unavailable");
  if (!subscription || !paysForHostedCompute(subscription)
    || (subscription.status !== "active" && subscription.status !== "past_due")
    || !subscription.plan || subscription.plan === "free"
    || !Number.isSafeInteger(subscription.instance_limit) || subscription.instance_limit <= 0
    || (subscription.source !== "stripe" && subscription.source !== "apple_iap" && subscription.source !== "token_yearly")) {
    throw new ManagedLaunchBridgeError("bridge_unavailable");
  }
  if (previous && (["source", "status", "plan", "instance_limit", "total_cpu_budget", "total_ram_budget"] as const)
    .some(field => subscription[field] !== previous[field])) {
    throw new ManagedLaunchBridgeError("bridge_unavailable");
  }
  return subscription;
}

export function managedLaunchBridgeArgs(bridge: ManagedLaunchBridge) {
  return {
    p_epoch: bridge.epoch,
    p_cpu_overcommit_ratio: bridge.cpuOvercommitRatio,
    p_skip_sleep: bridge.skipSleep,
  };
}

export function managedLaunchBridgeRow<T extends object>(row: T, bridge: ManagedLaunchBridge) {
  return bridge.epoch === "legacy" ? row : { ...row, seat_funding: bridge.seatFunding };
}
