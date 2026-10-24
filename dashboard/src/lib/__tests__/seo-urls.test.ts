import { COMPETITOR_FACTS_CHECKED } from "@/lib/compare/competitor-facts";
import { BLOG_ARTICLES_LIST } from "@/lib/blog-data";
import { AGENT_PAGES_LAST_MODIFIED } from "@/lib/hivra/agent-seo-catalog";
import { PRICES_AS_OF } from "@/app/pricing/pricing-content";
import { dayToDate, PAGE_LAST_MODIFIED, TOOL_PAGE_LAST_MODIFIED, type PageLastModifiedKey } from "../seo-lastmod";
import { TOOL_ENTRIES } from "@/lib/tools/tool-catalog";
import { CUTOVER_LAST_MODIFIED, getSiteUrls, SITE_URL } from "../seo-urls";

const day = (value: Date | string | number | undefined) => new Date(value as Date).toISOString().slice(0, 10);

/** A registry day as the sitemap shows it: the cutover date is a floor for the pages the cutover rewrote. */
function withFloor(registryDay: string, floored: boolean): Date {
  const real = dayToDate(registryDay);
  return floored && real < CUTOVER_LAST_MODIFIED ? CUTOVER_LAST_MODIFIED : real;
}

/** The sitemap as seo-urls.ts builds it from a registry with some days replaced. */
async function sitemapWithRegistry(overrides: Partial<Record<PageLastModifiedKey, string>>) {
  let urls: ReturnType<typeof getSiteUrls> = [];
  await jest.isolateModulesAsync(async () => {
    jest.doMock("@/lib/seo-lastmod", () => {
      const actual = jest.requireActual<typeof import("../seo-lastmod")>("@/lib/seo-lastmod");
      return { ...actual, PAGE_LAST_MODIFIED: { ...actual.PAGE_LAST_MODIFIED, ...overrides } };
    });
    const isolated = await import("../seo-urls");
    urls = isolated.getSiteUrls();
  });
  jest.dontMock("@/lib/seo-lastmod");
  return new Map(urls.map((entry) => [entry.url.slice(SITE_URL.length) || "/", entry]));
}

// The day the copy of the whole public site was rewritten (the website copy overhaul).
const OVERHAUL_DAY = "2026-10-20";

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

    for (const path of ["/changelog", "/week", "/status", "/stats"]) {
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

  it("lists the ecosystem map, with its registry date, whether or not the token surfaces are on", () => {
    for (const tokenSurfaces of [true, false]) {
      const entry = getSiteUrls({ tokenSurfaces }).find((u) => u.url === `${SITE_URL}/ecosystem`);
      expect({ tokenSurfaces, present: Boolean(entry) }).toEqual({ tokenSurfaces, present: true });
      expect(day(entry!.lastModified)).toBe(PAGE_LAST_MODIFIED.ecosystem);
      expect(entry?.changeFrequency).toBe("monthly");
    }
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

  it("lists the trust pages: /about (the entity home) and /security", () => {
    const urls = getSiteUrls();
    const registryDay = { "/about": PAGE_LAST_MODIFIED.about, "/security": PAGE_LAST_MODIFIED.security };
    for (const path of ["/about", "/security"] as const) {
      const entry = urls.find((u) => u.url === `${SITE_URL}${path}`);
      expect({ path, present: Boolean(entry) }).toEqual({ path, present: true });
      expect(day(entry!.lastModified)).toBe(registryDay[path]);
    }
  });

  it("dates the /features and /compare pages from the registry, and the host comparisons from the day their competitor numbers were read", () => {
    const urls = getSiteUrls();
    const rewritten = urls.filter((u) => /\/(features|compare)(\/|$)/.test(u.url));
    // 2 hubs + 6 feature pages + 9 comparison pages.
    expect(rewritten.map((u) => u.url.slice(SITE_URL.length)).sort()).toEqual(
      [
        "/compare",
        "/compare/ai-agent-hosting-alternatives",
        "/compare/openclaw-to-hermes",
        "/compare/vs-agent-37",
        "/compare/vs-hostinger",
        "/compare/vs-nous-hermes-cloud",
        "/compare/vs-railway",
        "/compare/vs-render",
        "/compare/vs-self-hosted",
        "/compare/vs-xcloud",
        "/features",
        "/features/browser-automation",
        "/features/multi-agent",
        "/features/no-docker-hosting",
        "/features/openclaw-alternative",
        "/features/persistent-memory",
        "/features/scheduled-tasks",
      ].sort(),
    );
    // The four host comparisons carry the later of the date their competitor
    // numbers were read (competitor-facts.ts) and the detail date, because their
    // text changed with the copy overhaul; everything else follows the registry's
    // hub and detail dates (lib/seo-lastmod.ts).
    const factsPages = new Set(["/compare/vs-agent-37", "/compare/vs-hostinger", "/compare/vs-xcloud", "/compare/vs-nous-hermes-cloud"]);
    for (const entry of rewritten) {
      const path = entry.url.slice(SITE_URL.length);
      const registryDay =
        path === "/features" ? PAGE_LAST_MODIFIED.featuresHub
        : path === "/compare" ? PAGE_LAST_MODIFIED.compareHub
        : factsPages.has(path) ? (COMPETITOR_FACTS_CHECKED > PAGE_LAST_MODIFIED.compareDetail ? COMPETITOR_FACTS_CHECKED : PAGE_LAST_MODIFIED.compareDetail)
        : path.startsWith("/features/") ? PAGE_LAST_MODIFIED.featureDetail
        : PAGE_LAST_MODIFIED.compareDetail;
      expect([entry.url, day(entry.lastModified)]).toEqual([entry.url, day(withFloor(registryDay, true))]);
    }
  });

  describe("lastmod is each page's real change date, not a release date", () => {
    const urls = () => new Map(getSiteUrls().map((entry) => [entry.url.slice(SITE_URL.length) || "/", entry]));

    // One route per registry key. Every key must appear: a key no route reads would never move a sitemap date.
    const REGISTRY_ROUTES: Array<[path: string, key: PageLastModifiedKey, floored: boolean]> = [
      ["/", "home", true],
      ["/pricing", "pricing", true],
      ["/features", "featuresHub", true],
      ["/features/persistent-memory", "featureDetail", true],
      ["/compare", "compareHub", true],
      ["/compare/vs-self-hosted", "compareDetail", true],
      ["/tools", "tools", true],
      ["/privacy", "privacy", true],
      ["/token", "token", false],
      ["/why-hivra", "whyHivra", false],
      ["/ecosystem", "ecosystem", false],
      ["/roadmap", "roadmap", false],
      ["/changelog", "changelog", false],
      ["/week", "week", false],
      ["/status", "status", false],
      ["/stats", "stats", false],
      ["/terms", "terms", false],
      ["/about", "about", false],
      ["/security", "security", false],
    ];

    it("takes every registry date from lib/seo-lastmod.ts, with the cutover as a floor only for the pages it rewrote", () => {
      const byPath = urls();
      for (const [path, key, floored] of REGISTRY_ROUTES) {
        expect([path, day(byPath.get(path)?.lastModified)]).toEqual([path, day(withFloor(PAGE_LAST_MODIFIED[key], floored))]);
      }
      // The agent pages carry their date in the agent catalog.
      expect(["/agents", day(byPath.get("/agents")?.lastModified)]).toEqual(["/agents", day(withFloor(AGENT_PAGES_LAST_MODIFIED, true))]);
    });

    it("reads every key of the registry through some route", () => {
      expect(new Set(REGISTRY_ROUTES.map(([, key]) => key))).toEqual(new Set(Object.keys(PAGE_LAST_MODIFIED)));
    });

    it("dates each tool page by its own content, and the hub by the list of tools it shows", () => {
      const byPath = urls();
      // A key for every tool, and no key for a tool that is gone.
      expect(Object.keys(TOOL_PAGE_LAST_MODIFIED).sort()).toEqual(TOOL_ENTRIES.map((entry) => entry.slug).sort());
      for (const entry of TOOL_ENTRIES) {
        const expected = withFloor(TOOL_PAGE_LAST_MODIFIED[entry.slug], true);
        expect([entry.slug, day(byPath.get(`/tools/${entry.slug}`)?.lastModified)]).toEqual([entry.slug, day(expected)]);
        // No tool page is newer than the hub that lists it.
        expect(TOOL_PAGE_LAST_MODIFIED[entry.slug] <= PAGE_LAST_MODIFIED.tools).toBe(true);
      }
      expect(day(byPath.get("/tools")?.lastModified)).toBe(day(withFloor(PAGE_LAST_MODIFIED.tools, true)));
    });

    it("dates every page of the website copy overhaul no earlier than the day its copy was rewritten", () => {
      const byPath = urls();
      const toolRoutes = TOOL_ENTRIES.map((entry) => `/tools/${entry.slug}`);
      const featureRoutes = [...byPath.keys()].filter((path) => path.startsWith("/features"));
      const compareRoutes = [...byPath.keys()].filter((path) => path.startsWith("/compare"));
      // The agent pages and the four host comparisons take their dates from lib/hivra/agent-seo-catalog.ts
      // and lib/compare/competitor-facts.ts, which the page work owns, so they are not listed here.
      const factsPages = new Set(["/compare/vs-agent-37", "/compare/vs-hostinger", "/compare/vs-xcloud", "/compare/vs-nous-hermes-cloud"]);
      const routes = [
        "/", "/about", "/why-hivra", "/pricing", "/ecosystem", "/tools", "/security", "/roadmap", "/changelog", "/terms", "/privacy", "/stats", "/status",
        ...toolRoutes,
        ...featureRoutes,
        ...compareRoutes.filter((path) => !factsPages.has(path)),
      ];
      expect(routes.length).toBeGreaterThanOrEqual(13 + 6 + 7 + 6);
      for (const path of routes) {
        const entry = byPath.get(path);
        expect({ path, present: Boolean(entry) }).toEqual({ path, present: true });
        expect({ path, onOrAfter: day(entry!.lastModified) >= OVERHAUL_DAY }).toEqual({ path, onOrAfter: true });
      }
    });

    it("keeps the utility pages that carry no copy of their own out of the sitemap", () => {
      const listed = new Set(urls().keys());
      for (const path of ["/download", "/get-started", "/get-started/activate", "/reserve", "/reserved", "/checkout/canceled", "/newupdate", "/offline"]) {
        expect({ path, listed: listed.has(path) }).toEqual({ path, listed: false });
      }
    });

    it("keeps a page's own earlier date when it is older than the cutover, except for the pages the cutover floored", async () => {
      // The registry holds the copy overhaul day today. These are the dates /terms, /status and /changelog
      // held before it: a registry that still has an old day must not be stamped with the cutover date.
      const byPath = await sitemapWithRegistry({ terms: "2026-03-01", status: "2026-06-22", changelog: "2026-06-21", whyHivra: "2026-09-30" });
      expect(day(byPath.get("/terms")?.lastModified)).toBe("2026-03-01");
      expect(day(byPath.get("/status")?.lastModified)).toBe("2026-06-22");
      expect(day(byPath.get("/changelog")?.lastModified)).toBe("2026-06-21");
      expect(day(byPath.get("/why-hivra")?.lastModified)).toBe("2026-09-30");
      for (const path of ["/terms", "/status", "/changelog"]) {
        expect(new Date(byPath.get(path)!.lastModified as Date).getTime()).toBeLessThan(CUTOVER_LAST_MODIFIED.getTime());
      }
    });

    it("floors the pages the cutover rewrote at the cutover date, and lets a later real date through", async () => {
      const byPath = await sitemapWithRegistry({ home: "2026-09-01", pricing: "2026-09-03", privacy: "2026-09-02", tools: "2026-10-02" });
      for (const path of ["/", "/pricing", "/privacy"]) {
        expect([path, day(byPath.get(path)?.lastModified)]).toEqual([path, day(CUTOVER_LAST_MODIFIED)]);
      }
      expect(day(byPath.get("/tools")?.lastModified)).toBe("2026-10-02");
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

    it("uses more than one date, because pages changed on different days", () => {
      // The blog posts keep the day each was last revised, so dates still differ even
      // though the rewritten pages share the copy overhaul day; a site-wide bump of
      // everything, blog included, would collapse them to one.
      const distinct = new Set(getSiteUrls().map((entry) => day(entry.lastModified)));
      expect(distinct.size).toBeGreaterThanOrEqual(4);
    });

    it("has a valid ISO day for every registry entry", () => {
      for (const [key, value] of Object.entries(PAGE_LAST_MODIFIED)) {
        expect({ key, valid: /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(dayToDate(value).getTime()) }).toEqual({ key, valid: true });
      }
      for (const [slug, value] of Object.entries(TOOL_PAGE_LAST_MODIFIED)) {
        expect({ slug, valid: /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(dayToDate(value).getTime()) }).toEqual({ slug, valid: true });
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
