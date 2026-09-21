// Read-only managed-Venice usage breakdown for the customer spend view:
// this month's charged total, per-model + per-modality burn, and a naive
// month-end projection. Backs the spend dashboard (Phase 4).

import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getManagedVeniceUsageSummary } from "@/lib/billing/managed-venice-usage-summary";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    const summary = await getManagedVeniceUsageSummary(userId);
    return apiSuccess(summary);
  } catch (error) {
    return apiError(
      "Failed to load managed Venice usage.",
      500,
      {
        failureType: "managed_venice_usage_summary_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      undefined,
      {
        source: "billing/managed-venice/usage",
        route: "/api/billing/managed-venice/usage",
        method: "GET",
        failureType: "managed_venice_usage_summary_failed",
        cause: error,
      }
    );
  }
}
