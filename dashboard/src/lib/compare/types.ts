export type ComparisonSection = {
  heading: string;
  paragraphs: string[];
};

export type ComparisonData = {
  title: string;
  h1: string;
  metaDescription: string;
  tagline: string;
  intro: string[];
  sections: ComparisonSection[];
  vsTable: Array<{
    criterion: string;
    hermesOs: string;
    other: string;
    hermosWins: boolean;
  }>;
  verdict: string;
  faqs: Array<{ q: string; a: string }>;
  relatedComparisons: Array<{ slug: string; title: string }>;
  relatedBlog?: Array<{ slug: string; title: string }>;
  relatedFeatures?: Array<{ slug: string; title: string }>;
  /** Off-site references, such as upstream docs a paragraph relies on. */
  externalRelated?: Array<{ label: string; href: string }>;
  /**
   * Vendor pages the competitor facts on this page were read from, shown under
   * the verdict with the check date. Set on pages that quote a competitor's
   * prices or terms.
   */
  factSources?: Array<{ label: string; href: string }>;
};

/*
 * Page model for the October 2026 copy overhaul (added, append only).
 *
 * `ComparisonData` above is the shape the pages had before the overhaul. It stays
 * exported so this file only ever grows; the pages now read `ComparePage`, which
 * follows the order of the supplied copy (four standard sections, one page specific
 * block, "At a glance", a caution note, questions and a closing row) instead of the
 * old intro / sections / verdict split. Display labels are neutral ("Hivra",
 * "Alternative"): nothing here carries the retired product name.
 */

/**
 * Copy strings may carry three kinds of inline markup, parsed by lib/compare/inline.ts:
 * `**bold**`, `` `code` `` and `[label](href)`. FAQ answers carry none, so FAQPage
 * JSON-LD and the visible answer are the same string.
 */
export type InlineMarkup = string;

/** A paragraph that opens with a bold lead, such as "Fly Sprites and E2B:". */
export type CompareEntry = { lead: InlineMarkup; text: InlineMarkup };

/** One row of the "At a glance" table. */
export type GlanceRow = { criterion: string; hivra: InlineMarkup; alternative: InlineMarkup };

export type CompareBlock =
  /** A paragraph. */
  | { kind: "p"; text: InlineMarkup }
  /** Bold-lead paragraphs set as a field guide, one hairline apart. */
  | { kind: "entries"; items: CompareEntry[] }
  /** A numbered list whose items open with a bold lead. */
  | { kind: "steps"; items: CompareEntry[] }
  /** The directory's provider rows. */
  | { kind: "providers"; items: Array<{ slug: string; label: string; text: InlineMarkup }> }
  /** The "At a glance" table: criterion, Hivra, Alternative. */
  | { kind: "glance"; caption: string; rows: GlanceRow[] }
  /** The dated price table on /compare, read from PRICE_TABLE in competitor-facts.ts. */
  | { kind: "priceTable"; caption: string };

export type CompareSection = {
  heading: string;
  /**
   * lede: the opening section in larger type. callout: the "when the alternative wins" section, with
   * a gold rule. note: the quiet caution block. Left out: an ordinary section.
   */
  tone?: "lede" | "callout" | "note";
  blocks: CompareBlock[];
};

/** Vendor pages the figures came from, shown under "Where these numbers come from". */
export type CompareSources = {
  /** Defaults to "Where these numbers come from". */
  heading?: string;
  intro: InlineMarkup;
  /** Facts from the vendor's pages that the copy above does not already state. */
  notes?: InlineMarkup[];
  links: Array<{ label: string; href: string }>;
};

export type CompareClosing = {
  heading: string;
  text: InlineMarkup;
  links: Array<{ label: string; href: string; kind: "primary" | "secondary" }>;
};

export type ComparePage = {
  slug: string;
  /** The finished browser title, brand included, used as an absolute title. */
  browserTitle: string;
  h1: string;
  metaDescription: string;
  /** Everything from "The real choice" down to the caution note, in reading order. */
  sections: CompareSection[];
  sources?: CompareSources;
  faqs: Array<{ q: string; a: string }>;
  closing: CompareClosing;
  /** Internal links under the closing row. */
  related: Array<{ label: string; href: string }>;
};
