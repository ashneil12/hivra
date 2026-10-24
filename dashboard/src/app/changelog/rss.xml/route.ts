// Public RSS 2.0 feed for the changelog: GET /changelog/rss.xml. Serialises the
// same readChangelog() entries the /changelog page renders into a subscribable
// feed: public-surface, read-only output, no auth, no tenant data, no writes.
// (#changelog-rss-feed)

import { readChangelog, resolveChangelogEntries } from "@/lib/changelog";
import { buildChangelogRssFeed } from "@/lib/changelog-rss";
import { SITE_URL } from "@/lib/seo-urls";

// readChangelog() reads hermes_changelog.md off disk, so this route needs the Node
// runtime; next.config.ts traces the markdown into the route's bundle. The feed only
// changes on deploy (the file is bundled), so render it statically.
export const runtime = "nodejs";
export const dynamic = "force-static";

export function GET() {
  const { entries, lastUpdated } = readChangelog();
  // The feed is rendered once and cached for everyone, so it carries the wording that holds for any
  // viewer: the Bankr section is its plain variant (the page shows the full note to viewers who may see it).
  const xml = buildChangelogRssFeed({ entries: resolveChangelogEntries(entries, false), lastUpdated, siteUrl: SITE_URL });

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
