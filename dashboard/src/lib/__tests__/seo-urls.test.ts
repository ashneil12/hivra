import { getSiteUrls, SITE_URL } from "../seo-urls";

describe("seo urls", () => {
  it("includes the token verification page in the sitemap", () => {
    const urls = getSiteUrls();

    expect(urls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: `${SITE_URL}/token`,
        }),
      ])
    );
  });

  it("includes the live public pages (/changelog, /status, /stats) so crawlers can discover them", () => {
    const urls = getSiteUrls();

    for (const path of ["/changelog", "/status", "/stats"]) {
      const entry = urls.find((u) => u.url === `${SITE_URL}${path}`);
      expect(entry).toBeDefined();
      // Each new entry carries a valid lastModified date and weekly cadence,
      // consistent with the surrounding public-page entries.
      expect(entry?.lastModified).toBeInstanceOf(Date);
      expect(Number.isNaN(new Date(entry!.lastModified as Date).getTime())).toBe(false);
      expect(entry?.changeFrequency).toBe("weekly");
    }
  });

  it("includes the public roadmap page in the sitemap", () => {
    const urls = getSiteUrls();
    const entry = urls.find((u) => u.url === `${SITE_URL}/roadmap`);
    expect(entry).toBeDefined();
    expect(entry?.lastModified).toBeInstanceOf(Date);
  });

  it("reports honest, non-stale lastmod dates on the key marketing pages", () => {
    const urls = getSiteUrls();

    // These surfaces were genuinely refreshed in the 2026-07 brand-bridge pass;
    // their lastmod must never regress to the stale 2026-04-05 placeholder.
    const keyPages = ["", "/blog", "/features", "/compare", "/why-hivra"];
    for (const path of keyPages) {
      const entry = urls.find((u) => u.url === `${SITE_URL}${path}`);
      expect(entry).toBeDefined();
      expect(new Date(entry!.lastModified as Date).getTime()).toBeGreaterThanOrEqual(
        new Date("2026-07-01").getTime()
      );
    }
  });

  it("keeps the changelog HTML page distinct from its RSS feed entry", () => {
    const urls = getSiteUrls();
    const htmlPage = urls.find((u) => u.url === `${SITE_URL}/changelog`);
    const rssFeed = urls.find((u) => u.url === `${SITE_URL}/changelog/rss.xml`);

    // Both must be present and remain separate sitemap entries.
    expect(htmlPage).toBeDefined();
    expect(rssFeed).toBeDefined();
  });
});
