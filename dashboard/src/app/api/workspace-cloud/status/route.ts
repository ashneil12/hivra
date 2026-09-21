export const runtime = "nodejs";

import { auth } from "@clerk/nextjs/server";

import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { resolveWorkspaceCloudEntitlement } from "@/lib/billing/instance-entitlement";
import {
  WORKSPACE_CLOUD_PLANS,
  getWorkspaceCloudPlan,
  DEFAULT_WORKSPACE_CLOUD_PLAN_KEY,
} from "@/lib/subscription/plans";

const ROUTE = "/api/workspace-cloud/status";

function priceLabel(cents: number): string {
  if (!cents || cents <= 0) return "";
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars.toFixed(0) : dollars.toFixed(2)}/mo`;
}

/**
 * Lane status for the Workspace Cloud control panel. Returns the caller's
 * subscription state (so the dashboard can show a Subscribe CTA upfront
 * instead of only after a failed launch), current agent usage vs the plan
 * limit, and the default offer plan to advertise when not subscribed.
 */
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401, undefined, undefined, { route: ROUTE });
    if (!supabaseAdmin) return apiError("Database not configured", 500, undefined, undefined, { route: ROUTE });

    const sub = await resolveWorkspaceCloudEntitlement(userId);

    const { count } = await supabaseAdmin
      .from("hermes_instances")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("product_surface", "workspace_cloud")
      .neq("status", "deleted");

    const offer = getWorkspaceCloudPlan(DEFAULT_WORKSPACE_CLOUD_PLAN_KEY);
    const subscribedPlan = sub
      ? WORKSPACE_CLOUD_PLANS[sub.plan as keyof typeof WORKSPACE_CLOUD_PLANS] ?? null
      : null;

    return apiSuccess({
      subscribed: !!sub,
      status: sub?.status ?? null,
      instanceLimit: sub?.instance_limit ?? 0,
      instanceCount: count ?? 0,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      plan: sub
        ? {
            key: sub.plan,
            name: subscribedPlan?.name ?? "Workspace Cloud",
            priceLabel: subscribedPlan ? priceLabel(subscribedPlan.price) : "",
          }
        : null,
      offer: {
        key: offer.key,
        name: offer.name,
        priceLabel: priceLabel(offer.price),
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
