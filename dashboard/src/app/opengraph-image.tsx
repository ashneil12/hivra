// Branded Open Graph card for the apex / marketing pages (#public-og-images).
// File-based dynamic image: Next.js serves this at /opengraph-image and
// page.tsx wires it into openGraph/twitter image metadata.

import { renderOgCard } from "@/lib/og-card";
import { OG_IMAGE, OG_CONTENT_TYPE } from "@/lib/og-meta";

export const runtime = "edge";
export const alt = OG_IMAGE.home.alt;
export const size = { width: OG_IMAGE.home.width, height: OG_IMAGE.home.height };
export const contentType = OG_CONTENT_TYPE;

export default function OpengraphImage() {
  return renderOgCard({
    title: "One control plane for agent computers",
    subtitle: "Use Hivra Cloud, connect your own host, or bring your infrastructure provider.",
  });
}
