// The /tools social cards: one per catalog tool, and a real 404 for anything
// else. The page's dynamicParams=false does not reach the image route (Next's
// metadata route loader drops it), so the route has to refuse unknown slugs.

import ToolOg, { alt, contentType, generateStaticParams, size } from "../[slug]/opengraph-image";
import { TOOL_ENTRIES } from "@/lib/tools/tool-catalog";

describe("/tools/[slug]/opengraph-image", () => {
  it("declares a 1200x630 PNG card with alt text", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    expect(alt).toMatch(/Hivra/);
  });

  it("prerenders and renders an image/png card for every catalog tool", async () => {
    expect(generateStaticParams()).toEqual(TOOL_ENTRIES.map((entry) => ({ slug: entry.slug })));
    for (const entry of TOOL_ENTRIES) {
      const res = await ToolOg({ params: Promise.resolve({ slug: entry.slug }) });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    }
  });

  it("returns a real 404 for an unknown slug rather than a generic card", async () => {
    const res = await ToolOg({ params: Promise.resolve({ slug: "not-a-tool" }) });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toBe("image/png");
  });
});
