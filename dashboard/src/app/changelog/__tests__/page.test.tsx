/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import ChangelogPage, { metadata } from "../page";
import { CHANGELOG_COPY } from "../changelog-content";
import { CHANGELOG_FEED_DESCRIPTION, CHANGELOG_FEED_TITLE } from "@/lib/changelog-rss";

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
// The page test only cares that the entry body reaches the render tree, so
// passing the markdown through verbatim keeps assertions on it meaningful.
jest.mock("react-markdown", () => {
  function MockReactMarkdown({ children }: { children?: React.ReactNode }) {
    return <div data-testid="md">{children}</div>;
  }
  MockReactMarkdown.displayName = "MockReactMarkdown";
  return { __esModule: true, default: MockReactMarkdown };
});

jest.mock("remark-gfm", () => ({ __esModule: true, default: () => undefined }));

// The page asks who is looking (token surfaces on or off, viewer in a listed country or not).
// Each case sets the answer; the default is a viewer who may see token copy.
const mockView = jest.fn();
jest.mock("@/lib/compliance/token-surface-view", () => ({
  ...jest.requireActual("@/lib/compliance/token-surface-view"),
  getTokenSurfaceView: () => mockView(),
}));

jest.mock("@/lib/changelog", () => ({
  ...jest.requireActual("@/lib/changelog"),
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
      {
        date: "2026-05-13",
        title: "Wallet Entry",
        body: "### Bankr wallet and skills for CLI agents\nCLI agents now have access to the **Bankr wallet** (deposit, withdraw, view history), plus the ability to install skills from the catalogue.\n\n### Paid agents resume automatically\nThey wake up on their own.",
      },
    ],
  }),
}));

beforeEach(() => {
  mockView.mockReset();
  mockView.mockResolvedValue({ tokenSurfaces: true, geoBlocked: false });
});

const PAGE_TITLE = "Hivra Changelog | Product Updates and Fixes";
const PAGE_DESCRIPTION =
  "Read what has changed on Hivra, from agent memory and browser sessions to reliability improvements and dashboard updates.";

describe("/changelog page", () => {
  it("renders the heading, the last-updated marker, and the entries with stable anchors", async () => {
    const { container } = render(await ChangelogPage());

    // One H1; the list heading is an H2 beside the entry titles.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "What we've been building." })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "What we have shipped" })).toBeInTheDocument();
    expect(screen.getByText(/Last updated/i)).toBeInTheDocument();

    // Entry headings come through verbatim from the markdown source.
    expect(screen.getByRole("heading", { level: 2, name: /public changelog page/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /earlier entry/i })).toBeInTheDocument();

    // Stable, date-based anchors per the brief: /changelog#YYYY-MM-DD.
    // CSS selectors choke on ids starting with a digit; query by attribute.
    expect(container.querySelector('article[id="2026-06-10"]')).not.toBeNull();
    expect(container.querySelector('article[id="2026-05-29"]')).not.toBeNull();

    // Permalink chips reference the date anchors and show the date as the reader sees it.
    const chip = screen.getByRole("link", { name: /permalink to 2026-06-10 entry/i });
    expect(chip).toHaveAttribute("href", "#2026-06-10");
    expect(chip).toHaveTextContent("10 June 2026");
    expect(screen.getByRole("link", { name: /permalink to 2026-05-29 entry/i })).toHaveAttribute("href", "#2026-05-29");

    // Markdown body reaches the render tree, one mock <div> per entry.
    const bodies = screen.getAllByTestId("md");
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toHaveTextContent("A small **change** that lands today.");
    expect(bodies[1]).toHaveTextContent("- Bullet one");
    expect(bodies[1]).toHaveTextContent("- Bullet two");
  });

  it("writes the introduction from the approved copy, in order, without em or en dashes", async () => {
    const { container } = render(await ChangelogPage());
    const main = container.querySelector("main")?.textContent ?? "";
    const { masthead, list } = CHANGELOG_COPY;
    const sequence = [
      masthead.heading,
      ...masthead.paragraphs,
      "Explore agents",
      "See the roadmap",
      list.eyebrow,
      list.heading,
      list.lede,
      `${list.lastUpdated} 10 June 2026`,
      "Roadmap",
      "RSS feed",
      "Deploy Now",
    ];
    let cursor = 0;
    for (const part of sequence) {
      const at = main.indexOf(part, cursor);
      expect(at).toBeGreaterThanOrEqual(cursor);
      cursor = at + part.length;
    }
    expect(main).toContain("recovering an instance or finding out what happened during a run");
    expect(main).toContain("This page is a shipping history, not a promise that every future feature is available.");
    // The list does not claim to hold every change: it says where it stops, from the date of its newest entry.
    expect(main).toContain("Dated notes on notable changes to Hivra:");
    expect(main).toContain(`${list.lede} ${list.coverage("10 June 2026")}`);
    expect(main).toContain("The newest entry is dated 10 June 2026. Later changes are not listed here.");
    expect(main).not.toMatch(/every notable/i);
    expect(main).not.toMatch(/[\u2013\u2014]/);
  });

  it("offers the two masthead actions and the three list links to real destinations", async () => {
    render(await ChangelogPage());
    expect(screen.getByRole("link", { name: /explore agents/i })).toHaveAttribute("href", "/agents");
    expect(screen.getByRole("link", { name: /see the roadmap/i })).toHaveAttribute("href", "/roadmap");
    // "Roadmap" is a second link to the sibling page, from the list head.
    const roadmapLinks = screen.getAllByRole("link", { name: /roadmap/i }).map((link) => link.getAttribute("href"));
    expect(roadmapLinks.filter((href) => href === "/roadmap").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("link", { name: /^rss feed/i })).toHaveAttribute("href", "/changelog/rss.xml");
    expect(screen.getByRole("link", { name: /^deploy now/i })).toHaveAttribute("href", "/sign-up");
  });

  it("puts the list head before the first entry and after the masthead", async () => {
    render(await ChangelogPage());
    const h1 = screen.getByRole("heading", { level: 1 });
    const shipped = screen.getByRole("region", { name: "What we have shipped" });
    const firstEntry = screen.getByRole("heading", { level: 2, name: /public changelog page/i });
    expect(h1.compareDocumentPosition(shipped) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(shipped.compareDocumentPosition(firstEntry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(shipped).queryAllByRole("article")).toHaveLength(0);
  });
});

describe("/changelog coverage line", () => {
  it("is built from the newest entry's date and is not typed into the copy", () => {
    // The changelog file decides the date; the copy only wraps it.
    expect(CHANGELOG_COPY.list.coverage("1 January 2030")).toBe(
      "The newest entry is dated 1 January 2030. Later changes are not listed here.",
    );
    expect(CHANGELOG_COPY.list.lede).not.toMatch(/\b20\d\d\b/);
    expect(CHANGELOG_COPY.list.coverage("1 January 2030")).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("/changelog and the Bankr release note (token surfaces)", () => {
  const BANKR = /bankr/i;

  it("shows the full 13 June note to a viewer who may see token copy", async () => {
    render(await ChangelogPage());
    const text = screen.getAllByTestId("md").map((node) => node.textContent).join("\n");
    expect(text).toContain("### Bankr wallet and skills for CLI agents");
    expect(text).toContain("access to the **Bankr wallet**");
  });

  it("shows only the skills half when the switch is off", async () => {
    mockView.mockResolvedValue({ tokenSurfaces: false, geoBlocked: false });
    const { container } = render(await ChangelogPage());
    const text = screen.getAllByTestId("md").map((node) => node.textContent).join("\n");
    expect(text).not.toMatch(BANKR);
    expect(text).toContain("### Skills for CLI agents");
    expect(text).toContain("### Paid agents resume automatically");
    expect(container.textContent ?? "").not.toMatch(BANKR);
  });

  it("shows only the skills half to a viewer in a listed country", async () => {
    mockView.mockResolvedValue({ tokenSurfaces: true, geoBlocked: true });
    const { container } = render(await ChangelogPage());
    expect(container.querySelector("main")?.textContent ?? "").not.toMatch(BANKR);
  });
});

describe("/changelog metadata and feed", () => {
  it("uses the approved browser title once and the approved description", () => {
    expect(metadata.title).toEqual({ absolute: PAGE_TITLE });
    expect(metadata.description).toBe(PAGE_DESCRIPTION);
    expect(PAGE_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(metadata.openGraph).toMatchObject({ title: PAGE_TITLE, description: PAGE_DESCRIPTION });
    expect(metadata.twitter).toMatchObject({ title: PAGE_TITLE, description: PAGE_DESCRIPTION });
    expect(`${PAGE_TITLE} ${PAGE_DESCRIPTION}`).not.toMatch(/[\u2013\u2014]/);
  });

  it("advertises the RSS feed under the same name the feed carries", () => {
    const feeds = metadata.alternates?.types?.["application/rss+xml"] as Array<{ url: string; title: string }>;
    expect(feeds).toEqual([{ url: "https://hivra.cloud/changelog/rss.xml", title: CHANGELOG_FEED_TITLE }]);
    // The feed is named for the page, and says what the page's search description says.
    expect(PAGE_TITLE.startsWith(CHANGELOG_FEED_TITLE)).toBe(true);
    expect(CHANGELOG_FEED_DESCRIPTION).toBe(PAGE_DESCRIPTION);
  });

  it("describes the page in JSON-LD with the approved title and the data file's last-updated date", async () => {
    const { container } = render(await ChangelogPage());
    const script = container.querySelector('script[type="application/ld+json"]');
    const graph = JSON.parse(script?.textContent ?? "{}")["@graph"] as Array<Record<string, unknown>>;
    const page = graph.find((node) => node["@type"] === "WebPage");
    expect(page?.name).toBe(PAGE_TITLE);
    expect(page?.description).toBe(PAGE_DESCRIPTION);
    expect(page?.dateModified).toBe("2026-06-10");
  });
});
