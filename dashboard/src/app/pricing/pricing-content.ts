// Copy for /pricing, read from checkout's plans so the page moves with billing.
//
// /pricing states only what can be bought today: free self-hosting and the two
// hosted sizes checkout sells, by price and size. The owner's proposed ladder
// (lib/subscription/hosted-ladder.ts) stays a labelled preview on the homepage;
// its planned perks are not shipped, so they are never repeated here. Plans are
// described by price and size, never by name, because checkout's names collide
// with the ladder's (see lib/blog/plan-facts.ts).

import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
} from "@/lib/blog/plan-facts";
import { PLANS } from "@/lib/subscription/plans";

export const PRICING_TITLE = "Pricing: self-host free, hosted from $9.99";
export const PRICING_DESCRIPTION = `Self-host Hivra for free, or let Hivra run the computer from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. ${MONEY_BACK_GUARANTEE}.`;

export const SELF_HOST_SOURCE_URL = "https://github.com/ashneil12/hivra";

export interface HostedSize {
  planKey: "operator" | "fleet";
  price: string;
  cpu: number;
  ramGb: number;
  body: string;
  /** Carries this paid plan through checkout (lib/public-start.ts allows it). */
  href: string;
}

function hostedSize(planKey: HostedSize["planKey"], price: string, body: string): HostedSize {
  const plan = PLANS[planKey];
  return { planKey, price, cpu: plan.totalCpu, ramGb: plan.totalRam / 1024, body, href: `/get-started?plan=${planKey}` };
}

export const HOSTED_SIZES: HostedSize[] = [
  hostedSize("operator", ENTRY_PLAN_PRICE, "Hivra runs the computer for you. It stays on and is not paused for inactivity."),
  hostedSize("fleet", LARGER_PLAN_PRICE, "The same, with twice the CPU and memory for bigger builds and heavier workloads."),
];

/**
 * The date the prices and sizes below were last checked against checkout's
 * PLANS. Change it only when a price or size is checked or changes, together
 * with the expected rows in __tests__/pricing-table.test.tsx, which fails when
 * PLANS and this date drift apart.
 */
export const PRICES_AS_OF = "2026-09-30";

/** "30 September 2026": spelled out, UTC, the same on every server. */
export function formatPricesAsOf(iso: string = PRICES_AS_OF): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * One row of the pricing table. The visible <table> and the Offer JSON-LD are
 * both built from these rows, so the markup cannot drift from what is shown.
 */
export interface PricingRow {
  key: "self-host" | HostedSize["planKey"];
  /** Row header, also the Offer name. */
  option: string;
  vcpu: string;
  ram: string;
  /** Visible price with its dollar sign: "$9.99". */
  price: string;
  /** The same price as a bare amount for structured data: "9.99". */
  priceAmount: string;
  /** What the price buys, shown beside the price and used as the Offer description. */
  priceFor: string;
  billing: string;
  refund: string;
  /** Hosted rows bill monthly; self-hosting has no billing period. */
  monthly: boolean;
}

export const SELF_HOST_OPTION = "Self-host";

export const PRICING_ROWS: PricingRow[] = [
  {
    key: "self-host",
    option: SELF_HOST_OPTION,
    vcpu: "Your server",
    ram: "Your server",
    price: "$0",
    priceAmount: "0",
    priceFor: "for the software, on your own server",
    billing: "None, you pay your own server and your AI company",
    refund: "Not applicable",
    monthly: false,
  },
  ...HOSTED_SIZES.map((size): PricingRow => ({
    key: size.planKey,
    option: `Hivra Cloud, ${size.cpu} vCPU and ${size.ramGb} GB`,
    vcpu: String(size.cpu),
    ram: `${size.ramGb} GB`,
    price: size.price,
    priceAmount: size.price.replace("$", ""),
    priceFor: `for ${size.cpu} vCPU and ${size.ramGb} GB of RAM`,
    billing: "Monthly",
    refund: MONEY_BACK_GUARANTEE,
    monthly: true,
  })),
];

/**
 * Offer JSON-LD for the pricing table: one Offer per row, the same option
 * name, price, currency and billing period the table shows.
 */
export function buildPricingOffers(siteUrl: string): Array<Record<string, unknown>> {
  return PRICING_ROWS.map((row) => ({
    "@type": "Offer",
    name: row.option,
    price: row.priceAmount,
    priceCurrency: "USD",
    description: row.monthly
      ? `${row.price} a month ${row.priceFor}. ${row.refund}.`
      : "Run Hivra on your own server from the open source code. You provide the server and pay for it and for your AI usage.",
    url: `${siteUrl}/pricing#pricing-table`,
    ...(row.monthly
      ? {
          priceSpecification: {
            "@type": "UnitPriceSpecification",
            price: row.priceAmount,
            priceCurrency: "USD",
            billingDuration: "P1M",
          },
        }
      : {}),
  }));
}

export const PRICING_FAQ: { q: string; a: string }[] = [
  {
    q: "How much does Hivra cost?",
    a: `Self-hosting the platform is free. If you want Hivra to run the computer for you, paid plans are ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}.`,
  },
  {
    q: "Can I self-host Hivra for free?",
    a: "Yes. Hivra is open source at github.com/ashneil12/hivra, and you can run it yourself. You supply the server and pay for it, and for your AI usage.",
  },
  {
    q: "Is a hosted computer paused when I am not using it?",
    a: "No. Paid plans stay on and are not paused for inactivity, and the computer keeps its files, sessions and login.",
  },
  {
    q: "Can I use my own AI key or login?",
    a: "Yes. Bring your own AI key, or sign in with your own account for Claude Code and Codex. Your AI company bills you for what you use.",
  },
  {
    q: "Is there a money-back guarantee?",
    a: `Yes. Paid plans come with a ${MONEY_BACK_GUARANTEE}.`,
  },
];
