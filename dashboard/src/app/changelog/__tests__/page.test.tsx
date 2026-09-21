/** @jest-environment jsdom */
/* eslint-disable @next/next/no-img-element */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import ChangelogPage from "../page";

jest.mock("next/link", () => {
  const MockLink = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

// react-markdown ships ESM-only and Jest's CJS transform can't load it.
// The page test only cares that the entry body reaches the render tree —
// passing the markdown through verbatim keeps assertions on it meaningful.
jest.mock("react-markdown", () => {
  function MockReactMarkdown({ children }: { children?: React.ReactNode }) {
    return <div data-testid="md">{children}</div>;
  }
  MockReactMarkdown.displayName = "MockReactMarkdown";
  return { __esModule: true, default: MockReactMarkdown };
});

jest.mock("remark-gfm", () => ({ __esModule: true, default: () => undefined }));

jest.mock("@/lib/changelog", () => ({
  readChangelog: () => ({
    lastUpdated: "2026-06-10",
    entries: [
      {
        date: "2026-06-10",
        title: "Public Changelog Page",
        body: "### Feature\n\nA small **change** that lands today.",
      },
      {
        date: "2026-05-29",
        title: "Earlier Entry",
        body: "Body text for the earlier entry.\n\n- Bullet one\n- Bullet two",
      },
    ],
  }),
}));

describe("/changelog page", () => {
  it("renders the hero, last-updated marker, and both entries with stable anchors", () => {
    const { container } = render(<ChangelogPage />);

    // Hero
    expect(
      screen.getByRole("heading", { level: 1, name: /what shipped on hivra/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last updated/i)).toBeInTheDocument();

    // Entry headings come through verbatim from the markdown source.
    expect(
      screen.getByRole("heading", { level: 2, name: /public changelog page/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /earlier entry/i }),
    ).toBeInTheDocument();

    // Stable, date-based anchors per the brief: /changelog#YYYY-MM-DD.
    // CSS selectors choke on ids starting with a digit; query by attribute.
    expect(container.querySelector('article[id="2026-06-10"]')).not.toBeNull();
    expect(container.querySelector('article[id="2026-05-29"]')).not.toBeNull();

    // Permalink chips reference the date anchors.
    expect(
      screen.getByRole("link", { name: /permalink to 2026-06-10 entry/i }),
    ).toHaveAttribute("href", "#2026-06-10");
    expect(
      screen.getByRole("link", { name: /permalink to 2026-05-29 entry/i }),
    ).toHaveAttribute("href", "#2026-05-29");

    // Markdown body reaches the render tree — one mock <div> per entry.
    const bodies = screen.getAllByTestId("md");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveTextContent("A small **change** that lands today.");
    expect(bodies[1]).toHaveTextContent("- Bullet one");
    expect(bodies[1]).toHaveTextContent("- Bullet two");
  });

  it("links to /roadmap from the top nav so users can reach the sibling page", () => {
    render(<ChangelogPage />);
    const roadmapLinks = screen.getAllByRole("link", { name: /^roadmap$/i });
    expect(roadmapLinks.length).toBeGreaterThanOrEqual(1);
    roadmapLinks.forEach((link) => {
      expect(link).toHaveAttribute("href", "/roadmap");
    });
  });
});
