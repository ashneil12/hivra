import type { ChangelogEntry } from "@/lib/changelog";

// Serialises the parsed changelog into an RSS 2.0 feed. Pure string-building so it
// can be unit-tested without a Next runtime; the route handler at
// app/changelog/rss.xml/route.ts wires readChangelog() into this. (#changelog-rss-feed)

/**
 * Channel-level copy, mirrored from the /changelog page so the feed reads the same: the title is the
 * page's name without its " | Product Updates and Fixes" strapline, and the description is the page's
 * search description word for word (app/changelog/__tests__/page.test.tsx holds the two together).
 */
export const CHANGELOG_FEED_TITLE = "Hivra Changelog";
export const CHANGELOG_FEED_DESCRIPTION =
  "Read what has changed on Hivra, from agent memory and browser sessions to reliability improvements and dashboard updates.";

export interface BuildChangelogRssOptions {
  /** Parsed entries, already newest-first (the order readChangelog returns). */
  entries: ChangelogEntry[];
  /** Optional "Last updated: YYYY-MM-DD" marker, used for <lastBuildDate>. */
  lastUpdated?: string | null;
  /** Absolute site origin, e.g. https://hivra.cloud (a trailing slash is tolerated). */
  siteUrl: string;
}

/** XML-escape text for safe use in element content and attribute values. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Convert a YYYY-MM-DD changelog date into an RFC-822 date string
 * (e.g. "Sun, 21 Jun 2026 00:00:00 GMT") for <pubDate>/<lastBuildDate>.
 * Returns undefined on an unparseable date so a malformed entry never emits an
 * invalid element.
 */
export function toRfc822(dateIso: string): string | undefined {
  const d = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toUTCString();
}

/** Wrap free-form (markdown) body text in CDATA, neutralising any nested terminator. */
function cdata(value: string): string {
  return `<![CDATA[${value.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

export function buildChangelogRssFeed({
  entries,
  lastUpdated,
  siteUrl,
}: BuildChangelogRssOptions): string {
  const base = siteUrl.replace(/\/+$/, "");
  const changelogUrl = `${base}/changelog`;
  const feedUrl = `${changelogUrl}/rss.xml`;

  const lastBuildDate =
    (lastUpdated ? toRfc822(lastUpdated) : undefined) ??
    (entries[0] ? toRfc822(entries[0].date) : undefined);

  const itemBlocks = entries.map((entry) => {
    const itemUrl = `${changelogUrl}#${entry.date}`;
    const pubDate = toRfc822(entry.date);
    return [
      "    <item>",
      `      <title>${escapeXml(entry.title)}</title>`,
      `      <link>${escapeXml(itemUrl)}</link>`,
      `      <guid isPermaLink="true">${escapeXml(itemUrl)}</guid>`,
      ...(pubDate ? [`      <pubDate>${pubDate}</pubDate>`] : []),
      `      <description>${cdata(entry.body.trim())}</description>`,
      "    </item>",
    ].join("\n");
  });

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(CHANGELOG_FEED_TITLE)}</title>`,
    `    <link>${escapeXml(changelogUrl)}</link>`,
    `    <description>${escapeXml(CHANGELOG_FEED_DESCRIPTION)}</description>`,
    "    <language>en</language>",
    `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`,
    ...(lastBuildDate ? [`    <lastBuildDate>${lastBuildDate}</lastBuildDate>`] : []),
    ...itemBlocks,
    "  </channel>",
    "</rss>",
  ];

  return `${lines.join("\n")}\n`;
}
