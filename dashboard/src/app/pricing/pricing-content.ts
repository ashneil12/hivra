// Copy and data for /pricing, read from checkout's plans so the page moves with billing.
//
// /pricing states only what can be bought today: free self-hosting and the two
// hosted sizes checkout sells, by price and size. The owner's proposed ladder
// (lib/subscription/hosted-ladder.ts) stays out of this page; its planned perks
// are not shipped, so they are never repeated here. Plans are described by price
// and size, never by checkout's names, because those names collide with the
// ladder's (see lib/blog/plan-facts.ts).
//
// The prose below is the September 2026 pricing rewrite (scratchpad/batch01/04-pricing.md),
// with the changes the repo's own rules require (copy-rules.ts, runtime-facts.ts,
// plan-facts.ts). Every price, size and the guarantee line is built from
// lib/blog/plan-facts.ts, never typed.

import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  FREE_ACCOUNT_SENTENCE,
  HOSTED_COMPUTE_NEEDS_PLAN,
  LARGER_PLAN_PRICE,
  MONEY_BACK_GUARANTEE,
  PLAN_DISPLAY,
  planSizeParts,
} from "@/lib/blog/plan-facts";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import { PAYMENT_GRACE_HOURS, PLANS } from "@/lib/subscription/plans";

export const SELF_HOST_SOURCE_URL = "https://github.com/ashneil12/hivra";

/** The public support address (lib/support-channels.ts SUPPORT_EMAIL, guarded by static-copy-safety). */
export const PRICING_SUPPORT_EMAIL = "info@hivra.cloud";

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
  hostedSize("operator", ENTRY_PLAN_PRICE, "Hivra runs the computer for you. It stays on and isn't paused for inactivity."),
  hostedSize("fleet", LARGER_PLAN_PRICE, "The same, with twice the CPU and memory, for bigger builds and heavier workloads."),
];

/**
 * What the page calls each option. Never checkout's "Pro" or "Power" and never
 * the unshipped ladder's names: the entry size is "Hivra Cloud" and the larger
 * one is "Hivra Cloud, more room" (PLAN_DISPLAY in lib/blog/plan-facts.ts).
 * JSON-LD Offer names are PRICING_ROWS' `option` and stay as they were.
 */
export const PLAN_LABELS = {
  selfHost: "Self-host",
  entry: PLAN_DISPLAY.entry,
  larger: `${PLAN_DISPLAY.entry}, ${PLAN_DISPLAY.larger.toLowerCase()}`,
} as const;

/** Button and link labels with their destinations, so the page and the homepage agree. */
export const PRICING_ACTIONS = {
  chooseEntry: { label: `Choose ${HOSTED_SIZES[0].cpu} vCPU and ${HOSTED_SIZES[0].ramGb} GB`, href: HOSTED_SIZES[0].href },
  chooseLarger: { label: `Choose ${HOSTED_SIZES[1].cpu} vCPU and ${HOSTED_SIZES[1].ramGb} GB`, href: HOSTED_SIZES[1].href },
  connectServer: { label: "Connect your server", href: PUBLIC_START_HREF },
  viewSource: { label: "View the source and setup instructions", href: SELF_HOST_SOURCE_URL },
  launchCloud: { label: "Launch on Hivra Cloud", href: HOSTED_SIZES[0].href },
  selfHostFromGitHub: { label: "Self-host from GitHub", href: SELF_HOST_SOURCE_URL },
} as const;

/**
 * The date the prices and sizes below were last checked against checkout's
 * PLANS. Change it only when a price or size is checked or changes, together
 * with the expected rows in __tests__/pricing-table.test.tsx, which fails when
 * PLANS and this date drift apart.
 */
export const PRICES_AS_OF = "2026-10-20";

/** "20 October 2026": spelled out, UTC, the same on every server. */
export function formatPricesAsOf(iso: string = PRICES_AS_OF): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * One row of the Offer data. The Offer JSON-LD is built from these rows, and the
 * comparison table's price and size cells are read from the same plans, so the
 * markup cannot drift from what is shown.
 */
export interface PricingRow {
  key: "self-host" | HostedSize["planKey"];
  /** The Offer name. */
  option: string;
  vcpu: string;
  ram: string;
  /** Visible price with its dollar sign: "$9.99". */
  price: string;
  /** The same price as a bare amount for structured data: "9.99". */
  priceAmount: string;
  /** What the price buys, used as the Offer description. */
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
    billing: "None (you pay for your own server and your own AI usage)",
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
 * name, price, currency and billing period the page shows.
 */
export function buildPricingOffers(siteUrl: string): Array<Record<string, unknown>> {
  return PRICING_ROWS.map((row) => ({
    "@type": "Offer",
    name: row.option,
    price: row.priceAmount,
    priceCurrency: "USD",
    description: row.monthly
      ? `${row.price} a month ${row.priceFor}. ${row.refund}.`
      : "Run Hivra on your own server from the open source code. You bring the server and pay for it, and you cover your own AI usage.",
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

const ENTRY = planSizeParts("entry");
const LARGER = planSizeParts("larger");

/** The paragraphs under the headline. */
export const PRICING_INTRO = [
  "Sign up free and connect your own server, or use Hivra's open-source platform yourself. Or pay us to run the computer for you. No requirement to buy a token.",
  HOSTED_COMPUTE_NEEDS_PLAN,
  "Prices are per month, in US dollars. Your AI provider's charges are separate, whether you sign in with your own account (where the agent supports it, subject to the provider's terms) or use an API key.",
] as const;

export const PRICING_OPTIONS = {
  heading: "Choose how you want to run it",
  /** Kept from the page before the rewrite (pinned by the pricing table test): the plan is a pool, not one machine per agent. */
  // No number here: the repo's copy rules keep agent counts off the public pages (copy-rules.ts, public-claims.ts).
  pool: "Each plan is a pool of CPU and memory for your agents' computers, and each size also sets how many agents can run at once.",
  selfHost: {
    title: "Self-host Hivra",
    price: "$0",
    priceNote: "for the software",
    meta: "Your server · Your control",
    body: "Run the platform from the public source code on a server you provide and manage. You choose the infrastructure and pay its provider directly. You are also responsible for setup, updates, backups and AI usage.",
    goodFor: "Good for developers who want to operate their own deployment, customise the software or avoid depending on a managed service.",
    included: "Open-source platform, the self-host guide, control over your server.",
    notIncluded: "A server, managed maintenance, AI usage or Hivra Cloud-only agent options.",
  },
  entry: {
    title: PLAN_LABELS.entry,
    price: ENTRY.price,
    priceNote: "/month",
    meta: `${ENTRY.cpu} and ${ENTRY.memory}`,
    body: [
      "A dedicated working environment for an agent or for you, without having to provision and maintain the server yourself.",
      "Keep its files and sessions on its computer, open it through your browser and leave it running when your laptop is closed. A paid Hivra Cloud computer stays on and is not paused for inactivity.",
    ],
    goodFor: "Good for getting started, everyday agent use, research, automation and smaller software projects.",
  },
  larger: {
    title: PLAN_LABELS.larger,
    price: LARGER.price,
    priceNote: "/month",
    meta: `${LARGER.cpu} and ${LARGER.memory}`,
    body: [
      "The same managed experience with more memory and computing capacity. Pick this if you regularly run heavier development tools or need more headroom in your agent's environment.",
    ],
  },
  ownServer: {
    title: "Start free: connect your own server",
    body: "You can also connect infrastructure you pay for to Hivra, where supported. A free account is enough for that. Hivra does not run a computer for you on a free account, and your server bill stays with your own provider.",
  },
} as const;

export const PRICING_COMPARISON = {
  heading: "Compare your options",
  caption: "Self-host, Hivra Cloud and Hivra Cloud with more room, compared",
  columns: [PLAN_LABELS.selfHost, PLAN_LABELS.entry, PLAN_LABELS.larger],
  rows: [
    { label: "Hivra software", cells: ["Free", "Included", "Included"] },
    { label: "Monthly Hivra Cloud price", cells: ["$0", ENTRY.price, LARGER.price] },
    // "and", not the md's slash: copy-rules.ts reads "$19.99" only with "4 vCPU and 8 GB" in the same sentence.
    { label: "CPU and memory", cells: ["Your server", `${ENTRY.cpu} and ${ENTRY.ram}`, `${LARGER.cpu} and ${LARGER.ram}`] },
    { label: "Who operates the server?", cells: ["You", "Hivra", "Hivra"] },
    { label: "Browser access", cells: ["According to your setup", "Yes", "Yes"] },
    { label: "Remains available when your laptop closes", cells: ["If your server stays on", "Yes", "Yes"] },
    { label: "Inactivity pause on paid cloud computer", cells: ["Not applicable", "No", "No"] },
    { label: "AI provider usage included", cells: ["No", "No", "No"] },
    { label: MONEY_BACK_GUARANTEE, cells: ["Not applicable", "Yes", "Yes"] },
  ],
} as const;

export const PRICING_PAYING = {
  heading: "What you're paying for",
  lede: "You're paying for the computer and the managed environment, not for a new AI subscription.",
  body: [
    "Your Hivra computer provides the place where the agent runs. The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. Where you use your own account or key, the provider's own rates and terms govern that usage.",
    "A paid Hivra Cloud computer doesn't stop merely because you close your browser. That doesn't mean every agent task will continue automatically: a command or process must itself be set up to keep running, and external services can still fail or time out.",
  ],
} as const;

export const PRICING_AGENTS = {
  heading: "Important differences between agents",
  intro: "What you can run depends on where it runs:",
  items: [
    { name: "On Hivra Cloud:", text: "Every Hivra Cloud computer needs a paid plan, whichever agent you run on it. Hermes runs on Hivra Cloud only." },
    { name: "On your own computer or server:", text: FREE_ACCOUNT_SENTENCE },
    { name: "Claude Code and Codex:", text: "Support signing in with your own provider account, subject to the provider's terms." },
    {
      name: "Other supported agents:",
      text: "Check their individual setup pages for any account, key or deployment requirements.",
      link: { text: "individual setup pages", href: "/agents" },
    },
  ],
  outro: "If you only need an ordinary computer, you can launch a supported operating-system environment without installing an agent.",
} as const;

export const PRICING_REFUNDS = {
  heading: "Refunds and billing",
  guarantee: {
    before: "Hivra Cloud comes with a ",
    bold: MONEY_BACK_GUARANTEE,
    after: ". The full conditions are in the ",
    link: { text: "terms", href: "/terms" },
    end: ".",
  },
  body: [
    "Prices are per month. Your own server and any separate AI-provider charges are not part of a Hivra Cloud refund. If you're using your own infrastructure, its provider sets the terms for those charges.",
    "Larger cloud sizes are planned, but we won't list them here as if they're available until you can actually choose them.",
  ],
} as const;

export const PRICING_CLOSING = {
  heading: "Ready to give it a computer?",
  body: "Start small, see how your agent works in its own environment, and increase resources when you actually need them.",
} as const;

export interface PricingFaqLink {
  /** The words in `a` that become the link. They must appear in `a` exactly once. */
  text: string;
  href: string;
}

export interface PricingFaqItem {
  q: string;
  /** The answer as plain text: it is what the FAQPage JSON-LD carries and what the page shows. */
  a: string;
  /** Words inside `a` shown as links. They never change the text. */
  links?: PricingFaqLink[];
  /** Mentions the token: shown, and put in the FAQPage JSON-LD, only while the token surfaces are visible. */
  tokenOnly?: boolean;
}

export const PRICING_FAQ_HEADING = "Questions people usually ask";

export const PRICING_FAQ: PricingFaqItem[] = [
  {
    q: "Is Hivra free?",
    a: `The open-source platform is free to self-host, and a free Hivra account works with a computer or server you connect yourself. That doesn't make the physical or cloud server free, and your AI usage still has a cost. A computer that Hivra runs for you is paid, from ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}.`,
  },
  {
    q: "Does Hivra run a free computer for me?",
    a: "No. Every computer that Hivra Cloud runs for you needs a paid plan. A free account works with a computer or server that you connect yourself, and you can self-host the open-source platform at no software cost.",
  },
  {
    q: "Do I have to pay for an AI model as well?",
    a: "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. Depending on the provider and your account, your own account or key may mean a subscription, usage-based billing or both. Hivra's advertised prices don't include those external charges.",
  },
  {
    q: "Can I use the Claude or ChatGPT subscription I already have?",
    a: "Supported login flows are available for Claude Code and Codex. Whether a particular subscription supports the use you intend is governed by that provider's terms.",
  },
  {
    q: "Will Hivra turn my computer off when I'm not using it?",
    a: "A paid Hivra Cloud computer stays on and is not paused for inactivity. It is stopped if the plan behind it stops being paid. If you start a long-running process, configure it appropriately so it survives the closure of a terminal or session.",
  },
  {
    q: "What happens if I stop paying?",
    // The same behaviour and the same Hermes exception the terms state (app/terms/page.tsx, "Failed Payments and Cancellation" and
    // "Hermes Agents"). The hours are the billing constant. The link goes on the first "terms", in the Hermes clause.
    a: `Except for Hermes agents, which follow an older process set out in the terms, a computer that Hivra Cloud runs for you runs only while its plan is paid. If a card payment fails, we retry the card and keep the computer running for up to ${PAYMENT_GRACE_HOURS} hours after the first failed payment. If it is still unpaid then, or when a cancelled plan ends, we stop the computer. A stopped computer keeps its files for a limited time, so you can start it again once you have a paid plan.`,
    links: [{ text: "terms", href: "/terms" }],
  },
  {
    q: "How do I access my computer?",
    a: "Open it through a supported browser interface. You can check the desktop or terminal, as available for the particular computer, without needing to be at the laptop where you launched it.",
  },
  {
    q: "Can I switch to self-hosting later?",
    // "an automatic migration", not the md's "one-click migration": copy-rules.ts bans "one-click" as an unmeasured speed claim.
    a: "Hivra's platform code is open source. Moving a specific computer, its files and account connections between environments may require manual work and isn't a promise of an automatic migration.",
  },
  {
    q: "Do I need to buy $HIVRA?",
    a: "No. Self-hosting and card-paid cloud access do not require it. See the token information if you want to understand the separate token ecosystem.",
    links: [{ text: "token information", href: "/token" }],
    tokenOnly: true,
  },
  {
    q: "Do I need an agent at all?",
    a: "No. Hivra also lets you start a supported computer for ordinary work. Choose an agent only if you want one.",
  },
  {
    q: "What if I'm not happy with Hivra Cloud?",
    a: `Check the terms for the ${MONEY_BACK_GUARANTEE}. You can also contact ${PRICING_SUPPORT_EMAIL} for support.`,
    links: [
      { text: "terms", href: "/terms" },
      { text: PRICING_SUPPORT_EMAIL, href: `mailto:${PRICING_SUPPORT_EMAIL}` },
    ],
  },
];

/** The questions to show (and to put in FAQPage JSON-LD) for a viewer who may or may not see token copy. */
export function visiblePricingFaq(tokenSurfacesVisible: boolean): PricingFaqItem[] {
  return PRICING_FAQ.filter((item) => tokenSurfacesVisible || !item.tokenOnly);
}
