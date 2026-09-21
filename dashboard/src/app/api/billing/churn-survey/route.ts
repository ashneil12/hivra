/**
 * POST /api/billing/churn-survey
 *
 * Persists the cancel save-flow's one-question survey ("What's making you
 * cancel?") to churn_surveys. Auth'd via Clerk; the plan is read from the
 * user's hermes_subscriptions row (server truth) rather than trusted from
 * the client. Fire-and-forget from the modal's perspective — a failure here
 * must never block the user's path to cancelling, so the client treats any
 * outcome as non-fatal.
 */

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { ChurnSurveySchema } from "@/lib/billing/churn-survey";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) return apiError("Unauthorized", 401);

    if (!supabaseAdmin) return apiError("Database not configured", 500);

    let parsedBody: unknown;
    try {
      parsedBody = await req.json();
    } catch {
      return apiError("Invalid JSON body", 400);
    }

    const parsed = ChurnSurveySchema.safeParse(parsedBody);
    if (!parsed.success) {
      return apiError("Invalid survey payload", 400, parsed.error);
    }

    const { data: sub } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select("plan")
      .eq("user_id", clerkUserId)
      .maybeSingle();

    const { error: insertError } = await supabaseAdmin.from("churn_surveys").insert({
      user_id: clerkUserId,
      plan: typeof sub?.plan === "string" ? sub.plan : null,
      reason: parsed.data.reason,
      detail: parsed.data.detail?.length ? parsed.data.detail : null,
    });

    if (insertError) {
      return apiError("Failed to record survey", 500, {
        failureType: "churn_survey_insert_failed",
        errorCode: typeof insertError.code === "string" ? insertError.code : undefined,
      });
    }

    return apiSuccess({ recorded: true });
  } catch (error) {
    log.error("churn survey failed", error, {
      source: "billing-churn-survey",
      route: "/api/billing/churn-survey",
      method: "POST",
      failureType: "churn_survey_unexpected_error",
    });
    return apiError("Failed to record survey", 500);
  }
}
