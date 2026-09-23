// Tests for the public dynamic OG cards (#public-og-images): each segment
// produces a 1200x630 image/png card, and the shared OG_IMAGE descriptors wire
// the generated cards into the public pages' openGraph/twitter image metadata.
//
// We deliberately exercise the segments + shared renderer + descriptors rather
// than importing the page components (page.tsx pulls Clerk/next-headers,
// changelog/page.tsx pulls ESM-only react-markdown) — the descriptors are the
// single source of truth the pages spread into buildWebsiteMetadata, so testing
// them through buildWebsiteMetadata proves the exact wiring contract.

import { buildWebsiteMetadata } from "@/lib/metadata";
import { renderOgCard } from "@/lib/og-card";
import { OG_IMAGE, OG_SIZE, OG_CONTENT_TYPE } from "@/lib/og-meta";

import * as rootSegment from "../opengraph-image";
import RootOg, {
  size as rootSize,
  contentType as rootContentType,
  alt as rootAlt,
} from "../opengraph-image";
import ChangelogOg, {
  size as changelogSize,
  contentType as changelogContentType,
} from "../changelog/opengraph-image";
import StatusOg, {
  size as statusSize,
  contentType as statusContentType,
} from "../status/opengraph-image";

describe("public OG image cards", () => {
  it("returns a 200 image/png response from the shared renderer", async () => {
    // The shared renderer hands back a real ImageResponse with image/png headers.
    // (The PNG bytes are rasterised lazily via @vercel/og's WASM at render time,
    // which Jest's CJS runtime can't drive — the actual pixels are verified in CI's
    // build + by QA on the served route; here we assert the response contract.)
    const res = await renderOgCard({ title: "Test card", subtitle: "A subtitle" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("uses the standard 1200x630 size + image/png content type everywhere", () => {
    expect(OG_SIZE).toEqual({ width: 1200, height: 630 });
    expect(OG_CONTENT_TYPE).toBe("image/png");

    for (const [size, contentType] of [
      [rootSize, rootContentType],
      [changelogSize, changelogContentType],
      [statusSize, statusContentType],
    ] as const) {
      expect(size).toEqual({ width: 1200, height: 630 });
      expect(contentType).toBe("image/png");
    }

    // Cards read the brand mark from public/, so they stay on the Node.js
    // runtime (prerendered at build); the apex card advertises descriptive alt text.
    expect(rootSegment).not.toHaveProperty("runtime");
    expect(rootAlt).toBe(OG_IMAGE.home.alt);
  });

  it("each segment default export returns an image/png response", async () => {
    for (const handler of [RootOg, ChangelogOg, StatusOg]) {
      const res = await handler();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    }
  });

  it("wires each generated card into its page's openGraph + twitter image metadata", () => {
    const cases: Array<{ path: string; image: (typeof OG_IMAGE)[keyof typeof OG_IMAGE] }> = [
      { path: "/", image: OG_IMAGE.home },
      { path: "/changelog", image: OG_IMAGE.changelog },
      { path: "/status", image: OG_IMAGE.status },
    ];

    for (const { path, image } of cases) {
      const meta = buildWebsiteMetadata({
        path,
        title: "t",
        description: "d",
        images: [image],
      });

      const ogImages = meta.openGraph?.images;
      const arr = (Array.isArray(ogImages) ? ogImages : [ogImages]) as Array<{
        url: string;
        width?: number;
        height?: number;
      }>;
      const card = arr.find((i) => i.url.endsWith(image.url));
      expect(card).toBeDefined();
      expect(card?.width).toBe(1200);
      expect(card?.height).toBe(630);

      // Twitter card points at the same generated image route.
      const twitterImages = meta.twitter?.images as string[] | undefined;
      expect(twitterImages?.some((u) => u.endsWith(image.url))).toBe(true);
    }
  });

  it("every OG descriptor points at a distinct public 1200x630 card route", () => {
    const urls = Object.values(OG_IMAGE).map((i) => i.url);
    // /opengraph-image, /changelog/opengraph-image, /status/opengraph-image
    expect(new Set(urls).size).toBe(urls.length);
    for (const img of Object.values(OG_IMAGE)) {
      expect(img.url).toMatch(/opengraph-image$/);
      expect(img.width).toBe(1200);
      expect(img.height).toBe(630);
      expect(img.type).toBe("image/png");
      // Cards carry only public branding copy — descriptors hold no tenant/user data.
      expect(img.alt).toMatch(/Hivra/);
    }
  });
});
