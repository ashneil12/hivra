// Pure (next/og-free) Open Graph card metadata for the public marketing pages
// (#public-og-images). Lives apart from og-card.tsx — which imports next/og and
// rasterises the PNG — so page metadata can reference these descriptors without
// pulling the @vercel/og runtime into every page module (and every page test).

// Standard Open Graph card dimensions.
export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";

// Per-page OG image descriptors. Single source of truth shared between each
// page's metadata (openGraph/twitter images) and its opengraph-image.tsx
// segment, so the wired URL always matches the route that generates the card.
export const OG_IMAGE = {
  home: {
    url: "/opengraph-image",
    width: OG_SIZE.width,
    height: OG_SIZE.height,
    alt: "Hivra — one control plane for agent computers",
    type: OG_CONTENT_TYPE,
  },
  changelog: {
    url: "/changelog/opengraph-image",
    width: OG_SIZE.width,
    height: OG_SIZE.height,
    alt: "Hivra Changelog — what shipped",
    type: OG_CONTENT_TYPE,
  },
  status: {
    url: "/status/opengraph-image",
    width: OG_SIZE.width,
    height: OG_SIZE.height,
    alt: "Hivra Status — live platform health",
    type: OG_CONTENT_TYPE,
  },
  // Token-facing cards: factual copy only (no price, returns or pitch).
  token: {
    url: "/token/opengraph-image",
    width: OG_SIZE.width,
    height: OG_SIZE.height,
    alt: "Hivra token contracts. Official addresses are listed at hivra.cloud/token.",
    type: OG_CONTENT_TYPE,
  },
  tokenomics: {
    url: "/tokenomics/opengraph-image",
    width: OG_SIZE.width,
    height: OG_SIZE.height,
    alt: "Proposed $HIVRA tokenomics from Hivra. Information, not an offer.",
    type: OG_CONTENT_TYPE,
  },
} as const;

// Pages whose metadata does not pass `images` still get their own card.
// Next.js ignores a segment's opengraph-image file when the page's metadata
// already sets openGraph.images, and buildWebsiteMetadata always sets them, so
// the default has to come from here rather than from the file convention.
export const OG_IMAGE_BY_PATH: Readonly<Record<string, (typeof OG_IMAGE)[keyof typeof OG_IMAGE]>> = {
  "/token": OG_IMAGE.token,
  "/tokenomics": OG_IMAGE.tokenomics,
};
