import { LARGER_PLAN_SIZE, PLAN_DISPLAY, planSizeParts, type PlanSizeKey } from "@/lib/blog/plan-facts";
import type { PlanKey } from "@/lib/subscription";

/**
 * What the /get-started plan card calls and lists the plans, in every language.
 *
 * Checkout still sells the plans under their billing names (PLANS in lib/subscription/plans.ts,
 * "Pro" and "Power"), and those names collide with the public price ladder, so the public site
 * never uses them: it names a plan by what it costs and how big it is (see lib/blog/plan-facts.ts).
 * This file is the only place the sign-up page maps the billing plan onto those words, and the page
 * uses it for every language, so a translated page never shows a billing name or a bullet the
 * English card dropped. Billing keeps its own names, keys and Stripe ids.
 */

const SIZE_KEY: Partial<Record<PlanKey, PlanSizeKey>> = { operator: "entry", fleet: "larger" };

/** The name the card, the plan switcher and the phone summary use. */
export function planLabel(key: PlanKey, billingName: string): string {
  const size = SIZE_KEY[key];
  return size ? PLAN_DISPLAY[size] : billingName;
}

/** "2 vCPU and 4 GB of RAM": the size that always travels with the price, or null for a plan with no hosted size. */
export function planSizeLine(key: PlanKey): string | null {
  const size = SIZE_KEY[key];
  return size ? planSizeParts(size).size : null;
}

const STAYS_ON = `A paid ${PLAN_DISPLAY.entry} computer stays on and is not paused for inactivity.`;

/**
 * The bullets under the price. Only claims the code and the owner's wording back: the stays-on sentence is
 * the repo-approved one, and AI usage is never promised as included.
 */
export const PLAN_FEATURES: Partial<Record<PlanKey, readonly string[]>> = {
  free: [
    "Sign in and use Hivra free",
    "Connect your own computer or server",
    "Bring your own account or key where the agent supports it",
    "Choose a plan when you want Hivra to run the computer",
  ],
  operator: [
    STAYS_ON,
    "Autonomous browsing & tool use",
    "Persistent memory across sessions",
    "Scheduled tasks & cron jobs",
    "Bring your own account or key where the agent supports it, or pay with Hivra credits",
  ],
  fleet: [
    `Everything in ${PLAN_DISPLAY.entry}`,
    // The size comes from the plan facts. "Twice" is pinned by the plan-card-copy test, so it cannot go stale.
    `Twice the CPU and memory: ${LARGER_PLAN_SIZE}`,
    "Burst CPU when capacity allows",
    "Priority scheduling",
  ],
};
