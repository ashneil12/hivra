import {
  buildChangelogRssFeed,
  escapeXml,
  toRfc822,
  CHANGELOG_FEED_TITLE,
} from "../changelog-rss";
import type { ChangelogEntry } from "../changelog";

const SITE_URL = "https://hivra.cloud";

const ENTRIES: ChangelogEntry[] = [
  {
    date: "2026-06-21",
    title: "Agent Rename & Stronger Telegram Connect",
    body: "### Rename\n\nInline rename for agents <now> available.",
  },
  {
    date: "2026-05-29",
    title: "Earlier Entry",
    body: "Body text for the earlier entry.\n\n- Bullet one\n- Bullet two",
  },
];

function build(entries = ENTRIES, lastUpdated: string | null = "2026-06-21") {
  return buildChangelogRssFeed({ entries, lastUpdated, siteUrl: SITE_URL });
}

describe("toRfc822", () => {
  it("formats a YYYY-MM-DD date as an RFC-822 GMT string", () => {
    expect(toRfc822("2026-06-21")).toBe("Sun, 21 Jun 2026 00:00:00 GMT");
  });

  it("returns undefined for an unparseable date", () => {
    expect(toRfc822("not-a-date")).toBeUndefined();
  });
});

describe("escapeXml", () => {
  it("escapes the five XML metacharacters", () => {
    expect(escapeXml(`<a href="x" & 'y'>`)).toBe(
      "&lt;a href=&quot;x&quot; &amp; &apos;y&apos;&gt;",
    );
  });
});

describe("buildChangelogRssFeed", () => {
  it("emits a well-formed RSS 2.0 document with the atom self-link", () => {
    const xml = build();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
    expect(xml).toContain("<channel>");
    expect(xml).toContain("</channel>");
    expect(xml.trimEnd().endsWith("</rss>")).toBe(true);
    expect(xml).toContain(`<title>${CHANGELOG_FEED_TITLE}</title>`);
    expect(xml).toContain(`<link>${SITE_URL}/changelog</link>`);
    expect(xml).toContain(
      `<atom:link href="${SITE_URL}/changelog/rss.xml" rel="self" type="application/rss+xml" />`,
    );
  });

  it("renders one <item> per entry, newest-first, in source order", () => {
    const xml = build();
    const titles = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)].map(
      (m) => m[1],
    );
    expect(titles).toEqual([
      "Agent Rename &amp; Stronger Telegram Connect",
      "Earlier Entry",
    ]);
  });

  it("links each item to the dated /changelog#<date> anchor with a permalink guid", () => {
    const xml = build();
    expect(xml).toContain(`<link>${SITE_URL}/changelog#2026-06-21</link>`);
    expect(xml).toContain(
      `<guid isPermaLink="true">${SITE_URL}/changelog#2026-05-29</guid>`,
    );
  });

  it("derives a pubDate from each entry date", () => {
    const xml = build();
    expect(xml).toContain("<pubDate>Sun, 21 Jun 2026 00:00:00 GMT</pubDate>");
    expect(xml).toContain("<pubDate>Fri, 29 May 2026 00:00:00 GMT</pubDate>");
  });

  it("carries a non-empty description drawn from the entry body, wrapped in CDATA", () => {
    const xml = build();
    // The body keeps its raw '<now>' markup because CDATA does not require escaping it.
    expect(xml).toContain(
      "<description><![CDATA[### Rename\n\nInline rename for agents <now> available.]]></description>",
    );
    expect(xml).toContain("<![CDATA[Body text for the earlier entry.");
  });

  it("uses the lastUpdated marker for <lastBuildDate>", () => {
    expect(build()).toContain("<lastBuildDate>Sun, 21 Jun 2026 00:00:00 GMT</lastBuildDate>");
  });

  it("falls back to the newest entry date for <lastBuildDate> when no marker is given", () => {
    const xml = build(ENTRIES, null);
    expect(xml).toContain("<lastBuildDate>Sun, 21 Jun 2026 00:00:00 GMT</lastBuildDate>");
  });

  it("escapes XML metacharacters in titles and links but not inside CDATA bodies", () => {
    const xml = buildChangelogRssFeed({
      entries: [{ date: "2026-01-01", title: "A & B <C>", body: "raw </xml> & <b>tags</b>" }],
      lastUpdated: null,
      siteUrl: SITE_URL,
    });
    expect(xml).toContain("<title>A &amp; B &lt;C&gt;</title>");
    expect(xml).toContain("<![CDATA[raw </xml> & <b>tags</b>]]>");
  });

  it("neutralises a CDATA terminator appearing in a body", () => {
    const xml = buildChangelogRssFeed({
      entries: [{ date: "2026-01-01", title: "T", body: "danger ]]> here" }],
      lastUpdated: null,
      siteUrl: SITE_URL,
    });
    expect(xml).not.toContain("danger ]]> here");
    expect(xml).toContain("]]]]><![CDATA[>");
  });

  it("tolerates a trailing slash on the site url", () => {
    const xml = buildChangelogRssFeed({ entries: ENTRIES, lastUpdated: null, siteUrl: `${SITE_URL}/` });
    expect(xml).toContain(`<link>${SITE_URL}/changelog</link>`);
    expect(xml).not.toContain("//changelog");
  });

  it("produces a valid feed with no items when the changelog is empty", () => {
    const xml = buildChangelogRssFeed({ entries: [], lastUpdated: null, siteUrl: SITE_URL });
    expect(xml).toContain("<channel>");
    expect(xml).toContain("</rss>");
    expect(xml).not.toContain("<item>");
  });
});
