import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import type { NextConfig } from "next";

jest.mock("next/headers", () => ({
  headers: jest.fn(async () => new Headers({ host: "operator.example.test" })),
}));

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  jest.resetModules();
});

async function loadConfig(mode: "local" | "hosted"): Promise<NextConfig> {
  process.env.HIVRA_AUTH_MODE = mode;
  process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = mode;
  jest.resetModules();
  return (await import("../../next.config")).default;
}

const marketingPaths = ["/", "/blog", "/blog/how-ai-agents-work", "/features", "/features/persistent-memory", "/compare/hermes", "/token", "/tokenomics", "/why-hivra/evolution"];

describe("self-host website boundary", () => {
  it("redirects commercial pages into the local app", async () => {
    const nextConfig = await loadConfig("local");
    for (const path of marketingPaths) {
      const response = await unstable_getResponseFromNextConfig({
        url: `https://operator.example.test${path}`, nextConfig,
      });
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("https://operator.example.test/dashboard");
    }
  });

  it("keeps operational, authentication, documentation and similarly named routes available", async () => {
    const nextConfig = await loadConfig("local");
    for (const path of ["/dashboard", "/dashboard/infrastructure", "/sign-in", "/api/self-host/auth/login", "/docs/litepaper/index.html", "/blogger", "/features-extra", "/robots.txt", "/sitemap.xml", "/favicon.ico", "/brand/hivra-icon-192.png"]) {
      const response = await unstable_getResponseFromNextConfig({
        url: `https://operator.example.test${path}`, nextConfig,
      });
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
  });

  it("keeps hosted marketing routes available and indexable", async () => {
    const nextConfig = await loadConfig("hosted");
    for (const path of marketingPaths) {
      const response = await unstable_getResponseFromNextConfig({
        url: `https://hivra.cloud${path}`, nextConfig,
      });
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("X-Robots-Tag")).toBeNull();
    }
  });

  it("does not advertise Hivra's public sitemap from an independent installation", async () => {
    await loadConfig("local");
    const robots = (await import("@/app/robots")).default;
    const sitemap = (await import("@/app/sitemap")).default;
    expect(await robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    expect(sitemap()).toEqual([]);
  });

  it("preserves the existing Canary crawl block in hosted mode", async () => {
    await loadConfig("hosted");
    const { headers } = await import("next/headers");
    (headers as jest.Mock).mockResolvedValue(new Headers({ host: "canary.hermesos.cloud" }));
    const robots = (await import("@/app/robots")).default;
    expect(await robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });

  it.each(["hermesos-canary.vercel.app", "hermesos.vercel.app"])(
    "blocks crawling of the %s deployment alias in hosted mode",
    async (host) => {
      await loadConfig("hosted");
      const { headers } = await import("next/headers");
      (headers as jest.Mock).mockResolvedValue(new Headers({ host }));
      const robots = (await import("@/app/robots")).default;
      expect(await robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    },
  );

  it("preserves public discovery in hosted mode", async () => {
    await loadConfig("hosted");
    const robots = (await import("@/app/robots")).default;
    const sitemap = (await import("@/app/sitemap")).default;
    expect(await robots()).toMatchObject({ sitemap: "https://hivra.cloud/sitemap.xml" });
    expect(sitemap()).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://hivra.cloud/blog" }),
    ]));
  });
});
