/** @jest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";

import BlogArticlePage, { generateMetadata, generateStaticParams } from "../[slug]/page";
import { BLOG_ARTICLES, BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import { CUTOVER_BLOG_SLUGS } from "@/lib/blog/__tests__/cutover-slugs";

jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/components/public-editorial/ArticleNavigation.client", () => ({
  __esModule: true,
  default: () => <nav aria-label="Article contents" />,
}));
jest.mock("@/components/markdown/CodeBlock", () => ({
  CodeBlock: ({ value }: { value: string }) => <pre>{value}</pre>,
}));
// react-markdown and remark-gfm ship ESM-only; pass the markdown through verbatim
// so the rendered text still carries every word of the article.
jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="markdown">{children}</div>,
}));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => undefined }));
jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

const SITE = "https://hivra.cloud";

async function renderArticle(slug: string) {
  const element = await BlogArticlePage({ params: Promise.resolve({ slug }) });
  return render(element);
}

function structuredData(container: HTMLElement) {
  const scripts = container.querySelectorAll('script[type="application/ld+json"]');
  expect(scripts).toHaveLength(1);
  return JSON.parse(scripts[0].textContent ?? "{}") as { "@graph": Array<Record<string, unknown>> };
}

describe("/blog/[slug] article page", () => {
  afterEach(cleanup);

  it("prerenders every registered article, including the cutover posts", () => {
    const params = generateStaticParams().map(({ slug }) => slug);
    expect(params.sort()).toEqual(Object.keys(BLOG_ARTICLES).sort());
    for (const slug of CUTOVER_BLOG_SLUGS) expect(params).toContain(slug);
  });

  it.each(BLOG_ARTICLES_LIST.map((article) => [article.slug]))("renders %s with one H1, its sections, FAQs and server-side JSON-LD", async (slug) => {
    const article = BLOG_ARTICLES[slug];
    const { container } = await renderArticle(slug);

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(article.title);
    for (const section of article.sections) {
      expect(screen.getByRole("heading", { level: 2, name: section.heading })).toBeInTheDocument();
    }

    const graph = structuredData(container)["@graph"];
    const posting = graph.find((node) => node["@type"] === "BlogPosting");
    expect(posting).toMatchObject({
      "@id": `${SITE}/blog/${slug}`,
      url: `${SITE}/blog/${slug}`,
      headline: article.title,
      image: `${SITE}/blog/${slug}/opengraph-image`,
      datePublished: article.publishedDate,
      dateModified: article.lastModified,
    });
    expect(graph.some((node) => node["@type"] === "BreadcrumbList")).toBe(true);
    const faq = graph.find((node) => node["@type"] === "FAQPage") as { mainEntity: unknown[] } | undefined;
    expect(faq?.mainEntity).toHaveLength(article.faqs.length);

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/free[- ]trial|card required|never sleeps/i);
    // The shared CTA's default headline promises an unmeasured deploy time.
    expect(text).not.toMatch(/Deploy in\s*5 minutes/i);
    expect(text).toContain("7-day money-back guarantee on card payments");
  });

  it("returns a real not-found for an unknown slug instead of an empty page", async () => {
    await expect(BlogArticlePage({ params: Promise.resolve({ slug: "not-a-real-post" }) })).rejects.toThrow();
  });

  it.each(CUTOVER_BLOG_SLUGS.map((slug) => [slug]))("gives %s a self-canonical, its own title and its own social card", async (slug) => {
    const article = BLOG_ARTICLES[slug];
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    const url = `${SITE}/blog/${slug}`;
    const card = `${url}/opengraph-image`;

    expect(metadata.title).toBe(article.metaTitle ?? article.title);
    expect(String(metadata.title)).not.toMatch(/\|\s*Hivra/);
    expect(metadata.description).toBe(article.metaDescription);
    expect(metadata.alternates?.canonical).toBe(url);

    const openGraph = metadata.openGraph as { url?: string; type?: string; images?: Array<{ url: string; width?: number; height?: number }> };
    expect(openGraph.url).toBe(url);
    expect(openGraph.type).toBe("article");
    expect(openGraph.images).toEqual([expect.objectContaining({ url: card, width: 1200, height: 630 })]);
    expect((metadata.twitter as { images?: string[] }).images).toEqual([card]);
  });
});
