import type { ActionLink } from "@/components/public-editorial/ActionLinks";

/**
 * The copy for the feature pages is data. Strings may carry three kinds of inline
 * markup, nothing else: `**bold**`, `code` between backticks and [label](href).
 * One renderer (_components/Inline.tsx) turns them into elements, and one function
 * turns the same strings into plain text for the FAQPage JSON-LD, so the structured
 * data is the visible text by construction.
 */

export type FeatureBlock =
  /** A paragraph. */
  | { kind: "p"; text: string }
  /** A small aside under a passage: a caution or a reminder that something is an example. */
  | { kind: "note"; text: string }
  /** A worked example set apart from the prose around it. */
  | { kind: "scenario"; text: string }
  /** Paragraphs that open with a bold lead-in, set as a two-column list. The lead-in is `term`. */
  | { kind: "terms"; items: ReadonlyArray<{ term: string; text: string }> }
  /** Numbered steps. */
  | { kind: "steps"; items: readonly string[] }
  /** A small heading and a paragraph for each example. */
  | { kind: "workflows"; items: ReadonlyArray<{ title: string; text: string }> }
  /** A comparison table. `caption` only names it for assistive technology. */
  | {
      kind: "table";
      caption: string;
      rowHeading: string;
      columns: readonly string[];
      rows: ReadonlyArray<{ label: string; cells: readonly string[] }>;
    };

export interface FeatureSection {
  heading: string;
  blocks: readonly FeatureBlock[];
}

export interface FeatureFaqItem {
  q: string;
  /** One paragraph, with inline markup. */
  a: string;
}

export interface FeaturePageContent {
  slug: string;
  /** The exact browser title from the copy, finished (the root template adds nothing). */
  seoTitle: string;
  /** The search description from the copy. */
  description: string;
  /** The short label above the h1, from the part of the title before the colon. Left out when the title has none. */
  eyebrow?: string;
  h1: string;
  /** The last breadcrumb. */
  breadcrumb: string;
  /** The opening statement: not listed in the contents. */
  lead: FeatureSection;
  sections: readonly FeatureSection[];
  faqs: readonly FeatureFaqItem[];
  actions: readonly ActionLink[];
  related: ReadonlyArray<{ label: string; href: string }>;
}
