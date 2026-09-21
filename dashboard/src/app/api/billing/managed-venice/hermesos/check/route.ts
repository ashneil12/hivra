import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { reconcileManagedVeniceTokenQuote } from "@/lib/billing/managed-venice-token-reconciliation";

const CheckRequestSchema = z.object({
  quoteId: z.string().trim().min(1),
});

function safeCheckErrorDetails(error: unknown) {
  if (!(error instanceof Error)) {
    return {
      errorName: typeof error,
    };
  }

  const isBaseRpcError = error.message.startsWith("Base RPC ");
  return {
    errorName: error.name,
    ...(isBaseRpcError ? { safeErrorMessage: error.message } : {}),
  };
}

export async function POST(req: NextRequest) {
  let userIdForLog: string | null = null;

  try {
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    let body: unknown;
    try {
      body = await req.json();
    } catch (error) {
      return apiError("Invalid JSON body.", 400, {
        failureType: "managed_venice_quote_check_invalid_json",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }

    const parsed = CheckRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid managed Venice quote check request.", 400, {
        failureType: "managed_venice_quote_check_invalid_request",
      });
    }

    const result = await reconcileManagedVeniceTokenQuote({
      quoteId: parsed.data.quoteId,
      userId,
    });

    if (result.status === "not_found") {
      return apiError("Managed Venice quote not found.", 404, {
        failureType: "managed_venice_quote_check_not_found",
      });
    }

    return apiSuccess(result);
  } catch (error) {
    return apiError(
      "Failed to check the managed Venice top-up.",
      500,
      {
        failureType: "managed_venice_quote_check_failed",
        ...safeCheckErrorDetails(error),
      },
      undefined,
      {
        source: "billing/managed-venice/hermesos/check",
        route: "/api/billing/managed-venice/hermesos/check",
        method: "POST",
        userId: userIdForLog,
        failureType: "managed_venice_quote_check_failed",
        cause: error,
      }
    );
  }
}
