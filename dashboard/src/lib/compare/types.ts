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
