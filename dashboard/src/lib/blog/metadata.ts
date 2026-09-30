import type { Metadata } from "next";

import { BLOG_ARTICLES } from "@/lib/blog-data";
import { buildArticleMetadata } from "@/lib/metadata";
import { OG_CONTENT_TYPE, OG_SIZE } from "@/lib/og-meta";

/** Path of the generated social card for one article (app/blog/[slug]/opengraph-image.tsx). */
export function blogArticleOgImagePath(slug: string): string {
  return `/blog/${slug}/opengraph-image`;
}

export function buildBlogArticleMetadata(slug: string): Metadata {
  const article = BLOG_ARTICLES[slug];
  if (!article) {
    return {};
  }

  return {
    title: article.metaTitle ?? article.title,
    description: article.metaDescription,
    ...buildArticleMetadata({
      path: `/blog/${slug}`,
      title: article.title,
      description: article.metaDescription,
      // Point social cards at the per-article generated card. Next.js only
      // applies a file-based opengraph-image when the same segment's metadata
      // sets no openGraph.images, and buildArticleMetadata always sets the
      // site default, so the card has to be named here to win.
      images: [
        {
          url: blogArticleOgImagePath(slug),
          width: OG_SIZE.width,
          height: OG_SIZE.height,
          alt: article.title,
          type: OG_CONTENT_TYPE,
        },
      ],
      publishedTime: article.publishedDate,
      modifiedTime: article.lastModified,
      authors: [article.author],
    }),
  };
}
