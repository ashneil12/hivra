/**
 * Server-side half of the withdrawal-destination rules (see
 * withdraw-destination-policy.ts): the fresh sign-in check a change needs, and
 * the email the owner gets after one.
 */

import { reverificationErrorResponse } from "@clerk/nextjs/server";

import {
  sendWithdrawDestinationChangedEmail,
  type WithdrawDestinationChangedParams,
} from "@/lib/email/withdraw-destination-changed";
import { log } from "@/lib/logger";
import { WITHDRAW_DESTINATION_REVERIFICATION } from "./withdraw-destination-policy";

type ReverificationCheck = (params: { reverification: typeof WITHDRAW_DESTINATION_REVERIFICATION }) => boolean;

/**
 * Null when this session verified recently enough to change a withdrawal
 * destination; otherwise Clerk's reverification response (403). The dashboard
 * wraps these requests in Clerk's useReverification, which reads that
 * response, asks the user to confirm it's them, and retries the request.
 *
 * Fails closed: an auth object that cannot answer the check is refused.
 */
export function withdrawDestinationStepUpResponse(
  authObject: { has?: unknown },
  context: { route: string; userId: string }
): Response | null {
  const has = authObject.has;
  if (typeof has === "function") {
    try {
      if ((has as ReverificationCheck)({ reverification: WITHDRAW_DESTINATION_REVERIFICATION })) return null;
    } catch (err) {
      log.warn("withdraw destination reverification check threw", {
        source: "billing/withdraw-destination",
        route: context.route,
        userId: context.userId,
        failureType: "withdraw_destination_reverification_check_failed",
      }, err);
    }
  }
  log.info("withdraw destination change needs a fresh sign-in check", {
    source: "billing/withdraw-destination",
    route: context.route,
    userId: context.userId,
    failureType: "withdraw_destination_reverification_required",
  });
  return reverificationErrorResponse(WITHDRAW_DESTINATION_REVERIFICATION);
}

/**
 * Email the owner about a destination change. Never throws and never undoes
 * the change: the cooldown protects the funds whether or not the email lands.
 * A notice that was not sent is logged so ops can see it.
 */
export async function noticeWithdrawDestinationChange(params: WithdrawDestinationChangedParams): Promise<void> {
  const context = {
    source: "billing/withdraw-destination",
    userId: params.userId,
    destinationKind: params.kind,
  };
  try {
    const result = await sendWithdrawDestinationChangedEmail(params);
    if (result.sent) {
      log.info("withdraw destination change notice sent", context);
      return;
    }
    if (result.reason === "not_configured") {
      log.warn("withdraw destination change notice not sent: email is not configured", {
        ...context,
        failureType: "withdraw_destination_notice_not_configured",
      });
      return;
    }
    log.error("withdraw destination change notice not sent", new Error(result.reason), {
      ...context,
      failureType: "withdraw_destination_notice_failed",
      reason: result.reason,
      errorMessage: result.errorMessage ?? null,
    });
  } catch (err) {
    log.error("withdraw destination change notice threw", err, {
      ...context,
      failureType: "withdraw_destination_notice_failed",
    });
  }
}
