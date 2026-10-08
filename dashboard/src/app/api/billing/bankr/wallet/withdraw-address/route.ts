/**
 * GET  /api/billing/bankr/wallet/withdraw-address
 *   → { address: string | null, normalizedAddress, network, acknowledgedResponsibility, setAt, updatedAt, availableAt }
 *
 * PUT  /api/billing/bankr/wallet/withdraw-address
 *   body: { address: string, acknowledged: boolean }
 *   → 200 saved | 400 invalid_address | 400 missing_acknowledgement
 *     | 403 Clerk reverification required (the dashboard's useReverification
 *       asks the user to confirm it's them, then retries)
 *
 * `availableAt` is when a newly saved address can first receive a withdrawal
 * (null once it can). See withdraw-destination-policy.ts.
 */

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  BILLING_V2_UNAVAILABLE_MESSAGE,
  isBillingV2ServerEnabled,
} from "@/lib/billing/billing-v2-availability";
import {
  getUserWithdrawAddress,
  setUserWithdrawAddress,
} from "@/lib/billing/withdraw-address";
import { withdrawDestinationStepUpResponse } from "@/lib/billing/withdraw-destination-notice";
import { withdrawDestinationHeldUntil } from "@/lib/billing/withdraw-destination-policy";

function heldUntilIso(setAt: string): string | null {
  return withdrawDestinationHeldUntil(setAt)?.toISOString() ?? null;
}

const LOG_CONTEXT = {
  source: "billing/withdraw-address",
  route: "/api/billing/bankr/wallet/withdraw-address",
};

export async function GET() {
  let userIdForLog: string | null = null;
  try {
    if (!isBillingV2ServerEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    const record = await getUserWithdrawAddress(userId);
    if (!record) {
      return apiSuccess({ address: null });
    }

    return apiSuccess({
      address: record.address,
      normalizedAddress: record.normalizedAddress,
      network: record.network,
      acknowledgedResponsibility: record.acknowledgedResponsibility,
      setAt: record.setAt,
      updatedAt: record.updatedAt,
      availableAt: heldUntilIso(record.setAt),
    });
  } catch (error) {
    return apiError("Failed to load withdraw address.", 500, {
      failureType: "withdraw_address_load_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      ...LOG_CONTEXT,
      method: "GET",
      userId: userIdForLog,
      failureType: "withdraw_address_load_failed",
      cause: error,
    });
  }
}

interface PutBody {
  address?: string;
  acknowledged?: boolean;
}

export async function PUT(req: NextRequest) {
  let userIdForLog: string | null = null;
  try {
    if (!isBillingV2ServerEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }
    const authObject = await auth();
    const { userId } = authObject;
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    // Changing where the whole balance is withdrawn to needs a fresh sign-in
    // check, so a stolen session alone cannot redirect it.
    const stepUp = withdrawDestinationStepUpResponse(authObject, { route: LOG_CONTEXT.route, userId });
    if (stepUp) return stepUp;

    let body: PutBody = {};
    try {
      body = (await req.json()) as PutBody;
    } catch {
      return apiError("Invalid JSON body.", 400);
    }

    if (typeof body.address !== "string") {
      return apiError("Missing 'address' field.", 400, {
        failureType: "withdraw_address_missing_field",
      });
    }

    const result = await setUserWithdrawAddress({
      userId,
      address: body.address,
      // Require a strict boolean `true` for the consent gate: Boolean(...) would
      // accept truthy non-booleans (e.g. the string "false"), weakening the
      // explicit-acknowledgement requirement for a funds-controlling destination.
      acknowledged: body.acknowledged === true,
    });

    if (result.status === "invalid_address") {
      return apiError(
        "That doesn't look like a valid Ethereum-style address. It must be 0x followed by 40 hex characters.",
        400,
        { failureType: "withdraw_address_invalid" }
      );
    }
    if (result.status === "missing_acknowledgement") {
      return apiError(
        "You must accept responsibility for the address you provide before it can be saved.",
        400,
        { failureType: "withdraw_address_unacknowledged" }
      );
    }

    return apiSuccess({
      status: "saved",
      address: result.record.address,
      normalizedAddress: result.record.normalizedAddress,
      network: result.record.network,
      setAt: result.record.setAt,
      updatedAt: result.record.updatedAt,
      availableAt: heldUntilIso(result.record.setAt),
    });
  } catch (error) {
    return apiError("Failed to save withdraw address.", 500, {
      failureType: "withdraw_address_save_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      ...LOG_CONTEXT,
      method: "PUT",
      userId: userIdForLog,
      failureType: "withdraw_address_save_failed",
      cause: error,
    });
  }
}
