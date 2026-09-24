// Social card for /blog/<slug>, served at /blog/<slug>/opengraph-image.
// lib/blog/metadata.ts names this URL in each article's openGraph and twitter
// images, because buildArticleMetadata's default image would otherwise win over
// the file convention. Cards are prerendered at build for every registered
// article; an unknown slug gets a real 404 instead of a generic card.

import { BLOG_ARTICLES } from "@/lib/blog-data";
import { renderBlogCard } from "@/lib/blog/og-card";
import { OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og-meta";

export const alt = "Hivra blog article";
export const size = { width: OG_SIZE.width, height: OG_SIZE.height };
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  return Object.keys(BLOG_ARTICLES).map((slug) => ({ slug }));
}

export default async function BlogArticleOpengraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = BLOG_ARTICLES[slug];
  if (!article) {
    return new Response("Not Found", { status: 404 });
  }
  return renderBlogCard({ title: article.title, readingTimeMin: article.readingTimeMin });
}
