import type { EffectiveSubscription } from "@/lib/billing/instance-entitlement";
import type { SeatFunding } from "@/lib/hivra/seat-funding";

/**
 * The single application-level funding decision for a newly provisioned
 * hosted seat. The client never supplies this value. A live paid entitlement
 * wins even when the account also holds tokens; only the admitted token-holder
 * entitlement produces a holder seat. Once written to the seat row this value
 * is immutable, so later subscription/token changes cannot retroactively alter
 * the controls or scheduler accounting for a seat that already exists.
 */
export function decideProvisionSeatFunding(
  sub: Pick<EffectiveSubscription, "source"> | null | undefined,
): SeatFunding | null {
  if (!sub) return null;
  return sub.source === "token_holding" ? "holder" : "paid";
}
