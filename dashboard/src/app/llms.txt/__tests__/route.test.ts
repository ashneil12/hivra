import { GET } from "../route";
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
    expect(body).toMatch(/\n> Hivra \(formerly HermesOS\) is managed cloud hosting/);
    // Markdown link sections.
    expect(body).toContain("## Product");
    expect(body).toContain("## Updates");
    expect(body).toContain("## Status");
    expect(body).toContain("## Legal");
  });

  it("links every curated public page as an absolute SITE_URL-based URL — no auth/api/404 links", async () => {
    const body = await GET().text();

    const expectedUrls = [
      SITE_URL, // home
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

  it("advertises a public, cacheable response", () => {
    expect(GET().headers.get("cache-control")).toContain("s-maxage=3600");
  });
});
