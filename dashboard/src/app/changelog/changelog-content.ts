// Introductory copy for /changelog, from the approved page copy. The release entries
// themselves are not here: they are read, untouched, from dashboard/hermes_changelog.md
// by lib/changelog.ts, so the dated notes, their wording and their anchors stay as shipped.

export const CHANGELOG_COPY = {
  masthead: {
    heading: "What we've been building.",
    paragraphs: [
      "A record of the practical changes we've made to Hivra. Some releases bring a new capability. Others are the fixes that make an agent easier to live with: reconnecting to Telegram, recovering an instance or finding out what happened during a run.",
      "We keep both kinds of work here. This page is a shipping history, not a promise that every future feature is available.",
    ],
  },
  list: {
    eyebrow: "Changelog",
    heading: "What we have shipped",
    lede: "Dated notes on notable changes to Hivra: bug fixes, new features, upstream syncs and infrastructure work.",
    /**
     * Says where the list stops, from the date of its newest entry (read from the changelog file, never typed
     * here), so the intro does not read as a current record when it is not. It stays true whatever entry is added.
     */
    coverage: (newestEntryDate: string) =>
      `The newest entry is dated ${newestEntryDate}. Later changes are not listed here.`,
    lastUpdated: "Last updated",
  },
} as const;
