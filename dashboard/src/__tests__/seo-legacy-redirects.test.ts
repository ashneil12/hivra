import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import type { NextConfig } from "next";

jest.mock("next/headers", () => ({
  headers: jest.fn(async () => new Headers({ host: "hivra.cloud" })),
}));

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  jest.resetModules();
});

async function loadHostedConfig(): Promise<NextConfig> {
  process.env.HIVRA_AUTH_MODE = "hosted";
  process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "hosted";
  jest.resetModules();
  return (await import("../../next.config")).default;
}

describe("legacy SEO redirects", () => {
  // The retired private build served these as 308s; without them the URLs 404
  // after cutover and their links and rankings are lost.
  it.each([["/faq", "https://hivra.cloud/#faq"]])("permanently redirects %s", async (path, location) => {
    const nextConfig = await loadHostedConfig();
    const response = await unstable_getResponseFromNextConfig({
      url: `https://hivra.cloud${path}`,
      nextConfig,
    });

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(location);
  });

  // /about used to 308 to the founder essay. It is now the entity home page, so
  // no redirect may shadow it: a redirect here would hide the page from
  // crawlers and from everyone who follows the footer link.
  it("serves /about and /security as pages instead of redirecting them", async () => {
    const nextConfig = await loadHostedConfig();
    const redirects = (await nextConfig.redirects?.()) ?? [];
    expect(redirects.map((rule) => rule.source)).not.toContain("/about");
    expect(redirects.map((rule) => rule.source)).not.toContain("/security");

    for (const path of ["/about", "/security"]) {
      const response = await unstable_getResponseFromNextConfig({
        url: `https://hivra.cloud${path}`,
        nextConfig,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    }
  });
});
