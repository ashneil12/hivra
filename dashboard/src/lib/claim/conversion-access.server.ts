import "server-only";

import { isBillingV2ServerEnabled } from "@/lib/billing/billing-v2-availability";
import { isCryptoBillingEnabled } from "@/lib/billing/crypto-availability";
import { resolveUserTokenAccess } from "@/lib/billing/token-access";
import { getHivraTokenPhase } from "@/lib/billing/token-registry";
import { log } from "@/lib/logger";

import type { ConversionAccessGate } from "./conversion-state";

/**
 * Reads the access gate for the convert page. Returns null, which keeps
 * conversion closed, when:
 * - $HIVRA is not active (no database read is needed or useful);
 * - the token-access surface is off, because then the user could not switch
 *   their access (POST /api/billing/token-access answers 404) before swapping;
 * - the access engine fails.
 */
export async function readConversionAccessGate(
  userId: string | null,
  now: Date = new Date(),
): Promise<ConversionAccessGate> {
  if (!userId || getHivraTokenPhase(now) !== "active") return null;
  if (!isBillingV2ServerEnabled() || !isCryptoBillingEnabled()) return null;
  try {
    // Same call as GET /api/billing/token-access: it records a cohort member the
    // activation pass missed, so a grandfathered holder is never read as
    // "already on $HIVRA" and shown a swap that would drop their tier.
    const access = await resolveUserTokenAccess(userId, { now });
    return {
      grandfathered: access.grandfathered,
      convertedAt: access.convertedAt?.toISOString() ?? null,
      conversionGraceEndsAt: access.conversionGraceEndsAt?.toISOString() ?? null,
    };
  } catch (error) {
    log.error("Failed to read token access for the convert page", error, {
      source: "dashboard/convert",
      userId,
      failureType: "convert_access_gate_failed",
    });
    return null;
  }
}
