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
  it("dates the rewritten /features and /compare pages to the 2026-09-24 truth pass so crawlers refetch them", () => {
    const urls = getSiteUrls();
    const rewritten = urls.filter((u) => /\/(features|compare)(\/|$)/.test(u.url));
    // 2 hubs + 6 feature pages + 5 comparison pages.
    expect(rewritten.map((u) => u.url.slice(SITE_URL.length)).sort()).toEqual(
      [
        "/compare",
        "/compare/ai-agent-hosting-alternatives",
        "/compare/openclaw-to-hermes",
        "/compare/vs-railway",
        "/compare/vs-render",
        "/compare/vs-self-hosted",
        "/features",
        "/features/browser-automation",
        "/features/multi-agent",
        "/features/no-docker-hosting",
        "/features/openclaw-alternative",
        "/features/persistent-memory",
        "/features/scheduled-tasks",
      ].sort(),
    );
    for (const entry of rewritten) {
      expect([entry.url, new Date(entry.lastModified as Date).toISOString().slice(0, 10)]).toEqual([entry.url, "2026-09-24"]);
    }
  });

  it("keeps every page the retired site had indexed: /pricing, /agents and /tools with their children", () => {
    const urls = new Set(getSiteUrls().map((entry) => entry.url));
    for (const path of [
      "/pricing",
      "/agents",
      "/agents/claude-code",
      "/agents/codex",
      "/agents/hermes",
      "/agents/openclaw",
      "/agents/agent-zero",
      "/agents/aeon",
      "/tools",
      "/tools/agent-survival-check",
      "/tools/ai-agent-hosting-cost-calculator",
      "/tools/claude-code-limit-reset-calculator",
      "/tools/claude-code-plan-calculator",
      "/blog/keep-claude-code-running-24-7",
      "/blog/run-codex-24-7-in-the-cloud",
    ]) {
      expect(urls.has(`${SITE_URL}${path}`)).toBe(true);
    }
  });
});
