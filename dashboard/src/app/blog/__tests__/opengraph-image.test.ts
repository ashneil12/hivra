// The per-article social card at /blog/<slug>/opengraph-image. Production
// served these from the private repo; before this port the public build 404'd
// every one of them.

import * as segment from "../[slug]/opengraph-image";
import BlogArticleOpengraphImage, { alt, contentType, generateStaticParams, size } from "../[slug]/opengraph-image";
import { BLOG_ARTICLES } from "@/lib/blog-data";
import { blogCardTitleSize } from "@/lib/blog/og-card";
import { blogArticleOgImagePath } from "@/lib/blog/metadata";
import { CUTOVER_BLOG_SLUGS } from "@/lib/blog/__tests__/cutover-slugs";

describe("/blog/[slug]/opengraph-image", () => {
  it("declares a 1200x630 PNG card with alt text and stays on the Node.js runtime", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    expect(alt).toBeTruthy();
    // The card reads the brand mark from public/, so it must not opt into the edge runtime.
    expect(segment).not.toHaveProperty("runtime");
  });

  it("prerenders a card for every registered article", () => {
    expect(generateStaticParams().map(({ slug }) => slug).sort()).toEqual(Object.keys(BLOG_ARTICLES).sort());
  });

  it.each(CUTOVER_BLOG_SLUGS.map((slug) => [slug]))("returns an image/png card for %s", async (slug) => {
    const response = await BlogArticleOpengraphImage({ params: Promise.resolve({ slug }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("returns a real 404 for an unknown slug rather than a generic card", async () => {
    const response = await BlogArticleOpengraphImage({ params: Promise.resolve({ slug: "not-a-real-post" }) });
    expect(response.status).toBe(404);
  });

  it("is the URL each article's metadata points social cards at", () => {
    expect(blogArticleOgImagePath("ai-agent-vps")).toBe("/blog/ai-agent-vps/opengraph-image");
  });

  it("steps the title size down so the longest titles still fit the card", () => {
    const longest = Object.values(BLOG_ARTICLES).reduce((a, b) => (b.title.length > a.title.length ? b : a));
    expect(blogCardTitleSize("Short title")).toBe(76);
    expect(blogCardTitleSize("x".repeat(60))).toBe(62);
    expect(blogCardTitleSize(longest.title)).toBe(52);
    // A 92-character title renders in three lines at 52px with room to spare
    // (checked by rasterizing the card). Much longer needs a new size step.
    expect(longest.title.length).toBeLessThanOrEqual(100);
  });
});
