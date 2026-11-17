// The docs hub (/docs): short, task-shaped reference pages for using Hivra.
// The blog explains and compares; a doc tells you how to do one thing on Hivra today.
// Every doc is checked by lib/docs/__tests__/docs-registry.test.ts with the same
// claim scanners the blog uses, because a doc is public copy too.

export type DocSectionId = "start" | "agents" | "computers" | "models" | "run";

/** What a doc about one agent or computer says about availability. Matches docs/STATUS.md. */
export type DocStatus = "available" | "alpha" | "preview" | "condition";

export type DocBlock = {
  heading: string;
  /**
   * Markdown paragraphs. Lists, tables, code fences, links and images are allowed. Images live in
   * public/images/docs/ and are written `![what it shows](/images/docs/name.webp "Caption")`.
   */
  paragraphs: string[];
};

export type DocPage = {
  slug: string;
  section: DocSectionId;
  title: string;
  /** Search result title, at most 58 characters. The root layout adds " | Hivra". */
  metaTitle?: string;
  /** 70 to 155 characters. */
  metaDescription: string;
  /** One or two sentences under the title and on the hub card. */
  summary: string;
  /** ISO date the page was last checked against the product. */
  lastReviewed: string;
  /** For agent and computer docs: the label from docs/STATUS.md. */
  status?: DocStatus;
  blocks: DocBlock[];
  /** Plain-text questions and answers shown at the end of the page. No links or markdown: they are the same text a reader sees. */
  faqs?: Array<{ q: string; a: string }>;
  /** Blog articles that go deeper, by slug. */
  articles?: string[];
  /** Other docs worth reading next, by slug. */
  next?: string[];
};

export type DocSection = {
  id: DocSectionId;
  title: string;
  blurb: string;
  /** Doc slugs in reading order. */
  docs: readonly string[];
};
