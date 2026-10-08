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

  // Guessed slugs of the laptop-close post that Search Console reported with
  // impressions. They 404ed on the retired build and on canary until this rule.
  it("sends every guessed laptop-post slug to the real post", async () => {
    const nextConfig = await loadHostedConfig();
    const { LAPTOP_POST_SLUG_VARIANTS } = await import("../../next.config");
    expect(LAPTOP_POST_SLUG_VARIANTS.length).toBeGreaterThan(10);
    for (const path of LAPTOP_POST_SLUG_VARIANTS) {
      const response = await unstable_getResponseFromNextConfig({ url: `https://hivra.cloud${path}`, nextConfig });
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe("https://hivra.cloud/blog/keep-claude-code-running-24-7");
    }
  });

  it("does not redirect the real post or other blog slugs", async () => {
    const nextConfig = await loadHostedConfig();
    for (const path of ["/blog/keep-claude-code-running-24-7", "/blog/codex-resume-session"]) {
      const response = await unstable_getResponseFromNextConfig({ url: `https://hivra.cloud${path}`, nextConfig });
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("sends the retired roadmap PDF to the roadmap page", async () => {
    const nextConfig = await loadHostedConfig();
    const response = await unstable_getResponseFromNextConfig({
      url: "https://hivra.cloud/roadmap/HermesOS_Roadmap_2026.pdf",
      nextConfig,
    });
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://hivra.cloud/roadmap");
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
