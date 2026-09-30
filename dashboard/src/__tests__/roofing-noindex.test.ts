import fs from "fs";
import path from "path";
import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import type { Header, Rewrite } from "next/dist/lib/load-custom-routes";
import { modifyRouteRegex } from "next/dist/lib/redirect-status";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";

import { getSiteUrls, SITE_URL } from "@/lib/seo-urls";
import nextConfig from "../../next.config";

jest.mock("next/headers", () => ({
  headers: jest.fn(async () => new Headers({ host: "hivra.cloud" })),
}));

// /roofing is an off-topic page ("AI Receptionist for Roofing Companies") that
// hivra.cloud served as an indexable 200. It stays up for the outreach that
// points at it, but search engines must not index it under Hivra.
async function headersFor(pathname: string): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const rule of ((await nextConfig.headers?.()) ?? []) as Header[]) {
    const matched = getPathMatch(rule.source, {
      strict: true,
      removeUnnamedParams: true,
      regexModifier: (regex: string) => modifyRouteRegex(regex),
    })(pathname);
    if (!matched) continue;
    for (const header of rule.headers) resolved[header.key.toLowerCase()] = header.value;
  }
  return resolved;
}

describe("/roofing stays up but is not indexable", () => {
  it.each(["/roofing", "/roofing.html"])("sends X-Robots-Tag noindex on %s", async (pathname) => {
    expect((await headersFor(pathname))["x-robots-tag"]).toBe("noindex, nofollow");
  });

  it("does not noindex the marketing pages around it", async () => {
    for (const pathname of ["/", "/pricing", "/agents/claude-code", "/roofing-tips"]) {
      expect((await headersFor(pathname))["x-robots-tag"]).toBeUndefined();
    }
  });

  it("still serves the page: /roofing rewrites to the static file, which carries a robots meta tag", async () => {
    const rewrites = ((await nextConfig.rewrites?.()) ?? []) as Rewrite[];
    const rule = (Array.isArray(rewrites) ? rewrites : []).find(entry => entry.source === "/roofing");
    expect(rule?.destination).toBe("/roofing.html");
    // The manifest regex (what Vercel's edge matches) agrees with the source.
    expect(new RegExp(buildCustomRoute("rewrite", rule!).regex, "i").test("/roofing")).toBe(true);

    const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "roofing.html"), "utf8");
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"\s*\/>/);
    expect(html).toContain("<title>AI Receptionist for Roofing Companies | Hivra</title>");
  });

  it("keeps /roofing out of the sitemap and lets crawlers fetch it to see the noindex", async () => {
    expect(getSiteUrls().map(entry => entry.url).filter(url => /roofing/i.test(url))).toEqual([]);
    expect(SITE_URL).toBe("https://hivra.cloud");

    // A robots.txt Disallow would hide the noindex from Google (canary's own
    // Disallow: / hides its header for the same reason), so it must stay allowed.
    const robots = (await import("@/app/robots")).default;
    const { rules } = await robots();
    const disallow = ([] as string[]).concat(
      ...(Array.isArray(rules) ? rules : [rules]).map(rule => rule.disallow ?? []),
    );
    expect(disallow.filter(entry => /roofing/i.test(entry))).toEqual([]);
  });
});
