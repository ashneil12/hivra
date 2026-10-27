import type { ComparePage } from "./types";
import { formatCheckedMonth } from "./competitor-facts";
import {
  AI_USAGE,
  CLOSING,
  ENTRY_PRICE_PROSE,
  PRICES_AS_OF_STAMP,
  cautionSection,
  paragraphs,
} from "./shared-copy";

/**
 * The /compare directory (scratchpad batches/b04, file 01). It keeps the dated price
 * table the page has always carried, because the supplied copy's own editorial
 * checks ask for the existing comparison table to be restored, and /llms.txt
 * describes this page as having one.
 */
export const COMPARE_DIRECTORY: ComparePage = {
  slug: "",
  browserTitle: "Hivra compared with the alternatives | Hivra",
  h1: "Hivra compared with the alternatives",
  metaDescription: `Hivra compared with Agent 37, Hostinger, xCloud, Nous Hermes Cloud, self-hosting, Railway and Render, with a dated price table. ${PRICES_AS_OF_STAMP}`,
  sections: [
    {
      heading: "The real choice",
      tone: "lede",
      blocks: paragraphs(
        "Choosing where an AI agent lives should not require believing every hosting company's favourite comparison chart. Start with the way you actually work: one assistant that runs every day, a collection of short-lived coding sandboxes, a desktop for visual tasks, or a Linux server you are happy to maintain. These are different problems, and no single host wins all of them.",
      ),
    },
    {
      heading: "What you are actually paying for",
      blocks: paragraphs(
        "The question is not just how much RAM you get for the money. Ask what survives a restart, whether the agent stays on while you are away, who applies security updates, and what happens if the service changes its prices. Model costs are usually separate, so factor those into your calculation as well.",
      ),
    },
    {
      heading: "Where Hivra fits",
      blocks: paragraphs(
        `For Hivra, the offer is fairly simple: a cloud computer for your agent, with its files and working environment kept in place for as long as the agent exists. Paid hosting starts at ${ENTRY_PRICE_PROSE}. ${AI_USAGE} It is a better fit for a persistent assistant than for thousands of temporary sandboxes.`,
      ),
    },
    {
      heading: "When the alternative is worth choosing",
      tone: "callout",
      blocks: paragraphs(
        "If you want root control and the cheapest infrastructure bill, self-hosting is often better. If you want a purpose-built computer-use product, an on-demand sandbox API, or a product already tied to your existing cloud stack, there are alternatives that may suit you better.",
      ),
    },
    {
      heading: "Compare the providers",
      blocks: [
        {
          kind: "providers",
          items: [
            { slug: "vs-agent-37", label: "Agent 37", text: "metered raw compute, a free tier and external assurance claims worth examining." },
            { slug: "vs-hostinger", label: "Hostinger", text: "attractive long-term prepaid offers and general VPS control." },
            { slug: "vs-xcloud", label: "xCloud", text: "stronger promotional hardware numbers, with renewal terms to check." },
            { slug: "vs-nous-hermes-cloud", label: "Nous Hermes Cloud", text: "usage-based hosting from Hermes' own developers." },
            { slug: "vs-self-hosted", label: "Self-hosted VPS", text: "more control and often less cash, with the maintenance on you." },
            { slug: "vs-railway", label: "Railway", text: "a well-established general deployment platform." },
            { slug: "vs-render", label: "Render", text: "an available Hermes template with configuration work remaining." },
            { slug: "openclaw-to-hermes", label: "OpenClaw to Hermes", text: "a practical migration decision, not a forced upgrade." },
            { slug: "ai-agent-hosting-alternatives", label: "Broader hosting choices", text: "including sandboxes and GUI-oriented computers." },
          ],
        },
      ],
    },
    {
      heading: "What does each host cost?",
      blocks: [
        ...paragraphs(
          `Sizes differ between providers, so each row states its own. Prices are in US dollars, from each provider's published pages, as of ${formatCheckedMonth()}. Model usage is extra unless a row says otherwise. Hostinger shows its managed plan and its KVM 2 VPS at sale prices, so check its pages. Nous now shows sizes and prices only after you sign in to its Portal, so its row shows the last published figures. Cloudways isn't listed, because its page doesn't say whether its prices already include its launch discount.`,
        ),
        { kind: "priceTable", caption: "Price table" } as const,
      ],
    },
    cautionSection(),
  ],
  faqs: [
    {
      q: "What does Hivra charge?",
      a: `Hivra hosting starts at ${ENTRY_PRICE_PROSE}, excluding model usage.`,
    },
    {
      q: "Is self-hosting a legitimate alternative?",
      a: "Absolutely. It offers more control and often a lower infrastructure bill, provided you are willing to maintain the machine.",
    },
  ],
  closing: CLOSING,
  related: [],
};
