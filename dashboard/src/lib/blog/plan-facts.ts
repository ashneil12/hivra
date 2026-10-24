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

/*
 * Display helpers for the public site copy (added 2026-10-20, append only).
 *
 * The two hosted sizes were written three ways across the site: "2 vCPU and 4 GB
 * of RAM", "2 vCPU . 4 GB RAM" and "2 vCPU / 4 GB". Every page builds its price and
 * size text from here instead, so the words, the plan names and the "$19.99 comes
 * with its size" rule (lib/tools/copy-rules.ts) hold on every page.
 */

/** The two hosted sizes the public pages name: the entry size and the one with more room. */
export type PlanSizeKey = "entry" | "larger";

/**
 * What the public site calls the two sizes. Never "Starter", "Pro" or "Power":
 * those names collide between checkout, the homepage ladder and the unshipped
 * ladder (see the header of this file). Offer names in structured data stay as
 * they are.
 */
export const PLAN_DISPLAY = {
  entry: "Hivra Cloud",
  larger: "More room",
} as const satisfies Record<PlanSizeKey, string>;

const PLAN_SIZE_SOURCE = {
  entry: { price: ENTRY_PLAN_PRICE, size: ENTRY_PLAN_SIZE, plan: PLANS.operator },
  larger: { price: LARGER_PLAN_PRICE, size: LARGER_PLAN_SIZE, plan: PLANS.fleet },
} as const;

/** One size broken into the pieces a layout sets in separate elements. */
export interface PlanSizeParts {
  /** "$9.99" */
  price: string;
  /** "$9.99/month": a compact label only, never prose. */
  pricePerMonth: string;
  /** "2 vCPU" */
  cpu: string;
  /** "4 GB" */
  ram: string;
  /** "4 GB RAM" */
  memory: string;
  /** "2 vCPU and 4 GB of RAM" */
  size: string;
  /** "2 vCPU / 4 GB" */
  slashSize: string;
}

/**
 * The price and the size as separate strings, for a dot-separated look that sets
 * each in its own element. No part holds the price and the size together.
 *
 * The rule in lib/tools/copy-rules.ts still reads the page text as a whole: a
 * "$19.99" must be followed, in the same sentence, by "4 vCPU and 8 GB". A
 * layout that shows the larger size only as "4 vCPU / 8 GB" or "4 vCPU . 8 GB RAM"
 * fails that scan, so it also needs `size` in the text after the price.
 */
export function planSizeParts(plan: PlanSizeKey): PlanSizeParts {
  const { price, size, plan: source } = PLAN_SIZE_SOURCE[plan];
  const cpu = `${source.totalCpu} vCPU`;
  const ram = `${source.totalRam / 1024} GB`;
  return {
    price,
    pricePerMonth: `${price}/month`,
    cpu,
    ram,
    memory: `${ram} RAM`,
    size,
    slashSize: `${cpu} / ${ram}`,
  };
}

/**
 * A price with its size, in one string that always keeps the size next to the price.
 * - "prose": "$9.99 a month for 2 vCPU and 4 GB of RAM"
 * - "compact": "$9.99/month, 2 vCPU and 4 GB RAM" (cards, table cells and labels;
 *   the only form that uses "/month")
 */
export function formatPlanSize(plan: PlanSizeKey, style: "prose" | "compact" = "prose"): string {
  const { price, size } = PLAN_SIZE_SOURCE[plan];
  if (style === "prose") return `${price} a month for ${size}`;
  const parts = planSizeParts(plan);
  return `${parts.pricePerMonth}, ${parts.cpu} and ${parts.memory}`;
}

/*
 * Hosted computers are paid (owner decision 2026-10-21, added append only).
 *
 * Every computer that Hivra Cloud runs for you needs a paid plan, whichever agent you pick. A free
 * account works with a computer or server you connect yourself. Articles use these sentences instead
 * of saying that one agent "needs a paid plan", which told readers the others were free. The price
 * and size come from the billing constants above, so the sentence moves with checkout.
 */

/** "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM." */
export const HOSTED_COMPUTE_NEEDS_PLAN_SENTENCE = `Every computer that Hivra Cloud runs for you needs a paid plan, from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}.`;

/** What a free account does include. */
export const FREE_ACCOUNT_SENTENCE = "A free account works with a computer or server you connect yourself.";

/** The canonical pair, for the places that have room for both sentences. */
export const HOSTED_COMPUTE_NEEDS_PLAN = `${HOSTED_COMPUTE_NEEDS_PLAN_SENTENCE} ${FREE_ACCOUNT_SENTENCE}`;

/** The short form, for a clause that cannot carry the price. */
export const HOSTED_COMPUTE_NEEDS_PLAN_SHORT = "Every Hivra Cloud computer needs a paid plan.";
