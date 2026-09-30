// Branded Open Graph card for /changelog (#public-og-images).
// Served at /changelog/opengraph-image; wired into the page's image metadata.

import { renderOgCard } from "@/lib/og-card";
import { OG_IMAGE, OG_CONTENT_TYPE } from "@/lib/og-meta";

export const alt = OG_IMAGE.changelog.alt;
export const size = { width: OG_IMAGE.changelog.width, height: OG_IMAGE.changelog.height };
export const contentType = OG_CONTENT_TYPE;

export default async function ChangelogOpengraphImage() {
  return renderOgCard({
    eyebrow: "Changelog",
    title: "What shipped on Hivra",
    subtitle: "Every notable ship: features, fixes, upstream syncs, and infrastructure.",
  });
}
