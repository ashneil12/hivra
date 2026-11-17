/**
 * Competitor prices and terms quoted on /compare, each read from the vendor's
 * own pages and cross-checked by a second pass. COMPETITOR_FACTS_CHECKED is the
 * day of the latest re-read, not a claim that every vendor was read that day:
 * the refresh notes below say which vendors were read on which day.
 * Pages and the shared price table both read from here, so a vendor change is a
 * one-file edit plus a new date. Anything a vendor does not publish is left out
 * rather than guessed; see `notPublished` for what was looked for and not found.
 *
 * Refresh rule: re-read the sources below before changing a number, then bump
 * the date. The monthly SEO routine flags this file when the date is 90 days old.
 *
 * 2026-11-17 refresh. Re-read on the vendors' own pages that day: Hostinger (managed plan APP 1 is
 * $4.99 for 24 months as a Black Friday sale, 1 vCPU, 4 GB, 25 GB NVMe, and renews at $9.99, not
 * $11.99; KVM 2 $8.79 renewing at $14.99 is confirmed on hostinger.com/vps-hosting, which is now the
 * KVM source because hostinger.com/vps/docker/openclaw shows the managed plans), xCloud (the 4 vCPU,
 * 6 GB, 100 GB plan is $24.99 with no promotion, no $19.99 renewal and no beta label on
 * xcloud.host/openclaw-hosting or /pricing), Agent 37 (pricing, personal, terms, docs and privacy pages
 * re-read; $4.76 is on agent37.com/pricing for 2 vCPU, 4 GB with 4 GB disk, per 730 running hours.
 * $9.34 for 4 vCPU, 8 GB is NOT published there: it is our arithmetic from the rate card, 4*0.80 +
 * 8*0.70 + 6 GB*0.09, with a 6 GB disk we assumed. The trust centre was not re-read) and Nous (portal.nousresearch.com and /cloud: still no per-size prices, so the per-size
 * figures stay the last published; monthly plans at $20, $100 and $200 are listed, and the deploy
 * minimum reads "$2 in credits, or an active subscription").
 * Railway was also re-read on its own pages that day (plans doc rates $10/GB RAM, $20/vCPU, $0.15/GB
 * volume, $0.05/GB egress; Hobby $5 and Pro $20 credited minimums; Free VM 2 vCPU/2 GB with a 24 hour
 * claim window).
 * Hetzner (CX23 from EUR 5.99 excl. VAT, 2 vCPU, 4 GB, 40 GB, shown unavailable, and Hetzner says
 * the number of cost-optimized servers is limited) and DigitalOcean (Droplet $24 for 2 vCPU, 4 GiB)
 * were re-read on 2026-11-17 and match. Cloudways Managed AI Agents: Scout $9.99 (1 vCPU, 2 GB, 50 GB),
 * Operator $19.99 (2 vCPU, 4 GB, 80 GB), Squad $39.99 (4 vCPU, 8 GB, 160 GB); the Black Friday code
 * BFCM802 is 80 percent off the first 2 months, with the end date shown as both December 4 and December 6.
 * Not re-read by us on that day, last matched in the 2026-10-20 claim audit: Render,
 * Fly Sprites, E2B, Orgo (read only in part) and Cloudways.
 *
 * 2026-10-21 refresh. Re-read on the vendors' own pages that day: Hostinger (managed plan $4.99,
 * KVM 2 $8.79, renewals unchanged; hostinger.com/managed-hermes-agent and
 * hostinger.com/vps/docker/openclaw), Agent 37 (plans now run to $99.99 for teams; SOC 2 Type I
 * stated, Type II in progress, and its trust centre lists SOC 2 as in progress;
 * agent37.com/personal and trust.agent37.com), xCloud (xcloud.host/pricing, /openclaw-hosting,
 * /paperclip-hosting, the OpenClaw deploy docs and the refund policy: figures, beta label and
 * refund terms unchanged, and Paperclip hosting is sold on the same sizes) and the Nous $2
 * minimum credit (portal.nousresearch.com/cloud). Nous no longer shows per-size prices without a
 * Portal sign-in, so its per-size figures are the last published ones, not read on the check
 * date, and every place that quotes them says so.
 * Not re-read on that day, last matched against the vendors' pages in the 2026-10-20 claim
 * audit: Render, Hetzner, DigitalOcean, Fly Sprites, E2B, Orgo and Cloudways.
 */
export const COMPETITOR_FACTS_CHECKED = "2026-11-17";

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
      { label: "Agent 37 privacy policy", href: "https://agent37.com/privacy" },
      { label: "Agent 37 trust centre", href: "https://trust.agent37.com" },
    ],
    keyFigures: ["$4.76", "$9.34", "$3.99", "$29.99", "$99.99", "30 days asleep"],
    notPublished: [
      "hosting regions or data centre locations",
      "the infrastructure provider for instances",
      "a published SOC 2 report (Type I and a readiness report are on request under an NDA)",
      "a minimum top-up amount or credit expiry",
      "terms for the sandbox 'refund the difference' headline",
      "how long a paused instance's data is kept when the balance runs out (the terms say only that instances may be paused until you top up)",
      "an Agent 37 total for a 4 vCPU, 8 GB shape (the $9.34 on the page is our arithmetic)",
    ],
  },
  "vs-hostinger": {
    slug: "vs-hostinger",
    name: "Hostinger",
    sources: [
      { label: "Hostinger managed Hermes Agent", href: "https://www.hostinger.com/managed-hermes-agent" },
      { label: "Hostinger OpenClaw hosting", href: "https://www.hostinger.com/vps/openclaw-hosting" },
      { label: "Hostinger VPS hosting (KVM plans)", href: "https://www.hostinger.com/vps-hosting" },
      { label: "Hostinger refund policy", href: "https://www.hostinger.com/legal/refund-policy" },
    ],
    keyFigures: ["$4.99", "$9.99", "$8.79", "$119.76"],
    notPublished: [
      "the amount of bundled AI credit",
      "a monthly billing option on the managed plan page",
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
      { label: "xCloud Paperclip hosting", href: "https://xcloud.host/paperclip-hosting/" },
      { label: "xCloud refund policy", href: "https://xcloud.host/docs/refund-policy/" },
      { label: "xCloud OpenClaw deploy guide", href: "https://xcloud.host/docs/how-to-deploy-openclaw-with-xcloud/" },
    ],
    keyFigures: ["$24.99", "100 GB", "4 vCPU", "10%"],
    notPublished: [
      "a promotional or renewal price for agent hosting",
      "the 12- and 24-month discounted prices",
      "price and specs for the 24 GB and larger sizes",
    ],
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
    keyFigures: ["$20", "$100", "$200", "$2 of credit"],
    notPublished: [
      "per-size instance prices without a Portal sign-in",
      "disk size per pay-as-you-go instance (plan tiers state 25 GB and 100 GB)",
      "how unspent prepaid credit is refunded",
    ],
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
 * Cloudways is left out on purpose: its listed prices sit under an 80 percent Black Friday
 * code (BFCM802, first 2 months) whose end date the page gives as both December 4 and December 6 (2026-11-17).
 */
export const PRICE_TABLE: PriceRow[] = [
  {
    provider: "Agent 37 metered Cloud API",
    price: "$4.76/mo for 2 vCPU and 4 GB RAM, always awake",
    terms: "A 730-hour estimate that includes 4 GB of persistent disk ($0.36 of it). Prepaid balance, billed per minute, so a mostly idle agent costs less; a sleeping instance still pays for its disk. Top-ups are non-refundable.",
    source: COMPETITOR_FACTS["vs-agent-37"].sources[0],
  },
  {
    provider: "Hostinger managed AI apps",
    price: "$4.99/mo for 1 vCPU, 4 GB RAM and 25 GB NVMe (APP 1)",
    terms: "Paid upfront for 24 months ($119.76, as Hostinger's page shows). Shown as a Black Friday sale price. Renews at $9.99/mo. Bundled AI credit amount not published.",
    source: COMPETITOR_FACTS["vs-hostinger"].sources[0],
  },
  {
    provider: "Hostinger KVM 2 VPS",
    price: "$8.79/mo for 2 vCPU and 8 GB RAM, self-managed",
    terms: "24-month term paid upfront, shown as a sale price. Renews at $14.99/mo. You run the updates and security. Weekly backups are listed on the plan.",
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
    // Not "Medium": Nous shows its sizes only after sign-in and a rival's blog names its tiers differently,
    // so the tier name cannot be confirmed (audit 2026-10-20). /compare/vs-nous-hermes-cloud does not use it either.
    // The figures are the last ones Nous published; its page no longer shows per-size prices (re-checked 2026-11-17).
    provider: "Nous Hermes Cloud",
    price: "Last published: $0.56/day running for 4 vCPU and 2 GB RAM, about $16.80 over 30 days",
    terms: "Prepaid Nous credit, charged daily in arrears. Stopped costs $0.03/day. Model usage is extra. Hermes only. The linked page no longer lists per-size prices: Nous now shows them only after you sign in to its Portal. Nous also lists monthly plans at $20, $100 and $200, which this row does not price.",
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
  {
    provider: "xCloud AI agent VPS",
    price: "$24.99/mo for 4 vCPU, 6 GB RAM and 100 GB NVMe",
    terms: "Monthly, or 12- or 24-month billing at a discount whose amount is not published. No promotional or renewal price is shown. Cancelling charges the used days plus up to a 10% fee.",
    source: COMPETITOR_FACTS["vs-xcloud"].sources[0],
  },
];
