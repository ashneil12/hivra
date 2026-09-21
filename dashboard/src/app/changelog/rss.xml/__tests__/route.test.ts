import { GET } from "../route";

// readChangelog() in the handler reads the real dashboard/hermes_changelog.md off
// disk (process.cwd() is the dashboard root under Jest), so this exercises the feed
// end-to-end against the shipped changelog content.
describe("GET /changelog/rss.xml", () => {
  it("returns 200 with an RSS content-type and a well-formed feed", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");

    const body = await res.text();
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(body).toContain('<rss version="2.0"');
    expect(body).toContain("<channel>");
    expect(body.trimEnd().endsWith("</rss>")).toBe(true);
  });

  it("lists changelog entries as items linking to dated /changelog anchors", async () => {
    const body = await (GET()).text();
    expect(body).toContain("<item>");
    expect(body).toMatch(/<link>https:\/\/hivra\.cloud\/changelog#\d{4}-\d{2}-\d{2}<\/link>/);
    expect(body).toMatch(/<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/);
  });

  it("advertises a public, cacheable response", async () => {
    const res = GET();
    expect(res.headers.get("cache-control")).toContain("s-maxage=3600");
  });
});
