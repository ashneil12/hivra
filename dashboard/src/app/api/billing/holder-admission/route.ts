import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * GET /api/billing/holder-admission
 *
 * Current-user read of the durable holder admission state. Identity comes only
 * from the authenticated session; the service-side SQL function reads exactly
 * that user's row and returns no queue position or other-user information.
 */
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { data, error } = await supabaseAdmin.rpc("holder_admission_state", {
      p_user_id: userId,
    });
    if (error) {
      return apiError("Failed to read holder admission state", 500, {
        failureType: "holder_admission_state_read_failed",
      });
    }

    const state = (data as { state?: unknown } | null)?.state;
    // Billing workers consume the exact state object; do not wrap it in the
    // dashboard's usual success envelope.
    return NextResponse.json({
      state: state === "waitlisted" || state === "admitted" ? state : "none",
    });
  } catch (error) {
    return apiError("Failed to read holder admission state", 500, {
      failureType: "holder_admission_state_unexpected_error",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
