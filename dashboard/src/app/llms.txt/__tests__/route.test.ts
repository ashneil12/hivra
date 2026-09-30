import fs from "fs";
import path from "path";

import { GET } from "../route";
import { SITE_DESCRIPTION } from "@/lib/brand-description";
import { SITE_URL } from "@/lib/seo-urls";

// Exercises the live /llms.txt route end-to-end against the shipped link map.
describe("GET /llms.txt", () => {
  it("returns 200 with a text/plain content-type", () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("is a well-formed llms.txt: H1 product line, blurb, and Markdown link sections", async () => {
    const body = await GET().text();

    // H1 product line first.
    expect(body.startsWith("# Hivra\n")).toBe(true);
    // A short '> ' description blurb.
    expect(body).toContain(`\n> ${SITE_DESCRIPTION}\n`);
    // Markdown link sections.
    expect(body).toContain("## Product");
    expect(body).toContain("## Updates");
    expect(body).toContain("## Papers");
    expect(body).toContain("## Source and self-hosting");
    expect(body).toContain("## Status");
    expect(body).toContain("## Legal");
  });

  it("links every curated public page as an absolute SITE_URL-based URL — no auth/api/404 links", async () => {
    const body = await GET().text();

    const expectedUrls = [
      SITE_URL, // home
      `${SITE_URL}/agents`,
      `${SITE_URL}/pricing`,
      `${SITE_URL}/tools`,
      `${SITE_URL}/features`,
      `${SITE_URL}/why-hivra`,
      `${SITE_URL}/compare`,
      `${SITE_URL}/blog`,
      `${SITE_URL}/changelog`,
      `${SITE_URL}/changelog/rss.xml`,
      `${SITE_URL}/roadmap`,
      `${SITE_URL}/status`,
      `${SITE_URL}/stats`,
      `${SITE_URL}/privacy`,
      `${SITE_URL}/terms`,
      `${SITE_URL}/about`,
      `${SITE_URL}/security`,
      `${SITE_URL}/ecosystem`,
      `${SITE_URL}/LITEPAPER.md`,
      `${SITE_URL}/WHITEPAPER.md`,
      `${SITE_URL}/TOKENOMICS.md`,
      `${SITE_URL}/token`,
      "https://github.com/ashneil12/hivra",
      "https://github.com/ashneil12/hivra/blob/main/docs/self-host/QUICKSTART.md",
    ];
    for (const url of expectedUrls) {
      expect(body).toContain(`(${url})`);
    }

    // No dashboard/auth/api surfaces leak into the public crawler map.
    expect(body).not.toMatch(/\/dashboard/);
    expect(body).not.toMatch(/\/api\//);
    expect(body).not.toMatch(/\/sign-in/);
    expect(body).not.toMatch(/\/get-started/);
  });

  it("only links site paths that the app, the staged papers or public/ actually serve", async () => {
    // Every same-site link must answer 200 on the build that ships it. The app
    // routes and public files are checked on disk; the three papers are staged
    // into public/ from the repository root by scripts/stage-litepaper.mjs.
    const dashboardRoot = path.join(__dirname, "..", "..", "..", "..");
    const repoRoot = path.join(dashboardRoot, "..");
    const appRoot = path.join(dashboardRoot, "src", "app");
    const exists = (file: string) => fs.existsSync(file);
    const body = await GET().text();
    const sitePaths = [...body.matchAll(/\]\(([^)\s]+)\)/g)]
      .map(match => match[1])
      .filter(url => url === SITE_URL || url.startsWith(`${SITE_URL}/`))
      .map(url => new URL(url).pathname);

    expect(sitePaths.length).toBeGreaterThan(15);
    const missing = sitePaths.filter(pathname => {
      if (pathname === "/") return !exists(path.join(appRoot, "page.tsx"));
      const relative = pathname.slice(1);
      const routeDir = path.join(appRoot, relative);
      if (exists(path.join(routeDir, "page.tsx")) || exists(path.join(routeDir, "route.ts"))) return false;
      if (/^\/(LITEPAPER|WHITEPAPER|TOKENOMICS)\.md$/.test(pathname)) return !exists(path.join(repoRoot, relative));
      return !exists(path.join(dashboardRoot, "public", relative));
    });
    expect(missing).toEqual([]);
  });

  it("advertises a public, cacheable response", () => {
    expect(GET().headers.get("cache-control")).toContain("s-maxage=3600");
  });
});
