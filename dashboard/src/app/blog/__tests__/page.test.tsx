/** @jest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import BlogIndexPage from "../page";
import { BLOG_ARTICLES_LIST } from "@/lib/blog-data";

jest.mock("@/components/public-site/PublicSite", () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

describe("blog editorial index", () => {
  it("includes every registered article exactly once with its full title, summary and destination", () => {
    render(<BlogIndexPage />);
    const articles = screen.getAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("/blog/"));
    expect(articles).toHaveLength(BLOG_ARTICLES_LIST.length);
    for (const article of BLOG_ARTICLES_LIST) {
      const links = articles.filter((link) => link.getAttribute("href") === `/blog/${article.slug}`);
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveTextContent(article.title);
      expect(links[0]).toHaveTextContent(article.intro);
      expect(links[0]).toHaveTextContent(`${article.readingTimeMin} min read`);
    }
  });
});
