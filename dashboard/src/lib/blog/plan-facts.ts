/**
 * Plan facts the blog may state, read from the billing source of truth.
 *
 * Blog articles are data modules whose prose is rendered on the page AND
 * shipped as FAQPage JSON-LD, so a stale price or plan promise does not just
 * mislead a reader, it reaches search engines as structured data. Articles
 * interpolate these values instead of hard-coding them, so the copy moves with
 * checkout.
 *
 * Plans are described by price and size, never by name: checkout's plan names
 * ("Pro" is the $9.99 plan) collide with the public price ladder on the
 * homepage ("Pro" is $19.99 there). Price and size are the same in both.
 *
 * What the blog must not claim about plans (enforced by
 * lib/blog/__tests__/blog-claims.test.ts): a free trial, "card required", a
 * hosted free plan, "never sleeps" or "always on" below the entry price,
 * agent-count limits, unlimited agents, and unmeasured launch-speed promises.
 */

import { PLANS } from "@/lib/subscription/plans";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function planSize(plan: { totalCpu: number; totalRam: number }): string {
  return `${plan.totalCpu} vCPU and ${plan.totalRam / 1024} GB of RAM`;
}

/** Entry paid plan price, e.g. "$9.99". */
export const ENTRY_PLAN_PRICE = dollars(PLANS.operator.price);
/** Entry paid plan compute, e.g. "2 vCPU and 4 GB of RAM". */
export const ENTRY_PLAN_SIZE = planSize(PLANS.operator);
/** Next paid plan price, e.g. "$19.99". */
export const LARGER_PLAN_PRICE = dollars(PLANS.fleet.price);
/** Next paid plan compute, e.g. "4 vCPU and 8 GB of RAM". */
export const LARGER_PLAN_SIZE = planSize(PLANS.fleet);

/**
 * Owner decision 2026-09-24. The guarantee covers card payments only, so the
 * qualifier is part of the phrase; the same wording as the checkout copy in
 * lib/i18n.ts and WelcomeFlow.
 */
export const MONEY_BACK_GUARANTEE = "7-day money-back guarantee on card payments";

/** One true sentence about what a paid plan gets you, for articles that end on it. */
export const PLAN_SUMMARY = `Paid plans start at ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, stay on without being paused for inactivity, and come with a ${MONEY_BACK_GUARANTEE}.`;
