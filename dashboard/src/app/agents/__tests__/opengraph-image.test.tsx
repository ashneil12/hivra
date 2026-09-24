// The /agents OG cards come from the shared public renderer (lib/og-card) and
// are wired into each page's openGraph/twitter image metadata by URL.

import HubOg, { alt as hubAlt, contentType as hubContentType, size as hubSize } from "../opengraph-image";
import AgentOg, {
  alt as agentAlt,
  contentType as agentContentType,
  generateStaticParams as generateOgParams,
  size as agentSize,
} from "../[slug]/opengraph-image";
import { metadata as hubMetadata } from "../page";
import { generateMetadata } from "../[slug]/page";
import { AGENT_SEO_ENTRIES } from "@/lib/hivra/agent-seo-catalog";

describe("/agents OG cards", () => {
  it("use the standard 1200x630 PNG card with alt text", () => {
    for (const [size, contentType, alt] of [
      [hubSize, hubContentType, hubAlt],
      [agentSize, agentContentType, agentAlt],
    ] as const) {
      expect(size).toEqual({ width: 1200, height: 630 });
      expect(contentType).toBe("image/png");
      expect(alt).toMatch(/Hivra/);
    }
  });

  it("render an image/png response for the hub and every agent", async () => {
    const hub = await HubOg();
    expect(hub.status).toBe(200);
    expect(hub.headers.get("content-type")).toBe("image/png");
    expect(generateOgParams()).toEqual(AGENT_SEO_ENTRIES.map((entry) => ({ slug: entry.slug })));
    for (const entry of AGENT_SEO_ENTRIES) {
      const res = await AgentOg({ params: Promise.resolve({ slug: entry.slug }) });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    }
  });

  it("return a real 404 for an unknown slug rather than a generic card", async () => {
    // The page's dynamicParams=false does not reach the image route, so the
    // route itself has to refuse slugs outside the catalog.
    for (const slug of ["not-an-agent", "deepseek-harness"]) {
      const res = await AgentOg({ params: Promise.resolve({ slug }) });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).not.toBe("image/png");
    }
  });

  it("are the images each page advertises", async () => {
    expect((hubMetadata.twitter as { images?: string[] }).images).toEqual(["https://hivra.cloud/agents/opengraph-image"]);
    for (const entry of AGENT_SEO_ENTRIES) {
      const meta = await generateMetadata({ params: Promise.resolve({ slug: entry.slug }) });
      const og = (meta.openGraph as { images?: Array<{ url: string; width: number; height: number }> }).images ?? [];
      expect(og).toEqual([expect.objectContaining({ url: `https://hivra.cloud/agents/${entry.slug}/opengraph-image`, width: 1200, height: 630 })]);
    }
  });
});
