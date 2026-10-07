/**
 * Competitor prices and terms quoted on /compare, each read from the vendor's
 * own pages on COMPETITOR_FACTS_CHECKED and cross-checked by a second pass.
 * Pages and the shared price table both read from here, so a vendor change is a
 * one-file edit plus a new date. Anything a vendor does not publish is left out
 * rather than guessed; see `notPublished` for what was looked for and not found.
 *
 * Refresh rule: re-read the sources below before changing a number, then bump
 * the date. The monthly SEO routine flags this file when the date is 90 days old.
 */
export const COMPETITOR_FACTS_CHECKED = "2026-10-02";

/**
 * "October 2026", for reader-facing freshness stamps ("Prices as of October 2026").
 * Ash's voice rule (2026-10-06): say it like a person, no "read on <date>" parentheticals and no day in reader copy.
 * The exact day stays in COMPETITOR_FACTS_CHECKED, the sitemap lastmod and <time dateTime>.
 */
export function formatCheckedMonth(iso: string = COMPETITOR_FACTS_CHECKED): string {
  const [year, month] = iso.split("-").map(Number);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[month - 1]} ${year}`;
}

export type CompetitorSlug = "vs-agent-37" | "vs-hostinger" | "vs-xcloud" | "vs-nous-hermes-cloud";

export type CompetitorFacts = {
  slug: CompetitorSlug;
  name: string;
  /** Vendor pages the facts were read from. */
  sources: Array<{ label: string; href: string }>;
  /** Numbers that must appear on the comparison page, so copy cannot drift from this file. */
  keyFigures: string[];
  /** Looked for on the vendor's pages on the check date and not found. */
  notPublished: string[];
};

export const COMPETITOR_FACTS: Record<CompetitorSlug, CompetitorFacts> = {
  "vs-agent-37": {
    slug: "vs-agent-37",
    name: "Agent 37",
    sources: [
      { label: "Agent 37 pricing", href: "https://agent37.com/pricing" },
      { label: "Agent 37 managed plans", href: "https://agent37.com/personal" },
      { label: "Agent 37 terms", href: "https://agent37.com/terms" },
      { label: "Agent 37 docs", href: "https://agent37.com/docs" },
    ],
    keyFigures: ["$4.76", "$9.34", "$3.99", "$29.99", "30 days asleep"],
    notPublished: ["hosting regions or data centre locations"],
  },
  "vs-hostinger": {
    slug: "vs-hostinger",
    name: "Hostinger",
    sources: [
      { label: "Hostinger managed Hermes Agent", href: "https://www.hostinger.com/managed-hermes-agent" },
      { label: "Hostinger OpenClaw hosting", href: "https://www.hostinger.com/vps/openclaw-hosting" },
      { label: "Hostinger VPS plans for agents", href: "https://www.hostinger.com/vps/docker/openclaw" },
      { label: "Hostinger refund policy", href: "https://www.hostinger.com/legal/refund-policy" },
    ],
    keyFigures: ["$5.99", "$11.99", "$8.99", "$143.76"],
    notPublished: [
      "vCPU, RAM or disk for the managed plan",
      "the amount of bundled AI credit",
      "whether the refund policy covers managed agent plans",
    ],
  },
  "vs-xcloud": {
    slug: "vs-xcloud",
    name: "xCloud",
    sources: [
      { label: "xCloud pricing", href: "https://xcloud.host/pricing/" },
      { label: "xCloud OpenClaw hosting", href: "https://xcloud.host/openclaw-hosting/" },
      { label: "xCloud Hermes Agent hosting", href: "https://xcloud.host/hermes-agent-hosting/" },
      { label: "xCloud refund policy", href: "https://xcloud.host/docs/refund-policy/" },
    ],
    keyFigures: ["$9.99", "100 GB", "4 vCPU", "10%"],
    notPublished: ["how long the promotional price lasts", "a per-size agent cap"],
  },
  "vs-nous-hermes-cloud": {
    slug: "vs-nous-hermes-cloud",
    name: "Nous Hermes Cloud",
    sources: [
      { label: "Nous Hermes Cloud", href: "https://portal.nousresearch.com/cloud" },
      { label: "Nous Portal terms", href: "https://portal.nousresearch.com/terms" },
      { label: "Hermes Agent docs", href: "https://hermes-agent.nousresearch.com/docs/" },
      { label: "Hermes Agent on GitHub", href: "https://github.com/NousResearch/hermes-agent" },
    ],
    keyFigures: ["$0.56", "$1.09", "$0.03", "$16.80", "$2"],
    notPublished: ["disk size per instance", "how unspent prepaid credit is refunded"],
  },
};

export type PriceRow = {
  provider: string;
  /** The price with the size it buys, in one cell so the size never gets separated from the number. */
  price: string;
  /** Billing term, renewal and what the price leaves out. */
  terms: string;
  /** Where the number was read. */
  source: { label: string; href: string };
  hivra?: boolean;
};

/**
 * One dated table for /compare. Sizes differ between providers, so every row
 * states its own; rows are ordered by monthly cost for an always-on agent.
 * Cloudways is left out on purpose: its listed prices are a 50 percent intro
 * discount and its page does not say when standard pricing starts (2026-10-02).
 */
export const PRICE_TABLE: PriceRow[] = [
  {
    provider: "Agent 37 metered Cloud API",
    price: "$4.76/mo for 2 vCPU and 4 GB RAM, always awake",
    terms: "Prepaid balance, billed per minute, so a mostly idle agent costs less. Top-ups are non-refundable.",
    source: COMPETITOR_FACTS["vs-agent-37"].sources[0],
  },
  {
    provider: "Hostinger managed AI apps",
    price: "$5.99/mo, size not published",
    terms: "Paid upfront for 24 months ($143.76, our arithmetic). Renews at $11.99/mo. Bundled AI credit amount not published.",
    source: COMPETITOR_FACTS["vs-hostinger"].sources[0],
  },
  {
    provider: "Hostinger KVM 2 VPS",
    price: "$8.99/mo for 2 vCPU and 8 GB RAM, self-managed",
    terms: "24-month term paid upfront. Renews at $14.99/mo. You run the updates and backups.",
    source: COMPETITOR_FACTS["vs-hostinger"].sources[2],
  },
  {
    provider: "Hivra",
    price: "$9.99/mo for 2 vCPU and 4 GB RAM",
    terms: "Monthly. 7-day money-back guarantee on card payments. Compute is shared by the agent computers on one account.",
    source: { label: "Hivra pricing", href: "/pricing" },
    hivra: true,
  },
  {
    provider: "xCloud AI agent VPS",
    price: "$9.99/mo promotional for 4 vCPU and 6 GB RAM",
    terms: "Monthly. Renews at $19.99/mo for that 4 vCPU size; the page does not say how long the promotion lasts.",
    source: COMPETITOR_FACTS["vs-xcloud"].sources[0],
  },
  {
    provider: "Nous Hermes Cloud Medium",
    price: "$0.56/day running for 4 vCPU and 2 GB RAM, about $16.80 over 30 days",
    terms: "Prepaid Nous credit, charged daily in arrears. Stopped costs $0.03/day. Model usage is extra. Hermes only.",
    source: COMPETITOR_FACTS["vs-nous-hermes-cloud"].sources[0],
  },
  {
    provider: "Hivra",
    price: "$19.99/mo for 4 vCPU and 8 GB RAM",
    terms: "Monthly. 7-day money-back guarantee on card payments. Compute is shared by the agent computers on one account.",
    source: { label: "Hivra pricing", href: "/pricing" },
    hivra: true,
  },
  {
    provider: "DigitalOcean Droplet",
    price: "$24/mo for 2 vCPU and 4 GB RAM, self-managed",
    terms: "Billed per second up to the monthly price. You run the server, updates and backups.",
    source: { label: "DigitalOcean Droplet pricing", href: "https://www.digitalocean.com/pricing/droplets" },
  },
];
