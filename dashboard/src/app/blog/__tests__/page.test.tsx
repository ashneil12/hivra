/** @jest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import BlogIndexPage from "../page";
import { getPublicBlogArticles } from "@/lib/blog-data";
import { BLOG_TOPICS, topicAnchor } from "@/lib/blog/topics";

jest.mock("@/components/public-site/PublicSite", () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

describe("blog editorial index", () => {
  afterEach(() => jest.restoreAllMocks());

  it("lists every public article exactly once across the topic sections, with its full title, summary and destination", () => {
    render(<BlogIndexPage />);
    const listed = BLOG_TOPICS.flatMap((topic) => {
      const section = screen.getByRole("region", { name: topic.title });
      expect(section).toHaveAttribute("id", topicAnchor(topic));
      return within(section).getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/blog/"));
    });
    expect(listed).toHaveLength(getPublicBlogArticles().length);
    for (const article of getPublicBlogArticles()) {
      const links = listed.filter((link) => link.getAttribute("href") === `/blog/${article.slug}`);
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveTextContent(article.title);
      expect(links[0]).toHaveTextContent(article.intro);
      expect(links[0]).toHaveTextContent(`${article.readingTimeMin} min read`);
    }
  });

  it("offers a jump link to every topic, and keeps the latest article as a highlighted card", () => {
    const { container } = render(<BlogIndexPage />);
    const nav = screen.getByRole("navigation", { name: "Blog topics" });
    for (const topic of BLOG_TOPICS) expect(within(nav).getByRole("link", { name: topic.title })).toHaveAttribute("href", `#${topicAnchor(topic)}`);
    // The latest card sits outside the topic sections, so it is one extra link to an article that is also in its topic.
    const latest = getPublicBlogArticles()[0];
    expect(container.querySelectorAll(`a[href="/blog/${latest.slug}"]`)).toHaveLength(2);
  });

  it("has a masthead without dashes", () => {
    render(<BlogIndexPage />);
    expect(screen.getByRole("heading", { level: 1 }).parentElement?.textContent ?? "").not.toMatch(/[\u2013\u2014]/);
  });

  it("lists a gated article in the index and structured data only when its own gate is on", () => {
    jest.replaceProperty(process, "env", {
      ...process.env,
      NEXT_PUBLIC_HIVRA_OPENBOT_AGENT: "0",
      NEXT_PUBLIC_HIVRA_NUPHOS_AGENT: "1",
      NEXT_PUBLIC_HIVRA_UNIVERSAL_CATALOG: "0",
    });
    const { container } = render(<BlogIndexPage />);
    const links = Array.from(container.querySelectorAll("a"), (a) => a.getAttribute("href"));
    const data = container.querySelector('script[type="application/ld+json"]')?.textContent;
    expect(data).toBeDefined();
    expect(links).toContain("/blog/nuphos-claude-code-team-chat");
    expect(data).toContain("/blog/nuphos-claude-code-team-chat");
    for (const slug of ["openbot-ai-coworkers", "what-is-zeroclaw"]) {
      expect(links).not.toContain(`/blog/${slug}`);
      expect(data).not.toContain(`/blog/${slug}`);
    }
  });
});
