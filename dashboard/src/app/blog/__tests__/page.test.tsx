/** @jest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import BlogIndexPage from "../page";
import { BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import { BLOG_TOPICS, topicAnchor } from "@/lib/blog/topics";

jest.mock("@/components/public-site/PublicSite", () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

describe("blog editorial index", () => {
  it("lists every registered article exactly once across the topic sections, with its full title, summary and destination", () => {
    render(<BlogIndexPage />);
    const listed = BLOG_TOPICS.flatMap((topic) => {
      const section = screen.getByRole("region", { name: topic.title });
      expect(section).toHaveAttribute("id", topicAnchor(topic));
      return within(section).getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/blog/"));
    });
    expect(listed).toHaveLength(BLOG_ARTICLES_LIST.length);
    for (const article of BLOG_ARTICLES_LIST) {
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
    const latest = BLOG_ARTICLES_LIST[0];
    expect(container.querySelectorAll(`a[href="/blog/${latest.slug}"]`)).toHaveLength(2);
  });

  it("has a masthead without dashes", () => {
    render(<BlogIndexPage />);
    expect(screen.getByRole("heading", { level: 1 }).parentElement?.textContent ?? "").not.toMatch(/[\u2013\u2014]/);
  });
});
