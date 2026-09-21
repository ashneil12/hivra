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
} as const;
