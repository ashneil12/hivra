// Closing the Free plan to new sign-ups (owner decision 2026-11-19): Hivra
// offers a free trial instead of a free version. HIVRA_FREE_PLAN_CLOSED_AT (an
// ISO time) is the cut-off. Accounts created at or after it need a paid plan or
// a trial to use Hivra, including connecting their own server; accounts
// created before it keep the Free account. Unset, nothing is closed.

import { log } from "@/lib/logger";

export const FREE_PLAN_CLOSED_CODE = "free_plan_closed" as const;

export const FREE_PLAN_CLOSED_MESSAGE =
  "Hivra no longer has a free plan. Start a 7-day free trial or choose a plan to connect your own server.";


import { freePlanClosedAt, isFreePlanClosed } from "./free-plan-cutoff";

export { freePlanClosedAt, isFreePlanClosed };


export interface FreePlanClosureDeps {
  resolveSubscription?: (userId: string) => Promise<{ plan: string; source: string; status: string } | null>;
  resolveAccountCreatedAt?: (userId: string) => Promise<Date | null>;
  env?: Record<string, string | undefined>;
}

async function defaultResolveSubscription(userId: string) {
  const { resolveEffectiveSubscription } = await import("@/lib/billing/instance-entitlement");
  return resolveEffectiveSubscription(userId, { throwOnQueryError: true });
}

async function defaultResolveAccountCreatedAt(userId: string): Promise<Date | null> {
  const { clerkClient } = await import("@clerk/nextjs/server");
  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId);
  return typeof user.createdAt === "number" ? new Date(user.createdAt) : null;
}

/**
 * True when this account was created after the Free plan closed and holds no
 * paid plan or trial. Any doubt (a failed read) is false: the Free account
 * costs Hivra no computer, so never lock someone out on doubt.
 */
export async function accountNeedsPlanForFree(userId: string, deps: FreePlanClosureDeps = {}): Promise<boolean> {
  const closedAt = freePlanClosedAt(deps.env);
  if (!closedAt) return false;
  try {
    const sub = await (deps.resolveSubscription ?? defaultResolveSubscription)(userId);
    if (sub && !(sub.source === "free" && sub.plan === "free")) return false;
    const createdAt = await (deps.resolveAccountCreatedAt ?? defaultResolveAccountCreatedAt)(userId);
    if (!createdAt) return false;
    return createdAt.getTime() >= closedAt.getTime();
  } catch (error) {
    log.warn("could not check whether the Free plan is closed for this account; allowing it", {
      source: "free-plan-closure",
      failureType: "free_plan_closure_check_failed",
      userId,
    }, error);
    return false;
  }
}
