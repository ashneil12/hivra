import { buildLaunchHref, launchProfileForAgentType, LAUNCH_ROUTE } from "@/lib/hivra/launch-navigation";
import { planReturnParams, withReturnParams } from "@/lib/safe-return-path";
import { PLANS } from "@/lib/subscription";

import { safeTemplateRef } from "./launch-template";

type WelcomeParams = Pick<URLSearchParams, "get" | "getAll">;

/** A paid plan key a link named, or null. */
function paidPlan(value: string | null): string | null {
  return value && value !== "free" && Object.hasOwn(PLANS, value) ? value : null;
}

/**
 * Where a /dashboard/welcome link goes now. Launch is the one front door, and
 * the jobs Welcome still had moved there:
 *
 * - back from checkout, Launch says whether the new plan shows yet;
 * - a paid plan is chosen in Billing, which returns to Launch;
 * - "Start from a template" and a named agent open that agent's plan;
 * - everything else opens Launch, where a new account turns Free on.
 */
export function welcomeRedirect(params: WelcomeParams): string {
  const plan = paidPlan(params.get("plan"));
  if (params.get("subscription") === "success") {
    return withReturnParams(LAUNCH_ROUTE, planReturnParams(plan));
  }
  if (plan) {
    // Billing opens its Plans tab on the plan the link named, and a confirmed
    // plan comes back to Launch.
    const billing = new URLSearchParams({ plan, from: "welcome" });
    const cadence = params.get("cadence");
    if (cadence === "monthly" || cadence === "yearly") billing.set("cadence", cadence);
    billing.set("returnTo", LAUNCH_ROUTE);
    return `/dashboard/billing?${billing.toString()}`;
  }

  const targetIds = params.getAll("targetId").filter(id => /^[0-9a-f-]{36}$/i.test(id));
  const template = safeTemplateRef(params.get("templateId"));
  if (template) {
    return buildLaunchHref({
      start: true,
      template,
      templateToken: safeTemplateRef(params.get("templateToken")),
      targetIds,
    });
  }
  const profile = launchProfileForAgentType(params.get("agentType"));
  if (profile) return buildLaunchHref({ start: true, profile, targetIds });
  const step = params.get("step");
  if (step === "agent-type" || step === "deploy" || targetIds.length > 0) {
    return buildLaunchHref({ kind: "agent", start: true, targetIds });
  }
  return LAUNCH_ROUTE;
}
