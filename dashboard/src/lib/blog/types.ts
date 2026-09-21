export type BlogSection = {
  heading: string;
  paragraphs: string[];
};

export type BlogArticle = {
  slug: string;
  title: string;
  metaDescription: string;
  publishedDate: string;   // ISO date string
  lastModified: string;
  readingTimeMin: number;
  author: string;
  tagline: string;
  intro: string;           // 1-2 sentences shown as the card preview and lede
  sections: BlogSection[];
  faqs: Array<{ q: string; a: string }>;
  relatedArticles: Array<{ slug: string; title: string }>;
  relatedFeatures?: Array<{ slug: string; title: string }>;
  relatedComparisons?: Array<{ slug: string; title: string }>;
};
