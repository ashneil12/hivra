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
  it.each([
    ["/faq", "https://hivra.cloud/#faq"],
    ["/about", "https://hivra.cloud/why-hivra"],
  ])("permanently redirects %s", async (path, location) => {
    const nextConfig = await loadHostedConfig();
    const response = await unstable_getResponseFromNextConfig({
      url: `https://hivra.cloud${path}`,
      nextConfig,
    });

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(location);
  });
});
