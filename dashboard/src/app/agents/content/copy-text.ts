// Every reader-facing string of an /agents page as plain text (markup stripped), in page order.
// The tests scan these for banned claims, dashes and leftovers, and the same list is what the
// rendered page is checked against.

import { plainText } from "./markup";
import type { AgentBlock, AgentPageContent, HubContent } from "./types";

function blockCopy(block: AgentBlock): string[] {
  switch (block.kind) {
    case "prose":
      return block.paragraphs.map(plainText);
    case "terms":
      return block.items.flatMap(({ term, text }) => [plainText(term), plainText(text)]);
    case "list":
      return block.items.map(plainText);
    case "steps":
      return block.steps.flatMap((step) => [step.title, ...step.paragraphs.map(plainText)]);
  }
}

/** The strings of one agent page, headings included, FAQ questions and answers included. */
export function agentPageCopy(content: AgentPageContent): string[] {
  return [
    content.h1,
    ...content.lead.map(plainText),
    ...content.heroLinks.map((link) => link.label),
    ...content.sections.flatMap((section) => [section.heading, ...section.blocks.flatMap(blockCopy)]),
    ...content.faqs.flatMap(({ q, a }) => [q, plainText(a)]),
    content.closing.heading,
    ...content.closing.links.map((link) => link.label),
    content.affiliation,
    content.related.heading,
  ];
}

/** The strings of the directory page. */
export function hubCopy(content: HubContent): string[] {
  return [
    content.h1,
    ...content.lead.map(plainText),
    ...content.heroLinks.map((link) => link.label),
    content.intro.heading,
    ...content.intro.paragraphs.map(plainText),
    ...content.intro.topics.flatMap((topic) => [topic.heading, ...topic.paragraphs.map(plainText)]),
    content.directory.heading,
    ...content.directory.cards.flatMap((card) => [
      card.name,
      card.tagline,
      plainText(card.body),
      `Good fit: ${card.goodFit}`,
      card.linkLabel,
    ]),
    content.choose.heading,
    ...content.choose.paragraphs.map(plainText),
    content.boundaries.heading,
    ...content.boundaries.items.flatMap(({ term, text }) => [plainText(term), plainText(text)]),
    content.closing.heading,
    plainText(content.closing.paragraph),
    ...content.closing.links.map((link) => link.label),
    content.affiliation,
  ];
}
