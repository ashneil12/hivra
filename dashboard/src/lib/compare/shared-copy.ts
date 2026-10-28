import { MONEY_BACK_GUARANTEE, formatPlanSize } from "@/lib/blog/plan-facts";
import { formatCheckedMonth } from "./competitor-facts";
import type { CompareBlock, CompareClosing, CompareSection, CompareSources } from "./types";

/**
 * Copy the ten comparison pages share, and the few facts they all state about Hivra.
 * Prices and sizes come from plan-facts (checkout's own numbers), so a change there
 * moves every page. The wording rules behind each constant:
 *
 * - Prose names a price with its size: "$9.99 a month for 2 vCPU and 4 GB of RAM".
 *   Table cells may use the compact "/mo" form.
 * - The guarantee is always "7-day money-back guarantee on card payments", linked to /terms.
 * - AI usage is not in the plan; the sentence is the owner-approved one.
 * - Plans are never called Starter, Pro or Power.
 */

/** "$9.99 a month for 2 vCPU and 4 GB of RAM" */
export const ENTRY_PRICE_PROSE = formatPlanSize("entry");

/** The guarantee as a link, for table cells and sentences. */
export const REFUND_LINKED = `[${MONEY_BACK_GUARANTEE}](/terms)`;

/** The owner-approved sentence for what the plan leaves out and how usage is paid. */
export const AI_USAGE = "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.";

/** Model access in a table cell. */
export const AI_ACCESS_CELL = "Your own account or key where the agent supports it, or Hivra credits";

/** The approved keep-running wording for a paid computer. */
export const STAYS_ON = "A paid Hivra Cloud computer stays on and is not paused for inactivity.";

/**
 * Aeon is listed as hosted, but Hivra only hosts its dashboard: its scheduled work runs
 * on the owner's own GitHub Actions (lib/launch/contracts.ts).
 */
export const HIVRA_AGENTS_CELL = "Hermes, OpenClaw, Agent Zero, Claude Code, Codex, Aeon (dashboard only)";

/**
 * Ends every meta description that quotes a price ("Prices as of October 2026."), in the same month the
 * page's own freshness stamp uses. A description with no dollar figure (the OpenClaw to Hermes page) has no
 * stamp. Each of the ten pages writes its own description (155 characters at most); a test keeps them
 * different from one another.
 */
export const PRICES_AS_OF_STAMP = `Prices as of ${formatCheckedMonth()}.`;

export function paragraphs(...texts: string[]): CompareBlock[] {
  return texts.map((text) => ({ kind: "p", text }));
}

/** The "How to make the decision" block six of the pages carry word for word. */
export const DECISION_SECTION: CompareSection = {
  heading: "How to make the decision",
  blocks: paragraphs(
    "Run the same small workload on both options. Give the agent an ordinary task, a scheduled task and a task that writes a file. Restart its environment. Confirm that its files, credentials and task history survived as expected. Then add up a full month of platform cost and model usage.",
    "Do not give either provider credit for a feature you have not tested in the actual plan you intend to use. And if your agent works with confidential accounts or can take irreversible actions, examine access controls before comparing CPU numbers.",
  ),
};

/**
 * "Things a comparison chart cannot tell you". The supplied text said the research was
 * "not checked live for this rewrite" and told the reader to confirm before "publishing";
 * that was a note to the editor, so the page states what was done instead: the figures
 * were collected from each provider's published pages, in the month on record in
 * competitor-facts.ts, and some may have changed since. It does not say they were "read" or
 * "verified" on the page: vendors have moved prices since (Hostinger's sale price) and Nous
 * now shows its per-size prices only after sign-in, so the page cannot claim live checking.
 */
export function cautionSection(): CompareSection {
  return {
    heading: "Things a comparison chart cannot tell you",
    tone: "note",
    blocks: paragraphs(
      `Prices, feature availability, introductory offers and refund policies can all change. The vendor figures and documentation on this page were collected from each provider's published pages in ${formatCheckedMonth()}. Some of them may have changed since, so confirm any quoted vendor price, hardware size, compliance status or security statement against the provider's current documentation before you buy.`,
      "Security claims also need context. A managed host can take infrastructure upkeep off your hands, but it cannot make an unrestricted AI agent safe. Review secrets, account permissions, approvals and backups wherever you run it.",
    ),
  };
}

/** "Where these numbers come from" for a page that quotes a competitor's prices or terms. */
export function priceSources(links: CompareSources["links"], notes?: string[], plural = false): CompareSources {
  const who = plural ? "the other providers come from their" : "the other provider come from its";
  return {
    intro: `Prices and terms for ${who} own pages, as of ${formatCheckedMonth()}. Vendors change prices, so check the source before you pay.`,
    notes,
    links,
  };
}

export const CLOSING: CompareClosing = {
  heading: "Ready to give your agent a computer?",
  text: "If you want a persistent environment without administering the server yourself, take a look at [Hivra's plans](/pricing) and [supported agents](/agents). If you want root access and prefer doing things yourself, a VPS may genuinely be the better fit.",
  links: [
    { label: "Explore Hivra pricing", href: "/pricing", kind: "primary" },
    { label: "Compare all options", href: "/compare", kind: "secondary" },
    { label: "Browse features", href: "/features", kind: "secondary" },
  ],
};

/** Labels for the comparison pages, used by every related-links block. */
export const COMPARISON_LABELS: Record<string, string> = {
  "vs-agent-37": "Hivra vs Agent 37",
  "vs-hostinger": "Hivra vs Hostinger",
  "vs-xcloud": "Hivra vs xCloud",
  "vs-nous-hermes-cloud": "Hivra vs Nous Hermes Cloud",
  "vs-self-hosted": "Hivra vs Self-Hosted VPS",
  "vs-railway": "Hivra vs Railway",
  "vs-render": "Hivra vs Render",
  "openclaw-to-hermes": "OpenClaw to Hermes",
  "ai-agent-hosting-alternatives": "AI agent hosting alternatives",
};

export const BLOG_LABELS: Record<string, string> = {
  "cost-of-running-ai-agent": "The real cost of running a persistent AI agent",
  "self-hosting-hermes-guide": "How to self-host Hermes Agent",
  "ai-agent-hosting-guide": "AI agent hosting guide",
  "managed-vs-self-hosted-ai-agents": "Managed vs self-hosted AI agents",
  "what-is-hermes-agent": "What is Hermes Agent?",
};

export const HOSTING_COST_CALCULATOR_HREF = "/tools/ai-agent-hosting-cost-calculator";

/** Related links under the closing row: other comparisons, then blog posts, then anything extra. */
export function relatedLinks(input: {
  comparisons: string[];
  blog?: string[];
  features?: Array<{ slug: string; label: string }>;
  extra?: Array<{ label: string; href: string }>;
}): Array<{ label: string; href: string }> {
  return [
    ...input.comparisons.map((slug) => ({ label: COMPARISON_LABELS[slug], href: `/compare/${slug}` })),
    ...(input.blog ?? []).map((slug) => ({ label: `Blog: ${BLOG_LABELS[slug]}`, href: `/blog/${slug}` })),
    ...(input.features ?? []).map(({ slug, label }) => ({ label: `Feature: ${label}`, href: `/features/${slug}` })),
    ...(input.extra ?? []),
  ];
}
