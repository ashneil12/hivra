import type { ComparePage } from "./types";
import { COMPETITOR_FACTS, type CompetitorSlug } from "./competitor-facts";
import {
  AI_ACCESS_CELL,
  AI_USAGE,
  CLOSING,
  DECISION_SECTION,
  ENTRY_PRICE_PROSE,
  HIVRA_AGENTS_CELL,
  REFUND_LINKED,
  PRICES_AS_OF_STAMP,
  cautionSection,
  paragraphs,
  priceSources,
  relatedLinks,
} from "./shared-copy";

/**
 * Comparison pages against the four hosts people search for by name. Every
 * competitor number here is in competitor-facts.ts with its source and check
 * date; a test keeps the two in step. Each page says where the other host is
 * the better choice, because a comparison that only flatters us is not one a
 * reader or an answer engine will trust.
 *
 * The wording is the October 2026 copy (scratchpad batches/b04, files 04, 05, 06
 * and 10), with these corrections that the claim audit of 2026-10-20 required:
 * nothing is stated as fact that a vendor's own pages contradict or no longer show,
 * and no line talks about "the source". Where a figure here is behind the vendor's
 * live page (Hostinger's sale prices for the managed plan and KVM 2, Nous Portal prices) the copy says so.
 * Refreshed 2026-10-21: Hostinger $4.99 and $8.79, Agent 37 plans up to $99.99, Nous prices called the last published,
 * and Paperclip added to xCloud's agents (xcloud.host/paperclip-hosting/).
 *
 * Copy rules that matter here: Hivra sizes are always stated as price plus size
 * ($9.99 is 2 vCPU and 4 GB, $19.99 is 4 vCPU and 8 GB); the guarantee is
 * 7 days on card payments only; no trial, no timing claims, no backup promise.
 */

const sourcesFor = (slug: CompetitorSlug) => COMPETITOR_FACTS[slug].sources;

export const HOST_COMPARISONS: Record<CompetitorSlug, ComparePage> = {
  "vs-agent-37": {
    slug: "vs-agent-37",
    browserTitle: "Agent 37 vs Hivra: a meter or a monthly computer? | Hivra",
    h1: "Agent 37 vs Hivra: a meter or a monthly computer?",
    metaDescription: `Hivra is ${ENTRY_PRICE_PROSE}. Agent 37 meters the same size at $4.76 a month, always on. Where each wins. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "Agent 37 and Hivra can both keep an agent available without a laptop running at home, but they approach the bill differently. Agent 37 focuses on inexpensive metered compute and advertises a free tier. Hivra offers a fixed monthly computer designed around supported agent deployments.",
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          "A meter is attractive when usage is genuinely intermittent. For an agent that wakes only occasionally, paying for its active compute time may beat a subscription. For an agent with frequent scheduled tasks and a persistent working environment, you need to examine what is billed while it waits, sleeps or restarts.",
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          `Hivra starts at ${ENTRY_PRICE_PROSE}, excluding model usage. Agent 37's raw compute is cheaper. Its site states SOC 2 Type I, with Type II in progress, and its trust centre lists SOC 2 as in progress, so ask for the report before you rely on it. Vendor assurance like that is a meaningful consideration for customers who need it; do not pretend that open-source code is equivalent to an external audit.`,
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Choose based on your usage pattern and assurance needs. A monthly price helps with budgeting; a meter helps when the machine is mostly idle. Neither makes unsafe agent permissions safe.",
        ),
      },
      DECISION_SECTION,
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and Agent 37 compared",
            rows: [
              { criterion: "Always-on 2 vCPU, 4 GB", hivra: "$9.99/mo flat", alternative: "$4.76/mo metered, prepaid balance" },
              { criterion: "Always-on 4 vCPU, 8 GB", hivra: "$19.99/mo flat for 4 vCPU and 8 GB", alternative: "$9.34/mo metered, prepaid balance" },
              { criterion: "Billing model", hivra: "Fixed monthly price", alternative: "Per minute from a balance; auto top-up on by default after the first top-up" },
              { criterion: "Free hosting", hivra: "None. A free account works with your own computer", alternative: "One managed agent at $0; sleeps when idle" },
              { criterion: "Agents hosted", hivra: HIVRA_AGENTS_CELL, alternative: "Hermes, OpenClaw, Claude Code, Codex, OpenCode, Grok, Pi, custom image" },
              { criterion: "Built for products with an agent per customer", hivra: "No", alternative: "Yes, API-first with a white-label starter dashboard" },
              { criterion: "Refund", hivra: REFUND_LINKED, alternative: "First month of a subscription; top-ups non-refundable" },
              { criterion: "Open source and self-host", hivra: "Yes", alternative: "No platform release found" },
              { criterion: "Security attestation", hivra: "None claimed", alternative: "Says SOC 2 Type I, Type II in progress; its trust centre lists SOC 2 as in progress, so ask for the report" },
            ],
          },
        ],
      },
      cautionSection(),
    ],
    sources: priceSources(sourcesFor("vs-agent-37"), [
      "Also on Agent 37's pages: flat managed plans from $3.99 a month (1 vCPU and 4 GB of RAM), through $29.99 a month (2 vCPU and 8 GB of RAM), to $99.99 a month for teams (4 vCPU and 16 GB of RAM), and a free managed agent that sleeps when idle and is removed after 30 days asleep.",
    ]),
    faqs: [
      {
        q: "Is Agent 37 always cheaper?",
        a: "On raw compute, yes: an always-on 2 vCPU, 4 GB shape is $4.76 a month on Agent 37's metered Cloud API, against Hivra's $9.99. That price assumes a funded balance and leaves out model usage. Metered compute can be a better deal for infrequent work, but a persistently active workload needs a full-month calculation.",
      },
      {
        q: "Does Hivra include AI inference in the monthly fee?",
        a: `No. ${AI_USAGE}`,
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-hostinger", "vs-xcloud", "ai-agent-hosting-alternatives"],
      blog: ["cost-of-running-ai-agent"],
    }),
  },

  "vs-hostinger": {
    slug: "vs-hostinger",
    browserTitle: "Hostinger vs Hivra: prepaid savings or managed agent computers | Hivra",
    h1: "Hostinger vs Hivra: prepaid savings or managed agent computers",
    metaDescription: `Hostinger's prepaid 24-month sale price against Hivra at ${ENTRY_PRICE_PROSE}, and when its VPS wins. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "Hostinger can be the cheaper way to keep a server running, especially when you accept a long prepaid term. Hivra is for people who would rather buy a ready-to-use agent environment one month at a time than manage a general hosting product.",
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          "Hostinger's managed-agent promotion is $4.99 a month on a 24-month commitment, renewing at $11.99. That headline price is not a rolling monthly subscription, and its managed plan does not publish the same hardware detail as a conventional VPS. Compare the full term and renewal rather than multiplying the promotional number by twelve. Hostinger shows both the managed plan and the KVM 2 VPS at sale prices, so confirm the current figures before you compare.",
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          `A Hostinger VPS gives you broader operating-system control. You can install whichever services you like, but you also configure and maintain them. Hivra's entry computer is listed at ${ENTRY_PRICE_PROSE}, with supported agent deployment handled through its own interface.`,
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "If you know Linux, plan to stay for two years and value root access, Hostinger can be a very sensible choice. If your priority is a simpler agent-specific experience without a multi-year commitment, Hivra may save the effort.",
        ),
      },
      DECISION_SECTION,
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and Hostinger compared",
            rows: [
              { criterion: "Entry price", hivra: "$9.99/mo monthly, 2 vCPU and 4 GB RAM", alternative: "$4.99/mo on a 24-month prepaid term, size not published" },
              { criterion: "Commitment", hivra: "Monthly", alternative: "Paid upfront for the term ($119.76 for 24 months, our arithmetic)" },
              { criterion: "Renewal", hivra: "The listed monthly price", alternative: "$11.99/mo on the managed plan" },
              { criterion: "Published hardware", hivra: "Stated for every size", alternative: "Not published for the managed plan" },
              { criterion: "VPS alternative", hivra: "No root or SSH access", alternative: "KVM 2 at $8.79/mo: 2 vCPU, 8 GB, root access" },
              { criterion: "Agents", hivra: HIVRA_AGENTS_CELL, alternative: "Hermes, OpenClaw, n8n, Paperclip" },
              { criterion: "Refund window", hivra: REFUND_LINKED, alternative: "30 days, with VPS conditions" },
              { criterion: "Open source platform", hivra: "Yes", alternative: "No open-source release found" },
            ],
          },
        ],
      },
      cautionSection(),
    ],
    sources: priceSources(sourcesFor("vs-hostinger")),
    faqs: [
      {
        q: "Why does the Hostinger headline price look lower?",
        a: "The promotion assumes a longer prepaid term. Check renewal pricing, the upfront total and the exact product tier.",
      },
      {
        q: "Can I host other things on a Hostinger VPS?",
        a: "Yes, with the relevant server access. That flexibility is a reason to choose general VPS hosting.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-agent-37", "vs-xcloud", "vs-self-hosted"],
      blog: ["self-hosting-hermes-guide"],
    }),
  },

  "vs-xcloud": {
    slug: "vs-xcloud",
    browserTitle: "xCloud vs Hivra: look beyond the promotional hardware | Hivra",
    h1: "xCloud vs Hivra: look beyond the promotional hardware",
    metaDescription: `xCloud's $9.99 promotion is 4 vCPU and 6 GB of RAM; Hivra is ${ENTRY_PRICE_PROSE}. Renewal and beta terms. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "xCloud's advertised promotional configuration provides more CPU and memory for the headline price than Hivra's entry plan. That is worth acknowledging rather than hiding. The more useful question is what the price becomes later, what work you must do yourself and which agent integrations are ready for production.",
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          "xCloud lists 4 vCPU and 6 GB RAM for $9.99 on promotion, while Hivra lists 2 vCPU and 4 GB of RAM at $9.99 a month. Those are not equivalent machines. Confirm xCloud's renewal rate and promotional conditions before using the headline as a long-term comparison.",
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          "xCloud's documentation labels its OpenClaw hosting as beta, with limited support. That can be fine for testing, but someone depending on an agent every day should look carefully at support, updates, data persistence and the refund process.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Choose xCloud if its larger promotional server fits your actual requirements and you are comfortable with its workflow. Choose Hivra if its agent-specific dashboard, supported runtimes and monthly billing are more valuable to you than raw memory per dollar.",
        ),
      },
      DECISION_SECTION,
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and xCloud compared",
            rows: [
              { criterion: "Entry price", hivra: "$9.99/mo for 2 vCPU and 4 GB RAM", alternative: "$9.99/mo promotional for 4 vCPU and 6 GB RAM" },
              { criterion: "After the promotion", hivra: "The listed monthly price; no promotional rate is shown", alternative: "Renews at $19.99/mo for that 4 vCPU server; length not stated" },
              { criterion: "OpenClaw hosting status", hivra: "Available on Hivra Cloud", alternative: "Beta with limited support in its docs" },
              { criterion: "Agents", hivra: HIVRA_AGENTS_CELL, alternative: "OpenClaw, Hermes Agent, DeepSeek Harness, Paperclip" },
              { criterion: "Models", hivra: AI_ACCESS_CELL, alternative: "Your own key only" },
              { criterion: "Refund", hivra: REFUND_LINKED, alternative: "Pro-rated unused value, minus used days and up to 10% fee, by request" },
              { criterion: "Server locations", hivra: "Not published", alternative: "30+ stated" },
            ],
          },
        ],
      },
      cautionSection(),
    ],
    sources: priceSources(sourcesFor("vs-xcloud"), [
      "The $9.99 promotional server also lists 100 GB of NVMe storage and 30 TB of bandwidth.",
    ]),
    faqs: [
      {
        q: "Is xCloud stronger on hardware?",
        a: "xCloud's promotional configuration lists more CPU and RAM at the same headline price. Renewal and support terms need checking.",
      },
      {
        q: "Does more RAM automatically make a better agent?",
        a: "No. Framework compatibility, task reliability, storage, model quality and permissions matter too.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-hostinger", "vs-agent-37", "ai-agent-hosting-alternatives"],
      blog: ["cost-of-running-ai-agent"],
    }),
  },

  "vs-nous-hermes-cloud": {
    slug: "vs-nous-hermes-cloud",
    // The supplied title is 76 characters with the brand; the rule for finished titles is 70
    // (62 before the " | Hivra" the template used to add), so "the" and "a" are left out.
    browserTitle: "Nous Hermes Cloud vs Hivra: official cloud or multi-agent home | Hivra",
    h1: "Nous Hermes Cloud vs Hivra: the official cloud or a multi-agent home",
    metaDescription: `Nous Hermes Cloud meters Hermes by the second; Hivra is ${ENTRY_PRICE_PROSE}. Not affiliated with Nous. ${PRICES_AS_OF_STAMP}`,
    sections: [
      {
        heading: "The real choice",
        tone: "lede",
        blocks: paragraphs(
          "There is an obvious reason to consider Nous Hermes Cloud: it comes from the team behind Hermes itself. Hivra is not affiliated with Nous Research. It is an independent hosting option for Hermes and other supported agents.",
        ),
      },
      {
        heading: "What you are actually paying for",
        blocks: paragraphs(
          "The main decision is how frequently the agent runs. Nous Hermes Cloud is metered by the second. Our estimate is roughly $16.80 for thirty days of continuous runtime on its 4 vCPU and 2 GB instance, excluding model usage, but that estimate depends on the exact machine, idle policy and current rates. Nous now shows sizes and prices only after you sign in to its Portal, so treat the figures on this page as the last published ones and confirm them there.",
        ),
      },
      {
        heading: "Where Hivra fits",
        blocks: paragraphs(
          "Hivra's hosted computer starts at $9.99 a month for 2 vCPU and 4 GB of RAM, and gives you a route to other agents such as Claude Code and Codex under the same platform. If you only run Hermes in occasional short sessions, a usage meter may be more economical than a full month of hosting.",
        ),
      },
      {
        heading: "When the alternative is worth choosing",
        tone: "callout",
        blocks: paragraphs(
          "Use Nous if its native tooling and usage-based model match your work. Use Hivra if you want a predictable monthly machine, or you expect to run different agent frameworks on separate computers over time.",
        ),
      },
      DECISION_SECTION,
      {
        heading: "At a glance",
        blocks: [
          {
            kind: "glance",
            caption: "Hivra and Nous Hermes Cloud compared",
            rows: [
              { criterion: "Always-on cost, smaller size", hivra: "$9.99/mo for 2 vCPU and 4 GB RAM", alternative: "About $16.80 over 30 days at its last published rate for 4 vCPU and 2 GB RAM, plus model usage" },
              { criterion: "Used a few hours a week", hivra: "Same flat price", alternative: "Stop it and, at its last published rate, pay about $0.90 a month for storage" },
              { criterion: "Billing", hivra: "Monthly", alternative: "Prepaid credit, charged daily in arrears" },
              { criterion: "Agents", hivra: HIVRA_AGENTS_CELL, alternative: "Hermes Agent only" },
              { criterion: "Hermes version", hivra: "Hivra's maintained image", alternative: "First-party from Nous" },
              { criterion: "Larger size", hivra: "4 vCPU and 8 GB RAM at $19.99/mo", alternative: "8 vCPU and 4 GB RAM at $1.09/day, as last published" },
              { criterion: "Refund", hivra: REFUND_LINKED, alternative: "All fees non-refundable per its terms" },
              { criterion: "Regions", hivra: "Not published", alternative: "14 cities listed" },
            ],
          },
        ],
      },
      cautionSection(),
    ],
    sources: priceSources(sourcesFor("vs-nous-hermes-cloud"), [
      "Nous Hermes Cloud's last published price for its 4 vCPU and 2 GB instance was $0.56 a day running and $0.03 a day stopped, and its page asks for at least $2 of credit to deploy.",
    ]),
    faqs: [
      {
        q: "Is Hivra affiliated with Nous Research?",
        a: "No. Nous makes Hermes. Hivra is an independent platform that offers Hermes hosting.",
      },
      {
        q: "When does metered hosting make sense?",
        a: "When an agent is idle for substantial periods and you do not need it running continuously.",
      },
    ],
    closing: CLOSING,
    related: relatedLinks({
      comparisons: ["vs-self-hosted", "vs-agent-37", "ai-agent-hosting-alternatives"],
      blog: ["self-hosting-hermes-guide"],
    }),
  },
};

export const HOST_COMPARISON_SLUGS = Object.keys(HOST_COMPARISONS) as CompetitorSlug[];
