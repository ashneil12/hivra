import type { Metadata } from "next";

import { BLOG_ARTICLES } from "@/lib/blog-data";
import { buildArticleMetadata } from "@/lib/metadata";

export function buildBlogArticleMetadata(slug: string): Metadata {
  const article = BLOG_ARTICLES[slug];
  if (!article) {
    return {};
  }

  return {
    title: article.title,
    description: article.metaDescription,
    ...buildArticleMetadata({
      path: `/blog/${slug}`,
      title: article.title,
      description: article.metaDescription,
      publishedTime: article.publishedDate,
      modifiedTime: article.lastModified,
      authors: [article.author],
    }),
  };
}
