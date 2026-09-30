import { BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import { AGENT_PAGES_LAST_MODIFIED } from "@/lib/hivra/agent-seo-catalog";
import { PRICES_AS_OF } from "@/app/pricing/pricing-content";
import { dayToDate, PAGE_LAST_MODIFIED } from "../seo-lastmod";
import { CUTOVER_LAST_MODIFIED, getSiteUrls, SITE_URL } from "../seo-urls";

const day = (value: Date | string | number | undefined) => new Date(value as Date).toISOString().slice(0, 10);

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

  // Crawlers refetch on a newer lastmod, so pages rewritten for the cutover
  // must carry at least the cutover date.
  it("dates the pages the cutover rewrote no earlier than the cutover", () => {
    const urls = getSiteUrls();
    for (const path of ["", "/blog", "/privacy", "/features", "/compare", "/pricing", "/agents", "/tools"]) {
      const entry = urls.find((u) => u.url === `${SITE_URL}${path}`);
      expect({ path, defined: Boolean(entry) }).toEqual({ path, defined: true });
      expect(new Date(entry!.lastModified as Date).getTime()).toBeGreaterThanOrEqual(CUTOVER_LAST_MODIFIED.getTime());
    }
  });

  it("lists the changelog page but not its RSS feed: a feed is not a page", () => {
    const urls = getSiteUrls().map((u) => u.url);

    expect(urls).toContain(`${SITE_URL}/changelog`);
    expect(urls).not.toContain(`${SITE_URL}/changelog/rss.xml`);
    // No feed or plain-file URL belongs in a page sitemap.
    expect(urls.filter((url) => /\.(xml|md|txt|json)$/.test(url))).toEqual([]);
  });

  it("keeps /status in the sitemap", () => {
    expect(getSiteUrls().map((u) => u.url)).toContain(`${SITE_URL}/status`);
  });

  it("dates the /features and /compare detail pages to the 2026-09-24 truth pass and the hubs to their later rewrite", () => {
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
      const isHub = entry.url === `${SITE_URL}/features` || entry.url === `${SITE_URL}/compare`;
      // The hubs were rewritten again in plain English on 2026-09-30; the detail
      // pages share a template last changed in the 2026-09-24 truth pass.
      expect([entry.url, day(entry.lastModified)]).toEqual([entry.url, isHub ? "2026-09-30" : "2026-09-24"]);
    }
  });

  describe("lastmod is each page's real change date, not a release date", () => {
    const urls = () => new Map(getSiteUrls().map((entry) => [entry.url.slice(SITE_URL.length) || "/", entry]));

    it("takes every registry date from lib/seo-lastmod.ts, with the cutover as a floor only for the pages it rewrote", () => {
      const byPath = urls();
      const expectations: Array<[string, string, boolean]> = [
        ["/", PAGE_LAST_MODIFIED.home, true],
        ["/pricing", PAGE_LAST_MODIFIED.pricing, true],
        ["/features", PAGE_LAST_MODIFIED.featuresHub, true],
        ["/compare", PAGE_LAST_MODIFIED.compareHub, true],
        ["/tools", PAGE_LAST_MODIFIED.tools, true],
        ["/privacy", PAGE_LAST_MODIFIED.privacy, true],
        ["/agents", AGENT_PAGES_LAST_MODIFIED, true],
        ["/token", PAGE_LAST_MODIFIED.token, false],
        ["/why-hivra", PAGE_LAST_MODIFIED.whyHivra, false],
        ["/roadmap", PAGE_LAST_MODIFIED.roadmap, false],
        ["/changelog", PAGE_LAST_MODIFIED.changelog, false],
        ["/status", PAGE_LAST_MODIFIED.status, false],
        ["/stats", PAGE_LAST_MODIFIED.stats, false],
        ["/terms", PAGE_LAST_MODIFIED.terms, false],
      ];
      for (const [path, registryDay, floored] of expectations) {
        const expected = floored && dayToDate(registryDay) < CUTOVER_LAST_MODIFIED ? CUTOVER_LAST_MODIFIED : dayToDate(registryDay);
        expect([path, day(byPath.get(path)?.lastModified)]).toEqual([path, day(expected)]);
      }
    });

    it("does not stamp older pages with the cutover date: /terms, /status and /changelog keep their real dates", () => {
      const byPath = urls();
      for (const path of ["/terms", "/status", "/changelog"]) {
        const entry = byPath.get(path);
        expect({ path, present: Boolean(entry) }).toEqual({ path, present: true });
        expect(new Date(entry!.lastModified as Date).getTime()).toBeLessThan(CUTOVER_LAST_MODIFIED.getTime());
      }
      expect(day(byPath.get("/terms")?.lastModified)).toBe("2026-03-01");
    });

    it("follows each blog article's own lastModified, and the blog index follows the newest of them", () => {
      const byPath = urls();
      for (const article of BLOG_ARTICLES_LIST) {
        const entry = byPath.get(`/blog/${article.slug}`);
        expect([article.slug, day(entry?.lastModified)]).toEqual([
          article.slug,
          day(article.lastModified || article.publishedDate),
        ]);
      }
      const newest = BLOG_ARTICLES_LIST.map((article) => day(article.lastModified || article.publishedDate)).sort().at(-1)!;
      expect(day(byPath.get("/blog")?.lastModified)).toBe(newest > day(CUTOVER_LAST_MODIFIED) ? newest : day(CUTOVER_LAST_MODIFIED));
    });

    it("never dates a page in the future, and every date parses", () => {
      const now = Date.now();
      for (const entry of getSiteUrls()) {
        const time = new Date(entry.lastModified as Date).getTime();
        expect({ url: entry.url, valid: Number.isFinite(time) }).toEqual({ url: entry.url, valid: true });
        expect({ url: entry.url, future: time > now }).toEqual({ url: entry.url, future: false });
      }
    });

    it("never dates /pricing before the day its prices were checked", () => {
      // The page shows "Prices as of <date>"; its lastmod cannot be older.
      expect(new Date(urls().get("/pricing")!.lastModified as Date).getTime()).toBeGreaterThanOrEqual(
        dayToDate(PRICES_AS_OF).getTime(),
      );
    });

    it("uses more than a handful of distinct dates, because pages changed on different days", () => {
      const distinct = new Set(getSiteUrls().map((entry) => day(entry.lastModified)));
      expect(distinct.size).toBeGreaterThanOrEqual(8);
    });

    it("has a valid ISO day for every registry entry, and every entry is used by a sitemap URL", () => {
      for (const [key, value] of Object.entries(PAGE_LAST_MODIFIED)) {
        expect({ key, valid: /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(dayToDate(value).getTime()) }).toEqual({ key, valid: true });
      }
      const used = new Set(getSiteUrls().map((entry) => day(entry.lastModified)));
      for (const key of ["home", "pricing", "featuresHub", "compareHub", "whyHivra", "roadmap", "changelog", "status", "stats", "terms"] as const) {
        expect({ key, used: used.has(PAGE_LAST_MODIFIED[key]) }).toEqual({ key, used: true });
      }
    });
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
