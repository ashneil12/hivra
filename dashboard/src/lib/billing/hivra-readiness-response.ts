/**
 * The one response every token route gives while $HIVRA is not usable for
 * this account (hivra-readiness.ts): a clear "not available yet", never a
 * price-gate error. Logged at info: it can hold for hours before the pool is
 * ready, and it is expected, not a fault.
 */
import { apiError } from "@/lib/api-response";
import { HIVRA_NOT_READY_FAILURE_TYPE, HIVRA_NOT_READY_MESSAGE } from "./hivra-readiness";

export const HIVRA_NOT_READY_STATUS = 503;

export function hivraNotReadyResponse(context: { source: string; route: string; method: string; userId?: string | null }) {
  return apiError(
    HIVRA_NOT_READY_MESSAGE,
    HIVRA_NOT_READY_STATUS,
    { failureType: HIVRA_NOT_READY_FAILURE_TYPE },
    { reason: HIVRA_NOT_READY_FAILURE_TYPE },
    { ...context, failureType: HIVRA_NOT_READY_FAILURE_TYPE, logLevel: "info" }
  );
}
