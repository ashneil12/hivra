import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildAbsoluteTitleMetadata } from "@/lib/metadata";
import { COMPARE_PAGES, COMPARE_PAGE_SLUGS } from "@/lib/compare/pages";
import CompareArticle from "../CompareArticle";

// The copy for all nine pages lives in lib/compare (host-comparisons.ts for the four named hosts,
// general-comparisons.ts for the rest). Competitor figures are in lib/compare/competitor-facts.ts,
// each with its source and the month it was read. This file only routes a slug to its page.

interface ComparePageParams {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: ComparePageParams): Promise<Metadata> {
  const { slug } = await params;
  const page = COMPARE_PAGES[slug];
  if (!page) return {};

  return buildAbsoluteTitleMetadata({
    path: `/compare/${slug}`,
    title: page.browserTitle,
    description: page.metaDescription,
  });
}

export function generateStaticParams() {
  return COMPARE_PAGE_SLUGS.map((slug) => ({ slug }));
}

export default async function ComparisonPage({ params }: ComparePageParams) {
  const { slug } = await params;
  const page = COMPARE_PAGES[slug];
  if (!page) notFound();

  return <CompareArticle page={page} variant="detail" />;
}
