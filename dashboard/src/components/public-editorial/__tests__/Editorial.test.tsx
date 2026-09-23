/** @jest-environment jsdom */
import React from "react";
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server.node";
import { EditorialMarkdownLink, EditorialQuestions } from "../Editorial";
import ArticleNavigation from "../ArticleNavigation.client";

function mockWideLayout(wide: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn((query: string) => ({ matches: query === "(min-width: 701px)" ? wide : false, addEventListener: jest.fn(), removeEventListener: jest.fn() })),
  });
}

describe("editorial reading controls", () => {
  it("opens external web sources separately while keeping site and section links in place", () => {
    render(<>
      <EditorialMarkdownLink href="https://docs.example.org/guide">External source</EditorialMarkdownLink>
      <EditorialMarkdownLink href="//docs.example.org/guide">Protocol-relative source</EditorialMarkdownLink>
      <EditorialMarkdownLink href="/blog/guide">Article</EditorialMarkdownLink>
      <EditorialMarkdownLink href="https://hivra.cloud/features">Feature</EditorialMarkdownLink>
      <EditorialMarkdownLink href="#section-2">Section</EditorialMarkdownLink>
      <EditorialMarkdownLink href="mailto:info@hermesos.cloud">Email</EditorialMarkdownLink>
    </>);
    for (const name of ["External source", "Protocol-relative source"]) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("target", "_blank");
      expect(screen.getByRole("link", { name })).toHaveAttribute("rel", "noopener noreferrer");
    }
    for (const name of ["Article", "Feature", "Section", "Email"]) {
      expect(screen.getByRole("link", { name })).not.toHaveAttribute("target");
    }
  });

  it("serves the article contents open without the ready marker, so wide screens need no script", () => {
    mockWideLayout(true);
    const html = renderToString(<ArticleNavigation items={[{ id: "one", label: "First section" }]} />);
    expect(html).toMatch(/<details[^>]*\sopen/);
    expect(html).not.toContain("data-toc-ready");
    expect(html).toContain('href="#one"');
  });

  it("collapses the article contents on single-column widths and keeps them open on wide screens", () => {
    const items = [{ id: "one", label: "First section" }, { id: "two", label: "Second section" }];
    mockWideLayout(false);
    const { container, unmount } = render(<ArticleNavigation items={items} />);
    const narrow = container.querySelector("details")!;
    expect(narrow).not.toHaveAttribute("open");
    expect(narrow).toHaveAttribute("data-toc-ready");
    expect(screen.getByText("In this article")).toBeInTheDocument();
    unmount();

    mockWideLayout(true);
    const wide = render(<ArticleNavigation items={items} />);
    const details = wide.container.querySelector("details")!;
    expect(details).toHaveAttribute("open");
    expect(details).toHaveAttribute("data-toc-ready");
    expect(screen.getByRole("link", { name: /First section/ })).toHaveAttribute("href", "#one");
  });

  it("keeps every supplied question and answer visible before the reader collapses it", () => {
    const questions = [{ q: "Can I keep my key?", a: "The supplied answer stays complete." }, { q: "Where does it run?", a: "A second distinct answer." }];
    const { container } = render(<EditorialQuestions questions={questions} />);
    expect(container.querySelectorAll("details[open]")).toHaveLength(2);
    for (const { q, a } of questions) {
      expect(screen.getByText(q)).toBeVisible();
      expect(screen.getByText(a)).toBeVisible();
    }
  });
});
