// Branded Open Graph card for /status (#public-og-images).
// Served at /status/opengraph-image; wired into the page's image metadata.

import { renderOgCard } from "@/lib/og-card";
import { OG_IMAGE, OG_CONTENT_TYPE } from "@/lib/og-meta";

export const alt = OG_IMAGE.status.alt;
export const size = { width: OG_IMAGE.status.width, height: OG_IMAGE.status.height };
export const contentType = OG_CONTENT_TYPE;

export default async function StatusOpengraphImage() {
  return renderOgCard({
    eyebrow: "Status",
    title: "Live platform health",
    subtitle: "Real-time operational status of Hivra's public surfaces.",
  });
}
