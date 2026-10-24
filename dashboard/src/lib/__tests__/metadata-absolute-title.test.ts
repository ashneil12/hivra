import fs from "fs";
import path from "path";
import { resolveTitle } from "next/dist/lib/metadata/resolvers/resolve-title";

import { absoluteTitle, buildAbsoluteTitleMetadata, buildWebsiteMetadata } from "../metadata";

const LAYOUT_SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "app", "layout.tsx"), "utf8");
const LAYOUT_TEMPLATE = LAYOUT_SOURCE.match(/template:\s*"([^"]+)"/)?.[1] ?? null;

const TITLE = "Pricing | Hivra";
const DESCRIPTION = "What each size costs and what it includes.";

describe("absolute page titles", () => {
  it("reads the root layout template it is meant to bypass", () => {
    expect(LAYOUT_TEMPLATE).toBe("%s | Hivra");
  });

  it("is the title exactly as written", () => {
    expect(absoluteTitle(TITLE)).toEqual({ absolute: TITLE });
  });

  it("shows the finished title once: Next's own resolver adds no second brand", () => {
    // Control: a plain string title is templated, which is why finished titles need `absolute`.
    expect(resolveTitle(TITLE, LAYOUT_TEMPLATE).absolute).toBe("Pricing | Hivra | Hivra");
    expect(resolveTitle(absoluteTitle(TITLE), LAYOUT_TEMPLATE).absolute).toBe(TITLE);
  });

  it("leaves a title with no brand in it without one", () => {
    expect(resolveTitle(absoluteTitle("Run Claude Code in the cloud"), LAYOUT_TEMPLATE).absolute).toBe("Run Claude Code in the cloud");
  });

  it("does not depend on the layout giving Open Graph or Twitter a title template", () => {
    // Next templates a page's Open Graph and Twitter titles only from a template those
    // fields carry in a layout. The root layout has one template, on `title`, and plain
    // strings for both social titles, so a social title is never suffixed.
    expect([...LAYOUT_SOURCE.matchAll(/template:/g)]).toHaveLength(1);
  });
});

describe("buildAbsoluteTitleMetadata", () => {
  const metadata = buildAbsoluteTitleMetadata({ path: "/pricing", title: TITLE, description: DESCRIPTION });

  it("returns the whole page metadata for generateMetadata()", () => {
    expect(Object.keys(metadata).sort()).toEqual(["alternates", "description", "openGraph", "title", "twitter"]);
    expect(metadata.title).toEqual({ absolute: TITLE });
    expect(metadata.description).toBe(DESCRIPTION);
    expect(metadata.alternates).toEqual({ canonical: "https://hivra.cloud/pricing" });
  });

  it("gives Open Graph and Twitter the same title and description, with no template", () => {
    expect(metadata.openGraph?.title).toBe(TITLE);
    expect(metadata.twitter?.title).toBe(TITLE);
    expect(metadata.openGraph?.description).toBe(DESCRIPTION);
    expect(metadata.twitter?.description).toBe(DESCRIPTION);
    // Resolved the way Next resolves them, with the (absent) social template.
    expect(resolveTitle(metadata.openGraph?.title, null).absolute).toBe(TITLE);
    expect(resolveTitle(metadata.twitter?.title, null).absolute).toBe(TITLE);
    // The page title, resolved with the layout template, is the same single string.
    expect(resolveTitle(metadata.title, LAYOUT_TEMPLATE).absolute).toBe(TITLE);
  });

  it("matches what the static shape produces, so a static page and a slug page agree", () => {
    const staticShape = {
      title: absoluteTitle(TITLE),
      description: DESCRIPTION,
      ...buildWebsiteMetadata({ path: "/pricing", title: TITLE, description: DESCRIPTION }),
    };
    expect(metadata).toEqual(staticShape);
  });

  it("passes images and social overrides through, as buildWebsiteMetadata does", () => {
    const withImage = buildAbsoluteTitleMetadata({
      path: "/agents/claude-code",
      title: "Claude Code on Hivra",
      description: DESCRIPTION,
      images: [{ url: "/agents/claude-code/opengraph-image", width: 1200, height: 630, alt: "Claude Code on Hivra", type: "image/png" }],
    });
    expect(withImage.openGraph?.images).toEqual([
      { url: "https://hivra.cloud/agents/claude-code/opengraph-image", width: 1200, height: 630, alt: "Claude Code on Hivra", type: "image/png" },
    ]);
    expect(withImage.twitter?.images).toEqual(["https://hivra.cloud/agents/claude-code/opengraph-image"]);
    expect(withImage.title).toEqual({ absolute: "Claude Code on Hivra" });
  });

  it("does not export a bare buildWebsiteMetadata shape for a page to use alone", () => {
    // static-copy-safety.test.ts rejects `metadata = buildWebsiteMetadata(...)`: it drops the title.
    expect(buildWebsiteMetadata({ path: "/pricing", title: TITLE, description: DESCRIPTION })).not.toHaveProperty("title");
    expect(metadata).toHaveProperty("title");
  });
});
